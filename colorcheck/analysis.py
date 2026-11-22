"""图像级分析: 透明合成、模拟帧、按类别的配对读数与冲突热点。

关键约定: 带半透明边缘的像素一律先按 alpha 合成到背景上,
再用合成后的实际显示颜色参与色差/反差计算——问题点因此能定位到
具体的边缘像素, 而不只是看源 RGBA 的名义色。
"""
from __future__ import annotations

import numpy as np

from . import cvd
from .colorio import (ciede2000, ciede2000_matrix, composite_over,
                      contrast_ratio, rgb_to_hex)

PROTAN = cvd.PROTAN
DEUTAN = cvd.DEUTAN


def composite_image(rgba, bg):
    """RGBA(0-255) 整图合成到纯色背景 bg 上, 返回 RGB float (H,W,3)。"""
    rgba = np.asarray(rgba, dtype=float)
    rgb = rgba[..., :3]
    alpha = rgba[..., 3:4] / 255.0
    bg_arr = np.asarray(bg, dtype=float).reshape(1, 1, 3)
    return rgb * alpha + bg_arr * (1.0 - alpha)


def simulate_frame(rgba, bg, kind: str, severity: float) -> np.ndarray:
    """先合成到背景, 再做色觉模拟。severity=0 时即普通视觉合成结果。"""
    composited = composite_image(rgba, bg)
    if severity <= 0.0:
        return composited
    return cvd.simulate(composited, kind, severity)


def pixel_color(rgba, y: int, x: int, bg) -> dict:
    """读取单个像素: 源 RGBA、合成后的实际显示色 (普通视觉)。"""
    rgba = np.asarray(rgba, dtype=float)
    px = rgba[y, x]
    alpha = px[3] / 255.0
    shown = composite_over(px[:3], alpha, np.asarray(bg, dtype=float))
    return {
        "x": x,
        "y": y,
        "src_rgb": tuple(int(round(v)) for v in px[:3]),
        "alpha": round(float(alpha), 3),
        "shown_rgb": tuple(int(round(v)) for v in shown),
        "shown_hex": rgb_to_hex(shown),
    }


def category_masks(rgba, colors, tolerance: float = 12.0):
    """按参考颜色做 soft 归属, 每个类别一张 0-1 权重图。

    用 CIEDE2000 距离转高斯权重, 抗锯齿/轻微抖动像素也能被部分纳入;
    完全透明像素权重恒为 0。
    """
    rgba = np.asarray(rgba, dtype=float)
    h, w = rgba.shape[:2]
    alpha = rgba[..., 3] / 255.0
    flat = rgba[..., :3].reshape(-1, 3)
    ref = np.asarray(colors, dtype=float).reshape(-1, 3)
    dist = ciede2000_matrix(flat, ref).reshape(h, w, len(ref))
    # 硬阈值: 距离超过 2.5 倍 tolerance 的像素权重归零,
    # 避免透明区 RGB=0 或其它类别边缘产生微弱误归属
    weights = np.exp(-0.5 * (dist / max(tolerance, 1e-6)) ** 2)
    weights[dist > tolerance * 2.5] = 0.0
    weights *= alpha[..., None]
    # 硬决策: 每个像素只归属权重最高的类别, 防止内部暗点等细节
    # 同时落入两类后出现 "像素与自身色差为 0" 的假读数
    if len(ref) > 1:
        winner = weights.argmax(axis=-1)
        keep = np.zeros_like(weights)
        active = weights.max(axis=-1) > 0.0
        keep[active, winner[active]] = weights[active, winner[active]]
        weights = keep
    return weights  # (H, W, K)


def _weighted_mean_color(frame, weight):
    wsum = float(weight.sum())
    if wsum <= 1e-9:
        return None, 0.0
    mean = (frame * weight[..., None]).sum(axis=(0, 1)) / wsum
    return mean, wsum


