"""Turning solver output into pixels the interface can show.

All images here are produced with numpy only; the Qt layer copies the
resulting arrays into ``QImage`` objects.  Keeping the pixel maths out of the
widgets makes it testable without a display.
"""
from __future__ import annotations

import numpy as np

from . import vecmath
from .solver import (REASON_AMBIGUOUS, REASON_DARK, REASON_ILL_CONDITIONED,
                     REASON_NOT_OBJECT, REASON_TOO_FEW, REASON_UNCERTAIN,
                     STATUS_NONLAMBERT, STATUS_OK, STATUS_SATURATED,
                     STATUS_SHADOW, STATUS_UNLIT, SolveResult)


def _to_uint8(rgb: np.ndarray) -> np.ndarray:
    return np.clip(np.rint(np.asarray(rgb, dtype=np.float64) * 255.0), 0, 255).astype(np.uint8)


def hex_of(rgb: tuple[float, float, float] | np.ndarray) -> str:
    """Float RGB (0..1) -> ``#rrggbb`` for Qt styles and legend chips."""
    vals = _to_uint8(np.asarray(rgb, dtype=np.float64).reshape(1, 1, 3))[0, 0]
    return "#{:02x}{:02x}{:02x}".format(int(vals[0]), int(vals[1]), int(vals[2]))


def gray_rgb(image: np.ndarray) -> np.ndarray:
    return vecmath.grayscale_to_rgb(image)


def normal_map_rgb(result: SolveResult, mask_invalid: bool = True,
                   background: int = 0) -> np.ndarray:
    """Encoded normal map (OpenGL convention) as uint8 RGB.

    For *display* the background is kept dark; the file exporter passes the
    encoder's neutral background instead (see :mod:`photometric.exporting`).
    """
    if mask_invalid:
        return vecmath.encode_normals(result.normals, result.valid, background=background)
    return vecmath.encode_normals(result.normals)


def direction_rgb(result: SolveResult) -> np.ndarray:
    """A more legible normal visualisation: hue = azimuth, saturation = tilt."""
    rgb = vecmath.direction_color(result.normals)
    rgb = np.where(result.valid[..., None], rgb, 0.16)
    return _to_uint8(rgb)


def shading_rgb(result: SolveResult) -> np.ndarray:
    """Lambertian shading from a fixed oblique light, for shape reading."""
    light = vecmath.normalize(np.array([-0.45, 0.55, 0.70]))
    lam = np.clip(np.einsum("hwj,j->hw", result.normals, light), 0.0, 1.0)
    rgb = np.repeat(lam[..., None], 3, axis=-1) * 0.85 + 0.06
    rgb = np.where(result.valid[..., None], rgb, np.array([0.20, 0.20, 0.20]))
    return _to_uint8(np.clip(rgb, 0.0, 1.0))


def albedo_rgb(result: SolveResult) -> np.ndarray:
    a = np.clip(result.albedo / 0.85, 0.0, 1.0)
    rgb = np.repeat(a[..., None], 3, axis=-1)
    rgb = np.where(result.object_mask[..., None], rgb, 0.06)
    return _to_uint8(rgb)


def uncertainty_rgb(result: SolveResult) -> np.ndarray:
    """Sequential magnitude map: light = certain, dark blue = uncertain."""
    rgb = _sequential_blue(np.clip(result.uncertainty_deg / 10.0, 0.0, 1.0))
    rgb = np.where(result.object_mask[..., None], rgb, 0.06)
    return _to_uint8(rgb)


# Three validated dark-mode hues (all-pairs pass on the panel surface) carry
# the three problem states; neutrals carry "fine" and "no reading".
STATUS_RGB = {
    STATUS_OK: (0.13, 0.16, 0.21),
    STATUS_SATURATED: (0.835, 0.318, 0.506),      # #d55181 magenta
    STATUS_SHADOW: (0.224, 0.529, 0.898),         # #3987e5 blue
    STATUS_NONLAMBERT: (0.788, 0.522, 0.000),     # #c98500 amber
    STATUS_UNLIT: (0.537, 0.529, 0.506),          # neutral grey
}
REASON_RGB = {
    REASON_NOT_OBJECT: (0.04, 0.05, 0.07),
    REASON_TOO_FEW: (0.224, 0.529, 0.898),        # blue
    REASON_ILL_CONDITIONED: (0.835, 0.318, 0.506),  # magenta
    REASON_UNCERTAIN: (0.788, 0.522, 0.000),      # amber
    REASON_AMBIGUOUS: (0.537, 0.529, 0.506),      # neutral grey
    REASON_DARK: (0.537, 0.529, 0.506),
}
_STATUS_COLORS = STATUS_RGB
_REASON_COLORS = REASON_RGB


