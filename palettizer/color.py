"""Colour helpers: sRGB <-> linear RGB and perceptual distance.

The quantiser works in linear-light RGB so that averaging a region gives a
physically sensible colour, and uses CIE L*a*b* distance so that two greens
that look different are not treated as "close" the way Euclidean sRGB would.
"""

from __future__ import annotations

import numpy as np

# sRGB transfer function constants (IEC 61966-2-1).
_LINEAR_CUT = 0.04045
_LINEAR_SLOPE = 12.92
_GAMMA = 2.4
_OFFSET = 0.055


def srgb_to_linear(rgb: np.ndarray) -> np.ndarray:
    """Convert sRGB 0..1 floats to linear-light 0..1 floats."""
    rgb = np.asarray(rgb, dtype=np.float64)
    return np.where(
        rgb <= _LINEAR_CUT,
        rgb / _LINEAR_SLOPE,
        ((rgb + _OFFSET) / (1.0 + _OFFSET)) ** _GAMMA,
    )


def linear_to_srgb(lin: np.ndarray) -> np.ndarray:
    """Convert linear-light 0..1 floats to sRGB 0..1 floats."""
    lin = np.clip(np.asarray(lin, dtype=np.float64), 0.0, 1.0)
    out = np.where(
        lin <= _LINEAR_CUT / _LINEAR_SLOPE,
        lin * _LINEAR_SLOPE,
        (1.0 + _OFFSET) * np.power(lin, 1.0 / _GAMMA) - _OFFSET,
    )
    return np.clip(out, 0.0, 1.0)


def _lab_f(t: np.ndarray) -> np.ndarray:
    # CIE Lab nonlinearity.
    return np.where(t > (6.0 / 29.0) ** 3, np.cbrt(t), t / (3.0 * (6.0 / 29.0) ** 2) + 4.0 / 29.0)


def linear_rgb_to_lab(lin: np.ndarray) -> np.ndarray:
    """Linear RGB (0..1) -> CIE L*a*b* (D65).  Supports arbitrary trailing shape."""
    lin = np.asarray(lin, dtype=np.float64)
    # linear sRGB -> XYZ (D65)
    x = 0.4124564 * lin[..., 0] + 0.3575761 * lin[..., 1] + 0.1804375 * lin[..., 2]
    y = 0.2126729 * lin[..., 0] + 0.7151522 * lin[..., 1] + 0.0721750 * lin[..., 2]
    z = 0.0193339 * lin[..., 0] + 0.1191920 * lin[..., 1] + 0.9503041 * lin[..., 2]
    # D65 white point
    xn, yn, zn = 0.95047, 1.0, 1.08883
    fx = _lab_f(x / xn)
    fy = _lab_f(y / yn)
    fz = _lab_f(z / zn)
    L = 116.0 * fy - 16.0
    a = 500.0 * (fx - fy)
    b = 200.0 * (fy - fz)
    return np.stack([L, a, b], axis=-1)


def srgb_u8_to_lab(rgb_u8: np.ndarray) -> np.ndarray:
    """uint8 sRGB (..., 3) -> Lab (..., 3) float64."""
    lin = srgb_to_linear(np.asarray(rgb_u8, dtype=np.float64) / 255.0)
    return linear_rgb_to_lab(lin)
