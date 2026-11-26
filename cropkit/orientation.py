"""EXIF orientation handling.

The whole tool works in *display* (upright) space.  The file on disk is in
*stored* space.  ``Orientation`` is the single place that knows how to go
between the two, for both pixels and integer pixel boundaries, so that no
other module has to reason about which corner flips where.

Orientation values follow the EXIF/TIFF Orientation tag (1..8).
Pillow's ``Transpose`` operations describe the way back from stored to
upright, which is exactly what ``pillow_op`` returns.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Tuple

from PIL import Image

# Human labels keyed by EXIF orientation value, indexed by display edge.
# "TL/TR/BL/BR" = top-left, top-right, bottom-left, bottom-right corners of
# the upright image.
LABELS = {
    1: "1 · 正常",
    2: "2 · 水平镜像",
    3: "3 · 旋转 180°",
    4: "4 · 垂直镜像",
    5: "5 · 转置 (镜像 + 旋转)",
    6: "6 · 旋转 90° 顺时针",
    7: "7 · 反置 (镜像 + 旋转)",
    8: "8 · 旋转 90° 逆时针",
}

# Which stored-space corner ends up in each display-space corner.
# Index 0 = TL, 1 = TR, 2 = BL, 3 = BR (display space).
# Each value is the stored-space corner ("TL" … "BR") that lands there.
DISPLAY_CORNER_SOURCES = {
    1: {"TL": "TL", "TR": "TR", "BL": "BL", "BR": "BR"},
    2: {"TL": "TR", "TR": "TL", "BL": "BR", "BR": "BL"},
    3: {"TL": "BR", "TR": "BL", "BL": "TR", "BR": "TL"},
    4: {"TL": "BL", "TR": "BR", "BL": "TL", "BR": "TR"},
    5: {"TL": "TL", "TR": "BL", "BL": "TR", "BR": "BR"},
    6: {"TL": "BL", "TR": "TL", "BL": "BR", "BR": "TR"},
    7: {"TL": "BR", "TR": "TR", "BL": "BL", "BR": "TL"},
    8: {"TL": "TR", "TR": "BR", "BL": "TL", "BR": "BL"},
}

_OPS = {
    1: None,
    2: Image.Transpose.FLIP_LEFT_RIGHT,
    3: Image.Transpose.ROTATE_180,
    4: Image.Transpose.FLIP_TOP_BOTTOM,
    5: Image.Transpose.TRANSPOSE,
    6: Image.Transpose.ROTATE_270,
    7: Image.Transpose.TRANSVERSE,
    8: Image.Transpose.ROTATE_90,
}

# True when the stored width becomes the display height.
SWAPS_AXES = {5, 6, 7, 8}
MIRRORED = {2, 4, 5, 7}

HORIZONTAL_EDGES = ("left", "right")
VERTICAL_EDGES = ("top", "bottom")


def normalize(value) -> int:
    """Clamp an arbitrary EXIF value into 1..8 (0/None/unknown -> 1)."""
    try:
        v = int(value)
    except (TypeError, ValueError):
        return 1
    return v if 1 <= v <= 8 else 1


@dataclass(frozen=True)
class Orientation:
    value: int = 1

    def __post_init__(self) -> None:
        object.__setattr__(self, "value", normalize(self.value))

    # -- geometry ---------------------------------------------------------
    @property
    def swaps_axes(self) -> bool:
        return self.value in SWAPS_AXES

    @property
    def mirrored(self) -> bool:
        return self.value in MIRRORED

    @property
    def label(self) -> str:
        return LABELS[self.value]

    def stored_size(self, display_size: Tuple[int, int]) -> Tuple[int, int]:
        w, h = display_size
        return (h, w) if self.swaps_axes else (w, h)

    def display_size(self, stored_size: Tuple[int, int]) -> Tuple[int, int]:
        # The transform is its own inverse for sizes.
        return self.stored_size(stored_size)

    # -- pixels -----------------------------------------------------------
    @property
    def pillow_op(self):
        return _OPS[self.value]

    def to_display(self, img: Image.Image) -> Image.Image:
        op = self.pillow_op
        return img.copy() if op is None else img.transpose(op)

    def to_stored_mapping(self, display_point, display_size) -> Tuple[int, int]:
        """A display pixel coordinate (top-left origin) -> stored pixel.

        Coordinates are treated as *pixel centres*: passing the top-left
        integer coordinate of a pixel returns the top-left integer
        coordinate of the stored pixel that holds it.
        """
        op = self.pillow_op
        X, Y = display_point
        if op is None:
            return X, Y
        if op == Image.Transpose.FLIP_LEFT_RIGHT:
            ww, hh = display_size
            return ww - X - 1, Y
        if op == Image.Transpose.FLIP_TOP_BOTTOM:
            ww, hh = display_size
            return X, hh - Y - 1
        if op == Image.Transpose.ROTATE_180:
            ww, hh = display_size
            return ww - X - 1, hh - Y - 1
        if op == Image.Transpose.ROTATE_270:  # stored = display rotated 90° CW
            ww, hh = display_size
            return Y, ww - X - 1
        if op == Image.Transpose.ROTATE_90:   # stored = display rotated 90° CCW
            ww, hh = display_size
            return hh - Y - 1, X
        if op == Image.Transpose.TRANSPOSE:   # stored(x,y) = (X,Y) swapped
            return Y, X
        if op == Image.Transpose.TRANSVERSE:  # transpose + 180
            ww, hh = display_size
            return hh - Y - 1, ww - X - 1
        raise AssertionError("unreachable")

    def from_stored_mapping(self, stored_point, display_size) -> Tuple[float, float]:
        """Inverse of ``to_stored_mapping`` for pixel centres."""
        op = self.pillow_op
        sx, sy = stored_point
        ww, hh = display_size
        if op is None:
            return sx, sy
        if op == Image.Transpose.FLIP_LEFT_RIGHT:
            return ww - sx - 1, sy
        if op == Image.Transpose.FLIP_TOP_BOTTOM:
            return sx, hh - sy - 1
        if op == Image.Transpose.ROTATE_180:
            return ww - sx - 1, hh - sy - 1
        if op == Image.Transpose.ROTATE_270:
            return ww - sy - 1, sx
        if op == Image.Transpose.ROTATE_90:
            return sy, hh - sx - 1
        if op == Image.Transpose.TRANSPOSE:
            return sy, sx
        if op == Image.Transpose.TRANSVERSE:
            return ww - sy - 1, hh - sx - 1
        raise AssertionError("unreachable")

    # -- boundaries -------------------------------------------------------
    def display_edge_is_stored_horizontal(self, edge: str) -> bool:
        """Whether a display-space vertical (left/right) edge stays vertical
        in stored space.  Only used for diagnostics."""
        if edge in HORIZONTAL_EDGES:
            return not self.swaps_axes
        return self.swaps_axes

    def display_points_to_stored(self, points, display_size):
        return [self.to_stored_mapping(p, display_size) for p in points]

    def corner_sources(self) -> dict:
        """display corner -> stored corner"""
        return dict(DISPLAY_CORNER_SOURCES[self.value])

    def stored_corner_targets(self) -> dict:
        """stored corner -> display corner (inverse of corner_sources)."""
        return {v: k for k, v in DISPLAY_CORNER_SOURCES[self.value].items()}

    # -- negative sizes ---------------------------------------------------
    def display_rect_to_stored(self, rect, display_size):
        from cropkit.rectmath import Rect

        r = rect.normalized()
        x0, y0 = self.to_stored_mapping((r.x0, r.y0), display_size)
        x1, y1 = self.to_stored_mapping((r.x1 - 1, r.y1 - 1), display_size)
        return Rect.from_size(min(x0, x1), min(y0, y1),
                              abs(x1 - x0) + 1, abs(y1 - y0) + 1)

    def stored_rect_to_display(self, rect, display_size):
        from cropkit.rectmath import Rect

        r = rect.normalized()
        x0, y0 = self.from_stored_mapping((r.x0, r.y0), display_size)
        x1, y1 = self.from_stored_mapping((r.x1 - 1, r.y1 - 1), display_size)
        return Rect.from_size(min(x0, x1), min(y0, y1),
                              abs(x1 - x0) + 1, abs(y1 - y0) + 1)


def as_orientation(value) -> Orientation:
    return value if isinstance(value, Orientation) else Orientation(value)
