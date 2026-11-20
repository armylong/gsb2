"""内容感知接缝雕刻（seam carving）核心引擎。

只做一件事：在不改变高度的前提下，从图中逐列删去若干条
**竖向 8 连通接缝**（每行删 1 个像素，相邻行删除位置相差不超过 1 列），
从而把宽度收窄。保护区域是硬约束：被保护的源像素永远不会被删除，
找不到合法接缝时立即停止，不会放松约束。

每条接缝的删除位置都以**当前源图列坐标**记录；同时维护一张
``source_index`` 图，把当前像素映射回原始图片坐标，因此输出可以
逐像素追溯到来源，被删像素也能完整列出。
"""

from __future__ import annotations

from dataclasses import dataclass, field

import cv2
import numpy as np

# 能量累加时的“无穷大”：必须是真正的 inf，np.isinf 才能识别不可达格子。
INF = np.inf
# 固定随机种子，保证同参数重复运行结果一致。
RNG_SEED = 13754


class CarveInfeasible(RuntimeError):
    """目标宽度本身不合法（过窄或比原图还宽）时抛出。"""


@dataclass
class CarveOutcome:
    """一次缩窄处理的完整结果，全部可追溯到原图坐标。"""

    result: np.ndarray                 # (H, W', 3) uint8 BGR 真实删缝后的图
    source_width: int                  # 原图宽度，重复运行始终以原图为起点
    target_width: int                  # 请求的目标宽度
    width: int                         # 实际完成宽度（<= target_width）
    height: int                        # 高度，恒等于原图高度
    source_index: np.ndarray           # (H, W') int32，输出像素 -> 原图列号
    # 每条已删接缝：长度 H 的数组，元素为删除发生时该像素在“当前图”中的列号
    removed_seams: list[np.ndarray] = field(default_factory=list)
    # 已删除的源像素坐标，每行一个 (row, source_col)，按删除顺序排列
    removed_source_points: list[tuple[int, int]] = field(default_factory=list)
    cancelled: bool = False            # 是否因取消而提前停止
    stopped_infeasible: bool = False   # 是否因保护约束找不到合法接缝而停止

    @property
    def completed(self) -> bool:
        """是否达成了请求的目标宽度。"""
        return self.width == self.target_width

    @property
    def remaining(self) -> int:
        """距离目标宽度还差多少像素（未开始处理时为完整目标量，下限为 0）。"""
        return max(self.width - self.target_width, 0)

    def removed_source_cols_per_row(self) -> np.ndarray:
        """每行被删除的源列号集合，形状 (H,) 的 object 数组。"""
        per_row: list[list[int]] = [[] for _ in range(self.height)]
        for r, c in self.removed_source_points:
            per_row[r].append(c)
        out = np.empty(self.height, dtype=object)
        for r, cols in enumerate(per_row):
            out[r] = np.asarray(sorted(cols), dtype=np.int32)
        return out


def compute_energy(image: np.ndarray) -> np.ndarray:
    """Sobel 梯度能量图（uint8 BGR -> float64）。

    高反差边缘能量高，接缝会优先绕开它们，从而保留主体轮廓。
    """
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (3, 3), 0)
    gx = cv2.Sobel(gray, cv2.CV_64F, 1, 0, ksize=3)
    gy = cv2.Sobel(gray, cv2.CV_64F, 0, 1, ksize=3)
    return cv2.magnitude(gx, gy)


def find_seam(energy: np.ndarray, protected: np.ndarray) -> np.ndarray | None:
    """在保护硬约束下找一条最低能量竖向接缝。

    ``protected`` 为 True 的像素禁止经过。DP 递推：

        M[r, c] = E[r, c] + min(M[r-1, c-1], M[r-1, c], M[r-1, c+1])

    受保护格子代价设为 INF；某行全部不可达时返回 None（当前宽度下
    已无合法接缝）。同代价时用列号做次级判据，结果确定可复现。
    """
    h, w = energy.shape
    cost = np.where(protected, INF, energy.astype(np.float64))
    back = np.full((h, w), -1, dtype=np.int32)

    prev = cost[0].copy()
    for r in range(1, h):
        shifted = np.full((3, w), INF, dtype=np.float64)
        # 三个前驱：左上 / 正上 / 右上，越界处保持 INF
        shifted[0, 1:] = prev[:-1]
        shifted[1, :] = prev
        shifted[2, :-1] = prev[1:]
        # 同价取更靠左的前驱：argmin 默认返回首个最小值，天然稳定。
        choice = np.argmin(shifted, axis=0)
        back[r] = np.arange(w) + (choice - 1)
        best = shifted[choice, np.arange(w)]
        prev = cost[r] + best
        # 整行不可达（前驱全是 INF）时提前结束
        if np.all(np.isinf(prev)):
            return None

    seam = np.empty(h, dtype=np.int32)
    seam[-1] = int(np.argmin(prev))
    if np.isinf(prev[seam[-1]]):
        return None
    for r in range(h - 1, 0, -1):
        seam[r - 1] = back[r, seam[r]]
    return seam


