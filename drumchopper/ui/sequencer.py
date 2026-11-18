"""Sixteen-step sequencer grid and slice details panel."""

from __future__ import annotations

from PySide6.QtCore import QRectF, Qt, Signal
from PySide6.QtGui import QColor, QFont, QPainter, QPen
from PySide6.QtWidgets import (
    QFormLayout,
    QGroupBox,
    QLabel,
    QPushButton,
    QSizePolicy,
    QSpinBox,
    QVBoxLayout,
    QWidget,
)

from .. import audio as A

COLORS = [
    "#59c2ff", "#7ee787", "#ffd166", "#ff7b54", "#c792ea", "#4dd0e1",
    "#f78fb3", "#a3e635", "#f5a97f", "#82aaff", "#89ddff", "#c3e88d",
    "#ffcb6b", "#f07178", "#bb80b3", "#a1c181",
]
STEPS = A.STEPS


def slice_color(index: int) -> QColor:
    return QColor(COLORS[index % len(COLORS)])


class StepGrid(QWidget):
    """A 16-cell one-bar grid.  Click cycles empty → slices → empty."""

    sequenceChanged = Signal()
    stepClicked = Signal(int)

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setMinimumHeight(190)
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Fixed)
        self._sequence = A.Sequence()
        self._slice_count = 0
        self._brush: int | None = None
        self._step_samples: list[int] = []
        self._samplerate = 44100
        self._recording = False
        self._cursor = -1

    def set_state(self, sequence: A.Sequence, slice_count: int,
                  step_samples: list[int], samplerate: int) -> None:
        self._sequence = sequence
        self._slice_count = slice_count
        self._step_samples = step_samples
        self._samplerate = samplerate
        self.update()

    def set_brush(self, slice_index: int | None) -> None:
        """When a brush slice is set, clicks paint it instead of cycling."""
        self._brush = slice_index
        self.update()

    def set_cursor(self, step: int) -> None:
        if self._cursor != step:
            self._cursor = step
            self.update()

    def set_recording(self, on: bool) -> None:
        self._recording = on
        self.update()

    def cycle_step(self, index: int, delta: int) -> None:
        """Advance a step: None → 0 → 1 … → last → None (or one slice only)."""
        if self._slice_count <= 0:
            return
        current = self._sequence.steps[index]
        n = self._slice_count
        if current is None:
            # stepping up starts at the first slice, stepping down at the last
            new = 0 if delta > 0 else n - 1
        else:
            new = current + delta
            if new >= n:
                new = None
            elif new < 0:
                new = None
        self._sequence.set_step(index, new)
        self.sequenceChanged.emit()
        self.update()

    # -- painting -----------------------------------------------------------
    def _cell_rects(self) -> list[QRectF]:
        cols = 8
        rows = 2
        gap = 5.0
        top_space = 20.0
        cell_w = (self.width() - gap * (cols + 1)) / cols
        cell_h = max(40.0, (self.height() - top_space - gap * (rows + 1)) / rows)
        rects = []
        for i in range(STEPS):
            row, col = divmod(i, cols)
            x = gap + col * (cell_w + gap)
            y = top_space + gap + row * (cell_h + gap)
            rects.append(QRectF(x, y, cell_w, cell_h))
        return rects

    def paintEvent(self, event) -> None:  # noqa: ANN001
        del event
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing, True)
        p.fillRect(self.rect(), QColor("#12161c"))
        f = QFont(p.font())
        f.setPointSize(9)
        p.setFont(f)
        for i, rect in enumerate(self._cell_rects()):
            value = self._sequence.steps[i]
            beat_start = i % 4 == 0
            base = QColor("#242e3b") if not beat_start else QColor("#2c394a")
            p.setBrush(base)
            p.setPen(QPen(QColor("#3c4b5e"), 1))
            p.drawRoundedRect(rect, 5, 5)

            if self._recording and self._cursor == i:
                p.setPen(QPen(QColor("#ff5d5d"), 2))
                p.setBrush(Qt.NoBrush)
                p.drawRoundedRect(rect.adjusted(1, 1, -1, -1), 5, 5)

            if value is not None:
                color = slice_color(value)
                fill = QColor(color)
                fill.setAlpha(190)
                p.setBrush(fill)
                p.setPen(QPen(color.lighter(130), 1))
                p.drawRoundedRect(rect.adjusted(2, 2, -2, -2), 4, 4)
                p.setPen(QColor("#0c1117"))
                big = QFont(p.font())
                big.setPointSize(13)
                big.setBold(True)
                p.setFont(big)
                p.drawText(rect.adjusted(0, 0, 0, -14), Qt.AlignCenter, f"S{value + 1}")
                p.setFont(f)

            # step number and true start time in ms
            label = f"{i + 1}"
            t_ms = (
                self._step_samples[i] / self._samplerate * 1000.0
                if i < len(self._step_samples) else 0.0
            )
            p.setPen(QColor("#9fb0c4") if value is None else QColor("#0c1117"))
            p.drawText(rect.adjusted(5, 3, -5, 0), Qt.AlignLeft | Qt.AlignTop, label)
            p.setPen(QColor("#c9d6e5") if value is None else QColor("#14202c"))
            p.drawText(rect.adjusted(5, 0, -5, -3), Qt.AlignRight | Qt.AlignBottom,
                       f"{t_ms:.1f}ms")

    def mousePressEvent(self, event) -> None:  # noqa: ANN001
        if event.button() == Qt.RightButton:
            for i, rect in enumerate(self._cell_rects()):
                if rect.contains(event.position()):
                    self._sequence.set_step(i, None)
                    self.sequenceChanged.emit()
                    self.update()
                    return
        if event.button() != Qt.LeftButton:
            return
        for i, rect in enumerate(self._cell_rects()):
            if rect.contains(event.position()):
                self.stepClicked.emit(i)
                self.apply_click(i)
                return

    def apply_click(self, index: int) -> None:
        """Click behaviour: brush paint when active, otherwise cycle."""
        if not (0 <= index < STEPS):
            return
        if self._brush is not None:
            # same value toggles the cell back to empty, so painting is undoable
            value = None if self._sequence.steps[index] == self._brush else self._brush
            self._sequence.set_step(index, value)
            self.sequenceChanged.emit()
            self.update()
        else:
            self.cycle_step(index, +1)

    def wheelEvent(self, event) -> None:  # noqa: ANN001
        delta = 1 if event.angleDelta().y() < 0 else -1
        for i, rect in enumerate(self._cell_rects()):
            if rect.contains(event.position()):
                current = self._sequence.steps[i]
                if self._slice_count <= 0:
                    return
                if current is None:
                    new = 0 if delta > 0 else self._slice_count - 1
                else:
                    new = current + delta
                    if new >= self._slice_count:
                        new = None
                    elif new < 0:
                        new = None
                self._sequence.set_step(i, new)
                self.sequenceChanged.emit()
                self.update()
                return


