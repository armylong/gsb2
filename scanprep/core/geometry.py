"""倾角估计与整页旋转。

约定:
- 角度单位为度, 正值表示将图像逆时针旋转 (与 cv2.getRotationMatrix2D 一致)。
- estimate_skew 返回的是 *校正角*: 把它传给 rotate_image 即可把页面转正。
- 旋转总是作用于原始输入, 绝不在上一次旋转结果上继续旋转 (避免累积模糊)。
"""

from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

# 状态码
STATUS_OK = "ok"                    # 估计可信
STATUS_BLANK = "blank"              # 页面近乎空白, 无法判断
STATUS_AMBIGUOUS = "ambiguous"      # 存在相互竞争的多个方向
STATUS_LOW_CONTRAST = "low_contrast"  # 有墨迹但方向性太弱

MAX_ABS_ANGLE = 10.0                # 需求限定: 整体倾斜在 ±10° 内


@dataclass
class SkewEstimate:
    angle: float                    # 校正角 (度), 仅在 status == STATUS_OK 时可信
    confidence: float               # 0..1
    status: str
    message: str
    ink_fraction: float = 0.0
    angles: np.ndarray | None = None   # 扫描的角度网格 (供界面画曲线/调试)
    scores: np.ndarray | None = None   # 各角度得分


