"""Colour maps and palette shared by the canvases and the exporters.

Values are OKLab-agnostic sRGB steps from the validated sequential blue ramp:
low distance = light, high distance = dark. One hue only, so the colour never
pretends to be a category.
"""
from __future__ import annotations

import numpy as np

# Sequential blue ramp, 100 -> 700.
BLUE_RAMP = np.array(
    [
        (0xCD, 0xE2, 0xFB),
        (0xB7, 0xD3, 0xF6),
        (0x9E, 0xC5, 0xF4),
        (0x86, 0xB6, 0xEF),
        (0x6D, 0xA7, 0xEC),
        (0x55, 0x98, 0xE7),
        (0x39, 0x87, 0xE5),
        (0x2A, 0x78, 0xD6),
        (0x25, 0x6A, 0xBF),
        (0x1C, 0x5C, 0xAB),
        (0x18, 0x4F, 0x95),
        (0x10, 0x42, 0x81),
        (0x0D, 0x36, 0x6B),
    ],
    dtype=np.uint8,
)

# Geometry palette. Fill categories use the validated categorical slots; the
# boundary hues are darker steps of the same families so the outline reads on
# top of its own fill.
A_FILL = (0x2A, 0x78, 0xD6, 190)
B_FILL = (0xEB, 0x68, 0x34, 190)
OVERLAP_FILL = (0x1B, 0xAF, 0x7A, 205)
# Lighter tints used when only one mask is visible: the exclusive part keeps
# the saturated fill, the shared part is shown as a lighter shade of the same
# mask so "whole mask" reads without inventing a second category.
A_ONLY_VIEW_OVERLAP = (0x9E, 0xC5, 0xF4, 205)
B_ONLY_VIEW_OVERLAP = (0xF5, 0xBE, 0xA6, 205)
A_LINE = "#184f95"
B_LINE = "#a8431c"
TARGET_LINE = "#898781"
TARGET_FILL = (0x52, 0x51, 0x4E, 255)
SURFACE = "#fcfcfb"
INK = "#0b0b0b"
INK_2 = "#52514e"
MUTED = "#898781"
GRID = "#e1e0d9"
WARNING = "#d03b3b"


def ramp_lut(n: int = 256) -> np.ndarray:
    """Interpolate the ramp to an ``n`` x 3 uint8 lookup table."""
    src = np.linspace(0.0, 1.0, len(BLUE_RAMP))
    dst = np.linspace(0.0, 1.0, int(n))
    out = np.empty((int(n), 3), dtype=np.float64)
    for ch in range(3):
        out[:, ch] = np.interp(dst, src, BLUE_RAMP[:, ch].astype(np.float64))
    return np.clip(np.rint(out), 0, 255).astype(np.uint8)


_LUT = ramp_lut(256)


def heat_rgba(values: np.ndarray, vmax: float, alpha: int = 225) -> np.ndarray:
    """Map a distance field to an RGBA image.

    ``inf`` / NaN (no target boundary) is fully transparent, never painted as
    "very far".
    """
    h, w = values.shape
    out = np.zeros((h, w, 4), dtype=np.uint8)
    finite = np.isfinite(values)
    if not finite.any():
        return out
    vmax = float(vmax) if np.isfinite(vmax) and vmax > 0 else 1.0
    safe = np.where(finite, values, 0.0)
    scaled = np.clip(safe / vmax, 0.0, 1.0)
    idx = np.clip(np.rint(scaled * 255).astype(np.int32), 0, 255)
    out[..., :3] = _LUT[idx]
    out[..., 3] = np.where(finite, alpha, 0).astype(np.uint8)
    return out


def lut() -> np.ndarray:
    return _LUT


def composite_rgba(
    shape: tuple[int, int],
    only_a: np.ndarray,
    overlap: np.ndarray,
    only_b: np.ndarray,
    show_a: bool = True,
    show_overlap: bool = True,
    show_b: bool = True,
) -> np.ndarray:
    """Category-coloured RGBA of the two masks (no basemap)."""
    out = np.zeros((*shape, 4), dtype=np.uint8)
    if show_a and only_a.any():
        out[only_a] = A_FILL
    if show_b and only_b.any():
        out[only_b] = B_FILL
    if show_overlap and overlap.any():
        out[overlap] = OVERLAP_FILL
    return out


def silhouette_rgba(shape: tuple[int, int], a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Neutral grey silhouette used beneath a heat map for orientation."""
    out = np.zeros((*shape, 4), dtype=np.uint8)
    both = a & b
    only_a = a & ~b
    only_b = b & ~a
    out[only_a] = (0xE1, 0xE0, 0xD9, 235)
    out[only_b] = (0xCF, 0xCE, 0xC6, 235)
    out[both] = (0xF0, 0xEF, 0xEC, 235)
    return out
