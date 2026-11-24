"""把一帧的原始平面按指定色度解释重建成 RGB。"""
from __future__ import annotations

import numpy as np

from .chroma import ChromaSite, upsample_chroma
from .color import yuv_to_rgb
from .formats import PixelFormat


def reconstruct_rgb(
    y: np.ndarray,
    u: np.ndarray,
    v: np.ndarray,
    pf: PixelFormat,
    site: ChromaSite,
    matrix: str,
    full_range: bool,
) -> np.ndarray:
    """返回 uint8 RGB(H,W,3)。4:4:4 忽略 site。"""
    h, w = y.shape
    if pf.h_sub == 1 and pf.v_sub == 1:
        u_up = u.astype(np.float64)
        v_up = v.astype(np.float64)
    else:
        u_up = upsample_chroma(u, site, pf.h_sub, pf.v_sub, h, w)
        v_up = upsample_chroma(v, site, pf.h_sub, pf.v_sub, h, w)
    return yuv_to_rgb(y.astype(np.float64), u_up, v_up, matrix, full_range)
