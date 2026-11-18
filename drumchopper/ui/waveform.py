"""Waveform view with draggable slice boundaries."""

from __future__ import annotations

import numpy as np
from PySide6.QtCore import QPointF, QRectF, Qt, Signal
from PySide6.QtGui import QColor, QFont, QLinearGradient, QPainter, QPen
from PySide6.QtWidgets import QSizePolicy, QWidget

from ..audio import MAX_SLICES, SliceModel, SourceAudio

BACKGROUND = QColor("#12161c")
LANE = QColor("#1b222c")
WAVE = QColor("#59c2ff")
WAVE_RMS = QColor("#2f86c9")
SELECTED_WAVE = QColor("#ffd166")
CUT = QColor("#ff7b54")
CUT_HOVER = QColor("#ffd166")
HINT = QColor(89, 194, 255, 120)
EDGE = QColor("#6b7c93")
TEXT = QColor("#d7e1ee")
GRID = QColor("#2a3441")


class WaveformWidget(QWidget):
    cutsChanged = Signal()
    sliceSelected = Signal(int)
    message = Signal(str)

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setMinimumHeight(220)
        self.setMouseTracking(True)
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)
        self._source: SourceAudio | None = None
        self._model: SliceModel | None = None
        self._selected = 0
        self._hover_cut: int | None = None
        self._drag_cut: int | None = None
        self._hints: list[int] = []
        self._peaks_cache: tuple[int, np.ndarray, np.ndarray] | None = None

    # -- data ---------------------------------------------------------------
    def set_source(self, source: SourceAudio | None, model: SliceModel | None) -> None:
        self._source = source
        self._model = model
        self._selected = 0
        self._peaks_cache = None
        self.update()

    def set_selected(self, index: int) -> None:
        if self._selected != index:
            self._selected = index
            self.update()

    def set_hints(self, positions: list[int]) -> None:
        """Show automatic onset suggestions that are not cuts yet."""
        self._hints = [int(p) for p in positions]
        self.update()

    def set_model(self, model: SliceModel | None) -> None:
        self._model = model
        self.update()

    @property
    def selected(self) -> int:
        return self._selected

    # -- geometry helpers ---------------------------------------------------
    def _plot_rect(self) -> QRectF:
        return QRectF(0, 8, max(1, self.width()), max(1, self.height() - 30))

    def _frames(self) -> int:
        return self._source.frames if self._source is not None else 0

    def x_for_sample(self, sample: int) -> float:
        frames = self._frames()
        rect = self._plot_rect()
        if frames <= 0:
            return rect.left()
        return rect.left() + (float(sample) / frames) * rect.width()

    def sample_for_x(self, x: float) -> int:
        frames = self._frames()
        rect = self._plot_rect()
        if frames <= 0 or rect.width() <= 0:
            return 0
        frac = (x - rect.left()) / rect.width()
        return int(round(frac * frames))

    def _cut_xs(self) -> list[tuple[int, float]]:
        if self._model is None:
            return []
        return [(i, self.x_for_sample(pos)) for i, pos in enumerate(self._model.cuts)]

    # -- painting -----------------------------------------------------------
    def paintEvent(self, event) -> None:  # noqa: ANN001
        del event
        painter = QPainter(self)
        painter.setRenderHint(QPainter.Antialiasing, False)
        painter.fillRect(self.rect(), BACKGROUND)
        if self._source is None:
            painter.setPen(TEXT)
            painter.drawText(self.rect(), Qt.AlignCenter, "导入一段不超过 8 秒的鼓循环 wav")
            return

        rect = self._plot_rect()
        painter.fillRect(rect, LANE)
        self._paint_grid(painter, rect)
        self._paint_waveform(painter, rect)
        self._paint_slices(painter, rect)
        self._paint_hints(painter, rect)
        self._paint_cuts(painter, rect)
        self._paint_ruler(painter, rect)

    def _paint_grid(self, painter: QPainter, rect: QRectF) -> None:
        painter.setPen(QPen(GRID, 1))
        step_s = 0.5
        t = 0.0
        duration = self._source.duration if self._source else 0.0
        while t < duration:
            x = self.x_for_sample(int(t * self._source.samplerate))
            painter.drawLine(QPointF(x, rect.top()), QPointF(x, rect.bottom()))
            t += step_s

    def _lane_peaks(self, lane: np.ndarray, width: int) -> tuple[np.ndarray, np.ndarray]:
        frames = lane.shape[0]
        ends = np.linspace(0, frames, width + 1).astype(np.int64)
        starts = ends[:-1]
        ends = np.maximum(ends[1:], starts + 1)
        mx = np.maximum.reduceat(lane, starts)
        mn = np.minimum.reduceat(lane, starts)
        return mn, mx

    def _paint_waveform(self, painter: QPainter, rect: QRectF) -> None:
        width = max(1, int(rect.width()))
        data = self._source.samples
        lanes = [data] if data.ndim == 1 else [data[:, 0], data[:, 1]]
        if self._peaks_cache is None or self._peaks_cache[0] != width:
            peaks = [self._lane_peaks(np.asarray(lane, dtype=np.float32), width) for lane in lanes]
            self._peaks_cache = (width, peaks)
        else:
            peaks = self._peaks_cache[1]  # type: ignore[assignment]

        slice_bounds = self._model.slice_bounds() if self._model else []
        lane_h = rect.height() / len(lanes)
        for lane_i, (mn, mx) in enumerate(peaks):
            lane_rect = QRectF(rect.left(), rect.top() + lane_i * lane_h, rect.width(), lane_h)
            mid = lane_rect.center().y()
            half = lane_h * 0.45
            x0 = int(rect.left())
            for p in range(width):
                vmin, vmax = float(mn[p]), float(mx[p])
                color = WAVE
                if self._model is not None and 0 <= self._selected < len(slice_bounds):
                    s0, s1 = slice_bounds[self._selected]
                    sample_start = int(p / width * self._frames())
                    sample_end = int((p + 1) / width * self._frames())
                    if sample_end > s0 and sample_start < s1:
                        color = SELECTED_WAVE
                painter.fillRect(
                    QRectF(x0 + p, mid - vmax * half, 1.0, max(1.0, (vmax - vmin) * half)),
                    color,
                )
        painter.setPen(QPen(QColor("#0a0e13"), 1))
        painter.drawLine(rect.topLeft(), rect.bottomLeft())

    def _paint_slices(self, painter: QPainter, rect: QRectF) -> None:
        if self._model is None:
            return
        bounds = self._model.slice_bounds()
        for i, (start, end) in enumerate(bounds):
            x0, x1 = self.x_for_sample(start), self.x_for_sample(end)
            if i == self._selected:
                painter.fillRect(QRectF(x0, rect.top(), x1 - x0, rect.height()), QColor(255, 209, 102, 26))
            painter.setPen(QPen(QColor(255, 255, 255, 30), 1))
            painter.drawLine(QPointF(x1, rect.top()), QPointF(x1, rect.bottom()))
            if x1 - x0 > 26:
                painter.setPen(TEXT)
                f = QFont(painter.font())
                f.setPointSize(9)
                painter.setFont(f)
                painter.drawText(
                    QRectF(x0 + 4, rect.top() + 4, max(18.0, x1 - x0 - 8), 16),
                    Qt.AlignLeft | Qt.AlignTop,
                    f"{i + 1}",
                )

    def _paint_hints(self, painter: QPainter, rect: QRectF) -> None:
        if not self._hints or self._model is None:
            return
        existing = set(self._model.cuts)
        painter.setPen(QPen(HINT, 1, Qt.DotLine))
        for pos in self._hints:
            if pos in existing:
                continue
            x = self.x_for_sample(pos)
            painter.drawLine(QPointF(x, rect.top()), QPointF(x, rect.bottom()))

    def _paint_cuts(self, painter: QPainter, rect: QRectF) -> None:
        if self._model is None:
            return
        for i, pos in enumerate(self._model.cuts):
            x = self.x_for_sample(pos)
            active = (self._drag_cut == i) or (self._hover_cut == i)
            pen = QPen(CUT_HOVER if active else CUT, 2.4 if active else 1.8)
            painter.setPen(pen)
            painter.drawLine(QPointF(x, rect.top()), QPointF(x, rect.bottom()))
            # grip
            painter.setBrush(CUT_HOVER if active else CUT)
            painter.setPen(Qt.NoPen)
            painter.drawRoundedRect(QRectF(x - 4, rect.top() + 2, 8, 10), 2, 2)
        painter.setBrush(Qt.NoBrush)
        painter.setPen(QPen(EDGE, 1.5))
        painter.drawLine(QPointF(rect.left(), rect.top()), QPointF(rect.left(), rect.bottom()))
        painter.drawLine(QPointF(rect.right(), rect.top()), QPointF(rect.right(), rect.bottom()))

    def _paint_ruler(self, painter: QPainter, rect: QRectF) -> None:
        painter.setPen(TEXT)
        f = QFont(painter.font())
        f.setPointSize(9)
        painter.setFont(f)
        duration = self._source.duration if self._source else 0.0
        n_ticks = max(2, int(duration) + 1)
        for t in np.linspace(0, duration, min(n_ticks * 2, 17)):
            x = self.x_for_sample(int(t * self._source.samplerate))
            painter.setPen(QPen(GRID, 1))
            painter.drawLine(QPointF(x, rect.bottom()), QPointF(x, rect.bottom() + 4))
            painter.setPen(TEXT)
            painter.drawText(QRectF(x - 22, rect.bottom() + 4, 44, 18), Qt.AlignCenter, f"{t:.2f}s")

    # -- interaction --------------------------------------------------------
    def _cut_at(self, x: float) -> int | None:
        for i, cx in self._cut_xs():
            if abs(cx - x) <= 6:
                return i
        return None

    def mousePressEvent(self, event) -> None:  # noqa: ANN001
        if self._source is None or self._model is None:
            return
        x = event.position().x()
        if event.button() == Qt.RightButton:
            idx = self._cut_at(x)
            if idx is not None:
                pos = self._model.cuts[idx]
                self._model.remove_cut(idx)
                self.message.emit(f"删除切点 {pos / self._source.samplerate:.3f}s")
                self.cutsChanged.emit()
                self.update()
            return
        if event.button() != Qt.LeftButton:
            return
        idx = self._cut_at(x)
        if idx is not None:
            self._drag_cut = idx
            self._drag_pos = self._model.cuts[idx]
            self.setCursor(Qt.SizeHorCursor)
            self.update()
            return
        sample = max(0, min(self._frames() - 1, self.sample_for_x(x)))
        for hint in self._hints:
            if abs(self.x_for_sample(hint) - x) <= 4 and hint not in self._model.cuts:
                if self._model.add_cut(hint):
                    self._hints.remove(hint)
                    self.message.emit(
                        f"采用自动建议切点 {hint / self._source.samplerate:.3f}s")
                    self.cutsChanged.emit()
                    self.update()
                return
        slice_idx = self._model.slice_of_position(sample)
        if slice_idx is not None and slice_idx != self._selected:
            self._selected = slice_idx
            self.sliceSelected.emit(slice_idx)
            self.update()

    def mouseDoubleClickEvent(self, event) -> None:  # noqa: ANN001
        if self._source is None or self._model is None or event.button() != Qt.LeftButton:
            return
        if self._cut_at(event.position().x()) is not None:
            return
        sample = self.sample_for_x(event.position().x())
        sample = max(1, min(self._frames() - 1, sample))
        if self._model.count >= MAX_SLICES:
            self.message.emit(f"最多 {MAX_SLICES} 个切片, 无法继续添加")
            return
        if self._model.add_cut(sample):
            self.message.emit(f"新增切点 {sample / self._source.samplerate:.3f}s")
            self.cutsChanged.emit()
            self.update()
        else:
            self.message.emit("该位置已有切点或无效")

    def mouseMoveEvent(self, event) -> None:  # noqa: ANN001
        if self._source is None or self._model is None:
            return
        x = event.position().x()
        if self._drag_cut is not None:
            # follow the *cut position* (not the list index): moving past a
            # neighbour re-sorts the list, so re-locate it each time.
            if self._drag_pos not in self._model.cuts:
                self._drag_cut = None
                self.update()
                return
            idx = self._model.cuts.index(self._drag_pos)
            self._drag_cut = idx
            sample = self._model.clamp_move(idx, self.sample_for_x(x))
            if sample != self._drag_pos and self._model.move_cut(idx, sample):
                self._drag_pos = sample
                self._drag_cut = self._model.cuts.index(sample)
                self.message.emit(
                    f"移动切点 → {sample / self._source.samplerate:.3f}s "
                    f"({sample} 采样)"
                )
                self.cutsChanged.emit()
            self.update()
            return
        hit = self._cut_at(x)
        if hit != self._hover_cut:
            self._hover_cut = hit
            self.setCursor(Qt.SizeHorCursor if hit is not None else Qt.ArrowCursor)
            self.update()

    def mouseReleaseEvent(self, event) -> None:  # noqa: ANN001
        del event
        if self._drag_cut is not None:
            self._drag_cut = None
            self.unsetCursor()
            self.update()

    def leaveEvent(self, event) -> None:  # noqa: ANN001
        del event
        self._hover_cut = None
        self.update()


