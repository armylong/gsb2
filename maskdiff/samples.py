"""Built-in synthetic examples for cross-checking area vs boundary distance.

Both examples are deliberately small (256 x 256) and use the same calibration,
so the two conclusions can be read side by side:

* ``translation`` -- one mask is a rigid copy of the other. Area and IoU look
  almost perfect, but every boundary point is off by the shift vector.
* ``notch`` -- a long, thin indentation (2 px wide, 22 px deep). Area changes by
  a fraction of a percent, but the groove bottom is 22 px away from the other
  boundary.

These are core-only (no Qt), so the tests can generate them too.
"""
from __future__ import annotations

import numpy as np
from scipy import ndimage as ndi


def _ellipse(shape: tuple[int, int], center: tuple[float, float], radii: tuple[float, float]) -> np.ndarray:
    h, w = shape
    yy, xx = np.mgrid[0:h, 0:w]
    cy, cx = center
    ry, rx = radii
    return ((yy - cy) / ry) ** 2 + ((xx - cx) / rx) ** 2 <= 1.0


def _rounded_rect(shape: tuple[int, int], inset: int, radius: int) -> np.ndarray:
    h, w = shape
    yy, xx = np.mgrid[0:h, 0:w]
    y0, y1 = inset, h - inset - 1
    x0, x1 = inset, w - inset - 1
    base = (yy >= y0) & (yy <= y1) & (xx >= x0) & (xx <= x1)
    r = max(int(radius), 0)
    if r:
        corners = (
            (y0 + r, x0 + r, yy <= y0 + r, xx <= x0 + r),
            (y0 + r, x1 - r, yy <= y0 + r, xx >= x1 - r),
            (y1 - r, x0 + r, yy >= y1 - r, xx <= x0 + r),
            (y1 - r, x1 - r, yy >= y1 - r, xx >= x1 - r),
        )
        for cy, cx, qy, qx in corners:
            # Clip the circle to its own quadrant: a full box around the centre
            # would also eat pixels that belong to the straight edge.
            quadrant = qy & qx
            inside = (yy - cy) ** 2 + (xx - cx) ** 2 <= r * r
            base[quadrant] = base[quadrant] & inside[quadrant]
    return base


def translation(shape: tuple[int, int] = (256, 256), shift: tuple[int, int] = (5, 4)) -> tuple[np.ndarray, np.ndarray]:
    """A rigid shift: area is identical, the boundary is uniformly off."""
    a = _ellipse(shape, (shape[0] / 2, shape[1] / 2), (72, 52))
    b = ndi.shift(a.astype(np.float32), shift=shift, order=0, mode="constant", cval=0.0) > 0.5
    return a, b


def notch(
    shape: tuple[int, int] = (256, 256),
    groove_width: int = 2,
    groove_depth: int = 22,
) -> tuple[np.ndarray, np.ndarray]:
    """A solid shape with one long thin groove cut out of the top edge.

    A has the groove, B does not. Area differs by only ``width * depth`` pixels,
    but A's boundary at the groove bottom is ``depth`` away from B's boundary.
    """
    a = _rounded_rect(shape, inset=28, radius=26)
    b = a.copy()
    h, w = shape
    top = int(np.argmax(b[:, w // 2]))
    c0 = w // 2 - groove_width // 2
    c1 = c0 + groove_width
    r0 = max(top, 0)
    r1 = min(h, top + groove_depth)
    a[r0:r1, c0:c1] = False
    return a, b


def pinhole(
    shape: tuple[int, int] = (200, 200),
    hole_side: int = 1,
) -> tuple[np.ndarray, np.ndarray]:
    """Identical blobs, but A carries a tiny hole B does not have."""
    a, b = translation(shape, shift=(0, 0))
    r, c = shape[0] // 2, shape[1] // 2
    a[r : r + hole_side, c : c + hole_side] = False
    return a, b


EXAMPLES = {
    "translation": ("整体平移", translation),
    "notch": ("细长凹槽", notch),
}


def build(name: str) -> tuple[np.ndarray, np.ndarray]:
    if name not in EXAMPLES:
        raise KeyError(f"未知示例: {name}")
    return EXAMPLES[name][1]()
