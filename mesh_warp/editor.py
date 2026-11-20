"""Qt-free editor state: image + mesh + history + render caches.

The GUI talks to this object for every mutation, which keeps all validation,
undo bookkeeping and coordinate logic testable without a display.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import numpy as np

from .history import History
from .io import (
    LoadedImage,
    load_image_rgba,
    load_mesh_json,
    save_mesh_json,
    save_png_rgba,
)
from .mesh import ControlMesh, ValidationReport
from .warp import make_preview_source, render_preview, render_warp


@dataclass(frozen=True)
class SampleResult:
    target: tuple[float, float]
    covered: bool
    source: tuple[float, float] | None
    triangle: int | None
    barycentric: tuple[float, float, float] | None


@dataclass(frozen=True)
class DragFeedback:
    accepted: bool
    message: str
    candidate: tuple[float, float]
    report: ValidationReport | None = None


class Editor:
    """Single-document mesh deformation editor."""

    default_cols = 6
    default_rows = 6

    def __init__(self) -> None:
        self.image: LoadedImage | None = None
        self.mesh: ControlMesh | None = None
        self.history: History | None = None
        self.grid_cols = self.default_cols
        self.grid_rows = self.default_rows
        self._full_cache: np.ndarray | None = None
        self._preview_cache: tuple[np.ndarray, float] | None = None
        self._preview_source: tuple[np.ndarray, float] | None = None
        self._preview_source_shape: tuple[int, int] | None = None
        self.drag_index: int | None = None
        self.drag_candidate: tuple[float, float] | None = None
        self.drag_report: ValidationReport | None = None
        # Persists after the mouse is released so the user can still read the
        # reason the last position was refused, and see the refused geometry.
        self.last_rejection: str = ""
        self.last_report: ValidationReport | None = None
        self.last_rejected_index: int | None = None
        self.last_rejected_candidate: tuple[float, float] | None = None

    # -- document -------------------------------------------------------------
    @property
    def has_document(self) -> bool:
        return self.image is not None and self.mesh is not None

    def set_document(self, image: LoadedImage, cols: int | None = None, rows: int | None = None) -> None:
        if cols is not None:
            self.grid_cols = int(cols)
        if rows is not None:
            self.grid_rows = int(rows)
        self.image = image
        self.mesh = ControlMesh(self.grid_cols, self.grid_rows, image.width, image.height)
        self.history = History(self.mesh)
        self._preview_source = make_preview_source(self.image.rgba, 700)
        self._preview_source_shape = self.image.rgba.shape[:2]
        self._invalidate()
        self.drag_index = None
        self.drag_candidate = None
        self.drag_report = None
        self.last_rejection = ""

    def open_image(self, path: str | Path) -> LoadedImage:
        image = load_image_rgba(path)
        self.set_document(image)
        return image

    def rebuild_mesh(self, cols: int, rows: int) -> None:
        assert self.image is not None
        self.mesh = ControlMesh(cols, rows, self.image.width, self.image.height)
        self.grid_cols, self.grid_rows = int(cols), int(rows)
        self.history = History(self.mesh)
        self._invalidate()
        self.drag_index = None
        self.drag_candidate = None
        self.drag_report = None
        self.last_rejection = ""

    def _invalidate(self) -> None:
        self._full_cache = None
        self._preview_cache = None

    def _clear_rejection(self) -> None:
        self.last_rejection = ""
        self.last_report = None
        self.last_rejected_index = None
        self.last_rejected_candidate = None

    # -- rendering ------------------------------------------------------------
    def render_full(self) -> np.ndarray:
        if not self.has_document:
            raise RuntimeError("no document loaded")
        if self._full_cache is None:
            self._full_cache = render_warp(self.image.rgba, self.mesh)
        return self._full_cache

    def render_drag_preview(self) -> tuple[np.ndarray, float]:
        """Preview image for the in-flight drag, at reduced resolution."""
        if not self.has_document:
            raise RuntimeError("no document loaded")
        if self._preview_cache is None:
            if self._preview_source_shape != self.image.rgba.shape[:2]:
                self._preview_source = make_preview_source(self.image.rgba, 700)
                self._preview_source_shape = self.image.rgba.shape[:2]
            self._preview_cache = render_preview(
                self.image.rgba, self.mesh, 700, source=self._preview_source
            )
        return self._preview_cache

    def is_identity(self) -> bool:
        return bool(self.mesh is not None and self.mesh.is_identity)

    # -- drag gesture ---------------------------------------------------------
    def begin_drag(self, index: int) -> tuple[bool, str]:
        if not self.has_document:
            return False, "请先载入图片"
        assert self.mesh is not None and self.history is not None
        index = int(index)
        if not (0 <= index < self.mesh.n_points):
            return False, "无效的控制点"
        if self.mesh.locked[index]:
            return False, f"点 {index + 1} 已锁定，不能拖动"
        if self.drag_index is not None:
            self.end_drag()
        self.history.begin(f"拖动点 {index + 1}")
        self.drag_index = index
        self.drag_candidate = tuple(float(v) for v in self.mesh.dst[index])
        self.drag_report = None
        self.last_rejection = ""
        self.last_report = None
        self.last_rejected_index = None
        self.last_rejected_candidate = None
        return True, ""

    def drag_to(self, x: float, y: float) -> DragFeedback:
        if self.drag_index is None or self.mesh is None:
            return DragFeedback(False, "没有正在拖动的控制点", (x, y))
        ok, message, report = self.mesh.attempt_move(
            [self.drag_index], np.array([[float(x), float(y)]])
        )
        self.drag_candidate = (float(x), float(y))
        self.drag_report = report if not ok else None
        if ok:
            self._invalidate()
            self._clear_rejection()
            return DragFeedback(True, "", self.drag_candidate, None)
        self.last_rejection = message
        self.last_report = report
        self.last_rejected_index = self.drag_index
        self.last_rejected_candidate = self.drag_candidate
        return DragFeedback(False, message, self.drag_candidate, report)

    def end_drag(self) -> bool:
        committed = False
        if self.history is not None:
            committed = self.history.commit()
        self.drag_index = None
        self.drag_candidate = None
        self.drag_report = None
        if self.has_document:
            self._invalidate()
        return committed

    def cancel_drag(self) -> None:
        if self.history is not None:
            self.history.cancel()
        self._clear_rejection()
        self.drag_index = None
        self.drag_candidate = None
        self.drag_report = None
        if self.has_document:
            self._invalidate()

    # -- direct edits ---------------------------------------------------------
    def _gesture(self, label: str, action) -> tuple[bool, str, ValidationReport | None]:
        """Run a user edit under one undo snapshot.

        Rejected edits are not recorded, but their diagnostics are kept so the
        same red overlay the drag path uses also appears for typed input.
        """
        assert self.mesh is not None and self.history is not None
        self.history.begin(label)
        try:
            ok, msg, report = action()
        except Exception:
            self.history.cancel()
            raise
        if ok:
            self.history.commit()
            self._clear_rejection()
        else:
            self.history.cancel()
            self.last_rejection = msg
            self.last_report = report
            self.last_rejected_index = None
            self.last_rejected_candidate = None
        self._invalidate()
        return ok, msg, report

    def set_point_target(self, index: int, x: float, y: float) -> tuple[bool, str]:
        assert self.mesh is not None
        index = int(index)
        if not (0 <= index < self.mesh.n_points):
            return False, "无效的控制点编号"
        if self.mesh.locked[index]:
            return False, "该点已锁定，无法修改"
        current = self.mesh.dst[index]
        if float(x) == current[0] and float(y) == current[1]:
            # No-op: do not create an undo entry or a rejection message.
            return True, ""

        def action():
            return self.mesh.attempt_move(
                [index], np.array([[float(x), float(y)]])
            )

        ok, msg, _ = self._gesture(f"设定点 {index + 1}", action)
        return ok, msg

    def nudge_point(self, index: int, dx: float, dy: float) -> tuple[bool, str]:
        assert self.mesh is not None
        if self.mesh.locked[int(index)]:
            return False, "该点已锁定"
        target = self.mesh.dst[int(index)] + np.array([dx, dy])
        return self.set_point_target(index, target[0], target[1])

    def reset_point(self, index: int) -> tuple[bool, str]:
        assert self.mesh is not None
        index = int(index)
        if self.mesh.locked[index]:
            return False, "该点已锁定，不能复位"
        if np.array_equal(self.mesh.dst[index], self.mesh.src[index]):
            return True, "该点已在原始位置"

        def action():
            return self.mesh.attempt_move([index], self.mesh.src[index][None].copy())

        ok, msg, _ = self._gesture(f"复位点 {index + 1}", action)
        if not ok:
            return False, "复位会导致无效网格：" + msg
        self._clear_rejection()
        return True, "已复位"

    def reset_all(self) -> None:
        assert self.mesh is not None and self.history is not None
        if self.mesh.is_identity:
            return
        self.history.begin("全部复位")
        self.mesh.reset_all()
        self.history.commit()
        self._clear_rejection()
        self._invalidate()

    def set_point_locked(self, index: int, locked: bool) -> None:
        assert self.mesh is not None and self.history is not None
        index = int(index)
        if bool(self.mesh.locked[index]) == bool(locked):
            return
        self.history.begin(f"{'锁定' if locked else '解锁'}点 {index + 1}")
        self.mesh.locked[index] = bool(locked)
        self.history.commit()
        self._invalidate()

    def set_border_locked(self, locked: bool) -> None:
        assert self.mesh is not None and self.history is not None
        border = self.mesh.border_indices()
        if np.array_equal(self.mesh.locked[border], np.full(len(border), bool(locked))):
            return
        self.history.begin("固定外边界" if locked else "解除外边界固定")
        self.mesh.locked[border] = bool(locked)
        self.history.commit()
        self._invalidate()

    def border_is_locked(self) -> bool:
        if not self.has_document:
            return False
        assert self.mesh is not None
        border = self.mesh.border_indices()
        return bool(len(border)) and bool(self.mesh.locked[border].all())

    # -- history --------------------------------------------------------------
    def undo(self) -> tuple[bool, str]:
        if self.drag_index is not None:
            self.cancel_drag()
        if not (self.history and self.history.undo()):
            return False, "没有可撤销的操作"
        self._clear_rejection()
        self._invalidate()
        self.drag_report = None
        return True, "已撤销"

    def redo(self) -> tuple[bool, str]:
        if self.drag_index is not None:
            self.cancel_drag()
        if not (self.history and self.history.redo()):
            return False, "没有可重做的操作"
        self._clear_rejection()
        self._invalidate()
        self.drag_report = None
        return True, "已重做"

    # -- sampling -------------------------------------------------------------
    def sample(self, target_xy: tuple[float, float]) -> SampleResult:
        assert self.mesh is not None
        tx, ty = float(target_xy[0]), float(target_xy[1])
        found = self.mesh.locate_target_triangle(np.array([tx, ty]))
        if found is None:
            return SampleResult((tx, ty), False, None, None, None)
        k, bary = found
        src = bary @ self.mesh.src[self.mesh.tris[k]]
        return SampleResult(
            (tx, ty),
            True,
            (float(src[0]), float(src[1])),
            int(k),
            (float(bary[0]), float(bary[1]), float(bary[2])),
        )

    # -- persistence ----------------------------------------------------------
    def export_png(self, path: str | Path) -> None:
        save_png_rgba(path, self.render_full())

    def export_json(self, path: str | Path) -> None:
        assert self.mesh is not None
        save_mesh_json(path, self.mesh, self.image)

    def load_mesh_json(self, path: str | Path) -> None:
        assert self.mesh is not None and self.image is not None
        mesh = load_mesh_json(
            path,
            width=self.image.width,
            height=self.image.height,
            image_sha256=self.image.sha256,
        )
        self.mesh = mesh
        self.grid_cols, self.grid_rows = mesh.cols, mesh.rows
        self.history = History(self.mesh)
        self._clear_rejection()
        self._invalidate()
        self.drag_index = None
        self.drag_candidate = None
        self.drag_report = None


def loaded_from_array(rgba: np.ndarray, path_hint: str) -> LoadedImage:
    """Wrap an in-memory RGBA image (e.g. the generated test image)."""
    import hashlib

    arr = np.ascontiguousarray(rgba.astype(np.uint8, copy=False))
    digest = hashlib.sha256(arr.tobytes()).hexdigest()
    return LoadedImage(arr, Path(path_hint), digest)


__all__ = ["Editor", "SampleResult", "DragFeedback", "loaded_from_array"]
