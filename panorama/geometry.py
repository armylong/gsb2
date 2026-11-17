"""单应矩阵（homography）几何工具与尺度合理性检查。

约定：H_ji 把第 i 张照片图像坐标下的点映射到第 j 张照片坐标，
即  p_j ~ H_ji @ p_i（齐次坐标）。
"""
from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

from .config import Config


def identity() -> np.ndarray:
    return np.eye(3, dtype=np.float64)


def invert(H: np.ndarray) -> np.ndarray:
    return np.linalg.inv(H.astype(np.float64))


def compose(H_ab: np.ndarray, H_bc: np.ndarray) -> np.ndarray:
    """H_ab: a->b, H_bc: b->c, 返回 a->c。"""
    return H_bc.astype(np.float64) @ H_ab.astype(np.float64)


def image_corners(w: int, h: int) -> np.ndarray:
    return np.array(
        [[0, 0], [w, 0], [w, h], [0, h]], dtype=np.float64
    )


def warp_points(H: np.ndarray, pts: np.ndarray) -> np.ndarray:
    """把 Nx2 点经 H 映射为 Nx2。"""
    pts = np.asarray(pts, dtype=np.float64)
    if len(pts) == 0:
        return pts.reshape(-1, 2)
    homog = np.concatenate([pts, np.ones((len(pts), 1))], axis=1)
    out = (H.astype(np.float64) @ homog.T).T
    out = out[:, :2] / out[:, 2:3]
    return out


def warp_corners(H: np.ndarray, w: int, h: int) -> np.ndarray:
    return warp_points(H, image_corners(w, h))


def _jacobian_scales(H: np.ndarray, w: int, h: int) -> np.ndarray:
    """在 5 个采样点计算投影映射雅可比的奇异值（局部各向异性尺度）。"""
    H = H.astype(np.float64)
    fx, fy = max(w - 1, 1), max(h - 1, 1)
    samples = np.array(
        [
            [0.0, 0.0], [fx, 0.0], [fx, fy], [0.0, fy],
            [fx / 2.0, fy / 2.0],
        ]
    )
    scales = []
    for x, y in samples:
        den = H[2, 0] * x + H[2, 1] * y + H[2, 2]
        # d(p')/d(x,y)，p' = (a/c, b/c)
        a = H[0, 0] * x + H[0, 1] * y + H[0, 2]
        b = H[1, 0] * x + H[1, 1] * y + H[1, 2]
        da = np.array([H[0, 0], H[0, 1]])
        db = np.array([H[1, 0], H[1, 1]])
        dc = np.array([H[2, 0], H[2, 1]])
        jac = np.outer(np.ones(2), da) / den - np.outer(a, dc) / den**2
        jac = np.stack(
            [da / den - a * dc / den**2,
             db / den - b * dc / den**2]
        )
        sv = np.linalg.svd(jac, compute_uv=False)
        scales.extend(sv.tolist())
    return np.array(scales)


@dataclass
class SanityReport:
    ok: bool
    reasons: list[str]
    scale_min: float = 0.0
    scale_max: float = 0.0

    def __bool__(self) -> bool:  # 便于 if report: 使用
        return self.ok


def check_homography_sanity(
    H: np.ndarray, w: int, h: int, cfg: Config
) -> SanityReport:
    """检查单应是否代表“合理的相机位姿关系”，拦截失控变换。"""
    reasons: list[str] = []
    H = H.astype(np.float64)
    if not np.isfinite(H).all():
        return SanityReport(False, ["变换包含非有限数值（NaN/Inf）"])
    if abs(H[2, 2]) < 1e-8:
        return SanityReport(False, ["变换奇异（H[2,2]≈0）"])
    Hn = H / H[2, 2]

    if abs(Hn[2, 0]) > cfg.max_persp or abs(Hn[2, 1]) > cfg.max_persp:
        reasons.append(
            f"透视项过大 h31={Hn[2, 0]:.2e}, h32={Hn[2, 1]:.2e}，"
            "疑似退化/失控投影"
        )
    if abs(Hn[0, 1]) > cfg.skew_max or abs(Hn[1, 0]) > cfg.skew_max:
        reasons.append("剪切项异常，映射严重倾斜")

    scales = _jacobian_scales(H, w, h)
    smin, smax = float(scales.min()), float(scales.max())
    if smin < cfg.scale_min or smax > cfg.scale_max:
        reasons.append(
            f"局部尺度越界（{smin:.3f} ~ {smax:.3f}，"
            f"允许 {cfg.scale_min} ~ {cfg.scale_max}）"
        )
    if smax / max(smin, 1e-9) > 20.0:
        reasons.append("各向异性比例异常，单应明显失真")
    return SanityReport(not reasons, reasons, smin, smax)


def estimate_overlap_frac(
    H: np.ndarray, size_i: tuple[int, int], size_j: tuple[int, int]
) -> float:
    """把 i 的有效区域映射进 j，返回交集占较小照片面积的比例。"""
    wi, hi = size_i
    wj, hj = size_j
    mask_i = np.ones((hi, wi), dtype=np.uint8)
    warped = cv2.warpPerspective(mask_i, H, (wj, hj))
    inter = float(np.count_nonzero(warped))
    return inter / max(min(wi * hi, wj * hj), 1)


def homography_from_correspondences(
    src: np.ndarray,
    dst: np.ndarray,
    cfg: Config,
    ransac: bool = True,
) -> tuple[np.ndarray | None, np.ndarray]:
    """由对应点求单应。返回 (H, inlier_mask)；失败返回 (None, 空mask)。"""
    src = np.asarray(src, dtype=np.float64).reshape(-1, 2)
    dst = np.asarray(dst, dtype=np.float64).reshape(-1, 2)
    n = len(src)
    if n < 4:
        return None, np.zeros(n, dtype=np.uint8)
    if ransac and n >= 8:
        H, mask = cv2.findHomography(
            src, dst, cv2.RANSAC,
            ransacReprojThreshold=cfg.max_reproj_px,
            maxIters=4000, confidence=0.995,
        )
        if H is None:
            return None, np.zeros(n, dtype=np.uint8)
        mask = (mask.ravel() > 0)
    else:
        H, _ = cv2.findHomography(src, dst, 0)
        if H is None:
            return None, np.zeros(n, dtype=np.uint8)
        mask = np.ones(n, dtype=bool)
    return H.astype(np.float64), mask.astype(np.uint8)


def reprojection_rmse(
    H: np.ndarray, src: np.ndarray, dst: np.ndarray
) -> float:
    if len(src) == 0:
        return float("inf")
    pred = warp_points(H, src)
    return float(np.sqrt(np.mean(np.sum((pred - dst) ** 2, axis=1))))
