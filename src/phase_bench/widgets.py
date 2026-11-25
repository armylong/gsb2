"""Custom Qt widgets for the bench: linked frequency plots and waveform tracer."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

import numpy as np
from PySide6.QtCore import QPointF, QRectF, Qt, Signal
from PySide6.QtGui import QBrush, QColor, QFont, QPainter, QPainterPath, QPen, QPolygonF
from PySide6.QtWidgets import QFrame, QLabel, QSizePolicy, QVBoxLayout, QWidget


SURFACE = "#fcfcfb"
PAGE = "#f9f9f7"
INK = "#0b0b0b"
INK_SECONDARY = "#52514e"
MUTED = "#898781"
GRID = "#e1e0d9"
BASELINE = "#c3c2b7"
BLUE = "#2a78d6"
ORANGE = "#eb6834"
GREEN = "#1baf7a"
VIOLET = "#6250d6"
RED = "#d03b3b"


def freq_label(value: float) -> str:
    if value >= 1000:
        text = f"{value / 1000:.1f}".rstrip("0").rstrip(".")
        return text + "k"
    if value >= 100:
        return f"{value:.0f}"
    return f"{value:.0f}"


def alpha_color(name: str, alpha: int) -> QColor:
    color = QColor(name)
    color.setAlpha(max(0, min(255, int(alpha))))
    return color


@dataclass
class PlotSeries:
    x: np.ndarray
    y: np.ndarray
    color: str
    label: str = ""
    width: float = 2.0
    alpha: float = 1.0
    style: Qt.PenStyle = Qt.PenStyle.SolidLine
    dots: bool = False
    dot_radius: float = 2.2
    draw_line: bool = True
    fill_to: float | None = None


class PlotWidget(QWidget):
    """A small log-frequency or linear Cartesian plot with band dragging."""

    bandSelected = Signal(float, float)
    hoverMessage = Signal(str)

    def __init__(
        self,
        title: str,
        y_range: tuple[float, float],
        y_ticks: list[tuple[float, str]],
        x_log: bool = True,
        x_range: tuple[float, float] = (20.0, 24_000.0),
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        self.title = title
        self.y_range = y_range
        self.y_ticks = y_ticks
        self.x_log = x_log
        self.x_range = x_range
        self.series: list[PlotSeries] = []
        self.band: tuple[float, float] | None = None
        self.markers: np.ndarray = np.array([], dtype=float)
        self.marker_color = VIOLET
        self.y_formatter: Callable[[float], str] | None = None

        self.setMinimumSize(330, 190)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding)
        self.setMouseTracking(True)
        self.setCursor(Qt.CursorShape.CrossCursor)
        self.setAutoFillBackground(True)
        pal = self.palette()
        pal.setColor(self.backgroundRole(), QColor(SURFACE))
        self.setPalette(pal)

        self._drag_x0: float | None = None
        self._drag_x1: float | None = None
        self._hover_px: QPointF | None = None

    def set_series(self, series: list[PlotSeries]) -> None:
        self.series = series
        self.update()

    def set_band(self, low: float | None, high: float | None) -> None:
        self.band = None if low is None or high is None else (float(low), float(high))
        self.update()

    def set_markers(self, markers: np.ndarray, color: str = VIOLET) -> None:
        self.markers = np.asarray(markers, dtype=float)
        self.marker_color = color
        self.update()

    def plot_rect(self) -> QRectF:
        return QRectF(56.0, 31.0, max(10.0, self.width() - 72.0), max(10.0, self.height() - 61.0))

    def _x_norm(self, x: float) -> float:
        lo, hi = self.x_range
        if self.x_log:
            a, b = np.log10(max(lo, 1e-6)), np.log10(max(hi, 1e-6))
            return (np.log10(max(x, 1e-6)) - a) / (b - a + 1e-15)
        return (x - lo) / (hi - lo + 1e-15)

    def map_x(self, x: float, rect: QRectF | None = None) -> float:
        r = rect or self.plot_rect()
        return r.left() + float(np.clip(self._x_norm(x), 0.0, 1.0)) * r.width()

    def unmap_x(self, px: float) -> float:
        r = self.plot_rect()
        u = float(np.clip((px - r.left()) / max(1.0, r.width()), 0.0, 1.0))
        lo, hi = self.x_range
        if self.x_log:
            a, b = np.log10(max(lo, 1e-6)), np.log10(max(hi, 1e-6))
            return float(10 ** (a + u * (b - a)))
        return float(lo + u * (hi - lo))

    def map_y(self, y: float, rect: QRectF | None = None) -> float:
        r = rect or self.plot_rect()
        lo, hi = self.y_range
        u = np.clip((y - lo) / (hi - lo), 0.0, 1.0)
        return r.bottom() - float(u) * r.height()

    def paintEvent(self, event) -> None:  # noqa: N802 - Qt API
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        p.fillRect(self.rect(), QColor(SURFACE))

        border = QPen(QColor(GRID), 1)
        p.setPen(border)
        p.drawRoundedRect(QRectF(0.5, 0.5, self.width() - 1, self.height() - 1), 8, 8)

        font = QFont(self.font())
        font.setPointSizeF(max(9.0, font.pointSizeF()))
        p.setFont(font)
        p.setPen(QColor(INK))
        p.drawText(QRectF(12, 7, self.width() - 24, 20), Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter, self.title)

        r = self.plot_rect()
        self._draw_grid(p, r)
        self._draw_band(p, r)
        self._draw_markers(p, r)

        p.save()
        p.setClipRect(r)
        for s in self.series:
            self._draw_series(p, r, s)
        if self._hover_px is not None:
            pen = QPen(alpha_color(INK_SECONDARY, 110), 1, Qt.PenStyle.DashLine)
            p.setPen(pen)
            x = self._hover_px.x()
            p.drawLine(QPointF(x, r.top()), QPointF(x, r.bottom()))
        p.restore()

        self._draw_legend(p)

    def _draw_grid(self, p: QPainter, r: QRectF) -> None:
        p.setPen(QPen(QColor(GRID), 1))
        for value, label in self.y_ticks:
            y = self.map_y(value, r)
            p.drawLine(QPointF(r.left(), y), QPointF(r.right(), y))
            p.setPen(QColor(MUTED))
            p.drawText(QRectF(4, y - 9, 47, 18), Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter, label)
            p.setPen(QPen(QColor(GRID), 1))

        candidates = [20, 30, 50, 100, 150, 200, 300, 500, 1000, 2000, 3000, 5000, 10000, 15000, 20000]
        lo, hi = self.x_range
        ticks = [f for f in candidates if lo * 1.01 <= f <= hi / 1.01]
        if len(ticks) < 3:
            ticks = list(np.linspace(lo, hi, 6))
        for f in ticks:
            x = self.map_x(float(f), r)
            p.drawLine(QPointF(x, r.bottom()), QPointF(x, r.bottom() + 4))
            p.setPen(QColor(MUTED))
            p.drawText(QRectF(x - 28, r.bottom() + 6, 56, 18), Qt.AlignmentFlag.AlignHCenter | Qt.AlignmentFlag.AlignTop, freq_label(float(f)))
            p.setPen(QPen(QColor(GRID), 1))

        p.setPen(QPen(QColor(BASELINE), 1.2))
        p.drawRect(r)

    def _draw_band(self, p: QPainter, r: QRectF) -> None:
        band = self.band
        if self._drag_x0 is not None and self._drag_x1 is not None:
            f0 = self.unmap_x(min(self._drag_x0, self._drag_x1))
            f1 = self.unmap_x(max(self._drag_x0, self._drag_x1))
            band = (f0, f1)
        if band is None:
            return
        x0, x1 = self.map_x(band[0], r), self.map_x(band[1], r)
        if x1 < x0:
            x0, x1 = x1, x0
        p.fillRect(QRectF(x0, r.top(), x1 - x0, r.height()), alpha_color(BLUE, 24))
        pen = QPen(alpha_color(BLUE, 150), 1.4)
        p.setPen(pen)
        p.drawLine(QPointF(x0, r.top()), QPointF(x0, r.bottom()))
        p.drawLine(QPointF(x1, r.top()), QPointF(x1, r.bottom()))

    def _draw_markers(self, p: QPainter, r: QRectF) -> None:
        if len(self.markers) == 0:
            return
        pen = QPen(alpha_color(self.marker_color, 150), 1.2, Qt.PenStyle.DotLine)
        p.setPen(pen)
        for f in self.markers:
            if self.x_range[0] <= f <= self.x_range[1]:
                x = self.map_x(float(f), r)
                p.drawLine(QPointF(x, r.top()), QPointF(x, r.bottom()))

    def _draw_series(self, p: QPainter, r: QRectF, s: PlotSeries) -> None:
        if len(s.x) == 0 or len(s.y) == 0:
            return
        color = QColor(s.color)
        color.setAlphaF(s.alpha)
        pen = QPen(color, s.width, s.style)
        pen.setJoinStyle(Qt.PenJoinStyle.RoundJoin)
        p.setPen(pen)

        if s.fill_to is not None:
            fill_path = QPainterPath()
            started = False
            last_x = last_y = 0.0
            for xv, yv in zip(s.x, s.y):
                if not np.isfinite(yv):
                    continue
                x, y = self.map_x(float(xv), r), self.map_y(float(yv), r)
                if not started:
                    fill_path.moveTo(x, self.map_y(s.fill_to, r))
                    fill_path.lineTo(x, y)
                    started = True
                else:
                    fill_path.lineTo(x, y)
                last_x, last_y = x, y
            if started:
                fill_path.lineTo(last_x, self.map_y(s.fill_to, r))
                fill_path.closeSubpath()
                fill_color = QColor(s.color)
                fill_color.setAlpha(34)
                p.fillPath(fill_path, QBrush(fill_color))

        if s.draw_line:
            path = QPainterPath()
            started = False
            for xv, yv in zip(s.x, s.y):
                if not np.isfinite(yv):
                    started = False
                    continue
                x, y = self.map_x(float(xv), r), self.map_y(float(yv), r)
                if not started:
                    path.moveTo(x, y)
                    started = True
                else:
                    path.lineTo(x, y)
            p.drawPath(path)

        if s.dots:
            p.setBrush(QBrush(color))
            p.setPen(Qt.PenStyle.NoPen)
            rad = s.dot_radius
            for xv, yv in zip(s.x, s.y):
                if np.isfinite(yv):
                    x, y = self.map_x(float(xv), r), self.map_y(float(yv), r)
                    p.drawEllipse(QPointF(x, y), rad, rad)

    def _draw_legend(self, p: QPainter) -> None:
        x_cursor = self.width() - 14.0
        font = QFont(self.font())
        font.setPointSizeF(max(8.5, font.pointSizeF() - 0.5))
        p.setFont(font)
        metrics = p.fontMetrics()
        for s in reversed(self.series):
            if not s.label:
                continue
            width = metrics.horizontalAdvance(s.label) + 34
            x0 = x_cursor - width
            y = 15.0
            pen = QPen(QColor(s.color), 2.4)
            p.setPen(pen)
            p.drawLine(QPointF(x0 + 2, y), QPointF(x0 + 22, y))
            p.setPen(QColor(INK_SECONDARY))
            p.drawText(QRectF(x0 + 27, 5, width - 27, 18), Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter, s.label)
            x_cursor = x0 - 18

    def mousePressEvent(self, event) -> None:  # noqa: N802
        if event.button() == Qt.MouseButton.LeftButton and self.plot_rect().contains(event.position()):
            x = event.position().x()
            self._drag_x0 = x
            self._drag_x1 = x
            self.update()
            event.accept()

    def mouseMoveEvent(self, event) -> None:  # noqa: N802
        pos = event.position()
        self._hover_px = QPointF(pos)
        if self._drag_x0 is not None:
            self._drag_x1 = pos.x()
            self.update()
        else:
            self._emit_hover(pos.x())
        self.update()

    def mouseReleaseEvent(self, event) -> None:  # noqa: N802
        if event.button() != Qt.MouseButton.LeftButton or self._drag_x0 is None:
            return
        x0, x1 = self._drag_x0, event.position().x()
        if abs(x1 - x0) < 4:
            f = self.unmap_x(x0)
            self.bandSelected.emit(f, f)
        else:
            f0 = self.unmap_x(min(x0, x1))
            f1 = self.unmap_x(max(x0, x1))
            self.bandSelected.emit(f0, f1)
        self._drag_x0 = self._drag_x1 = None
        self.update()

    def leaveEvent(self, event) -> None:  # noqa: N802
        self._hover_px = None
        self.update()

    def _emit_hover(self, px: float) -> None:
        if not self.series:
            return
        f = self.unmap_x(px)
        best = None
        best_dist = float("inf")
        best_y = None
        best_label = ""
        for s in self.series:
            if len(s.x) == 0:
                continue
            idx = int(np.argmin(np.abs(np.asarray(s.x) - f)))
            d = abs(float(s.x[idx]) - f)
            if d < best_dist and np.isfinite(s.y[idx]):
                best_dist = d
                best = float(s.x[idx])
                best_y = float(s.y[idx])
                best_label = s.label
        if best is None or best_y is None:
            return
        y_text = self.y_formatter(best_y) if self.y_formatter else f"{best_y:.1f}"
        self.hoverMessage.emit(f"{freq_label(best)} Hz · {best_label or '读数'} {y_text}")


class WaveformWidget(QWidget):
    """Two-channel waveform with draggable segment and exact FFT-frame traces."""

    selectionChanged = Signal(int, int)

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.left = np.zeros(1)
        self.right = np.zeros(1)
        self.sample_rate = 48_000
        self.delay = 0
        self.selection = (0, 1)
        self.frame_starts: np.ndarray = np.array([], dtype=int)
        self.frame_ends: np.ndarray = np.array([], dtype=int)
        self.frame_weights: np.ndarray = np.array([], dtype=float)
        self.playhead: int | None = None

        self.setMinimumHeight(235)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding)
        self.setMouseTracking(True)
        self.setAutoFillBackground(True)
        pal = self.palette()
        pal.setColor(self.backgroundRole(), QColor(SURFACE))
        self.setPalette(pal)

        self._mode: str | None = None
        self._press_sample = 0
        self._original_selection = (0, 0)
        self._envelope_cache: dict[str, tuple[int, np.ndarray, np.ndarray]] = {}

    def set_alignment(self, samples: np.ndarray, sample_rate: int, delay: int) -> None:
        self.left = np.asarray(samples[:, 0], dtype=np.float64)
        self.right = np.asarray(samples[:, 1], dtype=np.float64)
        self.sample_rate = int(sample_rate)
        self.delay = int(delay)
        n = len(self.left)
        self.selection = (0, n)
        self.playhead = None
        self._envelope_cache.clear()
        self.update()

    def set_selection(self, start: int, end: int) -> None:
        n = len(self.left)
        start = max(0, min(n, int(start)))
        end = max(0, min(n, int(end)))
        if end < start:
            start, end = end, start
        self.selection = (start, end)
        self.update()

    def set_frame_spans(self, starts: np.ndarray, ends: np.ndarray, weights: np.ndarray) -> None:
        self.frame_starts = np.asarray(starts, dtype=int)
        self.frame_ends = np.asarray(ends, dtype=int)
        self.frame_weights = np.asarray(weights, dtype=float)
        self.update()

    def set_playhead(self, sample: int | None) -> None:
        self.playhead = None if sample is None else int(sample)
        self.update()

    def _rects(self) -> tuple[QRectF, QRectF]:
        left_margin, right_margin = 56.0, 16.0
        top, bottom = 27.0, 35.0
        gap = 25.0
        w = max(10.0, self.width() - left_margin - right_margin)
        h = max(25.0, self.height() - top - bottom - gap) / 2.0
        r1 = QRectF(left_margin, top, w, h)
        r2 = QRectF(left_margin, top + h + gap, w, h)
        return r1, r2

    def _sample_to_x(self, sample: int | float, rect: QRectF | None = None) -> float:
        r1, _ = self._rects()
        r = rect or r1
        n = max(1, len(self.left))
        return r.left() + float(sample) / n * r.width()

    def _x_to_sample(self, x: float) -> int:
        r1, _ = self._rects()
        n = len(self.left)
        u = np.clip((x - r1.left()) / max(1.0, r1.width()), 0.0, 1.0)
        return int(round(u * n))

    def paintEvent(self, event) -> None:  # noqa: N802
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        p.fillRect(self.rect(), QColor(SURFACE))
        p.setPen(QPen(QColor(GRID), 1))
        p.drawRoundedRect(QRectF(0.5, 0.5, self.width() - 1, self.height() - 1), 8, 8)

        p.setPen(QColor(INK))
        font = QFont(self.font())
        font.setPointSizeF(max(9.0, font.pointSizeF()))
        p.setFont(font)
        p.drawText(QRectF(12, 6, 500, 20), Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter, "时域选区与 FFT 帧追踪（拖动选择试听/估计区间）")

        r1, r2 = self._rects()
        peak = max(0.02, float(np.max(np.abs(self.left))) if len(self.left) else 0.0, float(np.max(np.abs(self.right))) if len(self.right) else 0.0)
        self._draw_time_grid(p, r1, r2)
        self._draw_frame_spans(p, r1, r2)
        self._draw_invalid_edges(p, r1, r2)
        self._draw_wave(p, r1, self.left, BLUE, peak, "麦 1", "left")
        self._draw_wave(p, r2, self.right, ORANGE, peak, "麦 2（已应用延时/极性）", "right")
        self._draw_selection(p, r1, r2)
        self._draw_playhead(p, r1, r2)

    def _draw_time_grid(self, p: QPainter, r1: QRectF, r2: QRectF) -> None:
        for r in (r1, r2):
            p.fillRect(r, QColor("#fffefa"))
            p.setPen(QPen(QColor(GRID), 1))
            p.drawRect(r)
            mid = r.center().y()
            p.setPen(QPen(QColor(BASELINE), 1))
            p.drawLine(QPointF(r.left(), mid), QPointF(r.right(), mid))

        duration = len(self.left) / max(1, self.sample_rate)
        raw_step = duration / 8.0
        nice = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 30, 60]
        step = next((v for v in nice if v >= raw_step), 120.0)
        t = 0.0
        while t <= duration + 1e-9:
            sample = int(t * self.sample_rate)
            x = self._sample_to_x(sample, r1)
            p.setPen(QPen(QColor(GRID), 1))
            p.drawLine(QPointF(x, r1.bottom()), QPointF(x, r2.bottom()))
            label = f"{t:.2f}s" if step < 0.2 else f"{t:.1f}s"
            p.setPen(QColor(MUTED))
            p.drawText(QRectF(x - 35, r2.bottom() + 7, 70, 18), Qt.AlignmentFlag.AlignHCenter | Qt.AlignmentFlag.AlignTop, label)
            t += step

    def _envelopes(self, data: np.ndarray, rect: QRectF, cache_key: str) -> tuple[np.ndarray, np.ndarray]:
        width = max(1, int(rect.width()))
        cached = self._envelope_cache.get(cache_key)
        if cached is not None and cached[0] == width:
            return cached[1], cached[2]

        n = len(data)
        mins = np.zeros(width)
        maxs = np.zeros(width)
        if n:
            for i in range(width):
                s0 = int(i * n / width)
                s1 = max(s0 + 1, int((i + 1) * n / width))
                chunk = data[s0:min(n, s1)]
                if len(chunk):
                    mins[i] = float(np.min(chunk))
                    maxs[i] = float(np.max(chunk))
        self._envelope_cache[cache_key] = (width, mins, maxs)
        return mins, maxs

    def _draw_wave(
        self,
        p: QPainter,
        r: QRectF,
        data: np.ndarray,
        color: str,
        peak: float,
        label: str,
        cache_key: str,
    ) -> None:
        mins, maxs = self._envelopes(data, r, cache_key)
        half = r.height() * 0.43
        mid = r.center().y()
        pen = QPen(alpha_color(color, 190), 1.0)
        p.setPen(pen)
        for i, (lo, hi) in enumerate(zip(mins, maxs)):
            x = r.left() + i + 0.5
            y0 = mid - float(np.clip(hi / peak, -1.0, 1.0)) * half
            y1 = mid - float(np.clip(lo / peak, -1.0, 1.0)) * half
            p.drawLine(QPointF(x, y0), QPointF(x, y1))

        font = QFont(self.font())
        font.setBold(True)
        p.setFont(font)
        p.setPen(QColor(INK_SECONDARY))
        p.drawText(QRectF(8, int(r.top()) - 2, 46, 18), Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter, label.split()[0])
        p.setPen(QColor(MUTED))
        plain = QFont(self.font())
        plain.setBold(False)
        p.setFont(plain)
        p.drawText(QRectF(48, int(r.top()) - 2, int(r.width()) - 40, 18), Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter, " ".join(label.split()[1:]))

    def _draw_frame_spans(self, p: QPainter, r1: QRectF, r2: QRectF) -> None:
        if len(self.frame_starts) == 0:
            return
        top, bottom = r1.top() + 2, r2.bottom() - 2
        for start, end, weight in zip(self.frame_starts, self.frame_ends, self.frame_weights):
            x0 = self._sample_to_x(max(0, start), r1)
            x1 = self._sample_to_x(min(len(self.left), end), r1)
            alpha = int(5 + 13 * float(np.clip(weight, 0, 1)))
            color = QColor(GREEN)
            color.setAlpha(alpha)
            p.fillRect(QRectF(x0, top, max(1.0, x1 - x0), bottom - top), color)
            pen_color = QColor(GREEN)
            pen_color.setAlpha(int(70 + 80 * float(np.clip(weight, 0, 1))))
            p.setPen(QPen(pen_color, 1))
            p.drawLine(QPointF(x0, top), QPointF(x0, bottom))

        p.setPen(QColor("#0f7a55"))
        p.drawText(QRectF(r1.left() + 8, r1.top() + 4, 260, 16), Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter, "绿色竖带 = 当前频带加权后的实际 FFT 帧")

    def _draw_invalid_edges(self, p: QPainter, r1: QRectF, r2: QRectF) -> None:
        n = len(self.right)
        d = self.delay
        invalid: tuple[int, int] | None = None
        if d > 0:
            invalid = (0, min(n, d))
        elif d < 0:
            invalid = (max(0, n + d), n)
        if invalid is None or invalid[1] <= invalid[0]:
            return
        x0 = self._sample_to_x(invalid[0], r1)
        x1 = self._sample_to_x(invalid[1], r1)
        brush = QBrush(QColor(137, 135, 129, 55), Qt.BrushStyle.BDiagPattern)
        for r in (r1, r2):
            p.fillRect(QRectF(x0, r.top(), x1 - x0, r.height()), brush)
        if x1 - x0 > 42:
            p.setPen(QColor(INK_SECONDARY))
            p.drawText(QRectF(x0, r2.top() + 4, x1 - x0, 16), Qt.AlignmentFlag.AlignCenter, "补零边界")

    def _draw_selection(self, p: QPainter, r1: QRectF, r2: QRectF) -> None:
        a, b = self.selection
        x0, x1 = self._sample_to_x(a, r1), self._sample_to_x(b, r1)
        full = QRectF(r1.left(), r1.top(), r1.width(), r2.bottom() - r1.top())
        if x0 > full.left():
            p.fillRect(QRectF(full.left(), full.top(), x0 - full.left(), full.height()), QColor(11, 11, 11, 18))
        if x1 < full.right():
            p.fillRect(QRectF(x1, full.top(), full.right() - x1, full.height()), QColor(11, 11, 11, 18))
        p.fillRect(QRectF(x0, full.top(), max(1, x1 - x0), full.height()), alpha_color(BLUE, 18))
        pen = QPen(QColor(BLUE), 1.8)
        p.setPen(pen)
        p.drawLine(QPointF(x0, full.top()), QPointF(x0, full.bottom()))
        p.drawLine(QPointF(x1, full.top()), QPointF(x1, full.bottom()))
        for x in (x0, x1):
            p.setBrush(QBrush(QColor(BLUE)))
            p.setPen(Qt.PenStyle.NoPen)
            p.drawRoundedRect(QRectF(x - 4, full.center().y() - 13, 8, 26), 3, 3)

    def _draw_playhead(self, p: QPainter, r1: QRectF, r2: QRectF) -> None:
        if self.playhead is None:
            return
        x = self._sample_to_x(self.playhead, r1)
        pen = QPen(QColor(INK), 1.6)
        p.setPen(pen)
        p.drawLine(QPointF(x, r1.top() - 4), QPointF(x, r2.bottom() + 2))
        p.setBrush(QBrush(QColor(INK)))
        p.setPen(Qt.PenStyle.NoPen)
        triangle = [QPointF(x - 5, r1.top() - 4), QPointF(x + 5, r1.top() - 4), QPointF(x, r1.top() + 3)]
        p.drawPolygon(*triangle)  # type: ignore[arg-type]

    def mousePressEvent(self, event) -> None:  # noqa: N802
        if event.button() != Qt.MouseButton.LeftButton:
            return
        x = event.position().x()
        sample = self._x_to_sample(x)
        a, b = self.selection
        xa, xb = self._sample_to_x(a), self._sample_to_x(b)
        self._press_sample = sample
        self._original_selection = (a, b)
        if abs(x - xa) <= 8:
            self._mode = "left"
        elif abs(x - xb) <= 8:
            self._mode = "right"
        elif a <= sample <= b:
            self._mode = "move"
        else:
            self._mode = "new"
            self.selection = (sample, sample)
        self.update()

    def mouseMoveEvent(self, event) -> None:  # noqa: N802
        x = event.position().x()
        sample = self._x_to_sample(x)
        if self._mode is None:
            xa, xb = self._sample_to_x(self.selection[0]), self._sample_to_x(self.selection[1])
            if abs(x - xa) <= 8 or abs(x - xb) <= 8:
                self.setCursor(Qt.CursorShape.SizeHorCursor)
            elif self.selection[0] <= sample <= self.selection[1]:
                self.setCursor(Qt.CursorShape.SizeAllCursor)
            else:
                self.setCursor(Qt.CursorShape.CrossCursor)
            return

        n = len(self.left)
        min_len = max(64, int(0.05 * self.sample_rate))
        oa, ob = self._original_selection
        if self._mode == "left":
            new_a = max(0, min(sample, self.selection[1] - 32))
            self.selection = (new_a, self.selection[1])
        elif self._mode == "right":
            new_b = min(n, max(sample, self.selection[0] + 32))
            self.selection = (self.selection[0], new_b)
        elif self._mode == "move":
            length = ob - oa
            delta = sample - self._press_sample
            na = max(0, min(n - length, oa + delta))
            self.selection = (na, na + length)
        elif self._mode == "new":
            a, b = sorted((self._press_sample, sample))
            if b - a < min_len:
                center = (a + b) // 2
                a = max(0, center - min_len // 2)
                b = min(n, a + min_len)
                a = max(0, b - min_len)
            self.selection = (a, b)
        self.selectionChanged.emit(*self.selection)
        self.update()

    def mouseReleaseEvent(self, event) -> None:  # noqa: N802
        if event.button() != Qt.MouseButton.LeftButton or self._mode is None:
            return
        if self._mode == "new":
            a, b = self.selection
            if b - a < max(64, int(0.05 * self.sample_rate)):
                n = len(self.left)
                length = min(n, max(2048, int(0.25 * self.sample_rate)))
                center = (a + b) // 2
                na = max(0, min(n - length, center - length // 2))
                self.selection = (na, na + length)
        self._mode = None
        self.selectionChanged.emit(*self.selection)
        self.update()


class MetricCard(QFrame):
    def __init__(self, title: str, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setFrameShape(QFrame.Shape.StyledPanel)
        self.setStyleSheet(
            "MetricCard { background: #fcfcfb; border: 1px solid #e1e0d9; border-radius: 10px; }"
            "QLabel#cardTitle { color: #898781; font-size: 12px; }"
            "QLabel#cardValue { color: #0b0b0b; font-size: 20px; font-weight: 650; }"
            "QLabel#cardSub { color: #52514e; font-size: 12px; }"
        )
        layout = QVBoxLayout(self)
        layout.setContentsMargins(12, 9, 12, 10)
        layout.setSpacing(2)
        self.title = QLabel(title)
        self.title.setObjectName("cardTitle")
        self.value = QLabel("—")
        self.value.setObjectName("cardValue")
        self.value.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        self.sub = QLabel("")
        self.sub.setObjectName("cardSub")
        self.sub.setWordWrap(True)
        layout.addWidget(self.title)
        layout.addWidget(self.value)
        layout.addWidget(self.sub)

    def set_value(self, value: str, sub: str = "", tone: str = INK) -> None:
        self.value.setText(value)
        self.value.setStyleSheet(f"color: {tone};")
        self.sub.setText(sub)
