"""Numerical core for the normal-map workbench.

Coordinate convention (used everywhere in this project)
--------------------------------------------------------
* Surface space: x points right, y points up, z points toward the viewer.
* Image space: rows increase downward, columns increase rightward.
* A brighter height-map value means a higher surface.
* Height is normalised to [0, 1]; z = strength * height, where one pixel of
  horizontal spacing counts as one surface unit.  ``strength`` is therefore
  expressed in pixels per full height range.
* Normals point away from the surface: n = normalize(-dz/dx, -dz/dy, 1).

The normal map stores n in RGB with the usual [-1, 1] -> [0, 255] mapping.
The green channel is either Y-up (OpenGL style) or Y-down (DirectX style).
Toggling that convention only changes how G is stored/decoded; the geometric
normal field itself does not change.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Tuple

import cv2
import numpy as np

GREEN_Y_UP = "y_up"
GREEN_Y_DOWN = "y_down"
GREEN_CONVENTIONS = (GREEN_Y_UP, GREEN_Y_DOWN)
GREEN_LABELS = {
    GREEN_Y_UP: "+Y (OpenGL 风格)",
    GREEN_Y_DOWN: "−Y (DirectX 风格)",
}

BOUNDARY_EXTEND = "extend"
BOUNDARY_WRAP = "wrap"
BOUNDARIES = (BOUNDARY_EXTEND, BOUNDARY_WRAP)
BOUNDARY_LABELS = {
    BOUNDARY_EXTEND: "边界延续 (clamp / replicate)",
    BOUNDARY_WRAP: "周期边界 (wrap / tile)",
}

MAX_HEIGHTMAP_SIDE = 1024


@dataclass(frozen=True)
class LightSettings:
    """Point light of a planar material preview.

    ``plane_x`` / ``plane_y`` are normalised to the half extents of the image
    plane ([-1, 1] covers the whole image), with +y pointing up.  ``height`` is
    normalised by the plane half-diagonal, so it is aspect-ratio independent.
    The light sits at (plane_x * hx, plane_y * hy, height * S).
    """

    plane_x: float = -0.35
    plane_y: float = 0.35
    height: float = 1.0
    ambient: float = 0.20
    diffuse: float = 0.80

    def clamped(self) -> "LightSettings":
        return LightSettings(
            plane_x=float(np.clip(self.plane_x, -0.98, 0.98)),
            plane_y=float(np.clip(self.plane_y, -0.98, 0.98)),
            height=float(np.clip(self.height, 0.05, 4.0)),
            ambient=float(np.clip(self.ambient, 0.0, 1.0)),
            diffuse=float(np.clip(self.diffuse, 0.0, 1.0)),
        )


# Fixed lamp used by the independent preset checks (not affected by the live
# preview light).  Same coordinate meaning as LightSettings.
VALIDATION_LIGHT = LightSettings(
    plane_x=-0.35, plane_y=0.35, height=1.0, ambient=0.20, diffuse=0.80
)


@dataclass(frozen=True)
class DecodedNormals:
    """Normal data decoded from an 8-bit RGB map."""

    raw: np.ndarray       # HxWx3, decoded components before renormalising
    length: np.ndarray    # HxW, length of the decoded vectors
    unit: np.ndarray      # HxWx3, renormalised (used for lighting)


def smooth_height(
    height: np.ndarray,
    sigma: float,
    boundary: str = BOUNDARY_EXTEND,
) -> np.ndarray:
    """Optional Gaussian pre-smoothing of a normalised height field.

    The same boundary rule is used for smoothing and for the gradient so the
    four sides of a seamless (periodic) sample stay consistent.
    """
    h = np.asarray(height, dtype=np.float64)
    if h.ndim != 2:
        raise ValueError("height must be a 2-D array")
    if sigma <= 0.0:
        return h.copy()
    border = cv2.BORDER_WRAP if boundary == BOUNDARY_WRAP else cv2.BORDER_REPLICATE
    # Very small images cannot host a wide kernel; silently reduce sigma.
    max_sigma = max(0.0, min(h.shape) / 6.0)
    effective = min(float(sigma), max_sigma)
    if effective <= 1e-6:
        return h.copy()
    out = cv2.GaussianBlur(h, (0, 0), sigmaX=effective, sigmaY=effective,
                           borderType=border)
    return np.asarray(out, dtype=np.float64)


def _pad_for_gradient(h: np.ndarray, boundary: str) -> np.ndarray:
    if boundary == BOUNDARY_WRAP:
        return np.pad(h, 1, mode="wrap")
    if boundary == BOUNDARY_EXTEND:
        return np.pad(h, 1, mode="edge")
    raise ValueError(f"unknown boundary: {boundary!r}")


def height_gradient(
    height: np.ndarray,
    boundary: str = BOUNDARY_EXTEND,
) -> Tuple[np.ndarray, np.ndarray]:
    """Central differences of height along image rows and columns.

    Returns ``(d_h_d_row, d_h_d_col)`` in height units per pixel.

    With ``wrap`` the padding is done per axis with :func:`numpy.pad`, so the
    right edge samples the left neighbour of the same row (and the bottom edge
    samples the top neighbour of the same column); columns and rows are never
    flattened together.
    """
    h = np.asarray(height, dtype=np.float64)
    if h.ndim != 2:
        raise ValueError("height must be a 2-D array")
    p = _pad_for_gradient(h, boundary)
    d_row = (p[2:, 1:-1] - p[:-2, 1:-1]) * 0.5
    d_col = (p[1:-1, 2:] - p[1:-1, :-2]) * 0.5
    return d_row, d_col


def compute_normal_field(
    height: np.ndarray,
    strength: float,
    boundary: str = BOUNDARY_EXTEND,
) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Build unit normals from a normalised height field.

    Returns ``(normals, grad_row, grad_col)``.  ``normals[r, c]`` is
    ``(nx, ny, nz)`` in surface coordinates (x right, y up, z to viewer).
    """
    if boundary not in BOUNDARIES:
        raise ValueError(f"unknown boundary: {boundary!r}")
    h = np.asarray(height, dtype=np.float64)
    d_row, d_col = height_gradient(h, boundary)
    s = float(strength)
    # dz/dx = s * d_col ; dz/dy = -s * d_row (image rows point down)
    n = np.empty(h.shape + (3,), dtype=np.float64)
    n[..., 0] = -s * d_col
    n[..., 1] = s * d_row
    n[..., 2] = 1.0
    length = np.linalg.norm(n, axis=-1, keepdims=True)
    length = np.maximum(length, 1e-12)
    n /= length
    return n, d_row, d_col


