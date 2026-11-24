from __future__ import annotations

from typing import Any

import numpy as np
from PySide6.QtCore import QPointF, QRectF, Qt, Signal
from PySide6.QtGui import QBrush, QColor, QFont, QPainter, QPainterPath, QPen, QPolygonF
from PySide6.QtWidgets import QSizePolicy, QToolTip, QWidget

from .analysis import AnalysisResult
from .models import KIND_COLORS, KIND_LABELS, Annotation

SURFACE = QColor("#fcfcfb")
PAGE = QColor("#f9f9f7")
INK = QColor("#0b0b0b")
INK_SECONDARY = QColor("#52514e")
MUTED = QColor("#898781")
GRID = QColor("#e1e0d9")
BASELINE = QColor("#c3c2b7")
BLUE = QColor("#2a78d6")
ORANGE = QColor("#eb6834")
AQUA = QColor("#1baf7a")
VIOLET = QColor("#6250d6")
RED_STATUS = QColor("#d03b3b")
GREEN_STATUS = QColor("#0ca30c")
REFERENCE_FILL = QColor(42, 120, 214, 34)
REFERENCE_BORDER = QColor(42, 120, 214, 150)

LEFT_MARGIN = 112
RIGHT_MARGIN = 18
TOP_MARGIN = 26
BOTTOM_MARGIN = 24
_UNSET = object()