class MiniMeter(QWidget):
    """Small peak meter showing the render's peak and protection gain."""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setMinimumHeight(26)
        self._peak = 0.0
        self._gain = 1.0
        self._text = "尚未渲染"

    def set_render(self, peak_before: float, peak_after: float, gain: float) -> None:
        self._peak = peak_before
        self._gain = gain
        self._text = (
            f"混音峰值 {peak_before:.3f}"
            + (f" · 保护衰减 {-20 * np.log10(gain):.2f} dB" if gain < 0.9999 else " · 无需衰减")
            + f" · 输出峰值 {peak_after:.3f}"
        )
        self.update()

    def set_text(self, text: str) -> None:
        self._text = text
        self.update()

    def paintEvent(self, event) -> None:  # noqa: ANN001
        del event
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing, True)
        r = QRectF(0, 0, self.width(), self.height())
        p.fillRect(r, LANE)
        bar = QRectF(2, 6, max(1.0, r.width() - 4), 6)
        grad = QLinearGradient(bar.topLeft(), bar.topRight())
        grad.setColorAt(0.0, QColor("#3ddc97"))
        grad.setColorAt(0.7, QColor("#ffd166"))
        grad.setColorAt(1.0, QColor("#ff5d5d"))
        p.fillRect(bar, grad)
        # mark the actual (possibly attenuated) peak
        level = max(0.0, min(1.0, self._peak * self._gain))
        p.setPen(QPen(QColor("#ffffff"), 2))
        x = bar.left() + level * bar.width()
        p.drawLine(QPointF(x, bar.top() - 1), QPointF(x, bar.bottom() + 1))
        p.setPen(TEXT)
        f = QFont(p.font())
        f.setPointSize(9)
        p.setFont(f)
        p.drawText(QRectF(4, 13, r.width() - 8, 12), Qt.AlignLeft | Qt.AlignVCenter, self._text)