def remove_seam(
    image: np.ndarray,
    seam: np.ndarray,
    source_index: np.ndarray,
    protected: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """从图、源列号图、保护掩码中同时删掉一条接缝（宽度减 1）。"""
    h, w = image.shape[:2]
    keep = np.ones((h, w), dtype=bool)
    keep[np.arange(h), seam] = False
    new_image = image[keep].reshape(h, w - 1, -1)
    new_index = source_index[keep].reshape(h, w - 1)
    new_protected = protected[keep].reshape(h, w - 1)
    return new_image, new_index, new_protected


def _validate(image: np.ndarray, protected: np.ndarray, target_width: int) -> None:
    if image.ndim != 3 or image.shape[2] != 3 or image.dtype != np.uint8:
        raise ValueError("image 必须是 (H, W, 3) 的 uint8 BGR 数组")
    h, w = image.shape[:2]
    if protected.shape != (h, w) or protected.dtype != bool:
        raise ValueError("protected 必须是与 image 同尺寸的 bool 掩码")
    if not (0 < target_width <= w):
        raise CarveInfeasible(
            f"目标宽度 {target_width} 非法：当前宽度 {w}，只能在 (0, {w}] 之间"
        )


def carve_width(
    image: np.ndarray,
    protected: np.ndarray,
    target_width: int,
    should_cancel=None,
    progress=None,
) -> CarveOutcome:
    """把图像横向收窄到 ``target_width``。

    - 每次迭代重新计算能量并查找一条合法接缝，逐缝删除；
    - 保护掩码随像素删除同步压缩，始终与当前图对齐；
    - ``should_cancel`` 回调返回 True 时停在最后有效尺寸，半成品保留全部
      映射记录，但 ``cancelled=True``；
    - 保护导致无合法接缝时停在最后有效尺寸，``stopped_infeasible=True``，
      绝不放松保护；
    - 从原图与原始保护掩码开始，不依赖任何上一版成品。
    """
    _validate(image, protected, target_width)
    h, w = image.shape[:2]

    cur_img = image.copy()
    cur_prot = protected.copy()
    cur_index = np.tile(np.arange(w, dtype=np.int32), (h, 1))

    outcome = CarveOutcome(
        result=cur_img.copy(),
        source_width=w,
        target_width=target_width,
        width=w,
        height=h,
        source_index=cur_index.copy(),
    )

    total = w - target_width
    for step in range(total):
        if should_cancel is not None and should_cancel():
            outcome.cancelled = True
            break
        energy = compute_energy(cur_img)
        seam = find_seam(energy, cur_prot)
        if seam is None:
            outcome.stopped_infeasible = True
            break

        # 先按当前坐标记录接缝，再把删除位置翻译成原图坐标。
        outcome.removed_seams.append(seam.copy())
        rows = np.arange(h)
        removed_src = cur_index[rows, seam].astype(np.int32)
        outcome.removed_source_points.extend(zip(rows.tolist(), removed_src.tolist()))

        cur_img, cur_index, cur_prot = remove_seam(
            cur_img, seam, cur_index, cur_prot
        )
        outcome.width = cur_img.shape[1]
        if progress is not None:
            progress(step + 1, total)

    outcome.result = cur_img
    outcome.source_index = cur_index
    return outcome


def infeasible_reason(outcome: CarveOutcome) -> str:
    """给停止状态生成一句中文说明。"""
    if outcome.completed:
        return "已达到目标宽度。"
    if outcome.cancelled:
        return (
            f"已取消：停在最后有效宽度 {outcome.width}px，"
            f"距目标 {outcome.target_width}px 还差 {outcome.remaining}px。"
        )
    if outcome.stopped_infeasible:
        return (
            f"保护约束使合法接缝不存在：至少有一行的所有剩余像素都在保护区内，"
            f"无法在不删除保护像素的前提下继续。停在最后有效宽度 {outcome.width}px，"
            f"距目标 {outcome.target_width}px 还差 {outcome.remaining}px，"
            f"保护约束未放松。"
        )
    return "未完成，原因未知。"