def fmt_time(t: float) -> str:
    if t < 10:
        return f"{t:.2f}s"
    m = int(t // 60)
    s = t - 60 * m
    return f"{m}:{s:05.2f}"


def mix_color(a: QColor, b: QColor, ratio: float) -> QColor:
    ratio = max(0.0, min(1.0, ratio))
    return QColor(
        int(a.red() * (1 - ratio) + b.red() * ratio),
        int(a.green() * (1 - ratio) + b.green() * ratio),
        int(a.blue() * (1 - ratio) + b.blue() * ratio),
        255,
    )


def db_sequential_color(db: float, lo: float = -72.0, hi: float = -12.0) -> QColor:
    # Validated blue ramp endpoints; high energy is the darker step.
    stops = ["#cde2fb", "#86b6ef", "#3987e5", "#1c5cab", "#0d366b"]
    q = max(0.0, min(1.0, (db - lo) / (hi - lo)))
    pos = q * (len(stops) - 1)
    i = min(len(stops) - 2, int(pos))
    return mix_color(QColor(stops[i]), QColor(stops[i + 1]), pos - i)


def deficit_color(deficit: float, threshold: float) -> QColor:
    # Blue means louder than the reference, paper/gray means near reference,
    # amber->red means a growing loss. Text/table carries the exact value.
    if deficit < -3:
        ratio = min(1.0, (-deficit - 3) / 12)
        return mix_color(QColor("#e8f1fd"), BLUE, 0.35 + 0.45 * ratio)
    if deficit < threshold * 0.55:
        return mix_color(QColor("#f0efec"), QColor("#f6d78a"), max(0.0, deficit / (threshold * 0.55)))
    ratio = min(1.0, (deficit - threshold * 0.55) / max(1.0, threshold * 1.1))
    return mix_color(QColor("#fab219"), RED_STATUS, ratio)


class TimePlotWidget(QWidget):
    annotationSelected = Signal(str)
    referenceDrawn = Signal(float, float)
    statusMessage = Signal(str)

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.duration = 1.0
        self.audio = None
        self.result: AnalysisResult | None = None
        self.annotations: list[Annotation] = []
        self.selected_id: str | None = None
        self.reference_start = 0.0
        self.reference_end = 1.0
        self.playhead: float | None = None
        self._drag_start: float | None = None
        self._drag_current: float | None = None
        self._press_was_marker = False
        self.setMouseTracking(True)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)
        self.setMinimumWidth(720)

    def set_context(
        self,
        *,
        duration: float | None = None,
        audio: Any = None,
        result: AnalysisResult | None = None,
        annotations: list[Annotation] | None = None,
        selected_id: str | None | object = _UNSET,
        reference_start: float | None = None,
        reference_end: float | None = None,
        playhead: float | None | object = _UNSET,
    ) -> None:
        if duration is not None:
            self.duration = max(0.001, float(duration))
        if audio is not None:
            self.audio = audio
        if result is not None:
            self.result = result
            self.duration = max(self.duration, result.frame_ends[-1] / result.sample_rate)
        if annotations is not None:
            self.annotations = annotations
        if selected_id is not _UNSET:
            self.selected_id = selected_id  # type: ignore[assignment]
        if reference_start is not None:
            self.reference_start = reference_start
        if reference_end is not None:
            self.reference_end = reference_end
        if playhead is not _UNSET:
            self.playhead = playhead  # type: ignore[assignment]
        self.update()

    def plot_rect(self) -> QRectF:
        return QRectF(
            LEFT_MARGIN,
            TOP_MARGIN,
            max(10.0, self.width() - LEFT_MARGIN - RIGHT_MARGIN),
            max(10.0, self.height() - TOP_MARGIN - BOTTOM_MARGIN),
        )

    def x_for_time(self, t: float, rect: QRectF | None = None) -> float:
        rect = rect or self.plot_rect()
        return rect.left() + max(0.0, min(self.duration, t)) / self.duration * rect.width()

    def time_for_x(self, x: float, rect: QRectF | None = None) -> float:
        rect = rect or self.plot_rect()
        return max(0.0, min(self.duration, (x - rect.left()) / max(1.0, rect.width()) * self.duration))

    def _time_ticks(self, rect: QRectF, painter: QPainter) -> None:
        painter.save()
        painter.setPen(QPen(MUTED, 1))
        font = QFont(self.font())
        font.setPointSizeF(max(8.0, self.font().pointSizeF() - 1.5))
        painter.setFont(font)
        target_px = 86.0
        raw_step = target_px / max(1.0, rect.width()) * self.duration
        steps = [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300]
        step = next((s for s in steps if s >= raw_step), 600.0)
        t = 0.0
        while t <= self.duration + 1e-9:
            x = self.x_for_time(t, rect)
            painter.setPen(QPen(GRID, 1))
            painter.drawLine(QPointF(x, rect.top()), QPointF(x, rect.bottom()))
            painter.setPen(MUTED)
            painter.drawText(QRectF(x - 42, rect.bottom() + 5, 84, 15), Qt.AlignmentFlag.AlignCenter, fmt_time(t))
            t += step
        painter.restore()

    def _draw_reference(self, painter: QPainter, rect: QRectF) -> None:
        x0 = self.x_for_time(self.reference_start, rect)
        x1 = self.x_for_time(self.reference_end, rect)
        if x1 <= x0:
            return
        painter.save()
        painter.setPen(QPen(REFERENCE_BORDER, 1.5, Qt.PenStyle.DashLine))
        painter.setBrush(REFERENCE_FILL)
        painter.drawRect(QRectF(x0, rect.top(), x1 - x0, rect.height()))
        painter.setPen(REFERENCE_BORDER)
        label = "参考基线区"
        painter.drawText(QRectF(x0 + 5, rect.top() + 3, 90, 16), Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter, label)
        painter.restore()

    def _draw_partial_end(self, painter: QPainter, rect: QRectF) -> None:
        if self.result is None or self.result.n_frames == 0:
            return
        partial = self.result.partial_frame_indices
        if partial.size == 0:
            return
        first_partial = int(partial[0])
        last_partial = int(partial[-1])
        fs = self.result.frame_starts[first_partial] / self.result.sample_rate
        fe = self.result.frame_ends[last_partial] / self.result.sample_rate
        x0 = self.x_for_time(fs, rect)
        x1 = self.x_for_time(fe, rect)
        if x1 - x0 < 2:
            x1 = x0 + 3
        painter.save()
        clip = QRectF(x0, rect.top(), max(2.0, x1 - x0), rect.height())
        painter.setClipRect(clip)
        painter.fillRect(clip, QColor(250, 178, 25, 42))
        pen = QPen(QColor("#b7791f"), 1)
        painter.setPen(pen)
        d = 7
        y = rect.top() - d
        while y < rect.bottom() + d:
            painter.drawLine(QPointF(x0 - 3, y + d), QPointF(x1 + 3, y - d))
            y += d
        painter.restore()
        painter.save()
        painter.setPen(QPen(QColor("#b7791f"), 1.4, Qt.PenStyle.DashLine))
        painter.drawLine(QPointF(x0, rect.top()), QPointF(x0, rect.bottom()))
        expected = int(round(self.result.config.window_ms / 1000 * self.result.sample_rate))
        if partial.size == 1:
            text = f"结尾短窗 {int(self.result.valid_samples[last_partial])}/{expected} 采样"
        else:
            text = f"结尾 {partial.size} 个短窗；最短 {int(self.result.valid_samples[last_partial])}/{expected}"
        tw = 238 if partial.size > 1 else 190
        tx = min(max(rect.left() + 4, x0 - tw - 8), rect.right() - tw)
        ty = max(rect.top() + 2, rect.bottom() - 34)
        box = QRectF(tx, ty, tw, 18)
        painter.setBrush(QColor(255, 251, 235, 235))
        painter.setPen(QPen(QColor("#d97706"), 1))
        painter.drawRoundedRect(box, 4, 4)
        painter.setPen(QColor("#92400e"))
        painter.drawText(box, Qt.AlignmentFlag.AlignCenter, text)
        painter.restore()

    def _draw_marker_spans(
        self,
        painter: QPainter,
        rect: QRectF,
        channel_index: int | None = None,
    ) -> None:
        for ann in self.annotations:
            if channel_index is not None and ann.channels and channel_index not in ann.channels:
                continue
            x0 = self.x_for_time(ann.start, rect)
            x1 = self.x_for_time(ann.end, rect)
            width = max(3.0, x1 - x0)
            color = QColor(KIND_COLORS.get(ann.kind, "#64748b"))
            selected = ann.id == self.selected_id
            fill = QColor(color)
            fill.setAlpha(72 if selected else 34)
            painter.save()
            painter.setBrush(fill)
            border = QPen(QColor(color), 2.2 if selected else 1.2)
            if ann.is_confirmed:
                border = QPen(GREEN_STATUS, 2.4 if selected else 1.8)
            painter.setPen(border)
            painter.drawRect(QRectF(x0, rect.top(), width, rect.height()))

            # Top label chip; icons are represented by ✓ for confirmed.
            short = KIND_LABELS.get(ann.kind, ann.kind)
            if ann.is_confirmed:
                short = "✓ " + short
            if width >= 46:
                chip_w = min(width - 4, max(44, painter.fontMetrics().horizontalAdvance(short) + 12))
                chip = QRectF(x0 + 2, rect.top() + 2, chip_w, 17)
                chip_color = GREEN_STATUS if ann.is_confirmed else color
                painter.setBrush(chip_color)
                painter.setPen(Qt.PenStyle.NoPen)
                painter.drawRoundedRect(chip, 3, 3)
                painter.setPen(QColor("#ffffff"))
                font = QFont(self.font())
                font.setPointSizeF(max(7.5, self.font().pointSizeF() - 2.0))
                painter.setFont(font)
                painter.drawText(chip, Qt.AlignmentFlag.AlignCenter, short)
            painter.restore()

    def _draw_playhead(self, painter: QPainter, rect: QRectF) -> None:
        if self.playhead is None:
            return
        x = self.x_for_time(self.playhead, rect)
        painter.save()
        painter.setPen(QPen(QColor("#111827"), 1.6))
        painter.drawLine(QPointF(x, rect.top() - 4), QPointF(x, rect.bottom() + 3))
        painter.setBrush(QColor("#111827"))
        painter.setPen(Qt.PenStyle.NoPen)
        painter.drawPolygon(QPolygonF([QPointF(x - 5, rect.top() - 4), QPointF(x + 5, rect.top() - 4), QPointF(x, rect.top() + 3)]))
        painter.restore()

    def _y_matches_annotation(self, ann: Annotation, y: float, rect: QRectF) -> bool:
        return True

    def _marker_at_x(self, x: float, y: float | None = None, rect: QRectF | None = None) -> Annotation | None:
        rect = rect or self.plot_rect()
        t = self.time_for_x(x, rect)
        matches = [a for a in self.annotations if a.start - 0.015 <= t <= a.end + 0.015]
        if y is not None:
            matches = [a for a in matches if self._y_matches_annotation(a, y, rect)]
        if not matches:
            return None
        if self.selected_id:
            for a in matches:
                if a.id == self.selected_id:
                    return a
        return max(matches, key=lambda a: a.end - a.start)

    def mousePressEvent(self, event) -> None:  # noqa: N802
        rect = self.plot_rect()
        if event.button() == Qt.MouseButton.LeftButton and rect.contains(event.position()):
            marker = self._marker_at_x(event.position().x(), event.position().y(), rect)
            if marker is not None:
                self.annotationSelected.emit(marker.id)
                self._press_was_marker = True
                return
            self._press_was_marker = False
            t = self.time_for_x(event.position().x(), rect)
            self._drag_start = t
            self._drag_current = t
            self.update()
        super().mousePressEvent(event)

    def mouseMoveEvent(self, event) -> None:  # noqa: N802
        rect = self.plot_rect()
        if self._drag_start is not None:
            self._drag_current = self.time_for_x(event.position().x(), rect)
            self.update()
            return
        marker = self._marker_at_x(event.position().x()) if rect.contains(event.position()) else None
        if marker is not None:
            m = marker.metrics
            lines = [marker.label, marker.time_text()]
            if "observed_band_db" in m:
                lines.append(f"实测 {m.get('observed_band_db')} dB；参考 {m.get('reference_band_db')} dB；下降 {m.get('band_drop_db')} dB")
            elif "observed_rms_db" in m:
                lines.append(f"本路 {m.get('observed_rms_db')} dB；参考 {m.get('reference_rms_db')} dB；下降 {m.get('rms_drop_db')} dB")
            elif "rms_db_by_channel" in m:
                lines.append(f"各声道 RMS {m.get('rms_db_by_channel')} dB")
            QToolTip.showText(event.globalPosition().toPoint(), "\n".join(lines), self)
        elif self.result is not None and rect.contains(event.position()):
            t = self.time_for_x(event.position().x(), rect)
            idx = self.result.frame_at_time(t)
            if idx is not None:
                QToolTip.showText(event.globalPosition().toPoint(), f"t={t:.3f}s，帧 {idx}", self)
        super().mouseMoveEvent(event)

    def mouseReleaseEvent(self, event) -> None:  # noqa: N802
        if event.button() == Qt.MouseButton.LeftButton and self._drag_start is not None:
            start = min(self._drag_start, self._drag_current or self._drag_start)
            end = max(self._drag_start, self._drag_current or self._drag_start)
            self._drag_start = None
            self._drag_current = None
            if end - start >= 0.12:
                self.referenceDrawn.emit(start, end)
            else:
                self.statusMessage.emit("参考区至少 0.12 秒，请横向拖动")
            self.update()
        super().mouseReleaseEvent(event)

    def paintEvent(self, event) -> None:  # noqa: N802
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        painter.fillRect(self.rect(), SURFACE)
        rect = self.plot_rect()
        painter.setPen(QPen(BASELINE, 1))
        painter.setBrush(Qt.BrushStyle.NoBrush)
        painter.drawRect(rect)
        self._time_ticks(rect, painter)
        if self._drag_start is not None and self._drag_current is not None:
            x0 = self.x_for_time(min(self._drag_start, self._drag_current), rect)
            x1 = self.x_for_time(max(self._drag_start, self._drag_current), rect)
            painter.fillRect(QRectF(x0, rect.top(), max(2, x1 - x0), rect.height()), QColor(42, 120, 214, 45))
        painter.end()