def status_map_rgb(result: SolveResult, show_invalid: bool = True) -> np.ndarray:
    """Per-light readout statuses as a colour-coded map."""
    m, H, W = result.status.shape
    rgb = np.zeros((m, H, W, 3), dtype=np.float64)
    for code, colour in _STATUS_COLORS.items():
        sel = result.status == code
        rgb[sel] = colour
    if show_invalid:
        bad = ~result.valid & result.object_mask
        dim = rgb * 0.45
        rgb = np.where(bad[None, :, :, None], dim, rgb)
        rgb = np.where((~result.object_mask)[None, :, :, None], 0.045, rgb)
    return _to_uint8(rgb)


def invalid_map_rgb(result: SolveResult) -> np.ndarray:
    """Where an estimate is missing, coloured by reason."""
    H, W = result.height, result.width
    rgb = np.zeros((H, W, 3), dtype=np.float64)
    for code, colour in _REASON_COLORS.items():
        rgb[result.reason == code] = colour
    rgb[result.reason == 0] = (0.10, 0.12, 0.16)
    rgb[~result.object_mask] = (0.04, 0.05, 0.07)
    return _to_uint8(rgb)


def status_overlay(gray_rgb: np.ndarray, result: SolveResult,
                   light: int, dim: float = 0.55) -> np.ndarray:
    """Tint the input photograph where that light's reading was rejected.

    Problem readings get a 50% wash of their status hue; the untouched
    photograph underneath stays legible so the user can see *why* it was
    rejected (a dark patch, a blown highlight).
    """
    base = np.asarray(gray_rgb, dtype=np.float64) / 255.0
    out = base * 0.72
    st = result.status[light]
    for code, colour in STATUS_RGB.items():
        if code == STATUS_OK:
            continue
        sel = st == code
        if not np.any(sel):
            continue
        tint = np.array(colour)
        out = np.where(sel[..., None], out * (1.0 - dim) + tint * dim, out)
    rgb = _to_uint8(np.clip(out, 0.0, 1.0))
    return rgb


def overlay_invalid(base_rgb: np.ndarray, result: SolveResult,
                    silhouette: bool = True, dim: float = 0.55,
                    desaturate: bool = False) -> np.ndarray:
    """Tint missing regions with their reason colour over a dimmed base.

    ``dim`` controls how far the usable part recedes; pass ``1.0`` to keep it
    at full strength when the base is already the information you want to read
    (e.g. the normal map).  ``desaturate`` renders the usable part as grey so
    that the reason colours are the only hue on screen -- use that whenever the
    question is "where is the estimate missing", not "which way does it face".
    """
    base = np.asarray(base_rgb, dtype=np.float64)
    if desaturate:
        luma = base @ np.array([0.2126, 0.7152, 0.0722])
        base = np.repeat(luma[..., None], 3, axis=-1)
    out = base / 255.0 * dim
    invalid = (~result.valid) & result.object_mask
    reason_rgb = invalid_map_rgb(result).astype(np.float64) / 255.0
    out = np.where(invalid[..., None], reason_rgb, out)
    if silhouette:
        edge = _mask_edge(result.object_mask)
        out[edge] = np.minimum(1.0, out[edge] + 0.35)
    return _to_uint8(out)


def _mask_edge(mask: np.ndarray) -> np.ndarray:
    m = np.asarray(mask, dtype=bool)
    inner = m.copy()
    inner[1:, :] &= m[:-1, :]
    inner[:-1, :] &= m[1:, :]
    inner[:, 1:] &= m[:, :-1]
    inner[:, :-1] &= m[:, 1:]
    return m & ~inner


#: Flat value used for pixels that have no estimate in a re-render.  Mid-grey
#: reads as "no data" instead of a black hole that looks like a shadow.
UNKNOWN_GRAY = 0.28


def relight(result: SolveResult, direction: np.ndarray,
            unknown_gray: float | None = None) -> np.ndarray:
    """Lambertian re-render under a new light, float [0, 1] HxW.

    Pixels without a normal are filled with a flat grey (``unknown_gray``), not
    black: black would be mistaken for physical shading after re-lighting.
    Pass ``unknown_gray=0.0`` to get a hard cut-out instead.
    """
    l = vecmath.normalize(np.asarray(direction, dtype=np.float64).reshape(3))
    n = result.normals
    lam = np.clip(np.einsum("hwj,j->hw", n, l), 0.0, None)
    image = np.clip(result.albedo, 0.0, 1.0) * lam
    fill = UNKNOWN_GRAY if unknown_gray is None else float(unknown_gray)
    unknown = result.object_mask & ~result.valid
    image[unknown] = fill
    image[~result.object_mask] = 0.0
    return np.clip(image, 0.0, 1.0)


