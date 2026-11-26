"""波形 / 频谱 / 能量曲线的绘制控件.

用一个可缩放的时间轴把整段录音画成包络图, 上面叠三类标记:
* 已确定的按键 (灰绿实线)
* 待核对的按键 (橙色虚线)
* 被拒绝的候选 (红色斜线区域)
另外在右侧画当前光标处的频谱, 并把两组标称频率用竖线标出来.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from PySide6.QtCore import QPointF, QRectF, Qt, Signal
from PySide6.QtGui import QColor, QFont, QPainter, QPainterPath, QPen
from PySide6.QtWidgets import QSizePolicy, QWidget

from ..analysis import DetectionResult
from ..tones import HIGH_GROUP, LOW_GROUP

COLOR_BG = QColor("#10151c")
COLOR_GRID = QColor("#223042")
COLOR_WAVE = QColor("#3d7ea6")
COLOR_WAVE_FILL = QColor("#1b3d52")
COLOR_ACCEPT = QColor("#59c98a")
COLOR_REVIEW = QColor("#e8b44a")
COLOR_REJECT = QColor("#e0625e")
COLOR_CURSOR = QColor("#f1f5f9")
COLOR_TEXT = QColor("#c7d2de")
COLOR_MUTED = QColor("#6b7d90")


@dataclass
class Selection:
    start: float
    end: float


def _format_time(t: float) -> str:
    if t >= 60:
        return f"{int(t // 60)}:{t % 60:05.2f}"
    return f"{t:.3f}s"


class WaveformView(QWidget):
    cursorMoved = Signal(float)
    selectionChanged = Signal(float, float)  # 秒
    segmentClicked = Signal(int, str)  # 索引, 类别 (accepted/rejected)

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setMinimumHeight(220)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding)
        self.setMouseTracking(True)
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
        self._samples: np.ndarray | None = None
        self._sample_rate = 8000
        self._result: DetectionResult | None = None
        self._cursor = 0.0
        self._selection: Selection | None = None
        self._envelope: tuple[np.ndarray, np.ndarray] | None = None
        self._levels_db: np.ndarray | None = None
        self._levels_times: np.ndarray | None = None
        self._view_start = 0.0
        self._view_end = 1.0
        self._drag_anchor: float | None = None
        self._dragging = False
        self._show_envelope = True

    # ---- 数据接口 ----

    def set_audio(self, samples: np.ndarray | None, sample_rate: int) -> None:
        self._samples = None if samples is None else np.asarray(samples, dtype=np.float64)
        self._sample_rate = int(sample_rate) if sample_rate else 8000
        self._envelope = None
        self._result = None
        self._levels_db = None
        self._levels_times = None
        self._selection = None
        self._cursor = 0.0
        self._view_start = 0.0
        self._view_end = max(0.001, self.duration)
        self.update()

    def set_result(self, result: DetectionResult | None) -> None:
        self._result = result
        self.update()

    @property
    def duration(self) -> float:
        if self._samples is None or self._sample_rate <= 0:
            return 0.0
        return len(self._samples) / self._sample_rate

    @property
    def cursor(self) -> float:
        return self._cursor

    def set_cursor(self, t: float, emit: bool = False) -> None:
        self._cursor = max(0.0, min(t, self.duration))
        if emit:
            self.cursorMoved.emit(self._cursor)
        self.update()

    def selection(self) -> Selection | None:
        return self._selection

    def set_selection(self, start: float, end: float, emit: bool = True) -> None:
        if self.duration <= 0:
            return
        start = max(0.0, min(start, self.duration))
        end = max(0.0, min(end, self.duration))
        if end < start:
            start, end = end, start
        if end - start < 1e-4:
            self._selection = None
        else:
            self._selection = Selection(start, end)
        if emit:
            self.selectionChanged.emit(start, end)
        self.update()

    def clear_selection(self) -> None:
        self._selection = None
        self.update()

    def zoom_to(self, start: float, end: float) -> None:
        if end - start <= 0:
            return
        self._view_start = max(0.0, start)
        self._view_end = min(self.duration or end, max(end, start + 0.01))
        self.update()

    def zoom_reset(self) -> None:
        self._view_start = 0.0
        self._view_end = max(0.001, self.duration)
        self.update()

    def set_show_envelope(self, enabled: bool) -> None:
        self._show_envelope = enabled
        self.update()

    # ---- 坐标换算 ----

    def _plot_rect(self) -> QRectF:
        return QRectF(8, 8, max(1, self.width() - 16), max(1, self.height() - 34))

    def _time_to_x(self, t: float) -> float:
        rect = self._plot_rect()
        span = max(self._view_end - self._view_start, 1e-9)
        return rect.left() + (t - self._view_start) / span * rect.width()

    def _x_to_time(self, x: float) -> float:
        rect = self._plot_rect()
        span = max(self._view_end - self._view_start, 1e-9)
        return self._view_start + (x - rect.left()) / max(rect.width(), 1) * span

    # ---- 绘制 ----

    def paintEvent(self, event) -> None:  # noqa: N802
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        painter.fillRect(self.rect(), COLOR_BG)
        rect = self._plot_rect()

        if self._samples is None or len(self._samples) == 0:
            painter.setPen(COLOR_MUTED)
            painter.drawText(rect, Qt.AlignmentFlag.AlignCenter, "还没有载入音频")
            return

        self._draw_grid(painter, rect)
        self._draw_waveform(painter, rect)
        if self._result is not None:
            self._draw_segments(painter, rect)
            self._draw_threshold(painter, rect)
        self._draw_selection(painter, rect)
        self._draw_cursor(painter, rect)
        self._draw_time_axis(painter, rect)

    def _draw_grid(self, painter: QPainter, rect: QRectF) -> None:
        painter.setPen(QPen(COLOR_GRID, 1))
        steps = 8
        for i in range(steps + 1):
            y = rect.top() + rect.height() * i / steps
            painter.drawLine(QPointF(rect.left(), y), QPointF(rect.right(), y))

    def _build_envelope(self) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        samples = self._samples
        assert samples is not None
        width = max(100, int(self._plot_rect().width()))
        n = len(samples)
        if n <= width:
            xs = np.arange(n, dtype=np.float64)
            mins = samples
            maxs = samples
        else:
            edges = np.linspace(0, n, width + 1).astype(np.int64)
            xs = 0.5 * (edges[:-1] + edges[1:])
            mins = np.minimum.reduceat(samples, edges[:-1])
            maxs = np.maximum.reduceat(samples, edges[:-1])
        times = xs / self._sample_rate
        return times, mins, maxs

    def _draw_waveform(self, painter: QPainter, rect: QRectF) -> None:
        if self._envelope is None:
            self._envelope = self._build_envelope()
        times, mins, maxs = self._envelope
        mask = (times >= self._view_start) & (times <= self._view_end)
        if not np.any(mask):
            return
        t_sel = times[mask]
        lo_sel = mins[mask]
        hi_sel = maxs[mask]
        if len(t_sel) < 1:
            return
        mid = rect.center().y()
        scale = 0.5 * rect.height() * 0.92
        upper = QPainterPath()
        lower = QPainterPath()
        for i in range(len(t_sel)):
            x = self._time_to_x(float(t_sel[i]))
            y_hi = mid - float(hi_sel[i]) * scale
            y_lo = mid - float(lo_sel[i]) * scale
            if i == 0:
                upper.moveTo(x, y_hi)
                lower.moveTo(x, y_lo)
            else:
                upper.lineTo(x, y_hi)
                lower.lineTo(x, y_lo)
        body = QPainterPath(upper)
        for i in range(len(t_sel) - 1, -1, -1):
            x = self._time_to_x(float(t_sel[i]))
            body.lineTo(x, mid - float(lo_sel[i]) * scale)
        body.closeSubpath()
        painter.fillPath(body, COLOR_WAVE_FILL)
        painter.setPen(QPen(COLOR_WAVE, 0.9))
        painter.drawPath(upper)
        painter.drawPath(lower)

    def _draw_threshold(self, painter: QPainter, rect: QRectF) -> None:
        if self._result is None or self._levels_db is None:
            return
        levels = self._levels_db
        if len(levels) == 0:
            return
        # 电平曲线画在波形下方的一条窄带里, 避免和波形糊在一起.
        band_top = rect.bottom() - 0.26 * rect.height()
        band_height = 0.24 * rect.height()
        top_db = 0.0
        bottom_db = -80.0

        def db_to_y(db: float) -> float:
            clipped = max(bottom_db, min(top_db, db))
            return band_top + (1.0 - (clipped - bottom_db) / (top_db - bottom_db)) * band_height

        if self._show_envelope:
            times = self._levels_times
            if times is None or len(times) != len(levels):
                times = np.linspace(self._view_start, self._view_end, len(levels))
            curve = QPainterPath()
            first = True
            fill = QPainterPath()
            for t, db in zip(times, levels):
                if t < self._view_start or t > self._view_end:
                    continue
                x = self._time_to_x(float(t))
                y = db_to_y(float(db))
                if first:
                    curve.moveTo(x, y)
                    fill.moveTo(x, band_top + band_height)
                    fill.lineTo(x, y)
                    first = False
                else:
                    curve.lineTo(x, y)
                    fill.lineTo(x, y)
            if not first:
                last_x = self._time_to_x(float(times[-1]))
                fill.lineTo(last_x, band_top + band_height)
                fill.closeSubpath()
                painter.fillPath(fill, QColor(122, 92, 46, 45))
                painter.setPen(QPen(QColor("#a8823f"), 1))
                painter.drawPath(curve)

        thr_db = float(self._result.active_threshold_db)
        y = db_to_y(thr_db)
        pen = QPen(QColor("#7a5c2e"), 1, Qt.PenStyle.DashLine)
        painter.setPen(pen)
        painter.drawLine(QPointF(rect.left(), y), QPointF(rect.right(), y))
        painter.setPen(COLOR_MUTED)
        painter.setFont(QFont("Helvetica", 8))
        painter.drawText(QPointF(rect.left() + 4, y - 3), f"有声门限 {thr_db:.1f} dBFS")

    def _draw_segments(self, painter: QPainter, rect: QRectF) -> None:
        assert self._result is not None
        painter.setFont(QFont("Helvetica", 9, QFont.Weight.Bold))
        for idx, seg in enumerate(self._result.all_segments()):
            if seg.end_s < self._view_start or seg.start_s > self._view_end:
                continue
            x0 = self._time_to_x(max(seg.start_s, self._view_start))
            x1 = self._time_to_x(min(seg.end_s, self._view_end))
            w = max(2.0, x1 - x0)
            color = {
                "accept": COLOR_ACCEPT,
                "review": COLOR_REVIEW,
                "reject": COLOR_REJECT,
            }[seg.verdict]
            if seg.verdict == "reject":
                hatch = QPainterPath()
                hatch.addRect(x0, rect.top(), w, rect.height() * 0.5)
                painter.fillPath(hatch, QColor(224, 98, 94, 40))
                pen = QPen(color, 1, Qt.PenStyle.DotLine)
            elif seg.verdict == "review":
                pen = QPen(color, 1.6, Qt.PenStyle.DashLine)
            else:
                pen = QPen(color, 1.6)
            painter.setPen(pen)
            painter.drawLine(QPointF(x0, rect.top()), QPointF(x0, rect.bottom()))
            painter.drawLine(QPointF(x1, rect.top()), QPointF(x1, rect.bottom()))
            label = seg.key or "?"
            if w > 14:
                painter.setPen(color)
                painter.drawText(QPointF(x0 + 3, rect.top() + 14), label)

    def _draw_selection(self, painter: QPainter, rect: QRectF) -> None:
        if self._selection is None:
            return
        x0 = self._time_to_x(self._selection.start)
        x1 = self._time_to_x(self._selection.end)
        painter.fillRect(QRectF(x0, rect.top(), x1 - x0, rect.height()), QColor(255, 255, 255, 26))
        painter.setPen(QPen(QColor("#8fb6d8"), 1))
        painter.drawRect(QRectF(x0, rect.top(), max(1.0, x1 - x0), rect.height()))
        # 选区顶部标出时长, 方便核对"这一段的长度"
        painter.setPen(QColor("#8fb6d8"))
        painter.setFont(QFont("Helvetica", 8))
        label = f"{(self._selection.end - self._selection.start) * 1000:.0f} ms"
        painter.drawText(QPointF(x0 + 2, rect.bottom() - 4), label)

    def select_segment_at(self, t: float) -> bool:
        """点在某段已识别区间内时, 把这一整段设为选区; 返回是否命中."""
        if self._result is None:
            return False
        for seg in self._result.all_segments():
            if seg.start_s <= t <= seg.end_s:
                self.set_selection(seg.start_s, seg.end_s)
                return True
        return False

    def _draw_cursor(self, painter: QPainter, rect: QRectF) -> None:
        x = self._time_to_x(self._cursor)
        painter.setPen(QPen(COLOR_CURSOR, 1))
        painter.drawLine(QPointF(x, rect.top()), QPointF(x, rect.bottom()))
        painter.setPen(COLOR_TEXT)
        painter.setFont(QFont("Helvetica", 8))
        painter.drawText(QPointF(min(x + 4, rect.right() - 48), rect.bottom() - 4), _format_time(self._cursor))

    def _draw_time_axis(self, painter: QPainter, rect: QRectF) -> None:
        painter.setPen(COLOR_MUTED)
        painter.setFont(QFont("Helvetica", 8))
        span = self._view_end - self._view_start
        if span <= 0:
            return
        target = max(2, int(rect.width() / 110))
        step = _nice_step(span / target)
        t = np.ceil(self._view_start / step) * step
        while t <= self._view_end + 1e-9:
            x = self._time_to_x(float(t))
            painter.setPen(QPen(COLOR_GRID, 1, Qt.PenStyle.DotLine))
            painter.drawLine(QPointF(x, rect.top()), QPointF(x, rect.bottom()))
            painter.setPen(COLOR_MUTED)
            painter.drawText(QPointF(x + 2, rect.bottom() + 13), f"{t:.2f}".rstrip("0").rstrip("."))
            t += step

    # ---- 交互 ----

    def mousePressEvent(self, event) -> None:  # noqa: N802
        if self._samples is None:
            return
        pos = event.position()
        if not self._plot_rect().contains(pos):
            return
        t = self._x_to_time(pos.x())
        if event.modifiers() & Qt.KeyboardModifier.ShiftModifier:
            if self._selection is None:
                self.set_selection(t, t, emit=False)
                self._drag_anchor = t
            else:
                self.set_selection(self._selection.start, t)
            self._dragging = True
            return
        # 普通单击: 落在某段已识别区间里就直接选中整段 (方便一键试听),
        # 落在空白处则清掉选区, 只定位光标.
        self.clear_selection()
        self._drag_anchor = t
        self._dragging = True
        self.set_cursor(t, emit=True)
        self.select_segment_at(t)

    def mouseMoveEvent(self, event) -> None:  # noqa: N802
        if self._samples is None:
            return
        pos = event.position()
        if not self._plot_rect().contains(pos):
            return
        t = self._x_to_time(pos.x())
        if self._dragging and self._drag_anchor is not None:
            if abs(t - self._drag_anchor) > 2e-3:
                self.set_selection(min(self._drag_anchor, t), max(self._drag_anchor, t))
            self.set_cursor(t, emit=True)

    def mouseReleaseEvent(self, event) -> None:  # noqa: N802
        if self._dragging and self._drag_anchor is not None:
            t = self._x_to_time(event.position().x())
            if abs(t - self._drag_anchor) > 2e-3:
                self.set_selection(min(self._drag_anchor, t), max(self._drag_anchor, t))
            elif self._selection is None:
                self.select_segment_at(t)
        self._dragging = False
        self._drag_anchor = None

    def wheelEvent(self, event) -> None:  # noqa: N802
        if self._samples is None:
            return
        delta = event.angleDelta().y()
        if delta == 0:
            return
        span = self._view_end - self._view_start
        factor = 0.8 if delta > 0 else 1.25
        new_span = max(0.01, min(self.duration, span * factor))
        anchor = self._cursor if self._plot_rect().contains(event.position()) else 0.5 * (
            self._view_start + self._view_end
        )
        rel = (anchor - self._view_start) / max(span, 1e-9)
        start = anchor - rel * new_span
        start = max(0.0, min(start, max(0.0, self.duration - new_span)))
        self._view_start = start
        self._view_end = start + new_span
        self._envelope = None
        self.update()


def _nice_step(raw: float) -> float:
    if raw <= 0:
        return 1.0
    import math

    exp = math.floor(math.log10(raw))
    base = raw / (10**exp)
    for option in (1.0, 2.0, 5.0, 10.0):
        if base <= option:
            return option * (10**exp)
    return 10.0 * (10**exp)


class SpectrumView(QWidget):
    """光标处的幅度谱, 标出两组标称频率的位置."""

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setMinimumHeight(160)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding)
        self._freqs: np.ndarray | None = None
        self._mag: np.ndarray | None = None
        self._markers: dict[float, QColor] = {}
        self._max_freq = 2000.0

    def set_spectrum(
        self,
        freqs: np.ndarray | None,
        mag: np.ndarray | None,
        markers: dict[float, QColor] | None = None,
    ) -> None:
        self._freqs = freqs
        self._mag = mag
        self._markers = markers or {}
        self.update()

    def paintEvent(self, event) -> None:  # noqa: N802
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        painter.fillRect(self.rect(), COLOR_BG)
        rect = QRectF(8, 8, max(1, self.width() - 16), max(1, self.height() - 26))
        painter.setPen(QPen(COLOR_GRID, 1))
        for i in range(5):
            y = rect.top() + rect.height() * i / 4
            painter.drawLine(QPointF(rect.left(), y), QPointF(rect.right(), y))
        for f in (*LOW_GROUP, *HIGH_GROUP):
            x = rect.left() + (f / self._max_freq) * rect.width()
            painter.setPen(QPen(QColor(255, 255, 255, 22), 1, Qt.PenStyle.DotLine))
            painter.drawLine(QPointF(x, rect.top()), QPointF(x, rect.bottom()))
        if self._freqs is None or self._mag is None or len(self._freqs) == 0:
            painter.setPen(COLOR_MUTED)
            painter.drawText(rect, Qt.AlignmentFlag.AlignCenter, "选中一段或移动光标查看频谱")
            return
        freqs = self._freqs
        mag = self._mag
        mask = freqs <= self._max_freq
        freqs = freqs[mask]
        mag = mag[mask]
        peak = float(np.max(mag)) if len(mag) else 0.0
        if peak <= 0:
            return
        db = 20.0 * np.log10(np.maximum(mag / peak, 1e-6))
        top_db, bottom_db = 0.0, -60.0
        path = QPainterPath()
        first = True
        for f, d in zip(freqs, db):
            x = rect.left() + (float(f) / self._max_freq) * rect.width()
            clamped = max(bottom_db, min(top_db, float(d)))
            y = rect.top() + (1.0 - (clamped - bottom_db) / (top_db - bottom_db)) * rect.height()
            if first:
                path.moveTo(x, y)
                first = False
            else:
                path.lineTo(x, y)
        painter.setPen(QPen(COLOR_WAVE, 1.2))
        painter.drawPath(path)
        painter.setFont(QFont("Helvetica", 8))
        for f, color in self._markers.items():
            x = rect.left() + (f / self._max_freq) * rect.width()
            painter.setPen(QPen(color, 1.2))
            painter.drawLine(QPointF(x, rect.top()), QPointF(x, rect.bottom() + 4))
            painter.drawText(QPointF(x + 2, rect.top() + 10), f"{f:.0f}")
        painter.setPen(COLOR_MUTED)
        for f in (0, 500, 1000, 1500, 2000):
            x = rect.left() + (f / self._max_freq) * rect.width()
            painter.drawText(QPointF(x + 2, rect.bottom() + 12), f"{f}Hz")
