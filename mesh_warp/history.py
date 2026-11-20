"""Undo / redo history over control-mesh poses.

One user action is one snapshot.  A drag is recorded once on release (not per
mouse-move), so undo steps back one gesture.  Snapshots include the target
positions *and* lock state, which is what the requirement "锁定状态能恢复"
asks for.  Point movement and lock toggles go through the same history, so a
drag after unlocking can be undone back to the locked state.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .mesh import ControlMesh


@dataclass(frozen=True)
class MeshState:
    dst: np.ndarray
    locked: np.ndarray
    label: str

    def equals(self, other: "MeshState") -> bool:
        return (
            np.array_equal(self.dst, other.dst)
            and np.array_equal(self.locked, other.locked)
        )


class History:
    """Bounded undo/redo stack.  ``capacity=0`` disables history."""

    def __init__(self, mesh: ControlMesh, capacity: int = 200) -> None:
        self.capacity = int(capacity)
        self._mesh = mesh
        self._undo: list[MeshState] = []
        self._redo: list[MeshState] = []
        self._pending: MeshState | None = None

    # -- snapshots ------------------------------------------------------------
    def snapshot(self, label: str = "") -> MeshState:
        return MeshState(self._mesh.dst.copy(), self._mesh.locked.copy(), label)

    def _current(self) -> MeshState:
        return self.snapshot()

    def _restore(self, state: MeshState) -> None:
        self._mesh.dst = state.dst.copy()
        self._mesh.locked = state.locked.copy()

    # -- gesture recording ----------------------------------------------------
    def begin(self, label: str = "") -> None:
        """Remember the pose before a gesture (idempotent during the gesture)."""
        if self._pending is None:
            self._pending = self.snapshot(label)

    def commit(self) -> bool:
        """Close a gesture, pushing an undo entry only if something changed."""
        if self._pending is None:
            return False
        before = self._pending
        self._pending = None
        if before.equals(self._current()):
            return False
        if self.capacity <= 0:
            return False
        self._undo.append(before)
        if len(self._undo) > self.capacity:
            self._undo.pop(0)
        self._redo.clear()
        return True

    def cancel(self) -> None:
        """Abort an in-progress gesture and restore its starting pose."""
        if self._pending is not None:
            state = self._pending
            self._pending = None
            self._restore(state)

    # -- navigation -----------------------------------------------------------
    @property
    def can_undo(self) -> bool:
        return bool(self._undo)

    @property
    def can_redo(self) -> bool:
        return bool(self._redo)

    @property
    def undo_label(self) -> str:
        return self._undo[-1].label if self._undo else ""

    @property
    def redo_label(self) -> str:
        return self._redo[-1].label if self._redo else ""

    def undo(self) -> bool:
        if not self._undo:
            return False
        target = self._undo.pop()
        self._redo.append(self._current())
        self._restore(target)
        return True

    def redo(self) -> bool:
        if not self._redo:
            return False
        target = self._redo.pop()
        self._undo.append(self._current())
        self._restore(target)
        return True

    def clear(self) -> None:
        self._undo.clear()
        self._redo.clear()
        self._pending = None
