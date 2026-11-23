"""Waveform view: per-channel display with separate positive/negative clip marks."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from PySide6.QtCore import QPoint, QRectF, Qt, Signal
from PySide6.QtGui import (
    QColor,
    QFont,
    QMouseEvent,
    QPainter,
    QPaintEvent,
    QPen,
    QWheelEvent,
)
from PySide6.QtWidgets import QWidget

from ..analysis import (
    STATUS_CONFIRMED,
    STATUS_EXCLUDED,
    Segment,
    format_sample_time,
)

COL_BG = QColor("#14171c")
COL_GRID = QColor("#252b34")
COL_ZERO = QColor("#3a4250")
COL_WAVE = QColor("#7fb2e5")
COL_WAVE_REPAIRED = QColor("#ffb454")
COL_DIFF = QColor("#7ee0a3")
COL_SELECT = QColor(255, 255, 255, 38)
COL_POS = QColor("#e05c5c")
COL_NEG = QColor("#4f9bd9")
COL_CONFIRMED = QColor("#e0b34f")
COL_EXCLUDED = QColor("#6a7280")
COL_LOWCONF = QColor("#c060c0")
COL_PLAYHEAD = QColor("#ffffff")
COL_TEXT = QColor("#cfd6e0")
COL_TEXT_DIM = QColor("#8b95a3")

POLARITY_HATCH = 8


@dataclass
class ViewRange:
    start: int
    end: int

    @property
    def length(self) -> int:
        return max(1, self.end - self.start)


class WaveformView(QWidget):
    playheadMoved = Signal(int)
    regionSelected = Signal(int, int, int)  # channel, start, end
    viewChanged = Signal(int, int)
    segmentClicked = Signal(int)  # segment uid

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setMinimumHeight(220)
        self.setMouseTracking(True)
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
        self._samples: np.ndarray | None = None
        self._repaired: np.ndarray | None = None
        self._diff: np.ndarray | None = None
        self._sample_rate = 44100
        self._view = ViewRange(0, 1)
        self._segments: list[Segment] = []
        self._changed_runs: dict[int, list[tuple[int, int]]] = {}
        self._low_confidence: set[int] = set()
        self._playhead = 0
        self._selection: tuple[int, int] | None = None
        self._mode = "original"
        self._polarity_filter = "both"
        self._show_segments = True
        self._show_changed = True
        self._drag_anchor: int | None = None
        self._drag_moved = False
        self._hover_x: int | None = None
        self.view_changed_text = ""

    # -- data --------------------------------------------------------------

    def set_data(
        self,
        samples: np.ndarray | None,
        repaired: np.ndarray | None,
        diff: np.ndarray | None,
        sample_rate: int,
    ) -> None:
        self._samples = samples
        self._repaired = repaired
        self._diff = diff
        self._sample_rate = max(1, sample_rate)
        if samples is not None:
            self.set_view(0, samples.shape[0])
        self.update()

    def set_repaired(self, repaired: np.ndarray | None, diff: np.ndarray | None) -> None:
        self._repaired = repaired
        self._diff = diff
        self.update()

    def set_segments(
        self,
        segments: list[Segment],
        changed_runs: dict[int, list[tuple[int, int]]] | None = None,
        low_confidence_uids: set[int] | None = None,
    ) -> None:
        self._segments = list(segments)
        self._changed_runs = dict(changed_runs or {})
        self._low_confidence = set(low_confidence_uids or ())
        self.update()

    def set_mode(self, mode: str) -> None:
        self._mode = mode
        self.update()

    def set_polarity_filter(self, value: str) -> None:
        self._polarity_filter = value
        self.update()

    def set_show_segments(self, flag: bool) -> None:
        self._show_segments = bool(flag)
        self.update()

    def set_show_changed(self, flag: bool) -> None:
        self._show_changed = bool(flag)
        self.update()

    def set_selection(self, start: int | None, end: int | None) -> None:
        if start is None or end is None:
            self._selection = None
        else:
            lo, hi = sorted((int(start), int(end)))
            self._selection = (lo, hi)
        self.update()

    def set_playhead(self, frame: int) -> None:
        if self._samples is None:
            return
        self._playhead = max(0, min(int(frame), self._samples.shape[0]))
        self.update()

    @property
    def playhead(self) -> int:
        return self._playhead

    @property
    def selection(self) -> tuple[int, int] | None:
        return self._selection

    def view(self) -> ViewRange:
        return self._view

    def set_view(self, start: int, end: int) -> None:
        frames = self._samples.shape[0] if self._samples is not None else 1
        start = max(0, min(int(start), frames - 1))
        end = max(start + 1, min(int(end), frames))
        if end - start < 8:
            end = min(frames, start + 8)
        self._view = ViewRange(start, end)
        self.viewChanged.emit(self._view.start, self._view.end)
        self.update()

    def zoom(self, factor: float, anchor: int | None = None) -> None:
        if self._samples is None:
            return
        view = self._view
        anchor = view.start + view.length // 2 if anchor is None else anchor
        new_len = int(round(view.length / factor))
        new_len = max(8, min(self._samples.shape[0], new_len))
        frac = (anchor - view.start) / max(1, view.length)
        new_start = int(round(anchor - frac * new_len))
        new_start = max(0, min(new_start, self._samples.shape[0] - new_len))
        self.set_view(new_start, new_start + new_len)

    def fit(self) -> None:
        if self._samples is not None:
            self.set_view(0, self._samples.shape[0])

    def pan(self, delta_frames: int) -> None:
        view = self._view
        self.set_view(view.start + delta_frames, view.end + delta_frames)

    def show_frame(self, frame: int) -> None:
        """Scroll just enough to bring ``frame`` into view."""
        view = self._view
        if frame < view.start or frame >= view.end:
            self.set_view(frame - view.length // 2, frame + view.length // 2)

    # -- coordinate helpers ------------------------------------------------

    @property
    def channels(self) -> int:
        if self._samples is None:
            return 1
        return int(self._samples.shape[1])

    def _ruler_height(self) -> int:
        return 22

    def _plot_rect(self) -> QRectF:
        return QRectF(0, self._ruler_height(), self.width(), self.height() - self._ruler_height())

    def _channel_rects(self) -> list[QRectF]:
        plot = self._plot_rect()
        n = max(1, self.channels)
        h = plot.height() / n
        return [QRectF(plot.left(), plot.top() + i * h, plot.width(), h) for i in range(n)]

    def x_to_frame(self, x: float) -> int:
        plot = self._plot_rect()
        if plot.width() <= 0:
            return self._view.start
        frac = (x - plot.left()) / plot.width()
        frac = min(1.0, max(0.0, frac))
        return int(self._view.start + frac * self._view.length)

    def frame_to_x(self, frame: float) -> float:
        plot = self._plot_rect()
        frac = (frame - self._view.start) / self._view.length
        return plot.left() + frac * plot.width()

    def channel_at(self, y: float) -> int:
        rects = self._channel_rects()
        for i, r in enumerate(rects):
            if y < r.bottom():
                return i
        return max(0, len(rects) - 1)

    # -- painting ----------------------------------------------------------

    def paintEvent(self, event: QPaintEvent) -> None:  # noqa: N802
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing, False)
        painter.fillRect(self.rect(), COL_BG)
        if self._samples is None:
            painter.setPen(COL_TEXT_DIM)
            painter.drawText(self.rect(), Qt.AlignmentFlag.AlignCenter, "打开的 WAV 会显示在这里")
            painter.end()
            return

        self._paint_ruler(painter)
        rects = self._channel_rects()
        for ch, rect in enumerate(rects):
            self._paint_channel(painter, ch, rect)
        self._paint_spans(painter, rects)
        self._paint_playhead(painter)
        self._paint_hover(painter)
        painter.end()

    def _paint_ruler(self, painter: QPainter) -> None:
        rect = QRectF(0, 0, self.width(), self._ruler_height())
        painter.fillRect(rect, QColor("#1b1f26"))
        painter.setPen(COL_TEXT_DIM)
        font = QFont(painter.font())
        font.setPointSizeF(max(8.0, font.pointSizeF() - 1.5))
        painter.setFont(font)
        sr = self._sample_rate
        span_sec = self._view.length / sr
        target_ticks = max(2, self.width() // 110)
        raw = span_sec / target_ticks
        nice = _nice_step(raw)
        t0 = self._view.start / sr
        first = np.floor(t0 / nice) * nice
        t = first
        while t <= (self._view.end / sr) + 1e-9:
            x = self.frame_to_x(t * sr)
            painter.setPen(QPen(COL_GRID, 1))
            painter.drawLine(QPoint(int(x), self._ruler_height() - 5), QPoint(int(x), self.height()))
            painter.setPen(COL_TEXT_DIM)
            painter.drawText(QPoint(int(x) + 3, self._ruler_height() - 7), _fmt_time(t))
            t += nice
        # The exact visible window lives in the status bar; keeping the ruler
        # to tick labels avoids overlapping text at small widths.
        self.view_changed_text = (
            f"视图 {format_sample_time(self._view.start, sr)} – "
            f"{format_sample_time(self._view.end, sr)}"
            f"（{self._view.length} 样本）"
        )

    def _envelope(self, y: np.ndarray, width: int) -> tuple[np.ndarray, np.ndarray]:
        n = y.size
        if n == 0:
            return np.zeros(0), np.zeros(0)
        if n <= width:
            # Zoomed in: draw the actual samples.
            idx = np.linspace(0, n - 1, width)
            vals = np.interp(idx, np.arange(n), y)
            return vals, vals
        bounds = np.linspace(0, n, width + 1).astype(np.int64)
        mins = np.empty(width)
        maxs = np.empty(width)
        for i in range(width):
            a, b = bounds[i], max(bounds[i] + 1, bounds[i + 1])
            chunk = y[a:b]
            mins[i] = chunk.min()
            maxs[i] = chunk.max()
        return mins, maxs

    def _paint_channel(self, painter: QPainter, ch: int, rect: QRectF) -> None:
        painter.save()
        painter.setClipRect(rect)
        mid = rect.center().y()
        half = rect.height() / 2.0 - 6.0
        painter.setPen(QPen(COL_ZERO, 1))
        painter.drawLine(QPoint(int(rect.left()), int(mid)), QPoint(int(rect.right()), int(mid)))
        for frac in (0.5, 1.0):
            painter.setPen(QPen(COL_GRID, 1, Qt.PenStyle.DotLine))
            painter.drawLine(
                QPoint(int(rect.left()), int(mid - frac * half)),
                QPoint(int(rect.right()), int(mid - frac * half)),
            )
            painter.drawLine(
                QPoint(int(rect.left()), int(mid + frac * half)),
                QPoint(int(rect.right()), int(mid + frac * half)),
            )
        # Channel label
        painter.setPen(COL_TEXT_DIM)
        painter.drawText(
            QRectF(rect.left() + 6, rect.top() + 2, 120, 16),
            int(Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter),
            "左声道" if ch == 0 else ("右声道" if ch == 1 else f"声道 {ch + 1}"),
        )

        width = max(1, int(rect.width()))
        x0 = self._view.start
        x1 = min(self._view.end, self._samples.shape[0])
        if x1 <= x0:
            painter.restore()
            return
        original = self._samples[x0:x1, ch]

        if self._mode == "diff":
            if self._diff is not None:
                d = self._diff[x0:x1, ch] * 4.0
                lo, hi = self._envelope(d, width)
                self._draw_bars(painter, rect, lo, hi, COL_DIFF)
            painter.restore()
            return

        lo, hi = self._envelope(original, width)
        self._draw_bars(painter, rect, lo, hi, COL_WAVE)

        if self._mode == "repaired" and self._repaired is not None:
            r = self._repaired[x0:x1, ch]
            rlo, rhi = self._envelope(r, width)
            self._draw_bars(painter, rect, rlo, rhi, COL_WAVE_REPAIRED)
        elif self._mode == "overlay" and self._repaired is not None:
            # Draw only the changed samples on top of the original, so the
            # original stays visible and the difference is obvious.
            r = self._repaired[x0:x1, ch]
            changed = np.zeros(r.size, dtype=bool)
            for s, e in self._changed_runs.get(ch, []):
                lo_s = max(s, x0)
                hi_s = min(e, x1)
                if hi_s > lo_s:
                    changed[lo_s - x0 : hi_s - x0] = True
            if changed.any():
                rlo, rhi = self._envelope(r, width)
                keep = self._changed_columns(changed, width)
                self._draw_bars(
                    painter,
                    rect,
                    np.where(keep, rlo, np.nan),
                    np.where(keep, rhi, np.nan),
                    COL_WAVE_REPAIRED,
                )

        if self._show_changed:
            self._paint_changed_marks(painter, ch, rect)
        painter.restore()

    def _changed_columns(self, changed: np.ndarray, width: int) -> np.ndarray:
        """Map a per-sample change mask onto the envelope's pixel columns."""
        n = changed.size
        if n == 0:
            return np.zeros(width, dtype=bool)
        if n <= width:
            idx = np.linspace(0, n - 1, width).astype(np.int64)
            return changed[idx]
        bounds = np.linspace(0, n, width + 1).astype(np.int64)
        out = np.zeros(width, dtype=bool)
        for i in range(width):
            a, b = bounds[i], max(bounds[i] + 1, bounds[i + 1])
            out[i] = bool(changed[a:b].any())
        return out

    def _draw_bars(
        self,
        painter: QPainter,
        rect: QRectF,
        mins: np.ndarray,
        maxs: np.ndarray,
        color: QColor,
        alpha: int = 255,
    ) -> None:
        mid = rect.center().y()
        half = rect.height() / 2.0 - 6.0
        c = QColor(color)
        c.setAlpha(alpha)
        painter.setPen(QPen(c, 1))
        for i in range(mins.size):
            if np.isnan(mins[i]) or np.isnan(maxs[i]):
                continue
            x = rect.left() + i + 0.5
            top = mid - maxs[i] * half
            bot = mid - mins[i] * half
            if bot - top < 1.0:
                bot = top + 1.0
            painter.drawLine(QPoint(int(x), int(top)), QPoint(int(x), int(bot)))

    def _paint_changed_marks(self, painter: QPainter, ch: int, rect: QRectF) -> None:
        runs = self._changed_runs.get(ch, [])
        if not runs:
            return
        painter.setPen(QPen(QColor(126, 224, 163, 200), 1, Qt.PenStyle.DashLine))
        top = rect.top() + 3
        bottom = rect.bottom() - 3
        for s, e in runs:
            if e <= self._view.start or s >= self._view.end:
                continue
            xs = self.frame_to_x(max(s, self._view.start))
            xe = self.frame_to_x(min(e, self._view.end))
            if xe - xs < 1:
                xe = xs + 1
            painter.drawLine(QPoint(int(xs), int(bottom)), QPoint(int(xe), int(bottom)))
            painter.drawLine(QPoint(int(xs), int(bottom)), QPoint(int(xs), int(bottom - 5)))
            painter.drawLine(QPoint(int(xe), int(bottom)), QPoint(int(xe), int(bottom - 5)))

    def _paint_spans(self, painter: QPainter, rects: list[QRectF]) -> None:
        if self._selection is not None:
            s, e = self._selection
            x0 = self.frame_to_x(s)
            x1 = self.frame_to_x(e)
            painter.fillRect(
                QRectF(x0, self._plot_rect().top(), max(1.0, x1 - x0), self._plot_rect().height()),
                COL_SELECT,
            )
        if not self._show_segments or not rects:
            return
        for seg in self._segments:
            if seg.channel >= len(rects):
                continue
            if self._polarity_filter == "pos" and seg.polarity < 0:
                continue
            if self._polarity_filter == "neg" and seg.polarity > 0:
                continue
            rect = rects[seg.channel]
            if seg.end <= self._view.start or seg.start >= self._view.end:
                continue
            x0 = max(rect.left(), self.frame_to_x(seg.start))
            x1 = min(rect.right(), self.frame_to_x(seg.end))
            width = max(1.5, x1 - x0)
            color, border = self._span_colors(seg)
            fill = QColor(color)
            fill.setAlpha(52)
            painter.fillRect(QRectF(x0, rect.top(), width, rect.height()), fill)
            painter.setPen(QPen(border, 1.2, Qt.PenStyle.SolidLine))
            painter.drawLine(QPoint(int(x0), int(rect.top() + 2)), QPoint(int(x0), int(rect.bottom() - 2)))
            painter.drawLine(QPoint(int(x1), int(rect.top() + 2)), QPoint(int(x1), int(rect.bottom() - 2)))
            # Polarity ridge: top edge for positive, bottom edge for negative.
            y = rect.top() + 3 if seg.polarity > 0 else rect.bottom() - 3
            pen_style = (
                Qt.PenStyle.DashLine
                if seg.uid in self._low_confidence
                else Qt.PenStyle.SolidLine
            )
            painter.setPen(QPen(border, 1.6, pen_style))
            painter.drawLine(QPoint(int(x0), int(y)), QPoint(int(x1), int(y)))

    def _span_colors(self, seg: Segment) -> tuple[QColor, QColor]:
        if seg.status == STATUS_EXCLUDED:
            return COL_EXCLUDED, COL_EXCLUDED
        if seg.status == STATUS_CONFIRMED:
            # Explicit user decisions win over the detector's square hint.
            return COL_CONFIRMED, COL_CONFIRMED
        if "方波" in seg.hint:
            return COL_EXCLUDED, QColor("#9aa3b0")
        if seg.uid in self._low_confidence:
            return COL_LOWCONF, COL_LOWCONF
        return (COL_POS if seg.polarity > 0 else COL_NEG), (
            COL_POS if seg.polarity > 0 else COL_NEG
        )

    def _paint_playhead(self, painter: QPainter) -> None:
        if self._playhead < self._view.start or self._playhead > self._view.end:
            return
        x = self.frame_to_x(self._playhead)
        painter.setPen(QPen(COL_PLAYHEAD, 1.4))
        painter.drawLine(QPoint(int(x), self._ruler_height()), QPoint(int(x), self.height()))

    def _paint_hover(self, painter: QPainter) -> None:
        if self._hover_x is None:
            return
        frame = self.x_to_frame(self._hover_x)
        painter.setPen(COL_TEXT_DIM)
        label = (
            f"{format_sample_time(frame, self._sample_rate)}  "
            f"样本 {frame}"
        )
        painter.drawText(
            QRectF(0, self.height() - 18, self.width() - 6, 16),
            int(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter),
            label,
        )

    # -- interaction -------------------------------------------------------

    def mousePressEvent(self, event: QMouseEvent) -> None:  # noqa: N802
        if self._samples is None:
            return
        if event.button() == Qt.MouseButton.LeftButton:
            frame = self.x_to_frame(event.position().x())
            seg = self._segment_at(event.position().x(), event.position().y())
            if seg is not None:
                self.segmentClicked.emit(seg.uid)
            self._drag_anchor = frame
            self._drag_moved = False
            self._playhead = frame
            self.playheadMoved.emit(frame)
            self.update()
        elif event.button() == Qt.MouseButton.RightButton:
            self.zoom(0.5, self.x_to_frame(event.position().x()))

    def mouseMoveEvent(self, event: QMouseEvent) -> None:  # noqa: N802
        self._hover_x = int(event.position().x())
        if self._samples is None:
            return
        if (
            self._drag_anchor is not None
            and event.buttons() & Qt.MouseButton.LeftButton
        ):
            frame = self.x_to_frame(event.position().x())
            if abs(frame - self._drag_anchor) > 2:
                self._drag_moved = True
            lo, hi = sorted((self._drag_anchor, frame))
            self._selection = (lo, hi)
        self.update()

    def mouseReleaseEvent(self, event: QMouseEvent) -> None:  # noqa: N802
        if self._samples is None or event.button() != Qt.MouseButton.LeftButton:
            return
        anchor = self._drag_anchor
        self._drag_anchor = None
        if anchor is None:
            return
        if self._drag_moved and self._selection is not None and self._selection[1] - self._selection[0] > 2:
            ch = self.channel_at(event.position().y())
            self.regionSelected.emit(ch, self._selection[0], self._selection[1])
        else:
            self._selection = None
            frame = self.x_to_frame(event.position().x())
            self._playhead = frame
            self.playheadMoved.emit(frame)
        self._drag_moved = False
        self.update()

    def wheelEvent(self, event: QWheelEvent) -> None:  # noqa: N802
        if self._samples is None:
            return
        modifiers = event.modifiers()
        delta = event.angleDelta().y()
        if delta == 0:
            delta = event.angleDelta().x()
        if modifiers & (Qt.KeyboardModifier.ShiftModifier | Qt.KeyboardModifier.AltModifier):
            self.pan(-int(delta / 120.0 * self._view.length * 0.1))
        else:
            factor = 1.25 if delta > 0 else 0.8
            self.zoom(factor, self.x_to_frame(event.position().x()))
        event.accept()

    def keyPressEvent(self, event) -> None:  # noqa: N802
        key = event.key()
        step = max(1, self._view.length // 20)
        if key == Qt.Key.Key_Left:
            self.pan(-step)
        elif key == Qt.Key.Key_Right:
            self.pan(step)
        elif key == Qt.Key.Key_Plus or key == Qt.Key.Key_Equal:
            self.zoom(1.5)
        elif key == Qt.Key.Key_Minus:
            self.zoom(1 / 1.5)
        elif key == Qt.Key.Key_F:
            self.fit()
        elif key == Qt.Key.Key_Space:
            # Space is owned by the window (start/stop audition), so only pass
            # the playhead through; do not swallow it here.
            event.ignore()
            return
        else:
            super().keyPressEvent(event)

    def _segment_at(self, x: float, y: float) -> Segment | None:
        ch = self.channel_at(y)
        frame = self.x_to_frame(x)
        for seg in self._segments:
            if seg.channel == ch and seg.start <= frame < seg.end:
                if self._polarity_filter == "pos" and seg.polarity < 0:
                    continue
                if self._polarity_filter == "neg" and seg.polarity > 0:
                    continue
                return seg
        return None


def _nice_step(raw: float) -> float:
    if raw <= 0:
        return 1.0
    exp = np.floor(np.log10(raw))
    base = raw / (10**exp)
    for candidate in (1.0, 2.0, 5.0, 10.0):
        if base <= candidate:
            return candidate * 10**exp
    return 10.0 * 10**exp


def _fmt_time(seconds: float) -> str:
    if seconds < 0:
        seconds = 0.0
    minutes = int(seconds // 60)
    rest = seconds - minutes * 60
    if minutes:
        return f"{minutes}:{rest:05.2f}"
    return f"{rest:.2f}s"
