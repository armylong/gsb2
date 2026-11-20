"""Procedural test artwork.

These textures are generated analytically (no assets) and chosen to reproduce
the classic "thin line flicker" and "dark edge" symptoms:

* :func:`periodic_checker`           -- 2-px period checker: extreme aliasing.
* :func:`thin_lines`                 -- horizontal 1-3 px black lines on
                                        transparency.
* :func:`transparent_icon`           -- white rounded glyph with analytic
                                        anti-aliased edges; transparent pixels
                                        carry RGB=0, which is what makes
                                        straight-alpha averaging produce a dark
                                        rim.
* :func:`semi_transparent_diagonal`  -- 45 degree white line at 50 % opacity.
* :func:`odd_ratio_grid`             -- 1-px grid with a 3-px period, aimed at
                                        3:1 / 7:1 odd downscale ratios.

All return float32 RGBA (straight alpha) with shape ``(size, size, 4)`` and
values in [0, 1].  Colours are chosen so that ``RGB x alpha`` is the true
contribution of each sample (premultiplied colour); where alpha is zero the RGB
is zero, mirroring a typical export.
"""
from __future__ import annotations

import math

import numpy as np

RGBA = np.ndarray

WHITE = (1.0, 1.0, 1.0)
BLACK = (0.0, 0.0, 0.0)


def _empty(size: int) -> RGBA:
    """Transparent black canvas: RGB=0 wherever alpha=0."""
    return np.zeros((int(size), int(size), 4), dtype=np.float32)


def _normalise_size(size: int) -> int:
    return max(8, int(size))