class WaveformWidget(TimePlotWidget):
    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setMinimumHeight(210)
        self._peak_cache: dict[tuple, tuple[np.ndarray, np.ndarray]] = {}

    def set_context(self, **kwargs) -> None:
        new_audio = kwargs.get("audio")
        if new_audio is not None and new_audio is not self.audio:
            self._peak_cache.clear()
        super().set_context(**kwargs)

    def _y_matches_annotation(self, ann: Annotation, y: float, rect: QRectF) -> bool:
        n_ch = self.audio.n_channels if self.audio is not None else 1
        gap = 14.0 if n_ch == 2 else 0.0
        row_h = (rect.height() - gap) / n_ch
        for c in range(n_ch):
            top = rect.top() + c * (row_h + gap)
            if top <= y <= top + row_h:
                return not ann.channels or c in ann.channels
        return False

    def _peaks(self, channel: int, buckets: int) -> tuple[np.ndarray, np.ndarray]:
        assert self.audio is not None
        key = (channel, buckets, self.audio.n_frames)
        if key in self._peak_cache:
            return self._peak_cache[key]
        x = self.audio.channel(channel)
        n = x.size
        edges = np.linspace(0, n, buckets + 1, dtype=np.int64)
        mins = np.empty(buckets, dtype=np.float32)
        maxs = np.empty(buckets, dtype=np.float32)
        for i in range(buckets):
            a, b = int(edges[i]), int(edges[i + 1])
            if b <= a:
                mins[i] = maxs[i] = 0
            else:
                mins[i] = float(np.min(x[a:b]))
                maxs[i] = float(np.max(x[a:b]))
        self._peak_cache[key] = (mins, maxs)
        return mins, maxs

    def paintEvent(self, event) -> None:  # noqa: N802
        super().paintEvent(event)  # draws surface, frame, ticks, drag
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing, False)
        rect = self.plot_rect()
        if self.audio is None:
            painter.setPen(INK_SECONDARY)
            painter.drawText(rect, Qt.AlignmentFlag.AlignCenter, "导入短 WAV 或载入内置案例；随后在此横向拖动选择参考区")
            painter.end()
            return

        n_ch = self.audio.n_channels
        gap = 14.0 if n_ch == 2 else 0.0
        row_h = (rect.height() - gap) / n_ch
        colors = [BLUE, ORANGE]
        labels = ["L 左声道", "R 右声道"] if n_ch == 2 else ["Mono 单声道"]

        # Overlays live behind waveforms but above the grid.
        for c in range(n_ch):
            row = QRectF(rect.left(), rect.top() + c * (row_h + gap), rect.width(), row_h)
            self._draw_reference(painter, row)
            self._draw_marker_spans(painter, row, channel_index=c)

        buckets = max(120, int(rect.width()))
        for c in range(n_ch):
            row_top = rect.top() + c * (row_h + gap)
            mid = row_top + row_h / 2
            amp = row_h * 0.42
            painter.setPen(QPen(GRID, 1))
            painter.drawLine(QPointF(rect.left(), mid), QPointF(rect.right(), mid))
            mins, maxs = self._peaks(c, buckets)
            color = QColor(colors[c] if c < len(colors) else BLUE)
            pen = QPen(color, 1)
            painter.setPen(pen)
            for i in range(buckets):
                x = rect.left() + (i + 0.5) / buckets * rect.width()
                y0 = mid - float(maxs[i]) * amp
                y1 = mid - float(mins[i]) * amp
                painter.drawLine(QPointF(x, y0), QPointF(x, y1))
            painter.setPen(INK_SECONDARY)
            font = QFont(self.font())
            font.setBold(True)
            painter.setFont(font)
            painter.drawText(QRectF(6, row_top + 2, 100, 18), Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter, labels[c])

        # Partial-end marker and playhead across the full plotting area.
        self._draw_partial_end(painter, rect)
        self._draw_playhead(painter, rect)
        painter.end()