def encode_normal_rgb(normals: np.ndarray, green: str = GREEN_Y_UP) -> np.ndarray:
    """Encode unit normals as an 8-bit RGB map.

    The green convention is applied only here.  Y-down stores
    ``255 - G_y_up``; the complement is exact, so encode/decode round-trips are
    independent of the chosen convention.
    """
    if green not in GREEN_CONVENTIONS:
        raise ValueError(f"unknown green convention: {green!r}")
    n = np.asarray(normals, dtype=np.float64)
    if n.ndim != 3 or n.shape[-1] != 3:
        raise ValueError("normals must have shape (H, W, 3)")

    def channel(v: np.ndarray) -> np.ndarray:
        return np.rint(np.clip(v * 0.5 + 0.5, 0.0, 1.0) * 255.0).astype(np.uint8)

    g_y_up = channel(n[..., 1])
    rgb = np.empty(n.shape, dtype=np.uint8)
    rgb[..., 0] = channel(n[..., 0])
    rgb[..., 1] = g_y_up if green == GREEN_Y_UP else (255 - g_y_up)
    rgb[..., 2] = channel(n[..., 2])
    return rgb


def decode_normal_rgb(rgb: np.ndarray, green: str = GREEN_Y_UP) -> DecodedNormals:
    """Decode an 8-bit RGB normal map numerically.

    Values are read straight from the channel bytes (0..255); no colour
    management, gamma or image-viewer conversion is involved.  Callers should
    pass raw RGB values as returned by the PNG decoder.
    """
    if green not in GREEN_CONVENTIONS:
        raise ValueError(f"unknown green convention: {green!r}")
    arr = np.asarray(rgb, dtype=np.uint8)
    if arr.ndim != 3 or arr.shape[-1] < 3:
        raise ValueError("normal map must have shape (H, W, >=3)")
    raw = np.empty(arr.shape[:2] + (3,), dtype=np.float64)
    raw[..., 0] = arr[..., 0].astype(np.float64) / 255.0 * 2.0 - 1.0
    g = arr[..., 1].astype(np.float64) / 255.0 * 2.0 - 1.0
    raw[..., 1] = g if green == GREEN_Y_UP else -g
    raw[..., 2] = arr[..., 2].astype(np.float64) / 255.0 * 2.0 - 1.0
    length = np.linalg.norm(raw, axis=-1)
    safe = np.maximum(length, 1e-12)[..., None]
    unit = raw / safe
    return DecodedNormals(raw=raw, length=length, unit=unit)


