"""User constraint layers and undo/redo stroke history.

Three labels are kept in a single ``uint8`` map (``LabelMap``):

======  ======  ============================================================
value   name    meaning
======  ======  ============================================================
0       NONE    unknown / to be decided by the matting algorithm
1       FG      definite foreground (must end up opaque)
2       BG      definite background (must end up transparent)
3       ERASE   only meaningful inside a stroke; it clears labels back to
                NONE.  It is never stored in the committed label map (the
                committed map only ever contains 0, 1 and 2).
======  ======  ============================================================

A ``Stroke`` is one continuous press-drag-release gesture.  Strokes are the
unit of undo/redo.  Undo/redo is implemented by replaying the stroke table from
an empty label map, which keeps the history exact even when a stroke partially
overlaps earlier strokes of a different class.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import IntEnum
from typing import Iterable, Iterator

import cv2
import numpy as np

# Label values stored in the committed map.
NONE = 0
FG = 1
BG = 2
ERASE = 3  # only meaningful as a stroke kind; never stored in the label map

LABEL_NAMES = {NONE: "unknown", FG: "foreground", BG: "background"}


class Tool(IntEnum):
    """Tool selected in the UI.  FG/BG/ERASE values double as stroke kinds."""

    BOX = 0  # drag a rectangle around the subject
    FG = FG
    BG = BG
    ERASE = ERASE


@dataclass
class Stroke:
    """One continuous brush gesture, stored as a polyline in *original* image pixels."""

    kind: int  # FG / BG / ERASE
    radius: float  # brush radius in original image pixels
    points: list[tuple[float, float]] = field(default_factory=list)

    def append(self, x: float, y: float) -> bool:
        """Add a point; returns True when it is far enough from the previous one."""
        if self.points:
            px, py = self.points[-1]
            if (px - x) ** 2 + (py - y) ** 2 < 0.35:
                return False
        self.points.append((float(x), float(y)))
        return True


def _round_half_away(v: float) -> int:
    return int(np.floor(v + 0.5))


class LabelMap:
    """Committed per-pixel constraints where each user gesture overwrites earlier ones."""

    def __init__(self, height: int, width: int):
        self.height = int(height)
        self.width = int(width)
        self.data = np.zeros((self.height, self.width), np.uint8)

    def copy(self) -> "LabelMap":
        other = LabelMap(self.height, self.width)
        other.data = self.data.copy()
        return other

    # ------------------------------------------------------------------ queries
    def count(self, label: int) -> int:
        return int(np.count_nonzero(self.data == label))

    def has_effective_fg(self) -> bool:
        return self.count(FG) > 0

    def has_effective_bg(self) -> bool:
        return self.count(BG) > 0

    # ----------------------------------------------------------------- painting
    def apply_stroke(self, stroke: Stroke) -> None:
        """Rasterise ``stroke`` into the committed map in place."""
        if not stroke.points:
            return
        pts = np.asarray(
            [(_round_half_away(x), _round_half_away(y)) for x, y in stroke.points],
            np.int32,
        ).reshape(-1, 1, 2)
        radius = max(1, _round_half_away(stroke.radius))
        scratch = np.zeros((self.height, self.width), np.uint8)
        if len(pts) == 1:
            cv2.circle(scratch, tuple(int(v) for v in pts[0, 0]), radius, 1, -1, cv2.LINE_8)
        else:
            cv2.polylines(scratch, [pts], False, 1, max(1, radius * 2), cv2.LINE_8)
            # Round caps so short taps and stroke ends look like a brush.
            cv2.circle(scratch, tuple(int(v) for v in pts[0, 0]), radius, 1, -1, cv2.LINE_8)
            cv2.circle(scratch, tuple(int(v) for v in pts[-1, 0]), radius, 1, -1, cv2.LINE_8)
        hit = scratch.astype(bool)
        if stroke.kind == ERASE:
            self.data[hit] = NONE
        elif stroke.kind in (FG, BG):
            self.data[hit] = stroke.kind
        else:
            raise ValueError(f"unknown stroke kind {stroke.kind}")


class StrokeHistory:
    """Append-only stroke table with undo/redo cursors and label replay.

    Undo marks strokes inactive and rewinds the cursor; redo moves the cursor
    forward.  The committed label map is rebuilt by replaying active strokes in
    order.  A new stroke after an undo discards the redo tail.
    """

    def __init__(self, height: int, width: int, max_strokes: int = 500):
        self.height = int(height)
        self.width = int(width)
        self.max_strokes = int(max_strokes)
        self.strokes: list[Stroke] = []
        self.cursor = 0  # number of active strokes
        self._labels = LabelMap(self.height, self.width)
        self._replay_all()

    # --------------------------------------------------------------- properties
    def __len__(self) -> int:
        return self.cursor

    def strokes_count(self) -> int:
        return len(self.strokes)

    @property
    def labels(self) -> LabelMap:
        return self._labels

    def can_undo(self) -> bool:
        return self.cursor > 0

    def can_redo(self) -> bool:
        return self.cursor < len(self.strokes)

    def undo_label(self) -> str | None:
        if not self.can_undo():
            return None
        kind = self.strokes[self.cursor - 1].kind
        return {FG: "确定前景", BG: "确定背景", ERASE: "擦除"}.get(kind)

    def redo_label(self) -> str | None:
        if not self.can_redo():
            return None
        kind = self.strokes[self.cursor].kind
        return {FG: "确定前景", BG: "确定背景", ERASE: "擦除"}.get(kind)

    # ---------------------------------------------------------------- mutation
    def push(self, stroke: Stroke) -> bool:
        """Commit one finished gesture.  Returns False when it was empty."""
        if not stroke.points:
            return False
        del self.strokes[self.cursor:]
        self.strokes.append(stroke)
        self.cursor = len(self.strokes)
        if len(self.strokes) > self.max_strokes:
            drop = len(self.strokes) - self.max_strokes
            del self.strokes[:drop]
            self.cursor = len(self.strokes)
            self._replay_all()
        else:
            self._labels.apply_stroke(stroke)
        return True

    def undo(self) -> bool:
        if not self.can_undo():
            return False
        self.cursor -= 1
        self._replay_all()
        return True

    def redo(self) -> bool:
        if not self.can_redo():
            return False
        self.cursor += 1
        self._replay_all()
        return True

    def clear(self) -> None:
        self.strokes.clear()
        self.cursor = 0
        self._labels = LabelMap(self.height, self.width)

    # ---------------------------------------------------------------- internals
    def _replay_all(self) -> None:
        labels = LabelMap(self.height, self.width)
        for stroke in self.strokes[: self.cursor]:
            labels.apply_stroke(stroke)
        self._labels = labels

    # ------------------------------------------------------------ serialisation
    def to_json(self) -> list[dict]:
        out = []
        for stroke in self.strokes[: self.cursor]:
            out.append(
                {
                    "kind": int(stroke.kind),
                    "radius": round(float(stroke.radius), 2),
                    "points": [[round(float(x), 1), round(float(y), 1)] for x, y in stroke.points],
                }
            )
        return out

    def load_json(self, raw: Iterable[dict]) -> int:
        """Replace all strokes with ``raw``.  Returns number of strokes loaded."""
        self.clear()
        loaded = 0
        for item in raw:
            try:
                kind = int(item["kind"])
                radius = float(item["radius"])
                pts = [(float(p[0]), float(p[1])) for p in item["points"]]
            except (KeyError, TypeError, ValueError, IndexError):
                continue
            if kind not in (FG, BG, ERASE) or not pts:
                continue
            stroke = Stroke(kind=kind, radius=max(1.0, radius), points=pts)
            self.strokes.append(stroke)
            loaded += 1
        self.cursor = len(self.strokes)
        self._replay_all()
        return loaded

    def iter_active(self) -> Iterator[Stroke]:
        return iter(self.strokes[: self.cursor])


def draw_stroke_preview(
    canvas: np.ndarray,
    stroke: Stroke,
    *,
    color_bgr: tuple[int, int, int],
    alpha: float = 0.55,
) -> None:
    """Draw an in-progress stroke onto a BGR uint8 canvas (viewer helper)."""
    if not stroke.points:
        return
    overlay = canvas.copy()
    pts = np.asarray(
        [(_round_half_away(x), _round_half_away(y)) for x, y in stroke.points], np.int32
    ).reshape(-1, 1, 2)
    radius = max(1, _round_half_away(stroke.radius))
    if len(pts) == 1:
        cv2.circle(overlay, tuple(int(v) for v in pts[0, 0]), radius, color_bgr, -1, cv2.LINE_8)
    else:
        cv2.polylines(overlay, [pts], False, color_bgr, max(1, radius * 2), cv2.LINE_8)
        cv2.circle(overlay, tuple(int(v) for v in pts[0, 0]), radius, color_bgr, -1, cv2.LINE_8)
        cv2.circle(overlay, tuple(int(v) for v in pts[-1, 0]), radius, color_bgr, -1, cv2.LINE_8)
    cv2.addWeighted(overlay, alpha, canvas, 1.0 - alpha, 0, canvas)


def stroke_mask(stroke: Stroke, height: int, width: int) -> np.ndarray:
    """Boolean mask of pixels touched by ``stroke`` (used by self-checks)."""
    labels = LabelMap(height, width)
    labels.apply_stroke(stroke)
    return labels.data != NONE
