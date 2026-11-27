"""透印(背透)估计与压浅修复。

思路是物理成像的线性叠加: 薄纸正面扫描值 ≈ 纸白 - 正面墨 - 透过来的背面墨。
因此修复不是"对整图做一次模糊", 而是:

1. 把对齐后的背面逐像素换算成"背墨深度" back_ink(0=纸白, 越大墨越重);
   纸白用大窗口局部最大值估计, 以适应纸张/光照不均;
2. 在用户指定的"基本留白"矩形里标定强度 k——该区域正面没有自己的墨,
   正面变暗量与背墨深度的比值就是透印系数, 取稳健分位数;
3. 逐像素得到透印预测 bleed = k_field * back_ink, 再从正面减掉;
4. 保护: 正面墨显著深于透印预测的地方(自己的细字/线, 或与背面重合的笔画),
   自动弱处理; 用户手绘保护区完全不动。

所有像素级中间量都保留在 ProcessResult 里, 界面可以直接显示"实际用了哪些
参照像素", 而不是一个说不清的黑盒滤镜。
"""

from __future__ import annotations

from dataclasses import dataclass, field

import cv2
import numpy as np

# 强度场允许的范围, 0 表示该像素完全不修
STRENGTH_CLIP = (0.0, 3.0)


@dataclass
class LocalPatch:
    """局部强度调整块, 坐标全部是正面原图像素(与缩放无关)。"""

    x: int
    y: int
    w: int
    h: int
    gain: float  # 相对全局强度的倍数, 0=该块完全不修


@dataclass
class ProcessParams:
    base_strength: float = 0.0          # 留白区标定出来的全局 k(自动填充)
    paper_sigma: float = 31.0           # 纸白场平滑尺度(像素), 跟随光照渐变
    detail_sigma: float = 1.2           # 背墨参照的轻微高斯 sigma(仅去扫描噪点)
    protect_threshold: float = 18.0     # 正面比预测透印深多少算"自己的墨"
    protect_min_dark: float = 90.0      # 自动保护要求正面墨的最小绝对变暗量
    protect_dilate: int = 2             # 自动保护沿正面墨膨胀的像素(盖住抗锯齿边)
    protect_feather: int = 3            # 保护掩膜外缘羽化半径
    min_ink: float = 2.0                # 背墨低于该值视为纸白, 不参与参照
    protect_strokes: list = field(default_factory=list)   # 手绘笔画, 点序列列表
    protect_radius: int = 12            # 手绘保护笔刷半径(原图像素)
    patches: list[LocalPatch] = field(default_factory=list)


@dataclass
class ProcessResult:
    result: np.ndarray                  # 修复后灰度图(与原图同尺寸)
    back_ink: np.ndarray                # 背墨深度图(参照量, float32)
    local_white: np.ndarray             # 背面局部纸白
    bleed_pred: np.ndarray              # 预测的透印变暗量
    strength_field: np.ndarray          # 每像素实际 k
    coverage: np.ndarray                # 背面数据覆盖掩膜 0/255
    protect_mask: np.ndarray            # 最终保护掩膜 0..1(1=完全保留)
    auto_protect: np.ndarray           # 自动保护(正面自己的墨) 0/255
    hand_protect: np.ndarray           # 手绘保护 0/255
    reference_pixels: np.ndarray       # 实际参与参照的像素 0/255
    diff: np.ndarray                   # 原图-结果 的实际改动量(放大可视化用)


# ---------------------------------------------------------------- 纸白与背墨

def estimate_local_white(gray: np.ndarray, radius: int) -> np.ndarray:
    """大窗口局部最大值当作纸白基准。

    用形态学膨胀而不是全图均值: 窗口内只要存在纸白像素就能取到,
    背光不匀/页角发灰也能逐点跟随。
    """
    radius = max(3, int(radius) | 1)
    kernel = cv2.getStructuringElement(
        cv2.MORPH_ELLIPSE, (radius, radius)
    )
    return cv2.dilate(gray, kernel).astype(np.float32)


def estimate_paper_white(gray: np.ndarray, smooth_sigma: float = 25.0) -> np.ndarray:
    """估计纸张本身的亮度场(无墨处应有的灰度)。

    局部最大值在大字/粗线内部取不到纸白会塌陷, 这里改用:
    全图高百分位作为纸白地板, 再叠一层大尺度高斯平滑跟随光照渐变。
    页角发灰时平滑项给出更低的局部基准, 均匀页面则退化为常数地板。
    """
    g = gray.astype(np.float32)
    floor = float(np.percentile(g, 99.5))
    smooth = cv2.GaussianBlur(g, (0, 0), smooth_sigma)
    return np.maximum(smooth, floor)