def plane_half_extents(width: int, height: int) -> Tuple[float, float, float]:
    """Half extents (hx, hy) and half-diagonal S of the image plane in pixels."""
    hx = (float(width) - 1.0) * 0.5
    hy = (float(height) - 1.0) * 0.5
    half_diag = float(np.hypot(hx, hy))
    return hx, hy, half_diag


def light_direction_field(
    width: int,
    height: int,
    light: LightSettings,
) -> np.ndarray:
    """Per-pixel unit vectors pointing from the surface to the point light."""
    hx, hy, half_diag = plane_half_extents(width, height)
    rows = np.arange(height, dtype=np.float64)
    cols = np.arange(width, dtype=np.float64)
    x = cols[None, :] - hx
    y = hy - rows[:, None]
    vx = np.broadcast_to(light.plane_x * hx - x, (height, width))
    vy = np.broadcast_to(light.plane_y * hy - y, (height, width))
    vz = np.full((height, width), light.height * half_diag, dtype=np.float64)
    v = np.stack([vx, vy, vz], axis=-1)
    norm = np.linalg.norm(v, axis=-1, keepdims=True)
    norm = np.maximum(norm, 1e-12)
    return v / norm


def light_direction_at(
    row: int,
    col: int,
    width: int,
    height: int,
    light: LightSettings,
) -> np.ndarray:
    """Unit light direction at one pixel (surface -> light)."""
    hx, hy, half_diag = plane_half_extents(width, height)
    vx = light.plane_x * hx - (float(col) - hx)
    vy = light.plane_y * hy - (hy - float(row))
    vz = light.height * half_diag
    v = np.array([vx, vy, vz], dtype=np.float64)
    n = np.linalg.norm(v)
    if n <= 1e-12:
        return np.array([0.0, 0.0, 1.0])
    return v / n


def shade(
    unit_normals: np.ndarray,
    light_vectors: np.ndarray,
    ambient: float,
    diffuse: float,
) -> np.ndarray:
    """Lambert lighting with an ambient term; no specular or shadows."""
    ndotl = np.sum(unit_normals * light_vectors, axis=-1)
    ndotl = np.clip(ndotl, 0.0, 1.0)
    out = float(ambient) + float(diffuse) * ndotl
    return np.clip(out, 0.0, 1.0)


def light_plane_position_normalised(
    c: float, r: float, width: int, height: int
) -> Tuple[float, float]:
    """Convert fractional image coordinates to normalised plane coordinates."""
    hx, hy, _ = plane_half_extents(width, height)
    lx = (c - hx) / hx if hx > 1e-9 else 0.0
    ly = (hy - r) / hy if hy > 1e-9 else 0.0
    return lx, ly


def normalised_to_image_position(
    plane_x: float, plane_y: float, width: int, height: int
) -> Tuple[float, float]:
    """Convert normalised plane coordinates to fractional image coordinates."""
    hx, hy, _ = plane_half_extents(width, height)
    c = hx + plane_x * hx
    r = hy - plane_y * hy
    return c, r


def grey_uint8(field: np.ndarray) -> np.ndarray:
    """Map a [0, 1] field to a displayable 8-bit grey image (not for export)."""
    v = np.asarray(field, dtype=np.float64)
    return np.rint(np.clip(v, 0.0, 1.0) * 255.0).astype(np.uint8)



Boundary = Literal["extend", "wrap"]
Green = Literal["y_up", "y_down"]