class SlicePanel(QGroupBox):
    """Shows and edits the current slice's source bounds."""

    changed = Signal()
    auditionRequested = Signal()
    message = Signal(str)

    def __init__(self, parent=None):
        super().__init__("切片", parent)
        self.setObjectName("slicePanel")
        self._model: A.SliceModel | None = None
        self._source: A.SourceAudio | None = None
        self._index = 0

        layout = QVBoxLayout(self)
        form = QFormLayout()
        self.info = QLabel("—")
        self.info.setWordWrap(True)
        self.start_spin = QSpinBox()
        self.start_spin.setRange(0, 1)
        self.start_spin.setSingleStep(1)
        self.start_spin.setSuffix(" 采样")
        self.end_spin = QSpinBox()
        self.end_spin.setRange(0, 1)
        self.end_spin.setSuffix(" 采样")
        self.start_spin.setToolTip("切片起点不能小于前一切点, 不能晚于终点")
        self.end_spin.setToolTip("切片终点是下一个切点; 最后一片固定到素材末尾")
        form.addRow("序号", self.info)
        form.addRow("起点", self.start_spin)
        form.addRow("终点", self.end_spin)
        layout.addLayout(form)

        self.audition_btn = QPushButton("试听该切片")
        layout.addWidget(self.audition_btn)
        hint = QLabel("双击波形空白处 = 新增切点 · 拖动切点 = 移动 · 右键切点 = 删除")
        hint.setWordWrap(True)
        hint.setStyleSheet("color:#8b9bb0;")
        layout.addWidget(hint)

        self.audition_btn.clicked.connect(self.auditionRequested)
        self.start_spin.editingFinished.connect(self._apply_spins)
        self.end_spin.editingFinished.connect(self._apply_spins)

    def set_state(self, source: A.SourceAudio | None, model: A.SliceModel | None,
                  index: int) -> None:
        self._source = source
        self._model = model
        self._index = index
        self._refresh()

    def _refresh(self) -> None:
        self.start_spin.blockSignals(True)
        self.end_spin.blockSignals(True)
        if self._source is None or self._model is None:
            self.info.setText("—")
            self.start_spin.setEnabled(False)
            self.end_spin.setEnabled(False)
        else:
            bounds = self._model.slice_bounds()
            index = max(0, min(self._index, len(bounds) - 1))
            start, end = bounds[index]
            sr = self._source.samplerate
            self.info.setText(
                f"切片 {index + 1} / {len(bounds)}　{end - start} 采样 "
                f"({(end - start) / sr * 1000:.1f} ms)"
            )
            # the first slice always starts at 0, the last always ends at the
            # material end: their fixed edges are read-only
            self.start_spin.setEnabled(index > 0)
            self.end_spin.setEnabled(index < len(bounds) - 1)
            self.start_spin.setRange(0, max(0, self._source.frames - 1))
            self.end_spin.setRange(0, max(0, self._source.frames - 1))
            self.start_spin.setValue(start)
            self.end_spin.setValue(end)
        self.start_spin.blockSignals(False)
        self.end_spin.blockSignals(False)

    def _apply_spins(self) -> None:
        if self._model is None or self._source is None:
            return
        changed = False
        index = self._index
        frames = self._model.frames

        # Move the start by moving the cut *before* this slice.  Recompute
        # bounds after each edit so an inverted/empty slice is impossible.
        if index > 0:
            bounds = self._model.slice_bounds()
            start, end = bounds[index]
            new_start = self.start_spin.value()
            if new_start != start:
                lo = bounds[index - 1][0] + 1
                hi = end - 1
                clamped = max(lo, min(hi, new_start))
                if clamped != new_start:
                    self.message.emit("起点被限制在相邻切点之间")
                cut_pos = self._model.cuts[index - 1]
                self._model.move_cut(index - 1, clamped)
                changed = changed or (cut_pos != clamped)

        # Move the end by moving the cut that starts the next slice.
        if index < self._model.count - 1:
            bounds = self._model.slice_bounds()
            start, end = bounds[index]
            new_end = self.end_spin.value()
            if new_end != end:
                lo = start + 1
                hi = frames - 1
                if index + 1 < self._model.count - 1:
                    # next slice must keep at least one sample
                    hi = min(hi, self._model.cuts[index + 1] - 1)
                clamped = max(lo, min(hi, new_end))
                if clamped != new_end:
                    self.message.emit("终点被限制在相邻切点之间")
                cut_pos = self._model.cuts[index]
                self._model.move_cut(index, clamped)
                changed = changed or (cut_pos != clamped)

        self._refresh()
        if changed:
            self.changed.emit()
