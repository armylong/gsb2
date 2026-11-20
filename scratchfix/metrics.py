"""误差与结构指标."""

from __future__ import annotations

import numpy as np


def mask_errors(result: np.ndarray, reference: np.ndarray, mask: np.ndarray) -> dict:
    """遮罩内 MAE / RMSE / 最大绝对误差 (0-255 尺度)."""
    m = mask > 0
    if not m.any():
        return {"mae": 0.0, "rmse": 0.0, "max": 0.0, "pixels": 0}
    d = result[m].astype(np.float64) - reference[m].astype(np.float64)
    return {
        "mae": float(np.abs(d).mean()),
        "rmse": float(np.sqrt((d**2).mean())),
        "max": float(np.abs(d).max()),
        "pixels": int(m.sum()),
    }


def outside_unchanged(before: np.ndarray, after: np.ndarray, mask: np.ndarray) -> tuple[bool, int]:
    """遮罩外像素是否逐位不变. 返回 (是否全部不变, 被改动的像素数)."""
    m = mask > 0
    diff = np.any(before != after, axis=-1) if before.ndim == 3 else before != after
    changed = int((diff & ~m).sum())
    return changed == 0, changed


def line_continuity(result: np.ndarray, reference: np.ndarray,
                    line_mask: np.ndarray, damage_mask: np.ndarray) -> dict:
    """细线结构连续性: 只看"细线 x 损伤区"交叉像素的误差.

    细线跨过明暗边缘时, 这些像素最难修, 该指标直接反映结构是否接上.
    """
    m = (line_mask > 0) & (damage_mask > 0)
    if not m.any():
        return {"mae": 0.0, "rmse": 0.0, "pixels": 0}
    d = result[m].astype(np.float64) - reference[m].astype(np.float64)
    return {
        "mae": float(np.abs(d).mean()),
        "rmse": float(np.sqrt((d**2).mean())),
        "pixels": int(m.sum()),
    }
