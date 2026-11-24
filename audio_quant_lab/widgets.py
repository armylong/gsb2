"""Dependency-free Qt waveform and log-spectrum widgets."""

from __future__ import annotations

from collections.abc import Iterable

import numpy as np
from PySide6.QtCore import QPointF, QRectF, Qt, Signal
from PySide6.QtGui import (
    QColor,
    QFont,
    QMouseEvent,
    QPainter,
    QPainterPath,
    QPen,
    QPolygonF,
)
from PySide6.QtWidgets import QWidget

from .dsp import DB_FLOOR

SURFACE = "#fcfcfb"
PAGE = "#f9f9f7"
GRID = "#e1e0d9"
AXIS = "#c3c2b7"
INK = "#0b0b0b"
SECONDARY = "#52514e"
MUTED = "#898781"
BORDER = "rgba(11,11,11,0.10)"

COLOR_INPUT = "#6b6a65"
COLOR_DIRECT = "#2a78d6"
COLOR_DITHER = "#eb6834"
COLOR_SHAPED = "#1baf7a"
COLOR_ERROR = "#6250d6"
COLOR_CRITICAL = "#d03b3b"


def nice_step(raw: float) -> float:
    if raw <= 0 or not np.isfinite(raw):
        return 1.0
    exponent = int(np.floor(np.log10(raw)))
    base = 10.0**exponent
    for multiplier in (1.0, 2.0, 5.0, 10.0):
        if raw <= multiplier * base:
            return multiplier * base
    return 10.0 * base


def format_amplitude(value: float) -> str:
    if value == 0 or not np.isfinite(value):
        return "0"
    absolute = abs(value)
    if absolute >= 0.1:
        return f"{value:.2f}".rstrip("0").rstrip(".")
    if absolute >= 0.01:
        return f"{value:.3f}".rstrip("0").rstrip(".")
    return f"{value:.1e}"


