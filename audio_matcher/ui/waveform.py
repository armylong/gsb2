"""Waveform view with speech/exclude regions and a draggable selection.

The widget is intentionally one-clip, full-duration and non-zooming: the job
is choosing a handful of seconds of speech, not editing.  Everything drawn has
a matching numeric control elsewhere in the window so a range can also be
typed exactly.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from PySide6.QtCore import QPointF, QRectF, Qt, Signal
from PySide6.QtGui import (
    QBrush,
    QColor,
    QFont,
    QLinearGradient,
    QPainter,
    QPainterPath,
    QPen,
)
from PySide6.QtWidgets import QSizePolicy, QWidget

from ..levels import Interval, Region

COLOR_BG = QColor("#12161d")
COLOR_GRID = QColor("#242b36")
COLOR_WAVE = QColor("#7d8ea6")
COLOR_WAVE_MID = QColor("#9fb3ce")
COLOR_SPEECH = QColor(64, 196, 170, 46)
COLOR_SPEECH_EDGE = QColor("#40c4aa")
COLOR_EXCLUDE = QColor(236, 104, 104, 46)
COLOR_EXCLUDE_EDGE = QColor("#ec6868")
COLOR_EFFECTIVE = QColor(64, 196, 170, 110)
COLOR_SELECTION = QColor(90, 160, 255, 55)
COLOR_SELECTION_EDGE = QColor("#5aa0ff")
COLOR_PLAYHEAD = QColor("#ffffff")
COLOR_LIMITED = QColor("#ffb14d")
COLOR_TEXT = QColor("#aab7c7")


@dataclass
class Envelope:
    mins: np.ndarray
    maxs: np.ndarray


class WaveformView(QWidget):
    """Draw one clip, its regions, the user's drag-selection and a playhead."""

    selectionChanged = Signal(int, int)       # start_sample, end_sample
    positionClicked = Signal(int)             # sample under a plain click
    regionDoubleClicked = Signal(int)         # index into regions

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setMinimumHeight(190)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding)
        self.setMouseTracking(True)
        self._samples: np.ndarray | None = None
        self._rate = 48000
        self._regions: list[Region] = []
        self._effective: list[Interval] = []
        self._selection: tuple[int, int] | None = None
        self._drag_anchor: int | None = None
        self._drag_current: int | None = None
        self._playhead: int | None = None
        self._limited_runs: list[tuple[float, float]] = []
        self._envelope: Envelope | None = None
        self._envelope_key: tuple[int, int, int] | None = None
        self._poster_title = ""
        self._empty_text = "导入音频，或从「文件 → 生成样例音频」开始"

    # ------------------------------------------------------------------ data

    def set_clip(
        self,
        samples: np.ndarray | None,
        sample_rate: int,
        regions: list[Region] | None = None,
        effective: list[Interval] | None = None,
        title: str = "",
    ) -> None:
        self._samples = None if samples is None else np.asarray(samples, dtype=np.float64)
        self._rate = max(1, int(sample_rate))
        self._regions = list(regions or [])
        self._effective = list(effective or [])
        self._selection = None
        self._drag_anchor = self._drag_current = None
        self._playhead = None
        self._limited_runs = []
        self._poster_title = title
        self._envelope = None
        self._envelope_key = None
        self.update()

    @property
    def sample_rate(self) -> int:
        return self._rate

    @property
    def total_samples(self) -> int:
        return 0 if self._samples is None else int(self._samples.size)

    def set_regions(self, regions: list[Region], effective: list[Interval]) -> None:
        self._regions = list(regions)
        self._effective = list(effective)
        self.update()

    def set_selection(self, start_sample: int | None, end_sample: int | None) -> None:
        if start_sample is None or end_sample is None:
            self._selection = None
        else:
            a, b = int(start_sample), int(end_sample)
            if b < a:
                a, b = b, a
            self._selection = (max(0, a), min(self.total_samples, b))
        self.update()

    def selection(self) -> tuple[int, int] | None:
        return self._selection

    def set_playhead(self, sample: int | None) -> None:
        self._playhead = sample
        self.update()

    def set_limited_runs(self, runs: list[tuple[float, float]]) -> None:
        """Overlay ranges (seconds) where the peak limiter changed samples."""
        self._limited_runs = list(runs)
        self.update()

    # --------------------------------------------------------------- painting

    def _sample_to_x(self, sample: float) -> float:
        total = max(1, self.total_samples)
        return self._plot_rect().left() + (sample / total) * self._plot_rect().width()

    def _x_to_sample(self, x: float) -> int:
        rect = self._plot_rect()
        ratio = (x - rect.left()) / max(1.0, rect.width())
        return int(round(max(0.0, min(1.0, ratio)) * self.total_samples))

    def _plot_rect(self) -> QRectF:
        return QRectF(8.0, 20.0, max(10.0, self.width() - 16.0), max(10.0, self.height() - 40.0))

    def _ensure_envelope(self, width: int) -> Envelope | None:
        if self._samples is None or self._samples.size == 0:
            return None
        key = (self.total_samples, int(self._rate), width)
        if self._envelope is not None and self._envelope_key == key:
            return self._envelope
        buckets = max(1, min(width, self.total_samples))
        bounds = np.linspace(0, self._samples.size, buckets + 1).astype(np.int64)
        starts = np.minimum(bounds[:-1], self._samples.size - 1)
        maxs = np.maximum.reduceat(self._samples, starts)
        mins = np.minimum.reduceat(self._samples, starts)
        self._envelope = Envelope(mins=mins, maxs=maxs)
        self._envelope_key = key
        return self._envelope

    def paintEvent(self, event) -> None:  # noqa: N802 - Qt override
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        painter.fillRect(self.rect(), COLOR_BG)
        rect = self._plot_rect()

        self._draw_ruler(painter, rect)
        if self._samples is None or self._samples.size == 0:
            painter.setPen(COLOR_TEXT)
            font = QFont(self.font())
            font.setPointSize(12)
            painter.setFont(font)
            painter.drawText(rect, Qt.AlignmentFlag.AlignCenter, self._empty_text)
            painter.end()
            return

        self._draw_regions(painter, rect)
        self._draw_waveform(painter, rect)
        self._draw_limited_runs(painter, rect)
        self._draw_selection(painter, rect)
        self._draw_playhead(painter, rect)
        painter.end()

    def _draw_ruler(self, painter: QPainter, rect: QRectF) -> None:
        painter.setPen(QPen(COLOR_GRID, 1))
        painter.drawLine(QPointF(rect.left(), rect.top() - 4), QPointF(rect.right(), rect.top() - 4))
        duration = self.total_samples / float(self._rate) if self._rate else 0.0
        if duration <= 0:
            return
        target_ticks = max(4, int(rect.width() / 90))
        raw_step = duration / target_ticks
        steps = (0.1, 0.2, 0.5, 1.0, 2.0, 5.0, 10.0, 30.0, 60.0)
        step = next((s for s in steps if s >= raw_step), steps[-1])
        painter.setPen(COLOR_TEXT)
        font = QFont(self.font())
        font.setPointSize(8)
        painter.setFont(font)
        value = 0.0
        while value <= duration + 1e-9:
            x = self._sample_to_x(value * self._rate)
            painter.setPen(QPen(COLOR_GRID, 1, Qt.PenStyle.DotLine))
            painter.drawLine(QPointF(x, rect.top()), QPointF(x, rect.bottom()))
            painter.setPen(COLOR_TEXT)
            painter.drawText(QPointF(x + 3, rect.top() - 7), _fmt_time(value))
            value += step

    def _draw_regions(self, painter: QPainter, rect: QRectF) -> None:
        painter.save()
        painter.setClipRect(rect)
        for region in self._regions:
            if region.end <= region.start:
                continue
            x1 = self._sample_to_x(region.start)
            x2 = self._sample_to_x(region.end)
            area = QRectF(x1, rect.top(), max(1.0, x2 - x1), rect.height())
            if region.kind == "speech":
                painter.fillRect(area, COLOR_SPEECH)
                painter.setPen(QPen(COLOR_SPEECH_EDGE, 1.2))
            else:
                painter.fillRect(area, QBrush(COLOR_EXCLUDE, Qt.BrushStyle.BDiagPattern))
                painter.setPen(QPen(COLOR_EXCLUDE_EDGE, 1.2))
            painter.drawLine(QPointF(x1, rect.top()), QPointF(x1, rect.bottom()))
            painter.drawLine(QPointF(x2, rect.top()), QPointF(x2, rect.bottom()))
        for part in self._effective:
            x1 = self._sample_to_x(part.start)
            x2 = self._sample_to_x(part.end)
            if x2 - x1 < 1:
                continue
            painter.fillRect(
                QRectF(x1, rect.bottom() - 4, x2 - x1, 4), COLOR_EFFECTIVE
            )
        painter.restore()

    def _draw_waveform(self, painter: QPainter, rect: QRectF) -> None:
        bucket = self._ensure_envelope(max(1, int(rect.width())))
        if bucket is None:
            return
        mid = rect.center().y()
        half = rect.height() / 2.0 - 1.0
        painter.save()
        painter.setClipRect(rect)
        gradient = QLinearGradient(0, rect.top(), 0, rect.bottom())
        gradient.setColorAt(0.0, COLOR_WAVE_MID)
        gradient.setColorAt(0.5, COLOR_WAVE)
        gradient.setColorAt(1.0, COLOR_WAVE_MID)
        painter.setPen(Qt.PenStyle.NoPen)
        painter.setBrush(QBrush(gradient))
        path = QPainterPath()
        count = bucket.maxs.size
        step = rect.width() / count
        for index in range(count):
            x = rect.left() + index * step
            top = mid - float(bucket.maxs[index]) * half
            bottom = mid - float(bucket.mins[index]) * half
            height = max(0.8, bottom - top)
            path.addRect(QRectF(x, top, max(0.8, step + 0.4), height))
        painter.drawPath(path)
        painter.setPen(QPen(QColor(255, 255, 255, 28), 1))
        painter.drawLine(QPointF(rect.left(), mid), QPointF(rect.right(), mid))
        painter.restore()

    def _draw_limited_runs(self, painter: QPainter, rect: QRectF) -> None:
        if not self._limited_runs:
            return
        painter.save()
        painter.setClipRect(rect)
        for start_s, end_s in self._limited_runs:
            x1 = self._sample_to_x(start_s * self._rate)
            x2 = self._sample_to_x(end_s * self._rate)
            width = max(3.0, x2 - x1)
            painter.fillRect(QRectF(x1, rect.top(), width, 5), COLOR_LIMITED)
        painter.restore()

    def _draw_selection(self, painter: QPainter, rect: QRectF) -> None:
        selection = self._selection
        if self._drag_anchor is not None and self._drag_current is not None:
            a, b = sorted((self._drag_anchor, self._drag_current))
            selection = (a, b)
        if selection is None or selection[1] <= selection[0]:
            return
        x1 = self._sample_to_x(selection[0])
        x2 = self._sample_to_x(selection[1])
        painter.save()
        painter.setClipRect(rect)
        painter.fillRect(QRectF(x1, rect.top(), max(1.0, x2 - x1), rect.height()), COLOR_SELECTION)
        painter.setPen(QPen(COLOR_SELECTION_EDGE, 2))
        painter.drawLine(QPointF(x1, rect.top()), QPointF(x1, rect.bottom()))
        painter.drawLine(QPointF(x2, rect.top()), QPointF(x2, rect.bottom()))
        painter.restore()

    def _draw_playhead(self, painter: QPainter, rect: QRectF) -> None:
        if self._playhead is None:
            return
        x = self._sample_to_x(self._playhead)
        painter.setPen(QPen(COLOR_PLAYHEAD, 1.5))
        painter.drawLine(QPointF(x, rect.top() - 3), QPointF(x, rect.bottom()))

    # ------------------------------------------------------------------ mouse

    def mousePressEvent(self, event) -> None:  # noqa: N802 - Qt override
        if self._samples is None or event.button() != Qt.MouseButton.LeftButton:
            return
        self._drag_anchor = self._x_to_sample(event.position().x())
        self._drag_current = self._drag_anchor
        self.update()

    def mouseMoveEvent(self, event) -> None:  # noqa: N802 - Qt override
        if self._drag_anchor is None:
            return
        self._drag_current = self._x_to_sample(event.position().x())
        self.update()

    def mouseReleaseEvent(self, event) -> None:  # noqa: N802 - Qt override
        if self._samples is None or event.button() != Qt.MouseButton.LeftButton:
            return
        if self._drag_anchor is None:
            return
        start = min(self._drag_anchor, self._drag_current or self._drag_anchor)
        end = max(self._drag_anchor, self._drag_current or self._drag_anchor)
        self._drag_anchor = self._drag_current = None
        if abs(end - start) < max(1, int(self._rate * 0.010)):
            self._selection = None
            self.positionClicked.emit(start)
            self.update()
            return
        self._selection = (start, end)
        self.selectionChanged.emit(start, end)
        self.update()

    def mouseDoubleClickEvent(self, event) -> None:  # noqa: N802 - Qt override
        if self._samples is None:
            return
        sample = self._x_to_sample(event.position().x())
        for index, region in enumerate(self._regions):
            if region.start <= sample < region.end:
                self.regionDoubleClicked.emit(index)
                return


def _fmt_time(seconds: float) -> str:
    if seconds >= 60:
        minutes = int(seconds // 60)
        return f"{minutes}:{seconds - minutes * 60:05.2f}"
    return f"{seconds:.2f}s"
