"""YUV<->RGB 转换与范围（有限/全范围）定义。

所有分析都在 8bit 整数码值域进行：
- 有限范围 (limited / tv / mpeg): Y ∈ [16,235], C ∈ [16,240]
- 全范围   (full / pc / jpeg)   : Y ∈ [0,255],  C ∈ [0,255]
"""
from __future__ import annotations

import numpy as np

# (lo, hi) 合法亮度边界
RANGE_LIMITS = {
    "tv": (16, 235),
    "pc": (0, 255),
}

RANGE_LABELS = {
    "tv": "有限范围 (16-235)",
    "pc": "全范围 (0-255)",
}

# BT.709 系数（普通动态范围短片默认）
_KR, _KG, _KB = 0.2126, 0.7152, 0.0722


def yuv_to_rgb_u8(Y: np.ndarray, U: np.ndarray, V: np.ndarray, rng: str = "tv"):
    """yuv444p uint8 平面 -> (R,G,B) uint8。按 rng 解释 YUV 码值。"""
    y = Y.astype(np.float32)
    u = U.astype(np.float32) - 128.0
    v = V.astype(np.float32) - 128.0
    if rng == "tv":
        y = (y - 16.0) / 219.0
        u /= 224.0
        v /= 224.0
    else:
        y = y / 255.0
        u /= 255.0
        v /= 255.0
    r = y + 2.0 * (1.0 - _KR) * v
    b = y + 2.0 * (1.0 - _KB) * u
    g = (y - _KR * r - _KB * b) / _KG
    out = []
    for ch in (r, g, b):
        out.append(np.clip(ch * 255.0 + 0.5, 0, 255).astype(np.uint8))
    return tuple(out)


def rgb_to_yuv_u8(R: np.ndarray, G: np.ndarray, B: np.ndarray, rng: str = "tv"):
    """(R,G,B) uint8 -> yuv444p uint8 平面，按 rng 编码。用于内置样片。"""
    r = R.astype(np.float32) / 255.0
    g = G.astype(np.float32) / 255.0
    b = B.astype(np.float32) / 255.0
    y = _KR * r + _KG * g + _KB * b
    u = (b - y) / (2.0 * (1.0 - _KB))
    v = (r - y) / (2.0 * (1.0 - _KR))
    if rng == "tv":
        Y = y * 219.0 + 16.0
        U = u * 224.0 + 128.0
        V = v * 224.0 + 128.0
    else:
        Y = y * 255.0
        U = u * 255.0 + 128.0
        V = v * 255.0 + 128.0
    return (
        np.clip(Y + 0.5, 0, 255).astype(np.uint8),
        np.clip(U + 0.5, 0, 255).astype(np.uint8),
        np.clip(V + 0.5, 0, 255).astype(np.uint8),
    )