def format_time(seconds: float) -> str:
    if not np.isfinite(seconds):
        return "--"
    if abs(seconds) < 1.0:
        return f"{seconds * 1000.0:.1f} ms"
    minutes = int(seconds // 60)
    rest = seconds - minutes * 60
    if minutes:
        return f"{minutes}:{rest:04.1f}"
    return f"{rest:.2f} s"


def format_frequency(hz: float) -> str:
    if hz >= 1000.0:
        value = hz / 1000.0
        text = f"{value:.2f}".rstrip("0").rstrip(".")
        return f"{text} kHz"
    text = f"{hz:.1f}".rstrip("0").rstrip(".")
    return f"{text} Hz"


class WaveformWidget(QWidget):
    seekRequested = Signal(int)
    readoutChanged = Signal(str)

    def __init__(
        self,
        title: str = "",
        color: str = COLOR_INPUT,
        fixed_range: tuple[float, float] | None = (-1.0, 1.0),
        auto_range: bool = False,
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        self.title = title
        self.color = QColor(color)
        self.fixed_range = fixed_range
        self.auto_range = auto_range
        self.span_floor = 1.0 / (1 << 23)

        self.samples: np.ndarray | None = None
        self.sample_rate = 48_000
        self.playhead = -1
        self.hover_frame = -1
        self.alert_frames: np.ndarray | None = None
        self.alert_label = "饱和"
        self.setMinimumHeight(170)
        self.setMouseTracking(True)
        self.setCursor(Qt.CursorShape.IBeamCursor)

    def set_data(
        self,
        samples: np.ndarray,
        sample_rate: int | None = None,
        alert_frames: Iterable[int] | np.ndarray | None = None,
    ) -> None:
        self.samples = np.asarray(samples, dtype=np.float64)
        if sample_rate is not None:
            self.sample_rate = int(sample_rate)
        self.alert_frames = None if alert_frames is None else np.asarray(alert_frames)
        self.playhead = min(max(0, self.playhead), max(0, self.samples.size - 1))
        self.update()

    def set_playhead(self, frame: int) -> None:
        self.playhead = int(frame)
        self.update()

    def set_color(self, color: str) -> None:
        self.color = QColor(color)
        self.update()

    def plot_rect(self) -> QRectF:
        return QRectF(58.0, 12.0, max(10.0, self.width() - 72.0), max(10.0, self.height() - 38.0))

    def y_bounds(self) -> tuple[float, float, float]:
        if self.fixed_range is not None and not self.auto_range:
            lo, hi = self.fixed_range
            step = 0.5 if lo == -1 and hi == 1 else nice_step((hi - lo) / 4.0)
            return lo, hi, step

        if self.samples is None or self.samples.size == 0:
            maximum = self.span_floor
        else:
            maximum = float(np.max(np.abs(self.samples)))
            maximum = max(maximum, self.span_floor)
        step = nice_step(maximum / 2.0)
        top = max(step, np.ceil(maximum / step) * step)
        return -top, top, step

    def frame_to_x(self, frame: float, rect: QRectF) -> float:
        n = 0 if self.samples is None else self.samples.size
        if n <= 1:
            return rect.center().x()
        usable = max(1.0, rect.width() - 8.0)
        return rect.left() + 4.0 + (frame / (n - 1)) * usable

    def x_to_frame(self, x: float, rect: QRectF) -> int:
        n = 0 if self.samples is None else self.samples.size
        if n == 0:
            return -1
        if n == 1:
            return 0
        usable = max(1.0, rect.width() - 8.0)
        ratio = (x - rect.left() - 4.0) / usable
        ratio = min(1.0, max(0.0, ratio))
        return round(ratio * (n - 1))

    def y_to_pixel(self, value: float, rect: QRectF, lo: float, hi: float) -> float:
        return rect.bottom() - ((value - lo) / (hi - lo)) * rect.height()

    def paintEvent(self, event) -> None:
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        painter.fillRect(self.rect(), QColor(SURFACE))

        rect = self.plot_rect()
        lo, hi, y_step = self.y_bounds()

        # Horizontal grid and amplitude labels.
        font = QFont(self.font())
        font.setPointSizeF(max(8.0, self.font().pointSizeF() - 1.0))
        painter.setFont(font)
        value = 0.0
        ticks = [0.0]
        while value + y_step <= hi + y_step * 0.01:
            value += y_step
            ticks.extend((value, -value))
        for tick in sorted(set(ticks)):
            if tick < lo - 1e-18 or tick > hi + 1e-18:
                continue
            y = self.y_to_pixel(tick, rect, lo, hi)
            pen = QPen(QColor(AXIS if abs(tick) < 1e-15 else GRID), 1.0)
            painter.setPen(pen)
            painter.drawLine(QPointF(rect.left(), y), QPointF(rect.right(), y))
            painter.setPen(QColor(MUTED))
            label = format_amplitude(tick)
            painter.drawText(
                QRectF(2.0, y - 8.0, 52.0, 16.0),
                Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter,
                label,
            )

        self._draw_time_grid(painter, rect)

        pen = QPen(QColor(BORDER), 1.0)
        painter.setPen(pen)
        painter.setBrush(Qt.BrushStyle.NoBrush)
        painter.drawRect(rect)

        if self.samples is None or self.samples.size == 0:
            painter.setPen(QColor(MUTED))
            painter.drawText(rect, Qt.AlignmentFlag.AlignCenter, "没有可显示的样本")
            return

        painter.save()
        painter.setClipRect(rect)
        self._draw_waveform(painter, rect, lo, hi)
        self._draw_alerts(painter, rect)
        self._draw_playhead(painter, rect)
        self._draw_hover(painter, rect)
        painter.restore()

        painter.setPen(QColor(SECONDARY))
        caption = self.title
        if self.auto_range:
            caption += f"  ·  自动纵轴 ±{format_amplitude(hi)}"
        painter.drawText(
            QRectF(rect.left() + 6.0, 1.0, rect.width() - 12.0, 16.0),
            Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter,
            caption,
        )

    def _draw_time_grid(self, painter: QPainter, rect: QRectF) -> None:
        n = 0 if self.samples is None else self.samples.size
        if n == 0:
            return
        duration = n / self.sample_rate
        step = nice_step(duration / 5.0)
        t = 0.0
        while t <= duration + step * 1e-6:
            frame = round(t * self.sample_rate)
            if frame >= n:
                frame = n - 1
            x = self.frame_to_x(frame, rect)
            painter.setPen(QPen(QColor(GRID), 1.0))
            painter.drawLine(QPointF(x, rect.top()), QPointF(x, rect.bottom()))
            painter.setPen(QColor(MUTED))
            painter.drawText(
                QRectF(x - 45.0, rect.bottom() + 5.0, 90.0, 16.0),
                Qt.AlignmentFlag.AlignCenter,
                format_time(t),
            )
            t += step

    def _draw_waveform(self, painter: QPainter, rect: QRectF, lo: float, hi: float) -> None:
        assert self.samples is not None
        n = self.samples.size
        pixel_width = max(1, int(rect.width()))
        pen = QPen(self.color, 1.8)
        pen.setJoinStyle(Qt.PenJoinStyle.RoundJoin)
        painter.setPen(pen)

        if n > pixel_width * 2:
            per = int(np.ceil(n / pixel_width))
            bucket_count = int(np.ceil(n / per))
            padded = np.full(per * bucket_count, np.nan, dtype=np.float64)
            padded[:n] = self.samples
            buckets = padded.reshape(bucket_count, per)
            mins = np.nanmin(buckets, axis=1)
            maxs = np.nanmax(buckets, axis=1)
            for i in range(bucket_count):
                x = rect.left() + (i + 0.5) * rect.width() / bucket_count
                y1 = self.y_to_pixel(float(mins[i]), rect, lo, hi)
                y2 = self.y_to_pixel(float(maxs[i]), rect, lo, hi)
                painter.drawLine(QPointF(x, min(y1, y2)), QPointF(x, max(y1, y2)))
            return

        path = QPainterPath()
        x0 = self.frame_to_x(0, rect)
        y0 = self.y_to_pixel(float(self.samples[0]), rect, lo, hi)
        path.moveTo(x0, y0)
        previous_y = y0
        points = [QPointF(x0, y0)]
        for i in range(1, n):
            x = self.frame_to_x(i, rect)
            # Sample-and-hold edge makes integer levels easy to inspect.
            path.lineTo(x, previous_y)
            y = self.y_to_pixel(float(self.samples[i]), rect, lo, hi)
            path.lineTo(x, y)
            previous_y = y
            points.append(QPointF(x, y))
        painter.drawPath(path)

        if n <= 512:
            painter.setBrush(self.color)
            marker_pen = QPen(QColor(SURFACE), 1.2)
            painter.setPen(marker_pen)
            radius = 3.2 if n <= 64 else 2.4
            for point in points:
                painter.drawEllipse(point, radius, radius)

    def _draw_alerts(self, painter: QPainter, rect: QRectF) -> None:
        if self.alert_frames is None or self.alert_frames.size == 0 or self.samples is None:
            return
        n = self.samples.size
        if n == 1:
            unique_x = np.array([round(rect.center().x())])
        else:
            usable = max(1.0, rect.width() - 8.0)
            xs = rect.left() + 4.0 + (self.alert_frames / (n - 1)) * usable
            unique_x = np.unique(np.rint(xs).astype(int))
        color = QColor(COLOR_CRITICAL)
        painter.setPen(QPen(color, 1.4))
        painter.setBrush(color)
        for x_value in unique_x:
            x = float(x_value)
            painter.drawLine(QPointF(x, rect.top() + 2), QPointF(x, rect.top() + 8))
            triangle = QPolygonF(
                [
                    QPointF(x - 3.0, rect.top() + 2.0),
                    QPointF(x + 3.0, rect.top() + 2.0),
                    QPointF(x, rect.top() + 6.0),
                ]
            )
            painter.drawPolygon(triangle)

    def _draw_playhead(self, painter: QPainter, rect: QRectF) -> None:
        if self.playhead < 0 or self.samples is None or self.playhead >= self.samples.size:
            return
        x = self.frame_to_x(self.playhead, rect)
        painter.setPen(QPen(QColor(INK), 1.4))
        painter.drawLine(QPointF(x, rect.top()), QPointF(x, rect.bottom()))
        painter.setBrush(QColor(INK))
        painter.setPen(Qt.PenStyle.NoPen)
        painter.drawPolygon(
            QPolygonF(
                [
                    QPointF(x - 5.0, rect.top()),
                    QPointF(x + 5.0, rect.top()),
                    QPointF(x, rect.top() + 6.0),
                ]
            )
        )

    def _draw_hover(self, painter: QPainter, rect: QRectF) -> None:
        if self.hover_frame < 0 or self.samples is None:
            return
        x = self.frame_to_x(self.hover_frame, rect)
        pen = QPen(QColor(SECONDARY), 1.0, Qt.PenStyle.DashLine)
        painter.setPen(pen)
        painter.drawLine(QPointF(x, rect.top()), QPointF(x, rect.bottom()))

    def mousePressEvent(self, event: QMouseEvent) -> None:
        rect = self.plot_rect()
        frame = self.x_to_frame(event.position().x(), rect)
        if frame >= 0:
            self.hover_frame = frame
            self.seekRequested.emit(frame)
            self._emit_readout(frame)
        self.update()
        super().mousePressEvent(event)

    def mouseMoveEvent(self, event: QMouseEvent) -> None:
        rect = self.plot_rect()
        frame = self.x_to_frame(event.position().x(), rect)
        if frame != self.hover_frame:
            self.hover_frame = frame
            self.update()
        if frame >= 0:
            self._emit_readout(frame)
            if event.buttons() & Qt.MouseButton.LeftButton:
                self.seekRequested.emit(frame)
        super().mouseMoveEvent(event)

    def leaveEvent(self, event) -> None:
        self.hover_frame = -1
        self.readoutChanged.emit("")
        self.update()
        super().leaveEvent(event)

    def _emit_readout(self, frame: int) -> None:
        if self.samples is None or not 0 <= frame < self.samples.size:
            self.readoutChanged.emit("")
            return
        t = frame / self.sample_rate
        value = float(self.samples[frame])
        self.readoutChanged.emit(
            f"{format_time(t)}  ·  样本 {frame:,}  ·  幅度 {value:+.6f}"
        )


class SpectrumWidget(QWidget):
    readoutChanged = Signal(str)

    def __init__(self, title: str = "", color: str = COLOR_INPUT, parent: QWidget | None = None):
        super().__init__(parent)
        self.title = title
        self.color = QColor(color)
        self.freqs: np.ndarray | None = None
        self.db: np.ndarray | None = None
        self.sample_rate = 48_000
        self.segment_length = 0
        self.fft_size = 0
        self.hover_x: float | None = None
        self.setMinimumHeight(170)
        self.setMouseTracking(True)

    def set_spectrum(
        self,
        freqs: np.ndarray,
        db: np.ndarray,
        sample_rate: int,
        segment_length: int,
        fft_size: int,
    ) -> None:
        self.freqs = np.asarray(freqs)
        self.db = np.asarray(db)
        self.sample_rate = int(sample_rate)
        self.segment_length = int(segment_length)
        self.fft_size = int(fft_size)
        self.update()

    def set_color(self, color: str) -> None:
        self.color = QColor(color)
        self.update()

    def plot_rect(self) -> QRectF:
        return QRectF(62.0, 30.0, max(10.0, self.width() - 78.0), max(10.0, self.height() - 72.0))

    def frequency_limits(self) -> tuple[float, float]:
        nyquist = self.sample_rate / 2.0
        if self.freqs is not None and self.freqs.size:
            fmax = min(float(self.freqs[-1]), nyquist)
        else:
            fmax = nyquist
        fmax = max(1.0, fmax)
        fmin = min(20.0, fmax / 2.0)
        if fmax <= 40.0:
            fmin = max(1.0, fmax / 100.0)
        return fmin, fmax

    def freq_to_x(self, freq: float, rect: QRectF, fmin: float, fmax: float) -> float:
        low = np.log10(fmin)
        high = np.log10(fmax)
        return rect.left() + (np.log10(max(freq, fmin)) - low) / (high - low) * rect.width()

    def x_to_freq(self, x: float, rect: QRectF, fmin: float, fmax: float) -> float:
        ratio = (x - rect.left()) / max(1.0, rect.width())
        ratio = min(1.0, max(0.0, ratio))
        low = np.log10(fmin)
        high = np.log10(fmax)
        return 10.0 ** (low + ratio * (high - low))

    def db_to_y(self, value: float, rect: QRectF) -> float:
        return rect.bottom() - ((value - DB_FLOOR) / (0.0 - DB_FLOOR)) * rect.height()

    def paintEvent(self, event) -> None:
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        painter.fillRect(self.rect(), QColor(SURFACE))
        rect = self.plot_rect()

        font = QFont(self.font())
        font.setPointSizeF(max(8.0, self.font().pointSizeF() - 1.0))
        painter.setFont(font)

        title_font = QFont(font)
        title_font.setBold(True)
        title_font.setPointSizeF(max(9.0, self.font().pointSizeF()))
        painter.setFont(title_font)
        painter.setPen(QColor(INK))
        painter.drawText(
            QRectF(rect.left(), 4.0, 240.0, 18.0),
            Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter,
            self.title,
        )
        painter.setFont(font)

        for db_value in range(0, int(DB_FLOOR) - 1, -20):
            y = self.db_to_y(float(db_value), rect)
            painter.setPen(QPen(QColor(GRID if db_value else AXIS), 1.0))
            painter.drawLine(QPointF(rect.left(), y), QPointF(rect.right(), y))
            painter.setPen(QColor(MUTED))
            painter.drawText(
                QRectF(2.0, y - 8.0, 56.0, 16.0),
                Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter,
                f"{db_value}",
            )

        fmin, fmax = self.frequency_limits()
        candidates = [10, 20, 30, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 40000, 80000]
        last_label_right = rect.left() - 100.0
        label_font_metrics = painter.fontMetrics()
        for freq in candidates:
            if freq < fmin or freq > fmax:
                continue
            x = self.freq_to_x(float(freq), rect, fmin, fmax)
            painter.setPen(QPen(QColor(GRID), 1.0))
            painter.drawLine(QPointF(x, rect.top()), QPointF(x, rect.bottom()))

            label = format_frequency(float(freq))
            text_width = label_font_metrics.horizontalAdvance(label) + 12.0
            label_rect = QRectF(x - text_width / 2.0, rect.bottom() + 5.0, text_width, 16.0)
            # On a logarithmic axis low-frequency candidate labels can be only
            # a few pixels apart; retain gridlines but cull colliding labels.
            if label_rect.left() < last_label_right + 6.0:
                continue
            if label_rect.right() > rect.right() + 2.0:
                continue
            painter.setPen(QColor(MUTED))
            painter.drawText(label_rect, Qt.AlignmentFlag.AlignCenter, label)
            last_label_right = label_rect.right()

        painter.save()
        painter.translate(16.0, rect.center().y())
        painter.rotate(-90.0)
        painter.setPen(QColor(MUTED))
        painter.drawText(
            QRectF(-40.0, -8.0, 80.0, 16.0),
            Qt.AlignmentFlag.AlignCenter,
            "dBFS",
        )
        painter.restore()
        painter.setPen(QColor(MUTED))
        painter.drawText(
            QRectF(rect.left(), self.height() - 18.0, rect.width(), 14.0),
            Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter,
            "频率（对数轴）",
        )

        painter.setPen(QPen(QColor(BORDER), 1.0))
        painter.drawRect(rect)

        if self.freqs is None or self.db is None or self.freqs.size == 0:
            painter.setPen(QColor(MUTED))
            painter.drawText(rect, Qt.AlignmentFlag.AlignCenter, "没有频谱")
            return

        mask = (self.freqs >= fmin) & (self.freqs <= fmax)
        freqs = self.freqs[mask]
        values = self.db[mask]
        if freqs.size < 2:
            return

        silent = bool(np.max(values) <= DB_FLOOR + 0.5)
        if silent:
            painter.setPen(QColor(SECONDARY))
            painter.drawText(
                rect.adjusted(0, 0, 0, -24),
                Qt.AlignmentFlag.AlignHCenter | Qt.AlignmentFlag.AlignBottom,
                "数字静音：样本全为 0，频谱贴住显示底限",
            )

        painter.save()
        painter.setClipRect(rect)
        path = QPainterPath()
        first_x = self.freq_to_x(float(freqs[0]), rect, fmin, fmax)
        first_y = self.db_to_y(float(values[0]), rect)
        path.moveTo(first_x, first_y)
        for f, v in zip(freqs[1:], values[1:]):
            path.lineTo(self.freq_to_x(float(f), rect, fmin, fmax), self.db_to_y(float(v), rect))

        fill_path = QPainterPath(path)
        fill_path.lineTo(self.freq_to_x(float(freqs[-1]), rect, fmin, fmax), rect.bottom())
        fill_path.lineTo(first_x, rect.bottom())
        fill_path.closeSubpath()
        fill_color = QColor(self.color)
        fill_color.setAlpha(28)
        painter.fillPath(fill_path, fill_color)

        pen = QPen(self.color, 1.9)
        painter.setPen(pen)
        painter.drawPath(path)

        if self.hover_x is not None and rect.left() <= self.hover_x <= rect.right():
            freq = self.x_to_freq(self.hover_x, rect, fmin, fmax)
            index = int(np.argmin(np.abs(freqs - freq)))
            hf = float(freqs[index])
            hv = float(values[index])
            hx = self.freq_to_x(hf, rect, fmin, fmax)
            hy = self.db_to_y(hv, rect)
            painter.setPen(QPen(QColor(SECONDARY), 1.0, Qt.PenStyle.DashLine))
            painter.drawLine(QPointF(hx, rect.top()), QPointF(hx, rect.bottom()))
            painter.setBrush(self.color)
            painter.setPen(QPen(QColor(SURFACE), 1.5))
            painter.drawEllipse(QPointF(hx, hy), 4.0, 4.0)
        painter.restore()

        peak_index = int(np.argmax(values))
        peak_text = (
            f"峰值 {format_frequency(float(freqs[peak_index]))} · "
            f"{float(values[peak_index]):.1f} dBFS"
        )
        peak_rect = QRectF(rect.left() + 8.0, rect.top() + 6.0, 285.0, 18.0)
        painter.setPen(Qt.PenStyle.NoPen)
        painter.setBrush(QColor(252, 252, 251, 215))
        painter.drawRoundedRect(peak_rect.adjusted(-5.0, -2.0, 5.0, 2.0), 5.0, 5.0)
        painter.setPen(QColor(INK))
        painter.drawText(
            peak_rect,
            Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter,
            peak_text,
        )
        analysis = f"窗 {self.segment_length:,} 样本 / FFT {self.fft_size:,}"
        if self.segment_length < min(2048, self.fft_size):
            analysis += "（短录音，整段补零显示）"
        painter.setPen(QColor(MUTED))
        painter.drawText(
            QRectF(rect.right() - 360.0, 3.0, 352.0, 18.0),
            Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter,
            analysis,
        )

    def mouseMoveEvent(self, event: QMouseEvent) -> None:
        self.hover_x = event.position().x()
        if self.freqs is not None and self.db is not None and self.freqs.size:
            rect = self.plot_rect()
            fmin, fmax = self.frequency_limits()
            if rect.left() <= self.hover_x <= rect.right():
                freq = self.x_to_freq(self.hover_x, rect, fmin, fmax)
                mask = (self.freqs >= fmin) & (self.freqs <= fmax)
                freqs = self.freqs[mask]
                db = self.db[mask]
                if freqs.size:
                    index = int(np.argmin(np.abs(freqs - freq)))
                    self.readoutChanged.emit(
                        f"频谱 {format_frequency(float(freqs[index]))} · "
                        f"{float(db[index]):.1f} dBFS"
                    )
        self.update()
        super().mouseMoveEvent(event)

    def leaveEvent(self, event) -> None:
        self.hover_x = None
        self.readoutChanged.emit("")
        self.update()
        super().leaveEvent(event)