# --------------------------------------------------------------------------- #
# Textures
# --------------------------------------------------------------------------- #
def periodic_checker(size: int = 256, period: int = 2) -> RGBA:
    """Opaque black/white checker on a ``period``-px grid.

    With ``period=2`` the pattern runs at exactly Nyquist frequency for a 2x
    reduction, so any filter without an adequate prefilter aliases.
    """
    size = _normalise_size(size)
    yy, xx = np.mgrid[0:size, 0:size]
    cell = (((xx // period) + (yy // period)) % 2).astype(np.float32)
    out = np.empty((size, size, 4), dtype=np.float32)
    out[..., :3] = cell[..., None]
    out[..., 3] = 1.0
    return out


def thin_lines(
    size: int = 256, spacing: int = 4, thickness: int = 1, on_white: bool = False
) -> RGBA:
    """Horizontal black bars, ``thickness`` px thick, ``spacing`` px apart.

    A correct downscaler reproduces the source's mean alpha (``thickness /
    spacing``) regardless of output phase.  Direct interpolation cannot: at
    some phases it lands on the line and some it misses it completely.
    """
    size = _normalise_size(size)
    yy = np.mgrid[0:size, 0:size][0]
    on = (yy % spacing) < thickness
    out = _empty(size)
    if on_white:
        out[..., :3] = 1.0
    out[on, :3] = 0.0
    out[on, 3] = 1.0
    return out


def transparent_icon(
    size: int = 256,
    inner_alpha: float = 1.0,
    ring: bool = True,
    half_fraction: float = 0.36,
) -> RGBA:
    """White rounded glyph with analytic anti-aliased edges.

    Transparent samples are RGB=0.  Averaging straight (non-premultiplied)
    colour therefore drags edge pixels toward black while their alpha stays
    moderate -- the classic dark fringe around a downscaled icon.
    """
    size = _normalise_size(size)
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float64)
    c = (size - 1) / 2.0
    half = size * half_fraction
    round_r = half * 0.55
    edge = 1.25  # AA ramp half-width, in samples

    def rounded_rect_mask(cx: float, cy: float, half_x: float, half_y: float, radius: float):
        dx = np.abs(xx - cx) - (half_x - radius)
        dy = np.abs(yy - cy) - (half_y - radius)
        outside = np.hypot(np.maximum(dx, 0.0), np.maximum(dy, 0.0))
        inside = np.minimum(np.maximum(dx, dy), 0.0)
        dist = outside + inside - radius
        # Signed distance to the boundary; <=0 means inside.
        return np.clip(0.5 - dist / (2.0 * edge), 0.0, 1.0)

    cover = rounded_rect_mask(c, c, half, half, round_r)
    if ring:
        inner = rounded_rect_mask(c, c, half * 0.58, half * 0.58, round_r * 0.55)
        cover = np.clip(cover - inner, 0.0, 1.0)
        # A small solid dot in the centre, plus a notch to break symmetry.
        dot = rounded_rect_mask(c, c, half * 0.16, half * 0.16, half * 0.14)
        cover = np.maximum(cover, dot)
        notch = rounded_rect_mask(c + half * 0.62, c - half * 0.62, half * 0.22, half * 0.10, 0.0)
        cover = np.clip(cover - notch, 0.0, 1.0)

    out = _empty(size)
    alpha = (cover * inner_alpha).astype(np.float32)
    # Straight-alpha export convention: colour is defined only where alpha is
    # non-zero; fully transparent samples carry RGB=0.  That zero colour is
    # what a straight-alpha average mistakenly mixes into the edges.
    out[..., :3] = np.asarray(WHITE, dtype=np.float32) * (alpha[..., None] > 0.0)
    out[..., 3] = alpha
    return out


def semi_transparent_diagonal(
    size: int = 256, width: float = 1.0, alpha: float = 0.5, slope: float = 1.0
) -> RGBA:
    """45 degree white line, ``width`` samples thick, at partial opacity.

    ``slope=1`` gives an exact 45 degree line (the usual trouble case because
    it aligns with neither axis); other slopes exercise general angles.
    """
    size = _normalise_size(size)
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float64)
    # Perpendicular distance from the line y - slope*x = 0, in sample units.
    dist = np.abs(yy - slope * xx - (size * 0.5 - slope * size * 0.5)) / math.hypot(1.0, slope)
    cover = np.clip(0.5 + width / 2.0 - dist, 0.0, 1.0)
    out = _empty(size)
    alpha = (cover * alpha).astype(np.float32)
    out[..., :3] = np.asarray(WHITE, dtype=np.float32) * (alpha[..., None] > 0.0)
    out[..., 3] = alpha
    return out


def odd_ratio_grid(size: int = 256, period: int = 3) -> RGBA:
    """1-px black bars every ``period`` px on both axes, on transparency.

    For an integer block of k samples starting at 0, the bar union covers
    ``a*k + a*k - a*a`` of the ``k*k`` cells with ``a = ceil(k/period)``; a
    correct area filter reproduces that exactly.
    """
    size = _normalise_size(size)
    yy, xx = np.mgrid[0:size, 0:size]
    on = ((xx % period) == 0) | ((yy % period) == 0)
    out = _empty(size)
    out[on, :3] = 0.0
    out[on, 3] = 1.0
    return out


def checkerboard_backdrop(rgba: RGBA, cell: int = 8, dark: float = 0.30, light: float = 0.45) -> RGBA:
    """Composite a transparent image over a grey checkerboard for display."""
    h, w = rgba.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w]
    parity = ((xx // cell) + (yy // cell)) % 2
    base = np.where(parity[..., None], dark, light).astype(np.float32)
    base = np.repeat(base, 3, axis=2)
    alpha = rgba[..., 3:4]
    out = np.empty((h, w, 4), dtype=np.float32)
    out[..., :3] = rgba[..., :3] * alpha + base * (1.0 - alpha)
    out[..., 3] = 1.0
    return out


def nearest_zoom(rgba: RGBA, factor: int) -> RGBA:
    """Integer nearest-neighbour magnification so pixels stay inspectable."""
    factor = max(1, int(factor))
    return np.repeat(np.repeat(rgba, factor, axis=0), factor, axis=1)


SAMPLES: dict[str, tuple[str, callable]] = {
    "checker": ("周期格纹 2px", periodic_checker),
    "lines": ("细横线 1px", thin_lines),
    "icon": ("半透明图标", transparent_icon),
    "diagonal": ("半透明斜线", semi_transparent_diagonal),
    "grid": ("奇数比率网格", odd_ratio_grid),
}
SAMPLE_ORDER = ["checker", "lines", "icon", "diagonal", "grid"]


def make_sample(key: str, size: int = 256) -> RGBA:
    if key not in SAMPLES:
        raise KeyError(f"unknown sample {key!r}; choose from {', '.join(SAMPLE_ORDER)}")
    return SAMPLES[key][1](size)
