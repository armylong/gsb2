"""Custom-painted metric chart: RMSE against the clean reference over time.

Three series share one y-axis (RMSE in 0..255 units), so their magnitudes are
directly comparable.  Vertical hairlines mark detected cuts, and a shaded band
marks frames that were passed through unfiltered (window too short).  A
crosshair + readout follows the mouse and pressing on the chart seeks the
preview, which keeps the interaction useful without a heavyweight chart lib.
"""
from __future__ import annotations

from dataclasses import dataclass

from PySide6.QtCore import QPointF, QRectF, Qt, Signal
from PySide6.QtGui import QColor, QFontMetrics, QPainter, QPen, QPolygonF
from PySide6.QtWidgets import QSizePolicy, QWidget

# Validated categorical palette (dark surface) - slots 1..3 of the reference
# palette, which pass all-pairs CVD and normal-vision checks.
SURFACE = QColor("#1a1a19")
TEXT_PRIMARY = QColor("#f0efec")
TEXT_SECONDARY = QColor("#c3c2b7")
TEXT_MUTED = QColor("#8d8c84")
GRID = QColor("#33332f")
CUT = QColor("#fab219")

SERIES_COLORS = [QColor("#3987e5"), QColor("#d95926"), QColor("#199e70")]


@dataclass(frozen=True)
class Series:
    key: str
    name: str
    color: QColor


