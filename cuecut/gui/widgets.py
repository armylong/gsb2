"""Custom widgets: the shared time ruler, the waveform/ownership canvas."""

from __future__ import annotations

from dataclasses import dataclass
from fractions import Fraction
from typing import List, Optional, Sequence, Tuple

from PySide6.QtCore import QPointF, QRectF, Qt, Signal
from PySide6.QtGui import (
    QColor,
    QFont,
    QFontMetrics,
    QPainter,
    QPen,
    QPolygonF,
)
from PySide6.QtWidgets import QSizePolicy, QWidget

from ..timeutil import format_mmssff, nice_step


COLOR_BG = QColor("#12151b")
COLOR_WAVE = QColor("#7f8ea3")
COLOR_WAVE_PEAK = QColor("#b9c6d8")
COLOR_RULER_BG = QColor("#1a1f27")
COLOR_RULER_TEXT = QColor("#8e9aab")
COLOR_RULER_TICK = QColor("#3a4250")
COLOR_PLAYHEAD = QColor("#ffd166")
COLOR_LEAD = QColor("#e05d5d")
COLOR_START = QColor("#4cc9f0")
COLOR_SELECTION = QColor("#4cc9f0")


@dataclass
class MarkerSpec:
    sample: int
    kind: str  # "index00" | "index01"
    track: int
    title: str


@dataclass
class Band:
    """A coloured strip at the bottom of the waveform showing file ownership."""

    first: int
    last: int
    text: str
    color: QColor
    short_text: str = ""


