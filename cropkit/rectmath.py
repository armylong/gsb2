"""Integer rectangle maths.

Every crop is expressed as a half-open integer rectangle ``[x0, x1) x
[y0, y1)`` in upright (display) image coordinates.  Keeping rectangles as
integers, and deriving ``size`` from the two edges rather than storing it,
is what guarantees that a crop rect stays exactly ``w`` wide no matter how
the preview is scaled: preview and export both start from the same two
integers.

Floating point is used only while dragging; it is converted at the boundary
by ``Rect.from_floats``.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Tuple


@dataclass(frozen=True)
class Rect:
    x0: int
    y0: int
    x1: int  # exclusive
    y1: int  # exclusive

    # -- construction -----------------------------------------------------
    @classmethod
    def from_floats(cls, x, y, w, h) -> "Rect":
        x0 = int(round(x))
        y0 = int(round(y))
        x1 = int(round(x + w))
        y1 = int(round(y + h))
        return cls(x0, y0, max(x0, x1), max(y0, y1))

    @classmethod
    def from_size(cls, x: int, y: int, w: int, h: int) -> "Rect":
        return cls(x, y, x + w, y + h)

    # -- accessors --------------------------------------------------------
    @property
    def width(self) -> int:
        return self.x1 - self.x0

    @property
    def height(self) -> int:
        return self.y1 - self.y0

    @property
    def size(self) -> Tuple[int, int]:
        return self.width, self.height

    @property
    def area(self) -> int:
        return self.width * self.height

    @property
    def cx(self) -> float:
        return (self.x0 + self.x1) / 2

    @property
    def cy(self) -> float:
        return (self.y0 + self.y1) / 2

    def as_tuple(self) -> Tuple[int, int, int, int]:
        return self.x0, self.y0, self.width, self.height

    def corners(self) -> Tuple[Tuple[int, int], ...]:
        return (
            (self.x0, self.y0),
            (self.x1 - 1, self.y0),
            (self.x0, self.y1 - 1),
            (self.x1 - 1, self.y1 - 1),
        )

    def contains(self, px, py) -> bool:
        return self.x0 <= px < self.x1 and self.y0 <= py < self.y1

    def intersects(self, other: "Rect") -> bool:
        return (
            self.x0 < other.x1
            and other.x0 < self.x1
            and self.y0 < other.y1
            and other.y0 < self.y1
        )

    # -- derived rectangles ----------------------------------------------
    def normalized(self) -> "Rect":
        return Rect(
            min(self.x0, self.x1),
            min(self.y0, self.y1),
            max(self.x0, self.x1),
            max(self.y0, self.y1),
        )

    def translated(self, dx: int, dy: int) -> "Rect":
        return Rect(self.x0 + dx, self.y0 + dy, self.x1 + dx, self.y1 + dy)

    def resized(self, x0, y0, x1, y1) -> "Rect":
        return Rect(x0, y0, max(x0, x1), max(y0, y1))

    def clamped_to(self, width: int, height: int) -> "Rect":
        """Clip to the image, keeping the size when it fits."""
        r = self.normalized()
        w = min(r.width, width)
        h = min(r.height, height)
        x0 = min(max(r.x0, 0), width - w)
        y0 = min(max(r.y0, 0), height - h)
        return Rect(x0, y0, x0 + w, y0 + h)

    def clipped_to(self, width: int, height: int) -> "Rect":
        """Intersection with the image; an over-large rect shrinks."""
        r = self.normalized()
        x0 = min(max(r.x0, 0), width)
        y0 = min(max(r.y0, 0), height)
        x1 = min(max(r.x1, 0), width)
        y1 = min(max(r.y1, 0), height)
        if x1 <= x0:
            x1 = min(x0 + 1, width)
        if y1 <= y0:
            y1 = min(y0 + 1, height)
        return Rect(x0, y0, x1, y1)

    def clamped_position(self, width: int, height: int) -> "Rect":
        """Move (never resize) to sit inside the image when possible."""
        r = self.normalized()
        x0 = min(max(r.x0, min(0, width - r.width)), max(0, width - r.width))
        y0 = min(max(r.y0, min(0, height - r.height)), max(0, height - r.height))
        return Rect(x0, y0, x0 + r.width, y0 + r.height)

    def with_size_about_center(self, w: int, h: int) -> "Rect":
        cx = int(round(self.cx))
        cy = int(round(self.cy))
        x0 = cx - w // 2
        y0 = cy - h // 2
        return Rect(x0, y0, x0 + w, y0 + h)

    def inset(self, amount: int) -> "Rect":
        amount = min(amount, (self.width - 1) // 2, (self.height - 1) // 2)
        return Rect(self.x0 + amount, self.y0 + amount,
                    self.x1 - amount, self.y1 - amount)

    # -- serialisation ----------------------------------------------------
    def to_dict(self) -> dict:
        return {"x": self.x0, "y": self.y0, "w": self.width, "h": self.height}

    @classmethod
    def from_dict(cls, d) -> "Rect":
        return cls.from_size(int(d["x"]), int(d["y"]), int(d["w"]), int(d["h"]))


def parse_ratio(text: str):
    """``"4:3"`` / ``"4/3"`` / ``"1.5"`` -> (4.0, 3.0) or None."""
    if not text:
        return None
    text = text.strip().replace("/", ":").replace("：", ":")
    if ":" in text:
        a, _, b = text.partition(":")
        try:
            a_f, b_f = float(a), float(b)
        except ValueError:
            return None
    else:
        try:
            a_f, b_f = float(text), 1.0
        except ValueError:
            return None
    if a_f <= 0 or b_f <= 0:
        return None
    return a_f, b_f


def tighten(r: Rect, ratio: Tuple[float, float], mode: str = "center") -> Rect:
    """Shrink ``r`` to the given aspect ratio without leaving the rect.

    The result has the largest size whose ratio matches and that fits
    inside ``r``; at least 1x1 pixels is returned.
    """
    a, b = ratio
    target = a / b
    w, h = max(1, r.width), max(1, r.height)
    if w / h > target:          # too wide -> narrow it
        new_w = max(1, int(round(h * target)))
        new_h = h
    else:                       # too tall -> shorten it
        new_w = w
        new_h = max(1, int(round(w / target)))
    new_w = min(new_w, w)
    new_h = min(new_h, h)
    if mode == "center":
        x0 = r.x0 + (w - new_w) // 2
        y0 = r.y0 + (h - new_h) // 2
    else:                       # "area": keep the top-left corner
        x0, y0 = r.x0, r.y0
    return Rect(x0, y0, x0 + new_w, y0 + new_h)


def union(rects: Iterable[Rect]) -> Rect | None:
    rects = list(rects)
    if not rects:
        return None
    return Rect(
        min(r.x0 for r in rects),
        min(r.y0 for r in rects),
        max(r.x1 for r in rects),
        max(r.y1 for r in rects),
    )


# Handle indices used by the canvas: 0 TL, 1 T, 2 TR, 3 L, 4 R, 5 BL, 6 B, 7 BR
HANDLES = ("tl", "t", "tr", "l", "r", "bl", "b", "br")


def _clamp(v, lo, hi):
    return max(lo, min(hi, v))


def resize_handle(rect: Rect, handle: int, dx: float, dy: float,
                  ratio=None, bounds=None, min_size: int = 1) -> Rect:
    """Resize ``rect`` by dragging ``handle`` by (dx, dy) image pixels.

    The opposite edge/corner is the anchor and stays put.  With ``ratio``
    (a, b) the dragged dimension drives the other: corner drags follow the
    dimension that moved more, side drags fix the perpendicular size.
    ``bounds`` (w, h) clips the result into the image.
    """
    x0, y0, x1, y1 = rect.x0, rect.y0, rect.x1, rect.y1
    left = handle in (0, 3, 5)
    right = handle in (2, 4, 7)
    top = handle in (0, 1, 2)
    bottom = handle in (5, 6, 7)

    if left:
        x0 = min(x0 + dx, x1 - min_size)
    elif right:
        x1 = max(x1 + dx, x0 + min_size)
    if top:
        y0 = min(y0 + dy, y1 - min_size)
    elif bottom:
        y1 = max(y1 + dy, y0 + min_size)

    if bounds:
        bw, bh = bounds
        x0 = _clamp(x0, 0, bw)
        x1 = _clamp(x1, 0, bw)
        y0 = _clamp(y0, 0, bh)
        y1 = _clamp(y1, 0, bh)
        if x1 - x0 < min_size:
            x1 = min(bw, x0 + min_size)
            x0 = max(0, x1 - min_size)
        if y1 - y0 < min_size:
            y1 = min(bh, y0 + min_size)
            y0 = max(0, y1 - min_size)

    if not ratio:
        return Rect(x0, y0, x1, y1)

    a, b = ratio
    target = a / b
    w, h = x1 - x0, y1 - y0
    corner = (left or right) and (top or bottom)
    if corner:
        start_w = max(rect.width, 1)
        start_h = max(rect.height, 1)
        if abs(w - start_w) / start_w >= abs(h - start_h) / start_h:
            new_w = max(min_size, w)
            new_h = max(min_size, int(round(new_w / target)))
        else:
            new_h = max(min_size, h)
            new_w = max(min_size, int(round(new_h * target)))
    elif left or right:
        # the dragged (horizontal) size drives the height
        new_w = max(min_size, w)
        new_h = max(min_size, int(round(new_w / target)))
    else:  # pure top/bottom drag drives the width
        new_h = max(min_size, h)
        new_w = max(min_size, int(round(new_h * target)))

    if bounds:
        bw, bh = bounds
        # shrink proportionally until it fits
        factor = min(1.0, bw / new_w if new_w else 1.0,
                     bh / new_h if new_h else 1.0)
        if factor < 1.0:
            new_w = max(min_size, int(round(new_w * factor)))
            new_h = max(min_size, int(round(new_w / target)))

    nx0 = x1 - new_w if left else x0
    if not left and not right:
        nx0 = int(round((x0 + x1) / 2 - new_w / 2))
    ny0 = y1 - new_h if top else y0
    if not top and not bottom:
        ny0 = int(round((y0 + y1) / 2 - new_h / 2))

    if bounds:
        bw, bh = bounds
        nx0 = _clamp(nx0, 0, max(0, bw - new_w))
        ny0 = _clamp(ny0, 0, max(0, bh - new_h))
        new_w = min(new_w, bw)
        new_h = min(new_h, bh)
    return Rect(nx0, ny0, nx0 + new_w, ny0 + new_h)


def handle_at(rect: Rect, x: float, y: float, tol: float) -> int | None:
    """Which resize handle (if any) is within ``tol`` of the point."""
    x0, y0, x1, y1 = rect.x0, rect.y0, rect.x1, rect.y1
    mx, my = (x0 + x1) / 2, (y0 + y1) / 2
    spots = [(x0, y0), (mx, y0), (x1, y0), (x0, my),
             (x1, my), (x0, y1), (mx, y1), (x1, y1)]
    best, best_d = None, tol
    for i, (hx, hy) in enumerate(spots):
        d = max(abs(x - hx), abs(y - hy))
        if d <= best_d:
            best, best_d = i, d
    return best


def anchor_rect(anchor: Rect, x: float, y: float) -> Rect:
    """A drag-born rectangle whose anchor corner is fixed during a drag.

    The two corner coordinates are kept un-normalised so a drag back across
    the anchor keeps following the pointer instead of jumping.
    """
    return Rect(int(round(anchor.x0)), int(round(anchor.y0)),
                int(round(x)), int(round(y)))