class MetricChart(QWidget):
    seekRequested = Signal(int)

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setMinimumHeight(168)
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)
        self.setMouseTracking(True)
        self.setAttribute(Qt.WA_OpaquePaintEvent, True)

        self._values: dict[str, list[float]] = {}
        self._colors: dict[str, QColor] = {}
        self._names: dict[str, str] = {}
        self._cuts: list[int] = []
        self._degraded: list[bool] = []
        self._current = 0
        self._hover: int | None = None
        self._count = 0

        self.margins = (46, 26, 12, 20)   # left, top (recomputed), right, bottom

    # ------------------------------------------------------------- data
    def set_data(self, series: dict[str, tuple[str, QColor, list[float]]],
                 cuts: list[int], degraded: list[bool], current: int) -> None:
        self._values = {k: list(v[2]) for k, v in series.items()}
        self._names = {k: v[0] for k, v in series.items()}
        self._colors = {k: v[1] for k, v in series.items()}
        self._cuts = list(cuts)
        self._degraded = list(degraded)
        self._count = max((len(v) for v in self._values.values()), default=0)
        self._current = max(0, min(current, self._count - 1))
        self.update()

    def set_current(self, frame: int) -> None:
        self._current = frame
        self.update()

    # --------------------------------------------------------- geometry
    def _plot_rect(self) -> QRectF:
        left, _, right, bottom = self.margins
        top = legend_height(self.font())
        return QRectF(left, top, max(10, self.width() - left - right),
                      max(10, self.height() - top - bottom))

    def _y_max(self) -> float:
        peak = 0.0
        for vals in self._values.values():
            if vals:
                peak = max(peak, max(vals))
        if peak <= 0:
            return 5.0
        # Clean tick steps so labels are exact, never rounded into a lie.
        for step in (1.0, 2.0, 5.0, 10.0, 20.0, 50.0):
            if peak / step <= 4:
                return float(step * max(1, int(peak / step) + (0 if peak % step == 0 else 1)))
        return float(50.0 * (int(peak / 50.0) + 1))

    def _x_of(self, i: int, rect: QRectF) -> float:
        if self._count <= 1:
            return rect.left()
        return rect.left() + rect.width() * (i / (self._count - 1))

    def _y_of(self, v: float, rect: QRectF, ymax: float) -> float:
        return rect.bottom() - rect.height() * min(1.0, v / ymax)

    def _frame_at(self, x: float) -> int:
        rect = self._plot_rect()
        if self._count <= 1:
            return 0
        t = (x - rect.left()) / max(1.0, rect.width())
        return max(0, min(self._count - 1, round(t * (self._count - 1))))

    # ------------------------------------------------------------ events
    def mouseMoveEvent(self, event):
        self._hover = self._frame_at(event.position().x())
        self.update()

    def leaveEvent(self, event):
        self._hover = None
        self.update()

    def mousePressEvent(self, event):
        if event.button() == Qt.LeftButton:
            self.seekRequested.emit(self._frame_at(event.position().x()))

    # ----------------------------------------------------------- painting
    def paintEvent(self, event):
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing, True)
        p.fillRect(self.rect(), SURFACE)
        rect = self._plot_rect()
        if self._count == 0:
            p.setPen(TEXT_MUTED)
            p.drawText(rect, Qt.AlignCenter, "暂无指标 - 载入样例后显示")
            return

        ymax = self._y_max()
        self._paint_degraded_bands(p, rect)
        self._paint_grid(p, rect, ymax)
        self._paint_cuts(p, rect)
        self._paint_series(p, rect, ymax)
        self._paint_current(p, rect)
        self._paint_hover(p, rect, ymax)
        self._paint_legend(p, rect)

    def _paint_degraded_bands(self, p: QPainter, rect: QRectF) -> None:
        if not any(self._degraded):
            return
        p.setPen(Qt.NoPen)
        p.setBrush(QColor(250, 178, 25, 28))
        i = 0
        while i < len(self._degraded):
            if not self._degraded[i]:
                i += 1
                continue
            j = i
            while j + 1 < len(self._degraded) and self._degraded[j + 1]:
                j += 1
            x0 = self._x_of(i, rect)
            x1 = self._x_of(j, rect)
            p.drawRect(QRectF(x0, rect.top(), max(1.0, x1 - x0), rect.height()))
            i = j + 1
        p.setBrush(Qt.NoBrush)

    def _paint_grid(self, p: QPainter, rect: QRectF, ymax: float) -> None:
        p.setPen(QPen(GRID, 1))
        step = ymax / 4.0
        for k in range(5):
            v = step * k
            y = self._y_of(v, rect, ymax)
            p.drawLine(QPointF(rect.left(), y), QPointF(rect.right(), y))
            p.setPen(TEXT_MUTED)
            label = f"{v:.0f}" if abs(v - round(v)) < 1e-6 else f"{v:.1f}"
            p.drawText(QRectF(0, y - 8, rect.left() - 8, 16),
                       Qt.AlignRight | Qt.AlignVCenter, label)
            p.setPen(QPen(GRID, 1))
        # x ticks: every 25 frames
        p.setPen(TEXT_MUTED)
        for f in range(0, self._count, 25):
            x = self._x_of(f, rect)
            p.drawText(QRectF(x - 16, rect.bottom() + 2, 32, 16), Qt.AlignCenter, str(f))

    def _paint_cuts(self, p: QPainter, rect: QRectF) -> None:
        for cut in self._cuts:
            if cut <= 0 or cut >= self._count:
                continue
            x = self._x_of(cut, rect) - 0.5
            p.setPen(QPen(CUT, 1))
            p.drawLine(QPointF(x, rect.top()), QPointF(x, rect.bottom()))

    def _paint_series(self, p: QPainter, rect: QRectF, ymax: float) -> None:
        for key in self._values:
            vals = self._values[key]
            if not vals:
                continue
            pts = [QPointF(self._x_of(i, rect), self._y_of(v, rect, ymax))
                   for i, v in enumerate(vals)]
            pen = QPen(self._colors[key], 2)
            pen.setJoinStyle(Qt.RoundJoin)
            pen.setCapStyle(Qt.RoundCap)
            p.setPen(pen)
            # Split the polyline at cuts so a line never bridges two shots.
            bounds = [0] + [c for c in self._cuts if 0 < c < self._count] + [self._count]
            for a, b in zip(bounds[:-1], bounds[1:]):
                seg = pts[a:b]
                if len(seg) >= 2:
                    p.drawPolyline(QPolygonF(seg))

    def _paint_current(self, p: QPainter, rect: QRectF) -> None:
        x = self._x_of(self._current, rect)
        p.setPen(QPen(TEXT_SECONDARY, 1))
        p.drawLine(QPointF(x, rect.top()), QPointF(x, rect.bottom()))

    def _paint_hover(self, p: QPainter, rect: QRectF, ymax: float) -> None:
        if self._hover is None or self._hover >= self._count:
            return
        x = self._x_of(self._hover, rect)
        p.setPen(QPen(TEXT_MUTED, 1))
        p.drawLine(QPointF(x, rect.top()), QPointF(x, rect.bottom()))

        lines = [f"帧 {self._hover}（5 帧平滑，逐帧值见侧栏）"]
        for key, vals in self._values.items():
            if self._hover < len(vals):
                lines.append(f"{self._names[key]} {vals[self._hover]:.1f}")
        fm = QFontMetrics(self.font())
        w = max(fm.horizontalAdvance(t) for t in lines) + 16
        h = len(lines) * (fm.height() + 2) + 10
        bx = min(x + 10, rect.right() - w)
        by = rect.top() + 6
        p.setPen(QPen(GRID, 1))
        p.setBrush(QColor(0, 0, 0, 190))
        p.drawRoundedRect(QRectF(bx, by, w, h), 4, 4)
        p.setBrush(Qt.NoBrush)
        p.setPen(TEXT_PRIMARY)
        for k, text in enumerate(lines):
            p.drawText(QPointF(bx + 8, by + 6 + fm.ascent() + k * (fm.height() + 2)), text)
        for key, vals in self._values.items():
            if self._hover < len(vals):
                y = self._y_of(vals[self._hover], rect, ymax)
                p.setPen(QPen(SURFACE, 2))
                p.setBrush(self._colors[key])
                p.drawEllipse(QPointF(x, y), 4.0, 4.0)
        p.setBrush(Qt.NoBrush)

    def _paint_legend(self, p: QPainter, rect: QRectF) -> None:
        # Drawn above the plot, on two rows: series, then the secondary
        # encodings. Keeps every name whole in a narrow side panel.
        fm = QFontMetrics(self.font())
        x = rect.left() + 6
        y = 4.0
        for key, color in zip(self._values, self._colors.values()):
            text = self._names[key]
            p.setPen(Qt.NoPen)
            p.setBrush(color)
            p.drawRoundedRect(QRectF(x, y + fm.height() / 2 - 3, 12, 6), 2, 2)
            p.setBrush(Qt.NoBrush)
            p.setPen(TEXT_SECONDARY)
            p.drawText(QPointF(x + 17, y + fm.ascent()), text)
            x += 17 + fm.horizontalAdvance(text) + 14

        x = rect.left() + 6
        y += fm.height() + 2
        p.setPen(QPen(CUT, 1))
        p.drawLine(QPointF(x, y + 2), QPointF(x, y + fm.height() - 2))
        p.setPen(TEXT_MUTED)
        p.drawText(QPointF(x + 17, y + fm.ascent()), "镜头切换")
        x += 17 + fm.horizontalAdvance("镜头切换") + 14
        p.setPen(Qt.NoPen)
        p.setBrush(QColor(250, 178, 25, 60))
        p.drawRect(QRectF(x, y + 2, 12, fm.height() - 4))
        p.setBrush(Qt.NoBrush)
        p.setPen(TEXT_MUTED)
        p.drawText(QPointF(x + 17, y + fm.ascent()), "窗口不足·直通")


def legend_height(font, rows: int = 2) -> int:
    """Plot margin needed above the data for the two-row legend."""
    fm = QFontMetrics(font)
    return rows * (fm.height() + 2) + 8