def back_ink_map(
    back_warped: np.ndarray, coverage: np.ndarray, radius: int,
    detail_sigma: float, min_ink: float,
) -> tuple[np.ndarray, np.ndarray]:
    """对齐后的背面 -> (背墨深度图, 局部纸白)。

    背墨 = 纸白基准 - 背面灰度, 只在覆盖区内有效。
    一个很小的高斯仅用于压扫描噪点, 不做大范围模糊, 笔画形状保持清晰。
    """
    gray = back_warped.astype(np.float32)
    white = estimate_paper_white(back_warped, smooth_sigma=float(radius))
    ink = np.clip(white - gray, 0.0, None)
    if detail_sigma > 0:
        ink = cv2.GaussianBlur(ink, (0, 0), detail_sigma)
    cov = coverage > 0
    ink[~cov] = 0.0
    # 纸白附近的微小波动是噪声, 不算参照
    ink[ink < min_ink] = 0.0
    return ink.astype(np.float32), white


# ---------------------------------------------------------------- 留白标定

def calibrate_strength(
    front_gray: np.ndarray,
    back_ink: np.ndarray,
    coverage: np.ndarray,
    rect: tuple[int, int, int, int],
    quantile: float = 0.9,
    min_ink: float = 2.0,
) -> tuple[float, np.ndarray]:
    """在一块"基本留白"矩形里估计透印强度 k。

    留白区正面变暗应全部来自背透, 理论上 front_dark = k * back_ink。
    逐像素比值在笔画边缘/噪声处发散, 直接取分位数会被污染; 这里对入选
    像素做"过原点最小二乘" k = Σ(x·y)/Σ(x²), 等价于按背墨量加权的比值,
    重墨像素(信噪比最高)贡献最大。同时返回实际入选的参照像素掩膜,
    界面直接叠加显示, 不允许黑盒处理。
    """
    x, y, w, h = rect
    H, W = front_gray.shape
    x0 = max(0, x)
    y0 = max(0, y)
    x1 = min(W, x + w)
    y1 = min(H, y + h)
    if x1 <= x0 or y1 <= y0:
        return 0.0, np.zeros((H, W), np.uint8)

    front_white = estimate_paper_white(front_gray)
    front_dark = np.clip(front_white - front_gray.astype(np.float32), 0.0, None)

    ref = np.zeros((H, W), np.uint8)
    sub_cov = coverage[y0:y1, x0:x1] > 0
    sub_ink = back_ink[y0:y1, x0:x1]
    sub_dark = front_dark[y0:y1, x0:x1]
    # 只用背墨足够深的像素: 浅墨处比值受噪声主导
    valid = sub_cov & (sub_ink >= max(min_ink, 10.0))
    if int(valid.sum()) < 16:
        return 0.0, ref

    xs = sub_ink[valid]
    ys = sub_dark[valid]
    denom = float((xs * xs).sum())
    k = float((xs * ys).sum() / denom) if denom > 0 else 0.0
    k = float(np.clip(k, *STRENGTH_CLIP))

    sub_ref = ref[y0:y1, x0:x1]
    sub_ref[valid] = 255
    return k, ref


# ---------------------------------------------------------------- 强度场与保护

def build_strength_field(
    shape: tuple[int, int],
    base: float,
    patches: list[LocalPatch],
    coverage: np.ndarray,
) -> np.ndarray:
    """全局 k 叠加局部块, 覆盖区外强制为 0(缺背面数据不处理)。"""
    field = np.full(shape, float(base), dtype=np.float32)
    H, W = shape
    for p in patches:
        x0 = max(0, p.x)
        y0 = max(0, p.y)
        x1 = min(W, p.x + p.w)
        y1 = min(H, p.y + p.h)
        if x1 <= x0 or y1 <= y0:
            continue
        # 块边缘做高斯羽化, 避免接缝
        patch = np.zeros((y1 - y0, x1 - x0), np.float32)
        patch[:] = float(np.clip(base * p.gain, *STRENGTH_CLIP))
        blur_sz = max(3, min(patch.shape) | 1)
        if blur_sz >= 3:
            patch = cv2.GaussianBlur(patch, (blur_sz, blur_sz), 0)
        field[y0:y1, x0:x1] = patch
    field[coverage == 0] = 0.0
    return np.clip(field, *STRENGTH_CLIP).astype(np.float32)


