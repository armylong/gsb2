"""Application controller: owns the document and keeps views in sync.

The UI widgets are dumb; all state lives here.  Invariants that the requirements
demand:

* Loading a new image **clears** strokes, box, result and staleness flag, so an
  old result can never look like the new image is already done (req. 5).
* Recomputing always starts from the original image plus the current label map.
  The previous ``MattingResult`` is never an input (req. 3).
* A failed recompute keeps the strokes and the previous valid result (req. 5).
* Export is blocked while the result is stale (req. 6).
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Optional

import numpy as np
from PySide6 import QtCore

from matting.constraints import BG, FG, LabelMap, Stroke, StrokeHistory
from matting.engine import ComputeSettings, MattingError, MattingResult, compute_matting
from matting.record import ConstraintRecord, RecordError, state_key

MAX_DISPLAY_SIDE = 1200


@dataclass
class DocumentStatus:
    has_image: bool = False
    image_name: str = ""
    has_box: bool = False
    fg_count: int = 0
    bg_count: int = 0
    has_result: bool = False
    stale: bool = False
    last_error: str = ""
    last_message: str = ""


class Document(QtCore.QObject):
    """Holds the image, constraints and last valid result; emits change events."""

    content_changed = QtCore.Signal()  # image loaded/cleared
    constraints_changed = QtCore.Signal()  # strokes/box changed
    result_changed = QtCore.Signal()  # new valid result or failure
    status_changed = QtCore.Signal(object)  # DocumentStatus
    message = QtCore.Signal(str, str)  # text, level ('info'|'warn'|'error'|'success')

    def __init__(self, parent=None):
        super().__init__(parent)
        self.image: Optional[np.ndarray] = None
        self.image_name: str = ""
        self.source_path: str = ""
        self.history: Optional[StrokeHistory] = None
        self.settings = ComputeSettings()
        self.result: Optional[MattingResult] = None
        self._result_key: Optional[str] = None
        self.last_error: str = ""
        self.last_message: str = ""
        self.is_sample: bool = False
        self.sample_key: str = ""
        self._status = DocumentStatus()

    # ---------------------------------------------------------------- document
    def load_image(self, image: np.ndarray, name: str, *, source_path: str = "",
                   sample_key: str = "") -> None:
        """Replace the document and clear every trace of the previous one."""
        if image is None or image.size == 0:
            raise MattingError("没有可加载的图像。", code="no_image")
        height, width = image.shape[:2]
        if max(height, width) > MAX_DISPLAY_SIDE:
            from matting.engine import limit_long_side

            image = limit_long_side(image, MAX_DISPLAY_SIDE)
        self.image = np.ascontiguousarray(image)
        self.image_name = name
        self.source_path = source_path
        self.is_sample = bool(sample_key)
        self.sample_key = sample_key
        self.history = StrokeHistory(*self.image.shape[:2])
        # Keep the user's refinement preference; everything else is per-image.
        self.settings = ComputeSettings(
            refine_radius=self.settings.refine_radius,
            grabcut_iterations=self.settings.grabcut_iterations,
        )
        self.result = None
        self._result_key = None
        self.last_error = ""
        self.last_message = ""
        self.content_changed.emit()
        self.constraints_changed.emit()
        self.result_changed.emit()
        self._emit_status()

    def clear(self) -> None:
        self.image = None
        self.image_name = ""
        self.source_path = ""
        self.history = None
        self.result = None
        self._result_key = None
        self.settings = ComputeSettings()
        self.is_sample = False
        self.sample_key = ""
        self.last_error = ""
        self.content_changed.emit()
        self.constraints_changed.emit()
        self.result_changed.emit()
        self._emit_status()

    def has_image(self) -> bool:
        return self.image is not None and self.history is not None

    @property
    def labels(self) -> Optional[LabelMap]:
        return self.history.labels if self.history else None

    # ------------------------------------------------------------------- box
    def set_box(self, box: Optional[tuple[int, int, int, int]]) -> None:
        if not self.has_image():
            return
        self.settings.box = tuple(int(round(v)) for v in box) if box else None
        self._on_constraints_mutated()

    # --------------------------------------------------------------- strokes
    def begin_stroke(self) -> None:
        """Hook called when a gesture starts (kept for signal symmetry)."""
        return

    def load_strokes(self, strokes) -> int:
        """Replace all strokes in one go (used by samples and record loading)."""
        if not self.has_image():
            return 0
        loaded = self.history.load_json(
            [
                {"kind": int(st.kind), "radius": float(st.radius),
                 "points": [[float(x), float(y)] for x, y in st.points]}
                for st in strokes
            ]
        )
        self._on_constraints_mutated()
        return loaded

    def commit_stroke(self, stroke: Stroke) -> bool:
        if not self.has_image() or stroke is None or not stroke.points:
            return False
        if not self.history.push(stroke):
            return False
        self._on_constraints_mutated()
        return True

    def undo(self) -> bool:
        if not self.has_image() or not self.history.undo():
            return False
        self._on_constraints_mutated()
        return True

    def redo(self) -> bool:
        if not self.has_image() or not self.history.redo():
            return False
        self._on_constraints_mutated()
        return True

    def clear_strokes(self) -> bool:
        if not self.has_image() or len(self.history) == 0:
            return False
        self.history.clear()
        self._on_constraints_mutated()
        return True

    def _on_constraints_mutated(self) -> None:
        self.constraints_changed.emit()
        self._emit_status()

    # ------------------------------------------------------------- computing
    def current_key(self) -> Optional[str]:
        if not self.has_image():
            return None
        return state_key(
            self.image,
            self.settings.box,
            self.settings,
            self.history,
            refine_radius=self.settings.refine_radius,
        )

    def is_stale(self) -> bool:
        if not self.has_image():
            return False
        if self.result is None:
            return True
        return self._result_key != self.current_key()

    def compute(self) -> Optional[MattingResult]:
        """Recompute from the original image and current constraints.

        On failure the previous result is kept and the error is reported.
        """
        if not self.has_image():
            self.last_error = "还没有打开图片。"
            self._emit_status()
            return None
        if self.settings.box is None:
            return self._fail("还没有选框：请用“框选”工具拖出前景的大致范围。", code="no_box")
        if self.history.labels.count(FG) == 0:
            return self._fail(
                "缺少确定前景标记：请用“确定前景”画笔在物体内部画几笔。", code="no_foreground")
        if self.history.labels.count(BG) == 0:
            return self._fail(
                "缺少确定背景标记：请用“确定背景”画笔在物体外的背景上画几笔。", code="no_background")
        started = time.perf_counter()
        try:
            result = compute_matting(self.image, self.history.labels, self.settings)
        except MattingError as exc:
            return self._fail(exc.message, code=exc.code)
        except Exception as exc:  # pragma: no cover - defensive
            return self._fail(f"计算失败：{exc}", code="internal")
        result.elapsed_ms = (time.perf_counter() - started) * 1000.0
        self.result = result
        self._result_key = self.current_key()
        self.last_error = ""
        self.last_message = f"已重新计算（{result.elapsed_ms:.0f} ms，羽化半径 {result.refine_radius}px）"
        self.result_changed.emit()
        self._emit_status()
        self.message.emit(self.last_message, "success")
        return result

    def _fail(self, text: str, *, code: str = "error") -> None:
        self.last_error = text
        self.last_message = ""
        self._emit_status()
        self.message.emit(text, "error")
        return None

    # ---------------------------------------------------------------- records
    def build_record(self) -> ConstraintRecord:
        if not self.has_image():
            raise RecordError("还没有打开图片。", code="no_image")
        if self.settings.box is None:
            raise RecordError("还没有选框，无法保存约束。", code="no_box")
        return ConstraintRecord.build(self.image, self.settings.box, self.settings, self.history)

    def load_record(self, record: ConstraintRecord) -> None:
        """Apply a validated record to the current image."""
        if not self.has_image():
            raise RecordError("还没有打开图片。", code="no_image")
        record.validate_for(self.image)
        record.apply_to(self.history, self.settings)
        self.result = None
        self._result_key = None
        self.last_error = ""
        self.constraints_changed.emit()
        self.result_changed.emit()
        self._emit_status()

    # ----------------------------------------------------------------- status
    def status(self) -> DocumentStatus:
        has_image = self.has_image()
        fg = self.history.labels.count(FG) if has_image else 0
        bg = self.history.labels.count(BG) if has_image else 0
        self._status = DocumentStatus(
            has_image=has_image,
            image_name=self.image_name,
            has_box=bool(has_image and self.settings.box),
            fg_count=fg,
            bg_count=bg,
            has_result=self.result is not None,
            stale=self.is_stale() if has_image else False,
            last_error=self.last_error,
            last_message=self.last_message,
        )
        return self._status

    def _emit_status(self) -> None:
        self.status_changed.emit(self.status())