class SharedRuler(QWidget):
    """One absolute sample axis shared by sheet times, samples and in-track time.

    The ruler is deliberately dumb: it maps [view_first, view_last] to its
    width and paints absolute sample ticks plus MM:SS:FF of cue time.  The
    track-relative row of the header below it uses the same geometry, so all
    three time readings line up vertically.
    """

    seekRequested = Signal(int)  # absolute sample

    def __init__(self, parent=None):
        super().__init__(parent)
        self.view_first = 0
        self.view_last = 1
        self.samplerate = 44100
        self.setMinimumHeight(26)
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Fixed)

    def set_view(self, first: int, last: int, samplerate: int) -> None:
        self.view_first = first
        self.view_last = max(first + 1, last)
        self.samplerate = samplerate
        self.update()

    def sample_to_x(self, sample: int) -> float:
        span = max(1, self.view_last - self.view_first)
        return (sample - self.view_first) / span * self.width()

    def x_to_sample(self, x: float) -> int:
        span = max(1, self.view_last - self.view_first)
        return int(self.view_first + (x / max(1, self.width())) * span)

    def paintEvent(self, event) -> None:
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing, False)
        w, h = self.width(), self.height()
        p.fillRect(0, 0, w, h, COLOR_RULER_BG)

        span_seconds = (self.view_last - self.view_first) / self.samplerate
        step = nice_step(span_seconds)
        step_samples = max(1, int(round(step * self.samplerate)))
        first_tick = (self.view_first // step_samples) * step_samples

        font = QFont(self.font())
        font.setPointSizeF(9)
        p.setFont(font)
        fm = QFontMetrics(font)

        minor = step / 5
        minor_samples = max(1, int(round(minor * self.samplerate)))
        p.setPen(QPen(COLOR_RULER_TICK, 1))
        x = (self.view_first // minor_samples) * minor_samples
        while x <= self.view_last:
            px = self.sample_to_x(x)
            top = h - 6 if (x // step_samples) * step_samples == x else h - 3
            p.drawLine(QPointF(px, top), QPointF(px, h))
            x += minor_samples

        p.setPen(COLOR_RULER_TEXT)
        x = first_tick
        while x <= self.view_last:
            px = self.sample_to_x(x)
            t = Fraction(x, self.samplerate)
            label = format_mmssff(t)
            tw = fm.horizontalAdvance(label)
            p.drawText(QRectF(px + 3, 1, tw + 4, 14), Qt.AlignLeft | Qt.AlignVCenter, label)
            p.setPen(QPen(COLOR_RULER_TICK, 1))
            if (x // step_samples) * step_samples == x:
                p.drawLine(QPointF(px, 0), QPointF(px, h - 6))
            p.setPen(COLOR_RULER_TEXT)
            x += step_samples

        p.end()

    def mousePressEvent(self, event) -> None:
        if event.button() == Qt.LeftButton:
            self.seekRequested.emit(self.x_to_sample(event.position().x()))

    def mouseMoveEvent(self, event) -> None:
        if event.buttons() & Qt.LeftButton:
            self.seekRequested.emit(self.x_to_sample(event.position().x()))


class WaveformView(QWidget):
    """Waveform + sheet markers + ownership bands, on the shared x axis."""

    seekRequested = Signal(int)
    markerActivated = Signal(int)  # sheet index
    hoverSample = Signal(int)
    hoverLeft = Signal()

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setMinimumHeight(180)
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)
        self.setMouseTracking(True)
        self.view_first = 0
        self.view_last = 1
        self.samplerate = 44100
        self.total_samples = 1
        self.peaks: List[Tuple[float, float]] = []
        self.state_regions: List[Tuple[int, int, QColor, str]] = []
        self.markers: List[MarkerSpec] = []
        self.bands: List[Band] = []
        self.selected_sheet_index: Optional[int] = None
        self.playhead: Optional[int] = None
        self.preview_region: Optional[Tuple[int, int]] = None
        self.hover_sample: Optional[int] = None
        self._owner_lookup = None  # callable(int) -> Optional[object]
        self._text_lookup = None  # callable(int) -> str

    # -- state -------------------------------------------------------------
    def set_view(self, first: int, last: int, samplerate: int, total: int) -> None:
        self.view_first = first
        self.view_last = max(first + 1, last)
        self.samplerate = samplerate
        self.total_samples = max(1, total)
        self.update()

    def set_peaks(self, peaks: Sequence[Tuple[float, float]]) -> None:
        self.peaks = list(peaks)
        self.update()

    def set_ownership(self, markers, bands, owner_lookup, text_lookup) -> None:
        self.markers = list(markers)
        self.bands = list(bands)
        self._owner_lookup = owner_lookup
        self._text_lookup = text_lookup
        self.update()

    def set_state_regions(self, regions) -> None:
        """Intrinsic regions (lead vs track proper), independent of split mode."""
        self.state_regions = list(regions)
        self.update()

    def set_playhead(self, sample: Optional[int]) -> None:
        self.playhead = sample
        self.update()

    def set_preview_region(self, region: Optional[Tuple[int, int]]) -> None:
        self.preview_region = region
        self.update()

    def set_selected(self, index: Optional[int]) -> None:
        self.selected_sheet_index = index
        self.update()

    # -- geometry ----------------------------------------------------------
    def sample_to_x(self, sample: int) -> float:
        span = max(1, self.view_last - self.view_first)
        return (sample - self.view_first) / span * self.width()

    def x_to_sample(self, x: float) -> int:
        span = max(1, self.view_last - self.view_first)
        return int(self.view_first + (x / max(1, self.width())) * span)

    # -- painting ----------------------------------------------------------
    def paintEvent(self, event) -> None:
        p = QPainter(self)
        w, h = self.width(), self.height()
        p.fillRect(0, 0, w, h, COLOR_BG)

        bands_h = 24 if self.bands else 0
        wave_h = h - bands_h
        mid = wave_h / 2
        half = wave_h / 2 - 6

        # intrinsic state tint: lead regions vs song proper
        for first, last, color, label in self.state_regions:
            x0 = self.sample_to_x(max(first, self.view_first))
            x1 = self.sample_to_x(min(last + 1, self.view_last))
            if x1 <= x0:
                continue
            c = QColor(color)
            c.setAlpha(26)
            p.fillRect(QRectF(x0, 0, x1 - x0, wave_h), c)

        # ownership tint behind the waveform
        for band in self.bands:
            x0 = self.sample_to_x(max(band.first, self.view_first))
            x1 = self.sample_to_x(min(band.last + 1, self.view_last))
            if x1 <= x0:
                continue
            rect = QRectF(x0, 0, x1 - x0, wave_h)
            c = QColor(band.color)
            c.setAlpha(70 if (self.selected_sheet_index is None) else 55)
            p.fillRect(rect, c)
            p.setPen(QPen(band.color.darker(120), 1))
            p.drawLine(QPointF(x0, 0), QPointF(x0, wave_h))

        # waveform, normalised to the loudest visible peak so quiet beds are
        # still readable; never amplify past 40 dB (0.01 of full scale).
        if self.peaks:
            peak = max(1e-9, max(max(abs(lo), abs(hi)) for lo, hi in self.peaks))
            gain = min(1.0 / peak, 100.0)
            n = len(self.peaks)
            for i, (lo, hi) in enumerate(self.peaks):
                x = i * w / n
                y0 = mid - hi * gain * half
                y1 = mid - lo * gain * half
                if y1 - y0 < 1:
                    y1 = y0 + 1
                p.setPen(QPen(COLOR_WAVE, 1))
                p.drawLine(QPointF(x, y0), QPointF(x, y1))
                p.setPen(QPen(COLOR_WAVE_PEAK, 1))
                p.drawPoint(QPointF(x, y0))
                p.drawPoint(QPointF(x, y1))
            p.setPen(QPen(QColor(COLOR_WAVE_PEAK.red(), COLOR_WAVE_PEAK.green(),
                                 COLOR_WAVE_PEAK.blue(), 90), 1))
            p.drawLine(QPointF(0, mid), QPointF(w, mid))

        # preview region
        if self.preview_region:
            a, b = self.preview_region
            x0 = self.sample_to_x(max(a, self.view_first))
            x1 = self.sample_to_x(min(b + 1, self.view_last))
            if x1 > x0:
                pen = QPen(QColor(COLOR_SELECTION.red(), COLOR_SELECTION.green(),
                                  COLOR_SELECTION.blue(), 160), 1, Qt.DashLine)
                p.setPen(pen)
                p.drawRect(QRectF(x0, 0.5, max(1.0, x1 - x0), wave_h - 1))

        # markers
        font = QFont(self.font())
        font.setPointSizeF(8)
        p.setFont(font)
        fm = QFontMetrics(font)
        for m in self.markers:
            if m.sample < self.view_first or m.sample > self.view_last:
                continue
            x = self.sample_to_x(m.sample)
            color = COLOR_LEAD if m.kind == "index00" else COLOR_START
            p.setPen(QPen(color, 2))
            p.drawLine(QPointF(x, 0), QPointF(x, wave_h))
            label = ("00 " if m.kind == "index00" else "01 ") + f"T{m.track:02d}"
            tw = fm.horizontalAdvance(label) + 6
            y = 2 if m.kind == "index00" else 16
            p.fillRect(QRectF(x + 1, y, tw, 13), QColor(0, 0, 0, 150))
            p.setPen(color)
            p.drawText(QRectF(x + 3, y, tw, 13), Qt.AlignLeft | Qt.AlignVCenter, label)

        # bands
        if self.bands:
            p.setFont(font)
            band_font = QFont(font)
            band_font.setPointSizeF(8)
            p.setFont(band_font)
            bfm = QFontMetrics(band_font)
            for band in self.bands:
                x0 = self.sample_to_x(max(band.first, self.view_first))
                x1 = self.sample_to_x(min(band.last + 1, self.view_last))
                if x1 <= x0:
                    continue
                rect = QRectF(x0, wave_h, max(1.0, x1 - x0), bands_h)
                c = QColor(band.color)
                c.setAlpha(210)
                p.fillRect(rect, c)
                p.setPen(QPen(QColor("#0c0e12"), 1))
                p.drawRect(rect)
                p.setPen(QColor("#f2f5f9"))
                room = max(10, int(rect.width()) - 8)
                text = band.short_text if rect.width() < 64 else band.text
                if bfm.horizontalAdvance(text) > room:
                    text = bfm.elidedText(text, Qt.ElideMiddle, room)
                p.drawText(rect.adjusted(4, 0, -2, 0), Qt.AlignLeft | Qt.AlignVCenter, text)

        # playhead + hover
        if self.playhead is not None:
            x = self.sample_to_x(self.playhead)
            p.setPen(QPen(COLOR_PLAYHEAD, 2))
            p.drawLine(QPointF(x, 0), QPointF(x, h))
            tri = QPolygonF(
                [QPointF(x - 4, 0), QPointF(x + 4, 0), QPointF(x, 6)]
            )
            p.setBrush(COLOR_PLAYHEAD)
            p.setPen(Qt.NoPen)
            p.drawPolygon(tri)
        if self.hover_sample is not None and not self.playhead:
            x = self.sample_to_x(self.hover_sample)
            p.setPen(QPen(QColor(255, 255, 255, 60), 1, Qt.DashLine))
            p.drawLine(QPointF(x, 0), QPointF(x, h))
        p.end()

    # -- interaction -------------------------------------------------------
    def mousePressEvent(self, event) -> None:
        if event.button() == Qt.LeftButton:
            sample = self.x_to_sample(event.position().x())
            hit = None
            best = 1e9
            for m in self.markers:
                if m.sample < self.view_first or m.sample > self.view_last:
                    continue
                d = abs(self.sample_to_x(m.sample) - event.position().x())
                if d < 6 and d < best:
                    best = d
                    hit = m
            if hit is not None:
                self.markerActivated.emit(hit.track - 1)
            self.seekRequested.emit(sample)

    def mouseMoveEvent(self, event) -> None:
        self.hover_sample = self.x_to_sample(event.position().x())
        if event.buttons() & Qt.LeftButton:
            self.seekRequested.emit(self.hover_sample)
        self.hoverSample.emit(self.hover_sample)
        self.update()
        tip = None
        if self._text_lookup is not None and self.hover_sample is not None:
            try:
                tip = self._text_lookup(self.hover_sample)
            except Exception:
                tip = None
        self.setToolTip(tip or "")

    def leaveEvent(self, event) -> None:
        self.hover_sample = None
        self.hoverLeft.emit()
        self.update()


class HeaderReadout(QWidget):
    """Four stacked readouts aligned to the ruler's x axis.

    Rows: cue-sheet time of the cursor, its source sample, the in-track time
    (relative to INDEX 01, negative inside a lead region), and the ownership
    state ("lead / in track" + which file receives it).  A vertical guide at
    the cursor x ties the rows to the ruler below, so all three time readings
    are literally on the same time scale.
    """

    seekRequested = Signal(int)

    ROW_H = 20
    PAD_TOP = 3

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setFixedHeight(self.ROW_H * 4 + self.PAD_TOP + 4)
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Fixed)
        self.position: Optional[int] = None
        self.samplerate = 44100
        self.state_text = ""
        self.state_color = COLOR_START
        self.sheet_time = ""
        self.track_time = ""
        self.view_first = 0
        self.view_last = 1

    def set_view(self, first: int, last: int, samplerate: int) -> None:
        self.view_first = first
        self.view_last = max(first + 1, last)
        self.samplerate = samplerate
        self.update()

    def set_position(self, sample: Optional[int], samplerate: int, sheet_time: str,
                     track_time: str, state_text: str, state_color: QColor) -> None:
        self.position = sample
        self.samplerate = samplerate
        self.sheet_time = sheet_time
        self.track_time = track_time
        self.state_text = state_text
        self.state_color = state_color
        self.update()

    def paintEvent(self, event) -> None:
        p = QPainter(self)
        w, h = self.width(), self.height()
        p.fillRect(0, 0, w, h, QColor("#171b22"))

        font = QFont(self.font())
        font.setPointSizeF(9)
        mono = QFont(font)
        mono.setFamily("Menlo")

        rows = [
            ("分轨表时间", self.sheet_time, COLOR_RULER_TEXT),
            ("采样位置", f"{self.position}" if self.position is not None else "—",
             COLOR_WAVE_PEAK),
            ("轨内时间", self.track_time, COLOR_PLAYHEAD),
        ]
        label_w = 78
        y = self.PAD_TOP
        p.setFont(font)
        for i, (label, value, color) in enumerate(rows):
            p.setPen(COLOR_RULER_TEXT)
            p.drawText(QRectF(6, y, label_w, self.ROW_H), Qt.AlignLeft | Qt.AlignVCenter, label)
            p.setPen(color)
            p.setFont(mono if i >= 1 else font)
            p.drawText(QRectF(6 + label_w, y, w - label_w - 12, self.ROW_H),
                       Qt.AlignLeft | Qt.AlignVCenter, value)
            p.setFont(font)
            y += self.ROW_H

        if self.state_text:
            row_y = y
            tw = w - label_w - 14
            rect = QRectF(6 + label_w, row_y + 1, tw, self.ROW_H - 4)
            c = QColor(self.state_color)
            c.setAlpha(35)
            p.fillRect(rect, c)
            p.setPen(self.state_color)
            p.drawRect(rect)
            fm = QFontMetrics(font)
            elided = fm.elidedText(self.state_text, Qt.ElideRight, max(10, int(rect.width()) - 10))
            p.drawText(rect.adjusted(5, 0, -4, 0), Qt.AlignLeft | Qt.AlignVCenter, elided)
            p.setPen(COLOR_RULER_TEXT)
            p.drawText(QRectF(6, row_y, label_w, self.ROW_H), Qt.AlignLeft | Qt.AlignVCenter, "归属状态")

        if self.position is not None:
            span = max(1, self.view_last - self.view_first)
            x = (self.position - self.view_first) / span * w
            if -2 <= x <= w + 2:
                p.setPen(QPen(QColor(255, 209, 102, 110), 1, Qt.DashLine))
                p.drawLine(QPointF(x, 0), QPointF(x, h))
        p.end()

    def mousePressEvent(self, event) -> None:
        if event.button() == Qt.LeftButton:
            span = max(1, self.view_last - self.view_first)
            sample = int(self.view_first + event.position().x() / max(1, self.width()) * span)
            self.seekRequested.emit(sample)


class RulerStrip(QWidget):
    """Ruler + readout + waveform in one widget sharing one geometry."""

    seekRequested = Signal(int)
    markerActivated = Signal(int)
    hoverSample = Signal(int)
    hoverLeft = Signal()

    def __init__(self, parent=None):
        super().__init__(parent)
        from PySide6.QtWidgets import QVBoxLayout

        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)
        self.readout = HeaderReadout()
        self.ruler = SharedRuler()
        self.wave = WaveformView()
        layout.addWidget(self.readout)
        layout.addWidget(self.ruler)
        layout.addWidget(self.wave, 1)
        self.ruler.seekRequested.connect(self.seekRequested)
        self.readout.seekRequested.connect(self.seekRequested)
        self.wave.seekRequested.connect(self.seekRequested)
        self.wave.markerActivated.connect(self.markerActivated)
        self.wave.hoverSample.connect(self.hoverSample)
        self.wave.hoverLeft.connect(self.hoverLeft)

    def set_view(self, first: int, last: int, samplerate: int, total: int) -> None:
        self.ruler.set_view(first, last, samplerate)
        self.readout.set_view(first, last, samplerate)
        self.wave.set_view(first, last, samplerate, total)

    def set_peaks(self, peaks) -> None:
        self.wave.set_peaks(peaks)

    def set_ownership(self, markers, bands, owner_lookup, text_lookup) -> None:
        self.wave.set_ownership(markers, bands, owner_lookup, text_lookup)

    def set_state_regions(self, regions) -> None:
        self.wave.set_state_regions(regions)

    def set_playhead(self, sample: Optional[int]) -> None:
        self.wave.set_playhead(sample)

    def set_preview_region(self, region) -> None:
        self.wave.set_preview_region(region)

    def set_selected(self, index) -> None:
        self.wave.set_selected(index)

    def set_readout(self, *args) -> None:
        self.readout.set_position(*args)