def build_hand_protect(
    shape: tuple[int, int],
    strokes: list,
    radius: int,
) -> np.ndarray:
    """手绘保护笔画 -> 栅格掩膜。笔画坐标是原图像素, 缩放不影响落点。"""
    mask = np.zeros(shape, np.uint8)
    r = max(1, int(radius))
    for stroke in strokes:
        pts = np.asarray(stroke, dtype=np.int32)
        if len(pts) == 1:
            cv2.circle(mask, tuple(pts[0]), r, 255, -1)
        elif len(pts) >= 2:
            cv2.polylines(mask, [pts], False, 255, thickness=r * 2,
                          lineType=cv2.LINE_AA)
    return mask


# ---------------------------------------------------------------- 主处理

def process_front(
    front_gray: np.ndarray,
    back_warped: np.ndarray,
    coverage: np.ndarray,
    params: ProcessParams,
) -> ProcessResult:
    """逐像素透印压浅, 返回全部中间量以便界面核对。"""
    if front_gray.shape != back_warped.shape:
        raise ValueError("正面与 warp 后背面尺寸必须一致")
    shape = front_gray.shape
    front = front_gray.astype(np.float32)

    # 1) 背墨参照(真实的对齐背面像素, 不是全图模糊)
    ink, back_white = back_ink_map(
        back_warped, coverage,
        int(params.paper_sigma), params.detail_sigma, params.min_ink,
    )

    # 2) 强度场 + 透印预测
    k_field = build_strength_field(shape, params.base_strength,
                                   params.patches, coverage)
    bleed_pred = np.clip(k_field * ink, 0.0, None)

    # 3) 正面自身变暗量, 用于识别"正面本来就有墨"
    front_white = estimate_paper_white(front_gray)
    front_dark = np.clip(front_white - front, 0.0, None)

    # 4) 自动保护: 正面自己的字/线要弱处理或保留, 纯背透要清理。
    #    直接用原始灰度而不是"纸白-灰度"的变暗量: 深墨处变暗量会被压缩,
    #    原始灰度对细笔画更敏感。两条判据:
    #    a) 该像素比纸白暗到一定程度(绝对门槛, 纯背透通常到不了这么黑);
    #    b) 它比"只考虑背透时应有的亮度"还深(相对超出, 挡住对齐残差边缘)。
    #    不做形态学开运算(会吃掉 1px 细线), 改为沿墨小膨胀包住抗锯齿边。
    expected_after_bleed = front_white - bleed_pred
    auto = (
        (front_white - front >= params.protect_min_dark)
        & (front < expected_after_bleed - params.protect_threshold)
    ).astype(np.uint8) * 255
    if params.protect_dilate > 0:
        ksize = params.protect_dilate * 2 + 1
        auto = cv2.dilate(
            auto,
            cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (ksize, ksize)),
        )
    hand = build_hand_protect(shape, params.protect_strokes,
                              params.protect_radius)
    hard = cv2.bitwise_or(auto, hand)
    if params.protect_feather > 0:
        # 先把硬核提回 1: 膨胀区内完全不动, 只在掩膜外缘做羽化过渡
        blurred = cv2.GaussianBlur(
            hard, (params.protect_feather * 2 + 1,) * 2, 0
        ).astype(np.float32) / 255.0
        protect = np.maximum(blurred, (hard > 0).astype(np.float32))
    else:
        protect = (hard > 0).astype(np.float32)

    # 5) 实际减掉的量: 保护区按 (1-protect) 衰减, 且绝不减到比纸白还亮,
    #    也绝不改变覆盖区外的任何像素
    removal = bleed_pred * (1.0 - protect)
    removal[coverage == 0] = 0.0
    # 不能把正面本身的墨也减掉: 封顶到正面变暗量
    removal = np.minimum(removal, front_dark)
    result = np.clip(front + removal, 0.0, 255.0).astype(np.uint8)

    # 实际参与参照的像素: 覆盖区内背墨超过噪声门限且确实在做修正
    reference = ((ink >= params.min_ink) & (coverage > 0)
                 & (k_field > 0)).astype(np.uint8) * 255

    diff = np.clip(removal, 0, 255).astype(np.uint8)

    return ProcessResult(
        result=result,
        back_ink=ink,
        local_white=back_white,
        bleed_pred=bleed_pred.astype(np.float32),
        strength_field=k_field,
        coverage=coverage,
        protect_mask=protect,
        auto_protect=auto,
        hand_protect=hand,
        reference_pixels=reference,
        diff=diff,
    )
