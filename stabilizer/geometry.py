"""路径平滑、稳定变换、有效区域与安全裁切计算。

坐标约定:
- motion.affines[i] 把帧 i 的点映射到帧 i-1 坐标系。
- 累积矩阵 M_i 把帧 i 的点映射到该镜头参考帧(首帧)坐标系。
- 平滑后累积矩阵 M_s 与 M 同坐标系, 校正变换 C = M_s @ inv(M)
  把原始帧坐标映射到稳定后坐标, 再以画面中心做统一缩放 S 消除黑边。
所有平滑均按镜头独立进行, 绝不跨越硬切。
"""
from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np
from scipy.ndimage import gaussian_filter1d

# 有效画幅过小告警阈值 (面积占比)
RETAIN_WARN_RATIO = 0.5


def _aug(m23: np.ndarray) -> np.ndarray:
    m = np.eye(3, dtype=np.float64)
    m[:2, :] = m23
    return m


def cumulative_matrices(affines: np.ndarray, shot_starts: list[int],
                        frame_count: int) -> np.ndarray:
    """每个镜头从单位阵重新累积, 切点后不继承上一镜头运动。

    affines[i] 把帧 i 的点映射到帧 i-1 (经光流+RANSAC 实证),
    故 M_i = A_1 @ A_2 ... @ A_i (右乘), M_i 把帧 i 的点映射到镜头参考帧。
    """
    M = np.zeros((frame_count, 3, 3), dtype=np.float64)
    bounds = shot_starts + [frame_count]
    for s, e in zip(bounds[:-1], bounds[1:]):
        acc = np.eye(3, dtype=np.float64)
        M[s] = acc
        for i in range(s + 1, e):
            acc = acc @ _aug(affines[i])
            M[i] = acc
    return M


def decompose(M: np.ndarray) -> dict[str, np.ndarray]:
    """累积相似变换 -> 平移(px)、旋转(度)、缩放 三组逐帧序列。"""
    tx = M[:, 0, 2]
    ty = M[:, 1, 2]
    angle = np.degrees(np.arctan2(M[:, 1, 0], M[:, 0, 0]))
    scale = np.hypot(M[:, 0, 0], M[:, 0, 1])
    return {"tx": tx, "ty": ty, "angle": angle, "scale": scale}


def _reconstruct(tx: float, ty: float, angle_deg: float,
                 scale: float) -> np.ndarray:
    a = np.radians(angle_deg)
    c, s = np.cos(a), np.sin(a)
    return np.array([
        [scale * c, -scale * s, tx],
        [scale * s, scale * c, ty],
        [0.0, 0.0, 1.0],
    ])


def _robust_smooth(seg: np.ndarray, sigma: float) -> np.ndarray:
    """趋势保持型自适应平滑。

    以高斯低通为稳定基准, 再判断是否存在可信的线性有意运镜:
    - 用逐帧增量中位数得到对离群抖动不敏感的斜率;
    - 与高斯输出自身的线性斜率比较, 两者一致才认定为真实趋势
      (避免把噪声偏置当成运镜, 例如无旋转镜头被凭空制造旋转);
    - 按显著性权重把被高斯核衰减的趋势补回。
    缓慢有意运镜得以保留, 高频抖动被压制, 画面不会被整段定格。
    """
    n = len(seg)
    if n <= 3:
        return seg.astype(np.float64).copy()
    t = np.arange(n, dtype=np.float64)
    gauss = gaussian_filter1d(seg, sigma=sigma, mode="nearest")
    g_coef = np.polyfit(t, gauss, 1)
    g_slope = float(g_coef[0])
    g_trend = np.polyval(g_coef, t)
    med_slope = float(np.median(np.diff(seg)))

    # 两个独立斜率估计的一致性 (0~1)
    denom = abs(med_slope) + abs(g_slope) + 1e-12
    agreement = 1.0 - min(1.0, abs(med_slope - g_slope) / denom)
    # 趋势相对高斯残余抖动的显著性 (0~1)
    residual_rms = float(np.sqrt(np.mean((gauss - g_trend) ** 2)))
    drift = abs(med_slope) * n
    significance = drift / (drift + 3.0 * residual_rms + 1e-12)
    weight = float(np.clip(agreement * significance, 0.0, 1.0))

    median_trend = med_slope * t
    return gauss + weight * (median_trend - g_trend)


def smooth_matrices(M: np.ndarray, shot_starts: list[int], frame_count: int,
                    sigma: float) -> np.ndarray:
    """分镜头平滑。缓动(低频)保留, 抖动(高频)被压制, 不会整段定格。"""
    raw = decompose(M)
    out = np.zeros_like(M)
    bounds = shot_starts + [frame_count]
    for s, e in zip(bounds[:-1], bounds[1:]):
        length = e - s
        # 短镜头收窄核宽, 避免把短镜头平均成静止画面
        sigma_eff = min(float(sigma), max(1.0, length / 4.0))
        sm = {key: _robust_smooth(raw[key][s:e], sigma_eff)
              for key in ("tx", "ty", "angle")}
        # 缩放不做逐帧跟随, 取镜头中位数, 防止呼吸式缩放
        sm_scale = np.full(length, np.median(raw["scale"][s:e]))
        for k in range(length):
            out[s + k] = _reconstruct(
                sm["tx"][k], sm["ty"][k], sm["angle"][k], sm_scale[k],
            )
    return out