def _ink_points(gray: np.ndarray, max_side: int = 900, max_points: int = 80000):
    """提取墨迹点集 (降采样后), 返回 (ys, xs, ink_fraction)。"""
    h, w = gray.shape
    scale = min(1.0, max_side / max(h, w))
    if scale < 1.0:
        small = cv2.resize(gray, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    else:
        small = gray
    # Otsu 阈值取墨迹; 对近乎空白的页面 Otsu 会给出无意义阈值, 因此同时要求
    # 像素明显暗于纸面 (纸面取 90 分位)。
    paper = float(np.percentile(small, 90))
    otsu_t, _ = cv2.threshold(small, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    thr = min(float(otsu_t), paper - 25.0)
    if thr <= 0:
        thr = float(otsu_t)
    ink = small < thr
    frac = float(ink.mean())
    ys, xs = np.nonzero(ink)
    n = ys.size
    if n > max_points:
        idx = np.random.default_rng(0).choice(n, max_points, replace=False)
        ys, xs = ys[idx], xs[idx]
    return ys.astype(np.float64), xs.astype(np.float64), frac


def _profile_scores(ys: np.ndarray, xs: np.ndarray, angles_deg: np.ndarray,
                    bin_width: float = 2.0) -> np.ndarray:
    """对每个候选校正角, 旋转点集后统计水平投影剖面的方差。

    文字行/规则线水平时, 按行投影的直方图最尖锐, 方差最大。
    与 cv2.getRotationMatrix2D 的旋转方向保持一致:
        y' = -x*sin(a) + y*cos(a)
    """
    cy, cx = ys.mean(), xs.mean()
    y0 = ys - cy
    x0 = xs - cx
    rad = np.deg2rad(angles_deg)
    sin = np.sin(rad)[:, None]
    cos = np.cos(rad)[:, None]
    yp = -x0[None, :] * sin + y0[None, :] * cos          # (n_angles, n_points)
    lo = yp.min(axis=1, keepdims=True)
    idx = ((yp - lo) / bin_width).astype(np.int64)
    n_bins = idx.max(axis=1) + 1
    scores = np.empty(len(angles_deg), dtype=np.float64)
    n_pts = ys.size
    for i in range(len(angles_deg)):
        hist = np.bincount(idx[i], minlength=int(n_bins[i])).astype(np.float64)
        # 方差越大说明行结构越清晰; 减去均匀分布的基线使不同角度可比
        scores[i] = hist.var() / n_pts
    return scores


def estimate_skew(gray: np.ndarray, max_angle: float = MAX_ABS_ANGLE) -> SkewEstimate:
    """自动估计校正角。对空白页/方向矛盾页返回不可信状态而不是假结论。"""
    ys, xs, frac = _ink_points(gray)
    if frac < 5e-4 or ys.size < 200:
        return SkewEstimate(0.0, 0.0, STATUS_BLANK,
                            "页面近乎空白, 无法可靠判断倾角", frac)

    # 粗扫 0.2°, 细扫 0.02°, 最后抛物线拟合到亚步长
    coarse = np.arange(-max_angle, max_angle + 1e-9, 0.2)
    s_coarse = _profile_scores(ys, xs, coarse)
    i0 = int(np.argmax(s_coarse))
    a0 = float(coarse[i0])
    fine_lo = max(-max_angle, a0 - 0.3)
    fine_hi = min(max_angle, a0 + 0.3)
    fine = np.arange(fine_lo, fine_hi + 1e-9, 0.02)
    s_fine = _profile_scores(ys, xs, fine)
    i1 = int(np.argmax(s_fine))
    best = float(fine[i1])
    # 抛物线细化
    if 0 < i1 < len(fine) - 1:
        y1, y2, y3 = s_fine[i1 - 1], s_fine[i1], s_fine[i1 + 1]
        denom = (y1 - 2 * y2 + y3)
        if abs(denom) > 1e-12:
            best += float(np.clip(0.5 * (y1 - y3) / denom, -1, 1)) * 0.02

    angles = np.concatenate([coarse, fine])
    scores = np.concatenate([s_coarse, s_fine])
    order = np.argsort(angles)
    angles, scores = angles[order], scores[order]

    med = float(np.median(s_coarse))
    peak = float(s_fine[i1])
    prominence = (peak - med) / (abs(med) + 1e-12)

    # 次峰: 与主峰相距 >=1.5° 的最强局部峰, 用于检测方向矛盾
    mask_far = np.abs(coarse - best) >= 1.5
    second_ratio = 0.0
    if mask_far.any():
        second = float(s_coarse[mask_far].max())
        second_ratio = (second - med) / (peak - med + 1e-12)

    if prominence < 0.02:
        return SkewEstimate(0.0, 0.0, STATUS_LOW_CONTRAST,
                            "墨迹方向性太弱, 无法可靠判断倾角", frac, angles, scores)
    if second_ratio > 0.85:
        conf = float(np.clip(prominence / 0.15, 0, 1) * 0.3)
        return SkewEstimate(best, conf, STATUS_AMBIGUOUS,
                            "检测到多个相互竞争的线条方向, 无法可靠判断倾角",
                            frac, angles, scores)

    conf = float(np.clip(prominence / 0.15, 0.0, 1.0))
    if second_ratio > 0.6:
        conf *= float(np.clip(1.0 - (second_ratio - 0.6) / 0.25, 0.0, 1.0))
    direction = "逆时针" if best > 0 else ("顺时针" if best < 0 else "无需旋转")
    return SkewEstimate(best, conf, STATUS_OK,
                        f"建议{direction}旋转 {abs(best):.2f}°", frac, angles, scores)


def rotation_matrix_expanded(w: int, h: int, angle_deg: float):
    """返回 (2x3 仿射矩阵, (新宽, 新高))。画布扩大到能装下整页旋转结果。"""
    M = cv2.getRotationMatrix2D((w / 2.0, h / 2.0), angle_deg, 1.0)
    cos, sin = abs(M[0, 0]), abs(M[0, 1])
    nw = int(np.ceil(h * sin + w * cos))
    nh = int(np.ceil(h * cos + w * sin))
    M[0, 2] += (nw - w) / 2.0
    M[1, 2] += (nh - h) / 2.0
    return M, (nw, nh)


def rotate_image(img: np.ndarray, angle_deg: float, fill_value: int = 255):
    """整页旋转, 新增区域以 fill_value (纸白) 填充。

    返回 (旋转后图像, 有效区域掩膜 uint8{0,255}, 2x3 仿射矩阵)。
    掩膜用于: 界面绘制有效边界、纸白统计排除填充区。
    """
    h, w = img.shape[:2]
    M, (nw, nh) = rotation_matrix_expanded(w, h, angle_deg)
    rotated = cv2.warpAffine(img, M, (nw, nh), flags=cv2.INTER_CUBIC,
                             borderMode=cv2.BORDER_CONSTANT,
                             borderValue=float(fill_value))
    mask = cv2.warpAffine(np.full((h, w), 255, np.uint8), M, (nw, nh),
                          flags=cv2.INTER_NEAREST, borderMode=cv2.BORDER_CONSTANT,
                          borderValue=0)
    return rotated, mask, M


def map_points(M: np.ndarray, pts: np.ndarray) -> np.ndarray:
    """用 2x3 仿射矩阵把源图上的点 (N,2) 映射到旋转后坐标。"""
    pts = np.asarray(pts, dtype=np.float64)
    ones = np.ones((pts.shape[0], 1))
    hom = np.hstack([pts, ones])
    return hom @ M.T
