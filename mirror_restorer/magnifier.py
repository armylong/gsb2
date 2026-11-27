"""Paired magnifier: a point and its mirror position, side by side.

The inspection point moves in *image* float coordinates.  Crops are sampled
with sub-pixel translation (cv2.warpAffine on float32 maps), so the oblique
axis is inspected at true fractional-pixel precision instead of snapping to
integer offsets.
"""

from __future__ import annotations

import cv2
import numpy as np

from .geometry import SymLine, reflect_points


def paired_crops(
    image: np.ndarray,
    line: SymLine,
    point_xy: tuple[float, float],
    radius: int = 40,
    zoom: int = 6,
    fill_rgb: tuple[int, int, int] = (255, 0, 255),
) -> tuple[np.ndarray, np.ndarray, tuple[float, float], np.ndarray]:
    """Return (crop_a, crop_b, mirrored_point, inside_flags).

    crop_a is centered on ``point_xy``, crop_b on its reflection.  Out-of-range
    pixels are filled with magenta so the image boundary is obvious.
    """
    work = image if image.ndim == 3 else cv2.cvtColor(image, cv2.COLOR_GRAY2BGR)
    h, w = work.shape[:2]
    p = np.asarray(point_xy, dtype=np.float64)
    q = reflect_points(p.reshape(1, 2), line)[0]

    size = 2 * radius + 1

    def sample(center: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        # source coordinate for each output pixel, kept fractional
        ys, xs = np.mgrid[0:size, 0:size].astype(np.float32)
        map_x = xs + (center[0] - radius)
        map_y = ys + (center[1] - radius)
        inside = (map_x >= 0) & (map_x <= w - 1) & (map_y >= 0) & (map_y <= h - 1)
        crop = cv2.remap(
            work, map_x.astype(np.float32), map_y.astype(np.float32),
            cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT,
            borderValue=fill_rgb,
        )
        return crop, inside

    crop_a, inside_a = sample(p)
    crop_b, inside_b = sample(q)
    if zoom > 1:
        crop_a = cv2.resize(crop_a, None, fx=zoom, fy=zoom, interpolation=cv2.INTER_NEAREST)
        crop_b = cv2.resize(crop_b, None, fx=zoom, fy=zoom, interpolation=cv2.INTER_NEAREST)
    return crop_a, crop_b, (float(q[0]), float(q[1])), np.stack([inside_a, inside_b])


def draw_crosshair(crop: np.ndarray, zoom: int, color=(0, 255, 255)) -> np.ndarray:
    out = crop.copy()
    c = crop.shape[0] // 2
    cv2.line(out, (0, c), (crop.shape[1] - 1, c), color, 1)
    cv2.line(out, (c, 0), (c, crop.shape[0] - 1), color, 1)
    return out