class HeatmapWidget(TimePlotWidget):
    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.display_mode = "absolute"
        self.channel_filter = -1  # -1 all stacked, otherwise channel index
        self.setMinimumHeight(286)

    def set_display_mode(self, mode: str) -> None:
        self.display_mode = mode
        self.update()

    def set_channel_filter(self, channel: int) -> None:
        self.channel_filter = channel
        self.update()

    def _visible_channels(self, n_channels: int) -> list[int]:
        if self.channel_filter >= 0 and self.channel_filter < n_channels:
            return [self.channel_filter]
        return list(range(n_channels))

    def paintEvent(self, event) -> None:  # noqa: N802
        super().paintEvent(event)
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing, False)
        rect = self.plot_rect()
        if self.result is None or not self.result.bands:
            painter.setPen(INK_SECONDARY)
            painter.drawText(rect, Qt.AlignmentFlag.AlignCenter, "分析后显示各频带能量")
            painter.end()
            return

        result = self.result
        channels = self._visible_channels(result.rms_db.shape[1])
        group_gap = 18.0 if len(channels) > 1 else 0.0
        group_h = (rect.height() - group_gap * (len(channels) - 1)) / len(channels)
        colors = [BLUE, ORANGE]
        ch_names = ["L", "R"] if result.rms_db.shape[1] == 2 else ["M"]

        # Pixel-column aggregation keeps resizing and long-ish short files smooth.
        px_cols = max(120, int(rect.width()))
        frame_bins = np.linspace(0, result.n_frames, px_cols + 1, dtype=np.int64)

        for group_i, c in enumerate(channels):
            group = QRectF(rect.left(), rect.top() + group_i * (group_h + group_gap), rect.width(), group_h)
            n_bands = len(result.bands)
            band_h = group_h / n_bands

            for b, band in enumerate(result.bands):
                y = group.top() + (n_bands - 1 - b) * band_h
                row_rect = QRectF(rect.left(), y, rect.width(), max(2.0, band_h - 1))
                painter.fillRect(row_rect, QColor("#f6f7f9"))
                for px in range(px_cols):
                    f0, f1 = int(frame_bins[px]), max(int(frame_bins[px]) + 1, int(frame_bins[px + 1]))
                    f1 = min(result.n_frames, f1)
                    if f1 <= f0:
                        continue
                    if self.display_mode == "relative":
                        vals = result.reference.band_db[c, b] - result.band_db[f0:f1, c, b]
                        value = float(np.median(vals))
                        color = deficit_color(value, result.config.band_drop_db)
                    else:
                        value = float(np.median(result.band_db[f0:f1, c, b]))
                        color = db_sequential_color(value)
                    x = rect.left() + px / px_cols * rect.width()
                    w = rect.width() / px_cols + 0.6
                    painter.fillRect(QRectF(x, y, w, max(1.0, band_h - 1)), color)

                painter.setPen(INK_SECONDARY)
                font = QFont(self.font())
                font.setPointSizeF(max(7.5, self.font().pointSizeF() - 2.2))
                painter.setFont(font)
                label = band.name
                painter.drawText(QRectF(4, y, LEFT_MARGIN - 10, band_h), Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter, label)

            painter.setPen(QPen(colors[c] if c < len(colors) else BLUE, 2))
            painter.drawLine(QPointF(rect.left(), group.top()), QPointF(rect.left(), group.bottom()))
            painter.setPen(INK)
            f = QFont(self.font())
            f.setBold(True)
            f.setPointSizeF(max(8.5, self.font().pointSizeF() - 1.5))
            painter.setFont(f)
            painter.drawText(QRectF(4, group.top() - 17, 100, 16), Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter, f"通道 {ch_names[c]}")

            # Marker overlays are per channel where applicable; global quiet/all
            # bands are drawn on every visible group to preserve time alignment.
            for ann in self.annotations:
                if ann.channels and c not in ann.channels:
                    continue
                x0 = self.x_for_time(ann.start, rect)
                x1 = self.x_for_time(ann.end, rect)
                color = QColor(KIND_COLORS.get(ann.kind, "#64748b"))
                selected = ann.id == self.selected_id
                painter.save()
                fill = QColor(color)
                fill.setAlpha(28 if selected else 16)
                painter.fillRect(QRectF(x0, group.top(), max(3, x1 - x0), group_h), fill)
                pen = QPen(GREEN_STATUS if ann.is_confirmed else color, 2 if selected else 1.1)
                painter.setPen(pen)
                painter.drawRect(QRectF(x0, group.top(), max(3, x1 - x0), group_h))
                painter.restore()

        self._draw_reference(painter, rect)
        self._draw_partial_end(painter, rect)
        self._draw_playhead(painter, rect)

        # Compact color legend / readout.
        painter.save()
        legend_text = "颜色：绝对能量 dB（越深越响）" if self.display_mode == "absolute" else "颜色：相对参考下降 dB（红=疑似断裂）"
        painter.setPen(INK_SECONDARY)
        painter.drawText(QRectF(rect.right() - 260, 4, 260, 16), Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter, legend_text)
        painter.restore()
        painter.end()

    def _y_matches_annotation(self, ann: Annotation, y: float, rect: QRectF) -> bool:
        if not ann.channels or self.result is None:
            return True
        channels = self._visible_channels(self.result.rms_db.shape[1])
        group_gap = 18.0 if len(channels) > 1 else 0.0
        group_h = (rect.height() - group_gap * (len(channels) - 1)) / len(channels)
        for group_i, c in enumerate(channels):
            top = rect.top() + group_i * (group_h + group_gap)
            if top <= y <= top + group_h:
                return c in ann.channels
        return False

    def mouseMoveEvent(self, event) -> None:  # noqa: N802
        rect = self.plot_rect()
        if self._drag_start is not None:
            self._drag_current = self.time_for_x(event.position().x(), rect)
            self.update()
            QWidget.mouseMoveEvent(self, event)
            return
        if self.result is None:
            super().mouseMoveEvent(event)
            return
        pos = event.position()
        if not rect.contains(pos):
            super().mouseMoveEvent(event)
            return
        t = self.time_for_x(pos.x(), rect)
        idx = self.result.frame_at_time(t)
        if idx is None:
            return
        channels = self._visible_channels(self.result.rms_db.shape[1])
        group_gap = 18.0 if len(channels) > 1 else 0.0
        group_h = (rect.height() - group_gap * (len(channels) - 1)) / len(channels)
        lines = [f"t={t:.3f}s，帧 {idx}{'（结尾短窗）' if not self.result.complete[idx] else ''}"]
        for group_i, c in enumerate(channels):
            top = rect.top() + group_i * (group_h + group_gap)
            if top <= pos.y() <= top + group_h:
                b = min(len(self.result.bands) - 1, max(0, int((top + group_h - pos.y()) / group_h * len(self.result.bands))))
                band = self.result.bands[b]
                obs = float(self.result.band_db[idx, c, b])
                ref = float(self.result.reference.band_db[c, b])
                lines.append(f"通道 {c + 1} · {band.name}")
                lines.append(f"实测 {obs:.2f} dB；参考 {ref:.2f} dB；下降 {ref - obs:.2f} dB")
                break
        marker = self._marker_at_x(pos.x())
        if marker:
            lines.append(marker.label)
        QToolTip.showText(event.globalPosition().toPoint(), "\n".join(lines), self)
        # Skip base tooltip to avoid replacing this richer readout.
        QWidget.mouseMoveEvent(self, event)


