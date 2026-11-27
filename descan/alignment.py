"""点对对齐。

扫描的正背面在扫描仪上方向相反, 对齐前需要先把背面水平镜像(以背面图像
中线为轴)。之后用户在两张图上点若干对应点, 用小范围变换(平移/旋转/缩放,
必要时仿射或单应)把背面 warp 到正面坐标系。

设计约束:
- 始终保留两张原图, 所有变换只作用在副本上;
- warp 的同时输出覆盖掩膜, 角上对不到(背面没有数据)的位置显式标出来,
  后续处理不允许在这些位置凭空补白。
"""

from __future__ import annotations

from dataclasses import dataclass, field

import cv2
import numpy as np

# 变换档位 -> OpenCV 单应标志
HOMOGRAPHY_METHODS = {
    "translate": None,  # 特殊处理: 只取平移
    "similarity": cv2.LMEDS,
    "affine": cv2.LMEDS,
    "homography": cv2.LMEDS,
}


@dataclass
class Alignment:
    """一次对齐的完整描述, 可复现任意 warp。"""

    front_shape: tuple[int, int]  # (H, W)
    back_shape: tuple[int, int]
    mirror_back: bool = True
    method: str = "similarity"
    # 正面点 / 背面点(均为各自原图像素坐标, 背面点在镜像前的图上)
    front_pts: list[tuple[float, float]] = field(default_factory=list)
    back_pts: list[tuple[float, float]] = field(default_factory=list)
    # 3x3 矩阵: 把"镜像后的背面坐标"映射到正面坐标
    matrix: np.ndarray | None = None
    rms: float = float("nan")

    @property
    def is_ready(self) -> bool:
        return self.matrix is not None

    def mirror_matrix(self) -> np.ndarray:
        """背面原图坐标 -> 镜像后背面坐标的 3x3 矩阵。"""
        w = self.back_shape[1]
        if self.mirror_back:
            return np.array([[-1.0, 0.0, w], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]])
        return np.eye(3)

    def full_matrix(self) -> np.ndarray | None:
        """背面原图坐标 -> 正面坐标的完整矩阵(镜像 + 点对拟合)。"""
        if self.matrix is None:
            return None
        return self.matrix @ self.mirror_matrix()


def _as_float_array(points: list[tuple[float, float]]) -> np.ndarray:
    return np.asarray(points, dtype=np.float64).reshape(-1, 2)


