"""Pure geometry for the preview pyramid and its tiles.

Coordinate conventions used throughout:

* A pixel rectangle ``Rect(x, y, w, h)`` covers the half-open ranges
  ``[x, x + w)`` and ``[y, y + h)``.  ``x``/``y`` are the top-left pixel of
  the region, never a continuous coordinate.
* Every level owns a *core* rectangle per tile.  The union of all core
  rectangles is exactly the level image: nothing is dropped and nothing is
  duplicated.  A tile may additionally store a margin around its core so
  filtering/sampling code has neighbouring pixels available.  Margins are
  clipped at the level borders and are not part of the official tile area.
* Level dimensions are derived with ceiling division, so the last preview
  level keeps the last valid pixel of an odd-sized image.
"""

from __future__ import annotations

import math
from collections.abc import Iterator, Sequence
from dataclasses import dataclass

__all__ = [
    "Rect",
    "TileSpec",
    "LevelGeometry",
    "level_sizes",
    "choose_level_for_zoom",
    "choose_display_level",
    "fit_zoom",
    "map_original_to_level",
    "map_level_to_original",
]


@dataclass(frozen=True, slots=True)
class Rect:
    """An integer pixel rectangle in top-left/size form."""

    x: int
    y: int
    w: int
    h: int

    def __post_init__(self) -> None:
        if self.w < 0 or self.h < 0:
            raise ValueError(f"rectangle size must be non-negative: {self}")

    @property
    def x2(self) -> int:
        return self.x + self.w

    @property
    def y2(self) -> int:
        return self.y + self.h

    @property
    def is_empty(self) -> bool:
        return self.w == 0 or self.h == 0

    def intersects(self, other: Rect) -> bool:
        return not (
            self.x2 <= other.x
            or other.x2 <= self.x
            or self.y2 <= other.y
            or other.y2 <= self.y
        )

    def clipped_to(self, bounds: Rect) -> Rect:
        x0 = max(self.x, bounds.x)
        y0 = max(self.y, bounds.y)
        x1 = min(self.x2, bounds.x2)
        y1 = min(self.y2, bounds.y2)
        if x0 >= x1 or y0 >= y1:
            return Rect(0, 0, 0, 0)
        return Rect(x0, y0, x1 - x0, y1 - y0)

    def contains_pixel(self, x: int, y: int) -> bool:
        return self.x <= x < self.x2 and self.y <= y < self.y2


@dataclass(frozen=True, slots=True)
class TileSpec:
    """One tile of a level, with core and margin-expanded full regions."""

    col: int
    row: int
    core: Rect
    full: Rect

    @property
    def core_offset_in_full(self) -> tuple[int, int]:
        return self.core.x - self.full.x, self.core.y - self.full.y

    @property
    def left_margin(self) -> int:
        return self.core.x - self.full.x

    @property
    def top_margin(self) -> int:
        return self.core.y - self.full.y

    @property
    def right_margin(self) -> int:
        return self.full.x2 - self.core.x2

    @property
    def bottom_margin(self) -> int:
        return self.full.y2 - self.core.y2


@dataclass(frozen=True, slots=True)
class LevelGeometry:
    """Tile geometry for one level."""

    width: int
    height: int
    tile_size: int
    margin: int = 0

    def __post_init__(self) -> None:
        if self.width <= 0 or self.height <= 0:
            raise ValueError("level dimensions must be positive")
        if self.tile_size <= 0:
            raise ValueError("tile_size must be positive")
        if self.margin < 0:
            raise ValueError("margin must be non-negative")
        if self.margin >= self.tile_size:
            raise ValueError("margin must be smaller than tile_size")

    @property
    def cols(self) -> int:
        return math.ceil(self.width / self.tile_size)

    @property
    def rows(self) -> int:
        return math.ceil(self.height / self.tile_size)

    @property
    def tile_count(self) -> int:
        return self.cols * self.rows

    @property
    def bounds(self) -> Rect:
        return Rect(0, 0, self.width, self.height)

    def core_rect(self, col: int, row: int) -> Rect:
        if not (0 <= col < self.cols and 0 <= row < self.rows):
            raise IndexError(f"tile ({col}, {row}) outside {self.cols}x{self.rows}")
        x0 = col * self.tile_size
        y0 = row * self.tile_size
        x1 = min(self.width, x0 + self.tile_size)
        y1 = min(self.height, y0 + self.tile_size)
        return Rect(x0, y0, x1 - x0, y1 - y0)

    def full_rect(self, col: int, row: int) -> Rect:
        core = self.core_rect(col, row)
        x0 = max(0, core.x - self.margin)
        y0 = max(0, core.y - self.margin)
        x1 = min(self.width, core.x2 + self.margin)
        y1 = min(self.height, core.y2 + self.margin)
        return Rect(x0, y0, x1 - x0, y1 - y0)

    def tile(self, col: int, row: int) -> TileSpec:
        return TileSpec(
            col=col,
            row=row,
            core=self.core_rect(col, row),
            full=self.full_rect(col, row),
        )

    def iter_tiles(self) -> Iterator[TileSpec]:
        for row in range(self.rows):
            for col in range(self.cols):
                yield self.tile(col, row)

    def tile_index_at(self, x: int, y: int) -> tuple[int, int] | None:
        """Return ``(col, row)`` for a level pixel, or ``None`` outside."""
        if not (0 <= x < self.width and 0 <= y < self.height):
            return None
        return x // self.tile_size, y // self.tile_size

    def tiles_intersecting(self, region: Rect) -> Iterator[TileSpec]:
        clipped = region.clipped_to(self.bounds)
        if clipped.is_empty:
            return
        col0 = clipped.x // self.tile_size
        col1 = (clipped.x2 - 1) // self.tile_size
        row0 = clipped.y // self.tile_size
        row1 = (clipped.y2 - 1) // self.tile_size
        for row in range(row0, row1 + 1):
            for col in range(col0, col1 + 1):
                yield self.tile(col, row)