def pair_pixel_metrics(rgba, color_a, color_b, bg, kind: str,
                       severity: float, tolerance: float = 12.0):
    """一对类别在图像上的读数 (边缘像素按合成色参与)。

    返回:
      de_mean   两类别实际显示色的平均色差
      de_min    像素两两最小色差 (最容易混淆的一对边缘像素), 分块计算控内存
      contrast_a/b  各类别合成色与背景的 WCAG 亮度反差
      coverage_a/b  权重覆盖像素数 (0 表示图中没有该颜色)
    """
    frame = simulate_frame(rgba, bg, kind, severity)
    weights = category_masks(rgba, (color_a, color_b), tolerance)
    wa, wb = weights[..., 0], weights[..., 1]

    mean_a, cov_a = _weighted_mean_color(frame, wa)
    mean_b, cov_b = _weighted_mean_color(frame, wb)
    if mean_a is None or mean_b is None:
        return {"available": False, "coverage_a": cov_a, "coverage_b": cov_b}

    de_mean = float(ciede2000(mean_a, mean_b))

    # 分块最小色差, 避免整图外积爆内存
    idxa = np.argwhere(wa > 0.05)
    idxb = np.argwhere(wb > 0.05)
    de_min = float("inf")
    block = 2048
    for i in range(0, len(idxa), block):
        pa = frame[tuple(idxa[i:i + block].T)]
        for j in range(0, len(idxb), block):
            pb = frame[tuple(idxb[j:j + block].T)]
            de_min = min(de_min, float(np.min(ciede2000_matrix(pa, pb))))
    if not np.isfinite(de_min):
        de_min = de_mean

    sim_bg = cvd.simulate(np.asarray(bg, dtype=float), kind, severity) \
        if severity > 0 else np.asarray(bg, dtype=float)
    ca = float(contrast_ratio(mean_a, sim_bg))
    cb = float(contrast_ratio(mean_b, sim_bg))
    return {
        "available": True,
        "de_mean": de_mean,
        "de_min": de_min,
        "contrast_a": ca,
        "contrast_b": cb,
        "coverage_a": cov_a,
        "coverage_b": cov_b,
        "mean_a": tuple(int(round(v)) for v in mean_a),
        "mean_b": tuple(int(round(v)) for v in mean_b),
    }


def conflict_hotspots(rgba, color_a, color_b, bg, kind: str,
                      severity: float, threshold: float = 10.0,
                      tolerance: float = 12.0):
    """生成热点图: 两个类别像素间色差低于 threshold 的位置标 1。

    返回 (mask(H,W) bool, fraction, min_deltae)。
    """
    frame = simulate_frame(rgba, bg, kind, severity)
    weights = category_masks(rgba, (color_a, color_b), tolerance)
    wa, wb = weights[..., 0], weights[..., 1]
    idxa = np.argwhere(wa > 0.05)
    idxb = np.argwhere(wb > 0.05)
    hot = np.zeros(frame.shape[:2], dtype=bool)
    overall_min = float("inf")
    if len(idxa) and len(idxb):
        block = 2048
        for i in range(0, len(idxa), block):
            pa = frame[tuple(idxa[i:i + block].T)]
            for j in range(0, len(idxb), block):
                pb = frame[tuple(idxb[j:j + block].T)]
                m = ciede2000_matrix(pa, pb)
                overall_min = min(overall_min, float(np.min(m)))
                hit_a = np.any(m < threshold, axis=1)
                hit_b = np.any(m < threshold, axis=0)
                pts_a = idxa[i:i + block][hit_a]
                pts_b = idxb[j:j + block][hit_b]
                if len(pts_a):
                    hot[tuple(pts_a.T)] = True
                if len(pts_b):
                    hot[tuple(pts_b.T)] = True
    covered = (wa > 0.05) | (wb > 0.05)
    fraction = float(hot.sum()) / max(int(covered.sum()), 1)
    if not np.isfinite(overall_min):
        overall_min = 0.0
    return hot, fraction, overall_min
