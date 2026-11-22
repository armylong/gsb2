"""调色方案应用: 只改取样范围内的像素, 范围外逐字节保持原样。

对每个像素:
  w_k = 类别 k 的 soft 归属权重 (CIEDE2000 高斯权重 * alpha)
  W   = sum_k w_k
若 W 为 0 -> 该像素不在任何取样范围, RGB/alpha 原样保留;
否则按归一化权重把原始颜色向各目标色混合, 抗锯齿边缘因此平滑过渡,
不会出现硬边色晕。
"""
from __future__ import annotations

import numpy as np

from .analysis import category_masks


def recolor_image(rgba, source_colors, target_colors,
                  tolerance: float = 12.0, strength: float = 1.0):
    """返回调色后的 RGBA 副本 (uint8)。

    source_colors / target_colors: 等长的 RGB 序列 (只给可改类别)。
    strength: 0=原图 1=完全采用目标色, 便于做过渡比较。
    """
    rgba = np.asarray(rgba, dtype=np.uint8)
    out = rgba.copy()
    src = np.asarray(source_colors, dtype=float).reshape(-1, 3)
    dst = np.asarray(target_colors, dtype=float).reshape(-1, 3)
    if len(src) != len(dst) or len(src) == 0:
        raise ValueError("源颜色与目标颜色必须等长且非空")

    weights = category_masks(rgba, src, tolerance)  # (H,W,K)
    total = weights.sum(axis=-1)                     # (H,W)
    inside = total > 1e-6
    if not inside.any():
        return out

    rgb = rgba[..., :3].astype(float)
    norm = weights[inside] / total[inside][..., None]
    blended = norm @ dst
    original = rgb[inside]
    rgb[inside] = original * (1.0 - strength) + blended * strength
    out[..., :3] = np.clip(np.round(rgb), 0, 255).astype(np.uint8)
    # alpha 通道从不修改, 取样范围外像素完全不变
    return out


def affected_mask(rgba, source_colors, tolerance: float = 12.0):
    """布尔图: 哪些像素会受到调色方案影响 (供 UI 高亮范围)。"""
    weights = category_masks(rgba, source_colors, tolerance)
    return weights.sum(axis=-1) > 1e-6