@dataclass
class Geometry:
    corrections: np.ndarray       # (N,2,3) 正向 原帧->稳定帧
    full_warps: np.ndarray        # (N,2,3) 正向 原帧->输出帧(含缩放), 配 WARP_INVERSE_MAP
    valid_quads: np.ndarray       # (N,4,2) 稳定后(缩放前)有效画面四边形
    inner_rects: np.ndarray       # (N,4) 居中内接矩形 x1,y1,x2,y2 (缩放前坐标)
    shot_zoom: np.ndarray         # (K,) 每镜头统一缩放
    shot_safe_rects: np.ndarray   # (K,4) 输出帧坐标系下的安全裁切框
    retained_ratio: np.ndarray    # (K,) 安全框占整帧面积比
    sample_boxes: np.ndarray      # (N,4,2) 输出帧在源帧中的实际采样四边形
    params_raw: dict
    params_smooth: dict


def _largest_centered_rect(quad: np.ndarray, width: int, height: int
                           ) -> tuple[float, float]:
    """四边形内、以画面中心为中心、与输出同长宽比的最大轴对齐矩形。

    返回相对画面中心的半宽半高。
    """
    poly = np.ascontiguousarray(quad, dtype=np.float32)
    cx, cy = width / 2.0, height / 2.0
    aspect = width / height
    lo, hi = 0.0, min(width, height) / 2.0
    for _ in range(24):
        hy = (lo + hi) / 2.0
        hx = hy * aspect
        corners = [(cx - hx, cy - hy), (cx + hx, cy - hy),
                   (cx + hx, cy + hy), (cx - hx, cy + hy)]
        if all(cv2.pointPolygonTest(poly, (float(x), float(y)), False) >= 0
               for x, y in corners):
            lo = hy
        else:
            hi = hy
    return lo * aspect, lo


def build_geometry(M: np.ndarray, M_smooth: np.ndarray, width: int, height: int,
                   shot_starts: list[int], frame_count: int) -> Geometry:
    cx, cy = width / 2.0, height / 2.0
    corrections = np.zeros((frame_count, 2, 3))
    full_warps = np.zeros((frame_count, 2, 3))
    valid_quads = np.zeros((frame_count, 4, 2))
    inner_rects = np.zeros((frame_count, 4))
    sample_boxes = np.zeros((frame_count, 4, 2))
    src_corners = np.array([
        [0.0, 0.0], [width, 0.0], [width, height], [0.0, height],
    ])
    out_corners = src_corners.copy()

    # 先算每帧校正与内接矩形
    raw_inner = np.zeros((frame_count, 2))  # 半宽, 半高
    for i in range(frame_count):
        C = M_smooth[i] @ np.linalg.inv(M[i])
        corrections[i] = C[:2, :]
        q = cv2.perspectiveTransform(
            src_corners.reshape(-1, 1, 2), C).reshape(-1, 2)
        valid_quads[i] = q
        hx, hy = _largest_centered_rect(q, width, height)
        raw_inner[i] = (hx, hy)
        inner_rects[i] = (cx - hx, cy - hy, cx + hx, cy + hy)

    # 每镜头统一缩放: 取镜头内最紧一帧, 保证所有帧不露黑边
    bounds = shot_starts + [frame_count]
    n_shots = len(shot_starts)
    shot_zoom = np.ones(n_shots)
    shot_safe_rects = np.zeros((n_shots, 4))
    retained_ratio = np.ones(n_shots)
    for k, (s, e) in enumerate(zip(bounds[:-1], bounds[1:])):
        hx = raw_inner[s:e, 0].min()
        hy = raw_inner[s:e, 1].min()
        S = max(width / (2 * hx), height / (2 * hy))
        shot_zoom[k] = S
        # 输出帧坐标系中的安全裁切框 (居中, 至少一条边贴边)
        shot_safe_rects[k] = (
            cx - S * hx, cy - S * hy, cx + S * hx, cy + S * hy,
        )
        retained_ratio[k] = (4 * hx * hy) / (width * height)

    zoom_of_frame = np.ones(frame_count)
    for k, (s, e) in enumerate(zip(bounds[:-1], bounds[1:])):
        zoom_of_frame[s:e] = shot_zoom[k]

    for i in range(frame_count):
        S = zoom_of_frame[i]
        Z = np.array([
            [S, 0.0, cx * (1 - S)],
            [0.0, S, cy * (1 - S)],
            [0.0, 0.0, 1.0],
        ])
        R = Z @ _aug(corrections[i])
        full_warps[i] = R[:2, :]
        # 输出帧四角反投影回源帧 = 实际采样区域
        Rinv = np.linalg.inv(R)
        sample_boxes[i] = cv2.perspectiveTransform(
            out_corners.reshape(-1, 1, 2), Rinv).reshape(-1, 2)

    return Geometry(
        corrections=corrections,
        full_warps=full_warps,
        valid_quads=valid_quads,
        inner_rects=inner_rects,
        shot_zoom=shot_zoom,
        shot_safe_rects=shot_safe_rects,
        retained_ratio=retained_ratio,
        sample_boxes=sample_boxes,
        params_raw=decompose(M),
        params_smooth=decompose(M_smooth),
    )


def analyze(affines: np.ndarray, shot_starts: list[int], width: int, height: int,
            frame_count: int, sigma: float) -> tuple[np.ndarray, Geometry]:
    """一次完整的平滑+几何计算, 供预览与导出共用, 保证两者严格一致。"""
    M = cumulative_matrices(affines, shot_starts, frame_count)
    M_s = smooth_matrices(M, shot_starts, frame_count, sigma)
    geo = build_geometry(M, M_s, width, height, shot_starts, frame_count)
    return M, geo
