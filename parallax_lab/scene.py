"""Procedural sample scenes: a still-life image plus hand-authored layered depth.

Everything here is generated in-process -- no external assets are loaded.  The
pipeline works on *two* layers only (requirement 1):

    layer 0 = FRONT  (still-life objects / the occluding slab / the ramp)
    layer 1 = BACK   (table / wall)

Depth is distance from the camera in metres; smaller = nearer.  The camera is
a simple translation model: for a camera offset of `baseline` pixels-at-1-m, a
point at depth D lands at

    dx = -baseline / D,     dy = -vertical / D

i.e. a positive baseline means the camera moves right, so content moves left,
and farther points move less.  All sample scenes are *geometric* (axis-aligned
rectangles, discs, linear ramps) so projection and hole extents can be checked
against closed-form coordinates in `parallax_lab.verify`.

The back layer is authored as a *visible-surface* depth map: it has NaN under
the front layer.  That is what makes disocclusion holes appear when the camera
moves -- the back surface has no samples where it was occluded in the reference
view.  (Hidden-surface data would make holes impossible by construction.)
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable

import numpy as np


@dataclass
class Layer:
    """RGB image + metric depth for one depth layer.

    rgb      : (H, W, 3) uint8
    depth    : (H, W) float32, metres from the camera, smaller = nearer.
               NaN = no sample.
    name     : human readable tag
    editable : whether the GUI offers a depth brush for this layer
    """

    rgb: np.ndarray
    depth: np.ndarray
    name: str
    editable: bool = True

    def copy(self) -> "Layer":
        return Layer(self.rgb.copy(), self.depth.copy(), self.name, self.editable)

    @property
    def shape(self) -> tuple[int, int]:
        return self.rgb.shape[:2]


@dataclass
class Scene:
    width: int
    height: int
    f_px: float                  # focal length in pixels (informational)
    layers: list[Layer]          # index 0 = front-most
    name: str = "scene"
    meta: dict = field(default_factory=dict)

    @property
    def shape(self):
        return self.height, self.width

    def yyxx(self):
        yy, xx = np.mgrid[0:self.height, 0:self.width]
        return yy.astype(np.float32), xx.astype(np.float32)


# ---------------------------------------------------------------------------
# drawing helpers (numpy only)
# ---------------------------------------------------------------------------


def _disc(yy, xx, cy, cx, r):
    return (yy - cy) ** 2 + (xx - cx) ** 2 <= r * r


def _rect(yy, xx, y0, y1, x0, x1):
    return (yy >= y0) & (yy < y1) & (xx >= x0) & (xx < x1)


def _shade(yy, xx, cy, cx, radius):
    """Soft radial shading multiplier around (cy, cx)."""
    d = np.sqrt((yy - cy) ** 2 + (xx - cx) ** 2) / max(radius, 1.0)
    return np.clip(1.12 - 0.30 * d, 0.50, 1.12)


# ---------------------------------------------------------------------------
# internal painter
# ---------------------------------------------------------------------------


class _Canvas:
    """Accumulates front-layer colour and depth over a transparent canvas."""

    def __init__(self, H, W):
        self.rgb = np.zeros((H, W, 3), np.float32)
        self.alpha = np.zeros((H, W), bool)
        self.depth = np.full((H, W), np.nan, np.float32)

    def paint(self, mask, depth, color, shade=None):
        col = color
        if shade is not None:
            col = np.asarray(color, np.float32) * shade[..., None]
        self.rgb = np.where(mask[..., None], np.asarray(col, np.float32), self.rgb)
        self.alpha |= mask
        self.depth = np.where(mask, np.float32(depth), self.depth)

    def paint_map(self, mask, depth_map, rgb_map):
        """Paint per-pixel depth (ramp) instead of a constant depth."""
        self.rgb = np.where(mask[..., None], rgb_map.astype(np.float32), self.rgb)
        self.alpha |= mask
        self.depth = np.where(mask, depth_map.astype(np.float32), self.depth)


def _finish(scene: Scene, canvas: _Canvas, back_rgb: np.ndarray,
            back_depth: np.ndarray, front_name: str, back_name: str,
            meta: dict | None = None) -> Scene:
    rgb_front = np.clip(canvas.rgb, 0, 255).astype(np.uint8)
    rgb_front[~canvas.alpha] = 0
    # Visible-surface background: no samples where the front layer covers it.
    back_d = np.where(np.isnan(canvas.depth), back_depth, np.nan).astype(np.float32)
    scene.layers = [
        Layer(rgb_front, canvas.depth, front_name, True),
        Layer(np.clip(back_rgb, 0, 255).astype(np.uint8), back_d, back_name, True),
    ]
    scene.meta.update(meta or {})
    return scene


# ---------------------------------------------------------------------------
# Preset A: "still life" -- fruit bowl, book, vase over a table
# ---------------------------------------------------------------------------


def make_still_life(size: tuple[int, int] = (360, 640)) -> Scene:
    """Still life: flat-coloured front objects at 0.50 m over a 1.00 m table.

    Known coordinates (pixel, origin top-left), used by the tests:
        bowl  centre (0.45H, 0.32W), radius 0.20H
        book  x [0.60W, 0.73W), y [0.55H, 0.72H)
        vase  x [0.82W, 0.88W), y [0.22H, 0.70H)
        all front depth = 0.50 m, back depth = 1.00 m
    The front layer is a single depth, so it is one coherent surface and the
    only disocclusions are the silhouettes against the table.
    """
    H, W = size
    scene = Scene(width=W, height=H, f_px=0.9 * W, layers=[], name="still_life")
    yy, xx = scene.yyxx()

    # ---- back layer: table with a woven runner and soft shadows --------
    back = np.empty((H, W, 3), np.float32)
    back[..., 0] = 46.0
    back[..., 1] = 52.0
    back[..., 2] = 62.0

    # wall gradient toward the top
    back += (yy / H * 26.0)[..., None] * np.array([1.0, 0.92, 0.82], np.float32)

    # runner band on the table
    runner = _rect(yy, xx, H * 0.58, H * 0.92, W * 0.08, W * 0.92)
    stripe = (((xx - W * 0.08) // 16).astype(np.int32) % 2).astype(np.float32)
    rcol = np.array([124.0, 78.0, 62.0], np.float32)[None, None, :] * (0.84 + 0.16 * stripe)[..., None]
    back = np.where(runner[..., None], rcol, back)

    # table shadow pool beneath the object group
    shadow = np.exp(-(((xx - W * 0.46) / (W * 0.30)) ** 2 +
                      ((yy - H * 0.78) / (H * 0.12)) ** 2))
    back *= (1.0 - 0.42 * shadow)[..., None]
    back_d = np.full((H, W), 1.00, np.float32)

    # ---- front layer: all objects at one depth --------------------------
    D = 0.50
    cv = _Canvas(H, W)

    bowl_c = (H * 0.45, W * 0.32)
    bowl_r = H * 0.20
    bowl = _disc(yy, xx, *bowl_c, bowl_r)
    cv.paint(bowl, D, (206, 212, 220),
             shade=_shade(yy, xx, bowl_c[0] - bowl_r * 0.4, bowl_c[1] - bowl_r * 0.4, bowl_r * 1.6))

    fruits = [
        (bowl_c[0] - bowl_r * 0.30, bowl_c[1] - bowl_r * 0.30, bowl_r * 0.34, (198, 76, 54)),
        (bowl_c[0] - bowl_r * 0.02, bowl_c[1] + bowl_r * 0.10, bowl_r * 0.40, (216, 158, 46)),
        (bowl_c[0] - bowl_r * 0.48, bowl_c[1] + bowl_r * 0.30, bowl_r * 0.30, (146, 72, 122)),
    ]
    for (fy, fx, fr, col) in fruits:
        fm = _disc(yy, xx, fy, fx, fr)
        cv.paint(fm, D, col, shade=_shade(yy, xx, fy - fr * 0.4, fx - fr * 0.4, fr * 1.7))

    book = _rect(yy, xx, H * 0.55, H * 0.72, W * 0.60, W * 0.73)
    cv.paint(book, D, (68, 128, 178),
             shade=1.0 - 0.25 * ((xx - W * 0.60) / (W * 0.13)))

    vase = _rect(yy, xx, H * 0.22, H * 0.70, W * 0.82, W * 0.88)
    cv.paint(vase, D, (152, 122, 96),
             shade=_shade(yy, xx, H * 0.22, W * 0.845, W * 0.09))

    return _finish(scene, cv, back, back_d,
                   "front (still life)", "back (table)",
                   {"front_depth": D, "back_depth": 1.00, "f_px": scene.f_px,
                    "bowl": bowl_c, "bowl_r": bowl_r})


# ---------------------------------------------------------------------------
# Preset B: single occluding square ("遮挡方片")
# ---------------------------------------------------------------------------


def make_slab(size: tuple[int, int] = (240, 360), *, depth_front=0.50, depth_back=1.00,
              rect=None) -> Scene:
    """Back plane + one axis-aligned square occluder with exact coordinates.

    rect is (y0, y1, x0, x1), default (60, 150, 120, 210).
    """
    H, W = size
    scene = Scene(width=W, height=H, f_px=0.9 * W, layers=[], name="slab")
    yy, xx = scene.yyxx()
    if rect is None:
        rect = (H // 4, int(H * 0.625), W // 3, int(W * 0.583))
    y0, y1, x0, x1 = rect

    back = np.empty((H, W, 3), np.uint8)
    back[..., 0] = 40 + (xx / W * 60).astype(np.uint8)
    back[..., 1] = 48 + (yy / H * 40).astype(np.uint8)
    back[..., 2] = 56 + ((xx.astype(np.int32) + yy.astype(np.int32)) % 16).astype(np.uint8)
    back_d = np.full((H, W), depth_back, np.float32)

    cv = _Canvas(H, W)
    m = _rect(yy, xx, y0, y1, x0, x1)
    cv.paint(m, depth_front, (230, 120, 40))   # saturated orange: obvious bleed

    return _finish(scene, cv, back, back_d,
                   "front (slab)", "back (plane)",
                   {"rect": rect, "depth_front": depth_front,
                    "depth_back": depth_back, "f_px": scene.f_px})


# ---------------------------------------------------------------------------
# Preset C: sloped depth ("斜坡深度")
# ---------------------------------------------------------------------------


def make_ramp(size: tuple[int, int] = (240, 360), *, near=0.45, far=1.15,
              strip=(0.20, 0.80), depth_back=None) -> Scene:
    """Tall slanted strip; depth varies linearly with x inside the strip.

        depth(x) = near + (far - near) * (x - x0) / (x1 - 1 - x0)

    The wall behind is at constant `depth_back` (default far + 0.40).  Holes at
    the strip's right edge (camera moving right) have a width set by the local
    depth, so the hole width changes along the edge -- a direct check of the
    projection derivative.
    """
    H, W = size
    depth_back = float(far + 0.40) if depth_back is None else depth_back
    scene = Scene(width=W, height=H, f_px=0.9 * W, layers=[], name="ramp")
    yy, xx = scene.yyxx()
    x0, x1 = int(strip[0] * W), int(strip[1] * W)

    t = (xx - x0) / max(x1 - 1 - x0, 1)
    depth = near + (far - near) * t
    depth = depth.astype(np.float32)

    rgb = np.empty((H, W, 3), np.uint8)
    rgb[..., 0] = np.clip(40 + 200 * t, 0, 255).astype(np.uint8)
    rgb[..., 1] = np.clip(110 + 45 * np.sin(yy / 12.0), 0, 255).astype(np.uint8)
    rgb[..., 2] = np.clip(230 - 190 * t, 0, 255).astype(np.uint8)

    back_rgb = np.empty((H, W, 3), np.float32)
    back_rgb[..., 0] = 26.0 + yy / H * 34.0
    back_rgb[..., 1] = 30.0 + yy / H * 38.0
    back_rgb[..., 2] = 44.0 + yy / H * 44.0
    cell = 20
    checker = (((xx // cell) + (yy // cell)) % 2).astype(np.float32)
    back_rgb *= (0.9 + 0.18 * checker)[..., None]
    back_d = np.full((H, W), depth_back, np.float32)

    strip_mask = _rect(yy, xx, 0, H, x0, x1)
    cv = _Canvas(H, W)
    cv.paint_map(strip_mask, depth, rgb)

    return _finish(scene, cv, back_rgb, back_d,
                   "front (ramp)", "back (wall)",
                   {"strip": (x0, x1), "near": near, "far": far,
                    "depth_back": depth_back, "depth_at": lambda x: float(near + (far - near) * (x - x0) / max(x1 - 1 - x0, 1)),
                    "f_px": scene.f_px})


PRESETS: dict[str, Callable[..., Scene]] = {
    "still_life": make_still_life,
    "slab": make_slab,
    "ramp": make_ramp,
}