def fit_transform(alignment: Alignment) -> Alignment:
    """根据 alignment 里的点对填充 matrix / rms, 返回同一个对象。

    点数要求:
    - 1 对点: 只做平移(镜像后的背面整体平移);
    - 2 对点: 带旋转/均匀缩放的相似变换(最小二乘, 4 自由度恰好确定);
    - >=3 对: 相似/仿射用 LMEDS 稳健估计, 单应需要 >=4 对。
    """
    n = min(len(alignment.front_pts), len(alignment.back_pts))
    if n == 0:
        raise ValueError("至少需要 1 个点对才能对齐")

    fp = _as_float_array(alignment.front_pts[:n])
    bp = _as_float_array(alignment.back_pts[:n])

    # 先把背面点换到镜像后的坐标系, 拟合全部在该坐标系下进行
    mir = alignment.mirror_matrix()
    bp_h = cv2.convertPointsToHomogeneous(bp).reshape(-1, 3)
    bp_m = (mir @ bp_h.T).T
    bp_m = cv2.convertPointsFromHomogeneous(bp_m).reshape(-1, 2)

    method = alignment.method
    if n == 1 or method == "translate":
        shift = fp[0] - bp_m[0]
        mat = np.array(
            [[1.0, 0.0, shift[0]], [0.0, 1.0, shift[1]], [0.0, 0.0, 1.0]]
        )
    elif method == "similarity":
        if n == 2:
            # 两点确定一个有向线段: 平移 + 旋转 + 均匀缩放
            sf = fp[1] - fp[0]
            sb = bp_m[1] - bp_m[0]
            ang = np.arctan2(sf[1], sf[0]) - np.arctan2(sb[1], sb[0])
            scale = np.linalg.norm(sf) / max(np.linalg.norm(sb), 1e-9)
            c, s = np.cos(ang) * scale, np.sin(ang) * scale
            rot = np.array([[c, -s], [s, c]])
            shift = fp[0] - rot @ bp_m[0]
            mat = np.eye(3)
            mat[:2, :2] = rot
            mat[:2, 2] = shift
        else:
            m, _ = cv2.estimateAffinePartial2D(
                bp_m, fp, method=cv2.LMEDS, maxIters=2000, confidence=0.99
            )
            if m is None:  # LMEDS 退化时退回普通最小二乘
                m, _ = cv2.estimateAffinePartial2D(bp_m, fp)
            mat = np.vstack([m, [0.0, 0.0, 1.0]])
    elif method == "affine":
        if n < 3:
            raise ValueError("仿射变换至少需要 3 个点对")
        m, _ = cv2.estimateAffine2D(bp_m, fp, method=cv2.LMEDS)
        if m is None:
            m, _ = cv2.estimateAffine2D(bp_m, fp)
        mat = np.vstack([m, [0.0, 0.0, 1.0]])
    elif method == "homography":
        if n < 4:
            raise ValueError("单应变换至少需要 4 个点对")
        mat, _ = cv2.findHomography(bp_m, fp, method=cv2.LMEDS)
        if mat is None:
            mat, _ = cv2.findHomography(bp_m, fp, method=0)
    else:
        raise ValueError(f"未知变换类型: {method}")

    alignment.matrix = np.asarray(mat, dtype=np.float64)
    alignment.rms = float(residuals(alignment).mean()) if n else float("nan")
    return alignment


def warp_back(
    back_gray: np.ndarray, alignment: Alignment, shape: tuple[int, int] | None = None
) -> np.ndarray:
    """把背面原图 warp 到正面坐标系, 输出与正面同尺寸的灰度图。

    没有背面数据覆盖到的像素填 255(纸白), 配合 coverage_mask 使用——
    任何修复强度在覆盖区外都必须被关掉, 不能把这些位置当真白纸处理。
    """
    if alignment.matrix is None:
        raise RuntimeError("对齐尚未拟合, 先调用 fit_transform")
    h, w = shape or alignment.front_shape
    full = alignment.full_matrix()
    return cv2.warpPerspective(
        back_gray,
        full,
        (w, h),
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=255,
    )


def coverage_mask(
    alignment: Alignment, shape: tuple[int, int] | None = None
) -> np.ndarray:
    """背面 warp 后真正有数据的区域 (uint8, 255=有参考)。"""
    if alignment.matrix is None:
        raise RuntimeError("对齐尚未拟合, 先调用 fit_transform")
    h, w = shape or alignment.front_shape
    full = alignment.full_matrix()
    ones = np.ones(alignment.back_shape, dtype=np.uint8) * 255
    return cv2.warpPerspective(
        ones, full, (w, h), flags=cv2.INTER_NEAREST, borderValue=0
    )


def map_point(alignment: Alignment, back_xy: tuple[float, float]) -> tuple[float, float]:
    """单个背面原图坐标 -> 正面坐标, 供界面画点与核对。"""
    if alignment.matrix is None:
        raise RuntimeError("对齐尚未拟合")
    full = alignment.full_matrix()
    x, y, z = full @ np.array([back_xy[0], back_xy[1], 1.0])
    return float(x / z), float(y / z)


def residuals(alignment: Alignment) -> np.ndarray:
    """每个点对在正面坐标系下的残差(像素), 用于界面提示对齐质量。"""
    if alignment.matrix is None:
        return np.array([])
    n = min(len(alignment.front_pts), len(alignment.back_pts))
    if n == 0:
        return np.array([])
    out = np.empty(n)
    for i in range(n):
        mx, my = map_point(alignment, alignment.back_pts[i])
        fx, fy = alignment.front_pts[i]
        out[i] = float(np.hypot(mx - fx, my - fy))
    return out