def level_sizes(
    width: int,
    height: int,
    min_size: int = 256,
    max_levels: int = 10,
) -> list[tuple[int, int]]:
    """Build a half-resolution pyramid, largest first.

    Level 0 is the original size.  Each following level uses ceiling
    division and therefore never rounds away the far edge of an odd-sized
    image.  Levels stop when both axes are at most ``min_size`` or after
    ``max_levels`` entries.
    """
    if width <= 0 or height <= 0:
        raise ValueError("image dimensions must be positive")
    if min_size <= 0:
        raise ValueError("min_size must be positive")
    if max_levels <= 0:
        raise ValueError("max_levels must be positive")

    sizes = [(width, height)]
    w, h = width, height
    while len(sizes) < max_levels and max(w, h) > min_size:
        nw = max(1, (w + 1) // 2)
        nh = max(1, (h + 1) // 2)
        if (nw, nh) == (w, h):
            break
        sizes.append((nw, nh))
        w, h = nw, nh
    return sizes


def choose_level_for_zoom(
    sizes: Sequence[tuple[int, int]],
    original_width: int,
    original_height: int,
    zoom: float,
) -> int:
    """Pick the finest level that still has at least the requested density.

    ``zoom`` is widget pixels per *original* pixel.  Preferring a level that
    is then minified avoids inventing pixels during normal zoom-out; zooming
    in past 1:1 stays on level 0.
    """
    if original_width <= 0 or original_height <= 0:
        raise ValueError("original dimensions must be positive")
    if zoom <= 0:
        raise ValueError("zoom must be positive")
    chosen = 0
    for index, (w, h) in enumerate(sizes):
        scale = min(w / original_width, h / original_height)
        if scale >= zoom:
            chosen = index
        else:
            break
    return chosen


def choose_display_level(
    sizes: Sequence[tuple[int, int]],
    available: Sequence[int],
    original_width: int,
    zoom: float,
) -> int | None:
    """Pick the best *available* level for the current zoom.

    Unlike :func:`choose_level_for_zoom` (which answers "how fine should a
    level be for perfect 1:1 texels"), this works with a possibly sparse set
    of generated levels.  It minimises the log distance between the level's
    scale and the requested screen scale, preferring a slightly minified
    level over a magnified one on ties.
    """
    if not available:
        return None
    if original_width <= 0 or zoom <= 0:
        raise ValueError("original width and zoom must be positive")

    def cost(index: int) -> tuple[float, int]:
        scale = sizes[index][0] / original_width
        return (abs(math.log(scale / zoom)), -index)

    return min(available, key=cost)


def fit_zoom(
    view_width: float,
    view_height: float,
    image_width: int,
    image_height: int,
    padding: float = 0.0,
) -> float:
    """Zoom that shows the whole image inside the viewport."""
    if image_width <= 0 or image_height <= 0:
        raise ValueError("image dimensions must be positive")
    available_w = max(1.0, view_width - 2.0 * padding)
    available_h = max(1.0, view_height - 2.0 * padding)
    return min(available_w / image_width, available_h / image_height)


def map_original_to_level(
    x: float,
    y: float,
    original_width: int,
    original_height: int,
    level_width: int,
    level_height: int,
) -> tuple[float, float]:
    """Map a continuous original-image coordinate into level coordinates."""
    if original_width <= 0 or original_height <= 0:
        raise ValueError("original dimensions must be positive")
    return (
        x * (level_width / original_width),
        y * (level_height / original_height),
    )


def map_level_to_original(
    x: float,
    y: float,
    level_width: int,
    level_height: int,
    original_width: int,
    original_height: int,
) -> tuple[float, float]:
    """Inverse of :func:`map_original_to_level`."""
    if level_width <= 0 or level_height <= 0:
        raise ValueError("level dimensions must be positive")
    return (
        x * (original_width / level_width),
        y * (original_height / level_height),
    )