def hatch_unknown(result: SolveResult, gray: np.ndarray,
                  spacing: int = 7) -> np.ndarray:
    """Overlay a diagonal hatch on pixels with no estimate.

    A flat grey patch could be read as a real matte surface; a hatch says
    "unknown" unmistakably, and it survives greyscale printing.
    """
    out = np.array(gray, dtype=np.float64, copy=True)
    unknown = result.object_mask & ~result.valid
    if not np.any(unknown):
        return out
    yy, xx = np.mgrid[0:result.height, 0:result.width]
    stripe = ((xx + yy) % max(2, int(spacing))) < max(1, int(spacing) // 2)
    sel = unknown & stripe
    out[sel] = np.clip(out[sel] * 0.55 + 0.10, 0.0, 1.0)
    edge = unknown & ~stripe
    out[edge] = np.clip(out[edge] * 1.05, 0.0, 1.0)
    return out


def relight_with_specular(result: SolveResult, direction: np.ndarray,
                          strength: float = 0.22, power: float = 45.0) -> np.ndarray:
    l = vecmath.normalize(np.asarray(direction, dtype=np.float64).reshape(3))
    view = np.array([0.0, 0.0, 1.0])
    half = l + view
    half /= max(np.linalg.norm(half), 1e-9)
    lam = np.clip(np.einsum("hwj,j->hw", result.normals, l), 0.0, None)
    ndh = np.clip(np.einsum("hwj,j->hw", result.normals, half), 0.0, None)
    image = np.clip(result.albedo, 0.0, 1.0) * lam + strength * ndh ** power
    image[~result.object_mask] = 0.0
    return np.clip(image, 0.0, 1.0)


def arrow_field(result: SolveResult, spacing: int = 22,
                min_tilt_deg: float = 6.0) -> list[tuple[int, int, float, float, float]]:
    """Sparse arrows sampled on a grid of valid pixels.

    Returns ``(x, y, dx, dy, tilt_deg)`` tuples where the direction is the
    projected normal as it should be *drawn* (y down, as screen rows grow
    downwards).
    """
    H, W = result.height, result.width
    out: list[tuple[int, int, float, float, float]] = []
    half = max(spacing // 2, 1)
    step = max(int(spacing), 6)
    for y in range(half, H, step):
        for x in range(half, W, step):
            if not result.valid[y, x]:
                continue
            nx, ny, nz = result.normals[y, x]
            length = float(np.hypot(nx, ny))
            tilt = float(np.rad2deg(np.arccos(np.clip(nz, -1.0, 1.0))))
            if tilt < min_tilt_deg or length < 1e-6:
                continue
            # screen y grows downwards, so invert the y component
            out.append((x, y, float(nx), float(-ny), tilt))
    return out


def light_indicator(size: int, azimuth: float, elevation: float) -> np.ndarray:
    """Small compass drawing of one light direction (uint8 RGB, size x size)."""
    img = np.zeros((size, size, 3), dtype=np.float64)
    yy, xx = np.mgrid[0:size, 0:size]
    cx = cy = (size - 1) / 2.0
    radius = size * 0.42
    disk = (xx - cx) ** 2 + (yy - cy) ** 2 <= radius ** 2
    img[disk] = (0.14, 0.16, 0.22)
    ring = disk & ~((xx - cx) ** 2 + (yy - cy) ** 2 <= (radius - 1.2) ** 2)
    img[ring] = (0.40, 0.44, 0.54)
    # elevation shown by how far the light sits from the disc centre
    r = radius * (1.0 - elevation / 90.0) * 0.92
    az = np.deg2rad(azimuth)
    lx = cx + r * np.cos(az)
    ly = cy - r * np.sin(az)
    blob = (xx - lx) ** 2 + (yy - ly) ** 2 <= (size * 0.13) ** 2
    img[blob] = (1.0, 0.86, 0.38)
    return _to_uint8(img)


def _sequential_blue(t: np.ndarray) -> np.ndarray:
    """One-hue blue ramp (light = zero) from the reference palette."""
    stops = np.array([
        [0.804, 0.886, 0.984],
        [0.620, 0.773, 0.949],
        [0.337, 0.596, 0.918],
        [0.165, 0.416, 0.749],
        [0.055, 0.235, 0.502],
    ])
    x = np.clip(t, 0.0, 1.0) * (len(stops) - 1)
    i = np.minimum(np.floor(x).astype(int), len(stops) - 2)
    f = (x - i)[..., None]
    return stops[i] * (1 - f) + stops[i + 1] * f


def truth_comparison(result: SolveResult, truth_normals: np.ndarray,
                     valid: np.ndarray | None = None) -> np.ndarray:
    """Angular error map: one-hue sequential blue, darker = larger error."""
    err = vecmath.angle_between(result.normals, truth_normals)
    sel = result.valid if valid is None else (result.valid & valid)
    rgb = _sequential_blue(np.clip(err / 25.0, 0.0, 1.0))
    rgb = np.where(sel[..., None], rgb, 0.06)
    return _to_uint8(rgb)


def directional_shading(normals: np.ndarray, direction: np.ndarray) -> np.ndarray:
    """Simple directional shading for previewing the ground-truth normal field."""
    l = vecmath.normalize(np.asarray(direction, dtype=np.float64).reshape(3))
    lam = np.clip(np.einsum("hwj,j->hw", normals, l), 0.0, 1.0)
    return _to_uint8(np.repeat(lam[..., None], 3, axis=-1))