class RelationWidget(TimePlotWidget):
    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setMinimumHeight(214)

    def paintEvent(self, event) -> None:  # noqa: N802
        super().paintEvent(event)
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        rect = self.plot_rect()
        if self.result is None:
            painter.setPen(INK_SECONDARY)
            painter.drawText(rect, Qt.AlignmentFlag.AlignCenter, "显示双通道电平差与相关性；单声道显示为固定相关 1")
            painter.end()
            return

        rms_height = rect.height() * 0.58
        rms_rect = QRectF(rect.left(), rect.top(), rect.width(), rms_height)
        corr_top = rms_rect.bottom() + 24
        corr_rect = QRectF(rect.left(), corr_top, rect.width(), max(28.0, rect.bottom() - corr_top))
        self._draw_rms(painter, rms_rect)
        self._draw_correlation(painter, corr_rect)
        self._draw_marker_spans(painter, rect)
        self._draw_partial_end(painter, rect)
        self._draw_playhead(painter, rect)
        painter.end()

    def _draw_rms(self, painter: QPainter, rect: QRectF) -> None:
        assert self.result is not None
        lo, hi = -72.0, -12.0

        def y(v: float) -> float:
            v = max(lo, min(hi, v))
            return rect.bottom() - (v - lo) / (hi - lo) * rect.height()

        painter.save()
        painter.setPen(INK_SECONDARY)
        painter.drawText(QRectF(4, rect.top() - 18, 180, 16), Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter, "通道 RMS 能量 dBFS")
        for db in (-60, -48, -36, -24, -12):
            yy = y(db)
            painter.setPen(QPen(GRID, 1))
            painter.drawLine(QPointF(rect.left(), yy), QPointF(rect.right(), yy))
            painter.setPen(MUTED)
            painter.drawText(QRectF(2, yy - 8, LEFT_MARGIN - 10, 14), Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter, f"{db}")
        q = self.result.config.quiet_abs_db
        painter.setPen(QPen(QColor("#64748b"), 1.2, Qt.PenStyle.DashLine))
        painter.drawLine(QPointF(rect.left(), y(q)), QPointF(rect.right(), y(q)))
        painter.setPen(QColor("#64748b"))
        painter.drawText(QRectF(rect.right() - 170, y(q) - 15, 166, 13), Qt.AlignmentFlag.AlignRight, f"安静阈值 {q:.0f} dB")

        px_cols = max(120, int(rect.width()))
        bins = np.linspace(0, self.result.n_frames, px_cols + 1, dtype=np.int64)
        colors = [BLUE, ORANGE]
        for c in range(self.result.rms_db.shape[1]):
            path = QPainterPath()
            started = False
            for px in range(px_cols):
                f0, f1 = int(bins[px]), max(int(bins[px]) + 1, int(bins[px + 1]))
                vals = self.result.rms_db[f0:min(f1, self.result.n_frames), c]
                if vals.size == 0:
                    continue
                v = float(np.median(vals))
                x = rect.left() + (px + 0.5) / px_cols * rect.width()
                yy = y(v)
                if not started:
                    path.moveTo(x, yy)
                    started = True
                else:
                    path.lineTo(x, yy)
            painter.setPen(QPen(colors[c], 1.8))
            painter.drawPath(path)
            painter.setPen(INK_SECONDARY)
            name = "L" if c == 0 and self.result.rms_db.shape[1] == 2 else ("R" if c == 1 else "M")
            painter.drawText(QRectF(rect.left() + 6 + c * 28, rect.top() + 2, 24, 15), Qt.AlignmentFlag.AlignLeft, name)
        painter.restore()

    def _draw_correlation(self, painter: QPainter, rect: QRectF) -> None:
        assert self.result is not None
        lo, hi = -1.0, 1.0

        def y(v: float) -> float:
            v = max(lo, min(hi, v))
            return rect.bottom() - (v - lo) / (hi - lo) * rect.height()

        painter.save()
        painter.setPen(INK_SECONDARY)
        painter.drawText(QRectF(4, rect.top() - 17, 220, 15), Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter, "通道相关性（NaN/无声处断线）")
        for val in (-1, 0, 1):
            yy = y(val)
            painter.setPen(QPen(GRID if val != 0 else BASELINE, 1))
            painter.drawLine(QPointF(rect.left(), yy), QPointF(rect.right(), yy))
            painter.setPen(MUTED)
            painter.drawText(QRectF(LEFT_MARGIN - 34, yy - 7, 28, 14), Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter, f"{val:+d}")

        px_cols = max(120, int(rect.width()))
        bins = np.linspace(0, self.result.n_frames, px_cols + 1, dtype=np.int64)
        path = QPainterPath()
        active = False
        for px in range(px_cols):
            f0, f1 = int(bins[px]), max(int(bins[px]) + 1, int(bins[px + 1]))
            vals = self.result.correlation[f0:min(f1, self.result.n_frames)]
            vals = vals[np.isfinite(vals)]
            if vals.size == 0:
                active = False
                continue
            v = float(np.median(vals))
            x = rect.left() + (px + 0.5) / px_cols * rect.width()
            yy = y(v)
            if not active:
                path.moveTo(x, yy)
                active = True
            else:
                path.lineTo(x, yy)
        painter.setPen(QPen(VIOLET, 1.8))
        painter.drawPath(path)
        painter.restore()
