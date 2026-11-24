"""示波分析：亮度波形、RGB 三通道分量、范围/压边界统计、点击反查。

所有波形 x 轴都是**全图列坐标**（0..W-1 映射到输出宽度），
框选 ROI 只决定哪些像素参与统计，不改变坐标映射。
"""
from __future__ import annotations

import numpy as np

from .colorutil import RANGE_LIMITS, yuv_to_rgb_u8


def compute_waveform(plane: np.ndarray, roi, out_w: int) -> np.ndarray:
    """单平面列波形。返回 (256, out_w) float32，行 0 = 电平 0。

    roi = (x0, y0, x1, y1) 全图坐标，右下开区间；None 表示全图。
    """
    h, w = plane.shape
    if roi is None:
        x0, y0, x1, y1 = 0, 0, w, h
    else:
        x0, y0, x1, y1 = roi
        x0, x1 = max(0, x0), min(w, x1)
        y0, y1 = max(0, y0), min(h, y1)
    wf = np.zeros((256, out_w), np.float32)
    if x1 <= x0 or y1 <= y0:
        return wf
    sub = plane[y0:y1, x0:x1]
    cols = (np.arange(x0, x1, dtype=np.int64) * out_w) // w  # 全图列 -> 输出列
    col_map = np.tile(cols[None, :], (y1 - y0, 1)).ravel()
    np.add.at(wf, (sub.ravel(), col_map), 1.0)
    return wf


def compute_parade(R, G, B, roi, out_w: int):
    """RGB 三通道各自的列波形，返回 (wr, wg, wb)，各 (256, out_w)。"""
    return (
        compute_waveform(R, roi, out_w),
        compute_waveform(G, roi, out_w),
        compute_waveform(B, roi, out_w),
    )


def range_report(Y, R, G, B, rng: str) -> dict:
    """当前范围解释下的关键计数：哪些亮部/暗部被压在边界。"""
    lo, hi = RANGE_LIMITS[rng]
    total = int(Y.size)
    rep = {
        "range": rng,
        "range_lo": lo,
        "range_hi": hi,
        "total_px": total,
        "y_min": int(Y.min()),
        "y_max": int(Y.max()),
        "y_mean": round(float(Y.mean()), 2),
        # 暗部/亮部压在边界（含 ±1 容差带）
        "shadow_crush_px": int((Y <= lo + 1).sum()),
        "highlight_crush_px": int((Y >= hi - 1).sum()),
        # 越出合法范围的码值（有限范围时尤其值得看）
        "below_legal_px": int((Y < lo).sum()),
        "above_legal_px": int((Y > hi).sum()),
    }
    for name, ch in (("r", R), ("g", G), ("b", B)):
        rep[f"{name}_min"] = int(ch.min())
        rep[f"{name}_max"] = int(ch.max())
        rep[f"{name}_clip_lo_px"] = int((ch <= 0).sum())
        rep[f"{name}_clip_hi_px"] = int((ch >= 255).sum())
    for k in ("shadow_crush_px", "highlight_crush_px",
              "below_legal_px", "above_legal_px",
              "r_clip_lo_px", "r_clip_hi_px",
              "g_clip_lo_px", "g_clip_hi_px",
              "b_clip_lo_px", "b_clip_hi_px"):
        rep[k.replace("_px", "_pct")] = round(100.0 * rep[k] / total, 3)
    return rep


def pixels_at(Y: np.ndarray, col: int, level: int, roi=None,
              col_tol: int = 3, level_tol: int = 3) -> np.ndarray:
    """点击示波图后反查：全图列 col(±tol)、电平 level(±tol) 的像素掩码。

    若给了 roi，只在 roi 内找（与示波统计口径一致），掩码仍是全图尺寸。
    """
    h, w = Y.shape
    x0, x1 = max(0, col - col_tol), min(w, col + col_tol + 1)
    y0, y1 = 0, h
    if roi is not None:
        rx0, ry0, rx1, ry1 = roi
        x0, x1 = max(x0, rx0), min(x1, rx1)
        y0, y1 = max(y0, ry0), min(y1, ry1)
    mask = np.zeros((h, w), bool)
    if x1 <= x0 or y1 <= y0:
        return mask
    band = np.abs(Y[y0:y1, x0:x1].astype(np.int16) - level) <= level_tol
    mask[y0:y1, x0:x1] = band
    return mask


def analyze_frame(Y, U, V, rng: str, roi, out_w: int) -> dict:
    """一帧的完整分析：显示用 RGB、亮度波形、RGB 分量、范围报告。"""
    R, G, B = yuv_to_rgb_u8(Y, U, V, rng)
    return {
        "rgb": (R, G, B),
        "waveform": compute_waveform(Y, roi, out_w),
        "parade": compute_parade(R, G, B, roi, out_w),
        "report": range_report(Y, R, G, B, rng),
    }
