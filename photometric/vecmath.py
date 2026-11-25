"""Vector, colour and normal-map encoding helpers.

Coordinate conventions used throughout the project
--------------------------------------------------
* Camera space: x to the right of the image, y up, z towards the viewer.
* A light direction is the unit vector *from the surface towards the light*.
* Azimuth is measured counter-clockwise from +x in the image plane
  (0 deg = light on the right, 90 deg = light at the top).
* Elevation is measured above the image plane (90 deg = light straight on
  towards the viewer).
* Normal maps are written as 8-bit RGB using the common "OpenGL" encoding::

      R = (nx + 1) / 2,   G = (ny + 1) / 2,   B = (nz + 1) / 2

  Green therefore points *up* in the image.  A DirectX-style map (green
  down) can be decoded by flipping G before use.
"""
from __future__ import annotations

import numpy as np

EPS = 1e-12

NORMAL_ENCODING = "opengl"
NORMAL_ENCODING_LABEL = "OpenGL (R = +X 右, G = +Y 上, B = +Z 朝向观察者)"


def normalize(v: np.ndarray, axis: int = -1) -> np.ndarray:
    """Return ``v`` scaled to unit length along ``axis``."""
    v = np.asarray(v, dtype=np.float64)
    n = np.linalg.norm(v, axis=axis, keepdims=True)
    return v / np.maximum(n, EPS)


def light_from_az_el(azimuth_deg: float | np.ndarray,
                     elevation_deg: float | np.ndarray) -> np.ndarray:
    """Unit light vector(s) from azimuth/elevation in degrees."""
    az = np.deg2rad(np.asarray(azimuth_deg, dtype=np.float64))
    el = np.deg2rad(np.asarray(elevation_deg, dtype=np.float64))
    ce = np.cos(el)
    return np.stack([ce * np.cos(az), ce * np.sin(az), np.sin(el)], axis=-1)


def az_el_from_direction(v: np.ndarray) -> tuple[float, float]:
    """(azimuth, elevation) in degrees for a single direction."""
    v = normalize(np.asarray(v, dtype=np.float64).reshape(3))
    az = float(np.rad2deg(np.arctan2(v[1], v[0]))) % 360.0
    el = float(np.rad2deg(np.arcsin(np.clip(v[2], -1.0, 1.0))))
    return az, el


def normal_az_el(nxy: np.ndarray, nz: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Azimuth (0..360) and tilt (0..90) for normal arrays."""
    az = np.rad2deg(np.arctan2(nxy[..., 1], nxy[..., 0])) % 360.0
    tilt = np.rad2deg(np.arccos(np.clip(nz, -1.0, 1.0)))
    return az, tilt


#: Grey value written for pixels without a normal.  Decoding it yields the
#: zero vector, which cannot be a unit normal, so a bare normal map is still
#: unambiguous without its mask sidecar.
NORMAL_BACKGROUND = 128


def encode_normals(normals: np.ndarray, valid: np.ndarray | None = None,
                   background: int = NORMAL_BACKGROUND) -> np.ndarray:
    """[-1, 1] normals -> uint8 RGB image (OpenGL convention).

    Invalid / background pixels are written as neutral grey, which decodes to
    the zero vector.  The sidecar mask stays the authoritative region record.
    """
    n = np.nan_to_num(np.asarray(normals, dtype=np.float64), nan=0.0, posinf=0.0, neginf=0.0)
    out = np.clip(np.rint((n * 0.5 + 0.5) * 255.0), 0, 255).astype(np.uint8)
    if valid is not None:
        out = np.array(out, copy=True)
        out[~np.asarray(valid, dtype=bool)] = background
    return out


def decode_normals(rgb: np.ndarray, green_down: bool = False) -> np.ndarray:
    """uint8 RGB image -> [-1, 1] normals (optionally DirectX green flip)."""
    arr = np.asarray(rgb, dtype=np.float64)
    n = arr / 255.0 * 2.0 - 1.0
    if green_down:
        n = n.copy()
        n[..., 1] *= -1.0
    return n


def unit_normals(normals: np.ndarray) -> np.ndarray:
    """Normalise decoded normals, leaving zero vectors as zero."""
    return normalize(np.asarray(normals, dtype=np.float64))


def angle_between(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Angle in degrees between matching unit vectors in the last axis."""
    a = normalize(a)
    b = normalize(b)
    return np.rad2deg(np.arccos(np.clip(np.sum(a * b, axis=-1), -1.0, 1.0)))


def grayscale_to_rgb(gray: np.ndarray) -> np.ndarray:
    g = np.clip(np.asarray(gray, dtype=np.float64), 0.0, 1.0)
    return np.repeat((g * 255.0 + 0.5).astype(np.uint8)[..., None], 3, axis=-1)


def hsv_to_rgb(h: np.ndarray, s: np.ndarray, v: np.ndarray) -> np.ndarray:
    """Vectorised HSV (all inputs in 0..1) -> RGB float array."""
    h = np.asarray(h, dtype=np.float64) % 1.0
    s = np.asarray(s, dtype=np.float64)
    v = np.asarray(v, dtype=np.float64)
    i = np.floor(h * 6.0).astype(np.int64)
    f = h * 6.0 - i
    p = v * (1.0 - s)
    q = v * (1.0 - f * s)
    t = v * (1.0 - (1.0 - f) * s)
    i = i % 6
    out = np.empty(h.shape + (3,), dtype=np.float64)
    conditions = [i == 0, i == 1, i == 2, i == 3, i == 4, i == 5]
    reds = [v, q, p, p, t, v]
    greens = [t, v, v, q, p, p]
    blues = [p, p, t, v, v, q]
    for cond, r, g, b in zip(conditions, reds, greens, blues):
        out[cond, 0] = r[cond]
        out[cond, 1] = g[cond]
        out[cond, 2] = b[cond]
    return out


def direction_color(normals: np.ndarray, side: np.ndarray | None = None) -> np.ndarray:
    """Map normal directions to a readable RGB colour (float 0..1).

    Hue follows azimuth (cyclic compass colour), saturation follows tilt so
    flat areas stay pale.  ``side`` may carry a 0..1 scalar for brightness.
    """
    n = normalize(np.asarray(normals, dtype=np.float64))
    az = (np.arctan2(n[..., 1], n[..., 0]) / (2.0 * np.pi)) % 1.0
    tilt = np.clip(1.0 - n[..., 2], 0.0, 1.0) ** 0.7
    rgb = hsv_to_rgb(az, 0.25 + 0.65 * tilt, 0.72 + 0.25 * tilt)
    if side is not None:
        s = np.clip(np.asarray(side, dtype=np.float64), 0.0, 1.0)
        rgb = rgb * (0.35 + 0.65 * s[..., None])
    return rgb


# Colours shared by the interface (Qt hex strings).  Problem states use the
# three-hue validated set; "fine" and "no reading" stay neutral so hue always
# means "something needs attention".
OK_COLOR = "#898781"
SHADOW_COLOR = "#3987e5"
SATURATED_COLOR = "#d55181"
NONLAMBERT_COLOR = "#c98500"
INVALID_COLOR = "#d03b3b"
WARN_COLOR = "#fab219"
MUTED_COLOR = "#898781"
