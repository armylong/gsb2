"""Mask painting model (no Qt dependency, fully testable).

The mask is a float32 ``H×W`` array in [0, 1] where 1 means "take image A"
and 0 means "take image B".  The initial/unpainted value is 0.5.

Brushes paint *towards* a target value (1 for A, 0 for B, 0.5 for erase) with
a soft radial profile, so repeated strokes converge to the target instead of
overshooting.  Every stroke is recorded as one undoable command together with
the inverse operation for redo.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

BASE_VALUE = 0.5
TARGET_A = 1.0
TARGET_B = 0.0
TARGET_ERASE = BASE_VALUE


def _smoothstep(t: np.ndarray) -> np.ndarray:
    t = np.clip(t, 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def stamp(
    shape: tuple[int, int],
    cx: float,
    cy: float,
    radius: float,
    softness: float,
) -> tuple[tuple[int, int, int, int], np.ndarray]:
    """Return ``(bbox, weights)`` for one round brush stamp.

    ``bbox`` is ``(y0, y1, x0, x1)`` (half-open) and ``weights`` is the
    float32 brush weight inside it.  With ``softness == 0`` the disc has a
    hard edge; larger values widen the smooth falloff down to zero at
    ``radius``.
    """
    height, width = shape
    radius = max(float(radius), 0.5)
    softness = float(np.clip(softness, 0.0, 1.0))

    x0 = max(0, int(np.floor(cx - radius)))
    x1 = min(width, int(np.ceil(cx + radius)) + 1)
    y0 = max(0, int(np.floor(cy - radius)))
    y1 = min(height, int(np.ceil(cy + radius)) + 1)
    if x1 <= x0 or y1 <= y0:
        return (0, 0, 0, 0), np.zeros((0, 0), dtype=np.float32)

    yy = np.arange(y0, y1, dtype=np.float32)[:, None] + 0.5 - cy
    xx = np.arange(x0, x1, dtype=np.float32)[None, :] + 0.5 - cx
    distance = np.sqrt(xx * xx + yy * yy)

    inner = radius * (1.0 - softness)
    if softness <= 1e-6:
        weights = (distance <= radius).astype(np.float32)
    else:
        weights = _smoothstep((radius - distance) / max(radius - inner, 1e-6))
    return (y0, y1, x0, x1), weights.astype(np.float32)


def apply_stamp(
    mask: np.ndarray,
    weights: np.ndarray,
    bbox: tuple[int, int, int, int],
    target: float,
) -> tuple[int, int, int, int]:
    """Paint ``weights`` of ``target`` into ``mask`` in place; return dirty bbox."""
    y0, y1, x0, x1 = bbox
    if y1 <= y0 or x1 <= x0:
        return (0, 0, 0, 0)
    region = mask[y0:y1, x0:x1]
    region += (float(target) - region) * weights
    np.clip(region, 0.0, 1.0, out=region)
    return (y0, y1, x0, x1)


def stroke_points(
    p0: tuple[float, float],
    p1: tuple[float, float],
    spacing: float,
) -> list[tuple[float, float]]:
    """Positions between two mouse samples so a drag leaves no gaps."""
    dx = p1[0] - p0[0]
    dy = p1[1] - p0[1]
    length = float(np.hypot(dx, dy))
    if length <= 1e-9:
        return [p1]
    steps = max(1, int(np.ceil(length / max(spacing, 0.5))))
    return [
        (p0[0] + dx * i / steps, p0[1] + dy * i / steps)
        for i in range(1, steps + 1)
    ]


def paint_segment(
    mask: np.ndarray,
    p0: tuple[float, float],
    p1: tuple[float, float],
    radius: float,
    softness: float,
    target: float,
) -> tuple[int, int, int, int]:
    """Paint a segment with max-combined stamps (no over-darkening)."""
    spacing = max(1.0, radius * 0.25)
    points = stroke_points(p0, p1, spacing)

    # Combine all stamps of this segment with max() so overlapping stamps do
    # not apply the target several times within one mouse move.
    union = (10**9, -1, 10**9, -1)
    y0u, y1u, x0u, x1u = union
    stamps: list[tuple[int, int, int, int, np.ndarray]] = []
    for x, y in points:
        bbox, w = stamp(mask.shape, x, y, radius, softness)
        y0, y1, x0, x1 = bbox
        if y1 <= y0 or x1 <= x0:
            continue
        stamps.append((y0, y1, x0, x1, w))
        y0u, y1u = min(y0u, y0), max(y1u, y1)
        x0u, x1u = min(x0u, x0), max(x1u, x1)
    if y1u <= y0u or x1u <= x0u:
        return (0, 0, 0, 0)

    weights = np.zeros((y1u - y0u, x1u - x0u), dtype=np.float32)
    for y0, y1, x0, x1, w in stamps:
        sub = weights[y0 - y0u : y1 - y0u, x0 - x0u : x1 - x0u]
        np.maximum(sub, w, out=sub)
    return apply_stamp(mask, weights, (y0u, y1u, x0u, x1u), target)


@dataclass
class _Command:
    kind: str
    bbox: tuple[int, int, int, int] | None
    before: np.ndarray
    after: np.ndarray

    def apply(self, mask: np.ndarray, use_after: bool) -> tuple[int, int, int, int]:
        data = self.after if use_after else self.before
        if self.bbox is None:
            np.copyto(mask, data)
            return (0, mask.shape[0], 0, mask.shape[1])
        y0, y1, x0, x1 = self.bbox
        np.copyto(mask[y0:y1, x0:x1], data)
        return self.bbox


class MaskDocument:
    """Mask array plus undo/redo history."""

    def __init__(self, height: int, width: int, history_limit: int = 50) -> None:
        self.mask = np.full((height, width), BASE_VALUE, dtype=np.float32)
        self._undo: list[_Command] = []
        self._redo: list[_Command] = []
        self._history_limit = history_limit
        self.revision = 0
        self._stroke_snapshot: np.ndarray | None = None
        self._stroke_bbox: tuple[int, int, int, int] | None = None
        self._stroke_touched = False

    # -- history ---------------------------------------------------------
    @property
    def can_undo(self) -> bool:
        return bool(self._undo)

    @property
    def can_redo(self) -> bool:
        return bool(self._redo)

    def clear_history(self) -> None:
        self._undo.clear()
        self._redo.clear()

    def _push(self, command: _Command) -> None:
        self._undo.append(command)
        if len(self._undo) > self._history_limit:
            self._undo.pop(0)
        self._redo.clear()

    # -- strokes ---------------------------------------------------------
    def begin_stroke(self) -> None:
        self._stroke_snapshot = self.mask.copy()
        self._stroke_bbox = None
        self._stroke_touched = False

    def paint(
        self,
        p0: tuple[float, float],
        p1: tuple[float, float],
        radius: float,
        softness: float,
        target: float,
    ) -> tuple[int, int, int, int]:
        if self._stroke_snapshot is None:
            self.begin_stroke()
        dirty = paint_segment(self.mask, p0, p1, radius, softness, target)
        if dirty[1] > dirty[0] and dirty[3] > dirty[2]:
            if self._stroke_bbox is None:
                self._stroke_bbox = dirty
            else:
                y0, y1, x0, x1 = self._stroke_bbox
                d0, d1, e0, e1 = dirty
                self._stroke_bbox = (min(y0, d0), max(y1, d1), min(x0, e0), max(x1, e1))
            self._stroke_touched = True
            self.revision += 1
        return dirty

    def end_stroke(self) -> bool:
        if self._stroke_snapshot is None:
            return False
        snapshot = self._stroke_snapshot
        self._stroke_snapshot = None
        bbox = self._stroke_bbox
        self._stroke_bbox = None
        touched = self._stroke_touched
        self._stroke_touched = False
        if bbox is None or not touched:
            return False
        y0, y1, x0, x1 = bbox
        before = snapshot[y0:y1, x0:x1].copy()
        after = self.mask[y0:y1, x0:x1].copy()
        if np.array_equal(before, after):
            return False
        self._push(_Command("stroke", bbox, before, after))
        return True

    # -- whole-mask operations ------------------------------------------
    def _whole(self, kind: str, new_mask: np.ndarray) -> bool:
        new_mask = np.asarray(new_mask, dtype=np.float32)
        if new_mask.shape != self.mask.shape:
            raise ValueError("mask shape mismatch")
        if np.array_equal(new_mask, self.mask):
            return False
        before = self.mask.copy()
        self.mask = np.ascontiguousarray(new_mask)
        self._push(_Command(kind, None, before, self.mask.copy()))
        self.revision += 1
        return True

    def set_target(self, target: float, region: np.ndarray | None = None) -> bool:
        """Fill the whole mask (or a boolean region) with a constant target."""
        target = float(np.clip(target, 0.0, 1.0))
        new = self.mask.copy()
        if region is None:
            new[...] = target
        else:
            new[region] = target
        return self._whole("fill", new)

    def fill_a(self) -> bool:
        return self.set_target(TARGET_A)

    def fill_b(self) -> bool:
        return self.set_target(TARGET_B)

    def fill_base(self) -> bool:
        return self.set_target(BASE_VALUE)

    def invert(self) -> bool:
        return self._whole("invert", 1.0 - self.mask)

    def undo(self) -> bool:
        if not self._undo:
            return False
        command = self._undo.pop()
        command.apply(self.mask, use_after=False)
        self._redo.append(command)
        self.revision += 1
        return True

    def redo(self) -> bool:
        if not self._redo:
            return False
        command = self._redo.pop()
        command.apply(self.mask, use_after=True)
        self._undo.append(command)
        self.revision += 1
        return True

    # -- info ------------------------------------------------------------
    def stats(self) -> dict[str, float]:
        return {
            "mean": float(self.mask.mean()),
            "a_fraction": float((self.mask > 0.5).mean()),
            "b_fraction": float((self.mask < 0.5).mean()),
            "min": float(self.mask.min()),
            "max": float(self.mask.max()),
        }
