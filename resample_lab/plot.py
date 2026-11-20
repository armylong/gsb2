"""Tiny dependency-free line plot for the diagnostics curves.

Uses QPainter only (no QtCharts / matplotlib) so the tool has no extra runtime
dependencies.  Handles NaN gaps (e.g. "no edge pixels at this scale") by
breaking the line.
"""
from __future__ import annotations

import math

from PySide6.QtCore import QPointF, Qt
from PySide6.QtGui import QColor, QFont, QPainter, QPen
from PySide6.QtWidgets import QSizePolicy, QWidget

COLORS = {
    "area": QColor(120, 200, 255),
    "direct": QColor(255, 120, 120),
    "gaussian": QColor(170, 230, 140),
    "mean": QColor(240, 200, 100),
}


class LinePlot(QWidget):
    def __init__(self, parent=None):
        super().__init__(parent)
        self._series: dict[str, list[tuple[float, float]]] = {}
        self._x_label = ""
        self._y_label = ""
        self._marker_x: float | None = None
        self.setMinimumHeight(140)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Preferred)

    def set_data(
        self,
        series: dict[str, list[tuple[float, float]]],
        x_label: str,
        y_label: str,
        marker_x: float | None = None,
    ) -> None:
        self._series = series
        self._x_label = x_label
        self._y_label = y_label
        self._marker_x = marker_x
        self.update()

    def paintEvent(self, event) -> None:  # noqa: N802
        p = QPainter(self)
        try:
            self._paint(p)
        finally:
            p.end()

    def _paint(self, p: QPainter) -> None:
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        p.fillRect(self.rect(), QColor(24, 26, 30))

        left, top, right, bottom = 56, 18, 12, 40
        plot = self.rect().adjusted(left, top, -right, -bottom)
        if plot.width() < 20 or plot.height() < 20:
            return

        points = [pt for pts in self._series.values() for pt in pts if not math.isnan(pt[1])]
        if not points:
            p.setPen(QColor(150, 150, 150))
            p.drawText(self.rect(), Qt.AlignmentFlag.AlignCenter, "无数据")
            return

        xs = [pt[0] for pt in points]
        ys = [pt[1] for pt in points]
        x_lo, x_hi = min(xs), max(xs)
        y_lo, y_hi = min(ys), max(ys)
        if x_hi - x_lo < 1e-12:
            x_hi = x_lo + 1.0
        pad = (y_hi - y_lo) * 0.1 or 0.05
        y_lo -= pad
        y_hi += pad
        # All metrics in this tool are alpha/luma ratios in [-1, 1]; clamping
        # keeps one outlier from flattening the curves everyone else reads.
        y_lo = max(y_lo, -1.05)
        y_hi = min(y_hi, 1.05)
        if y_hi - y_lo < 1e-6:
            y_lo -= 0.01
            y_hi += 0.01

        def to_px(x: float, y: float) -> QPointF:
            px = plot.left() + (x - x_lo) / (x_hi - x_lo) * plot.width()
            y_clamped = min(max(y, y_lo), y_hi)
            py = plot.bottom() - (y_clamped - y_lo) / (y_hi - y_lo) * plot.height()
            return QPointF(px, py)

        # Grid + tick labels.
        p.setPen(QPen(QColor(60, 64, 72), 1))
        font = QFont()
        font.setPointSize(9)
        p.setFont(font)
        for i in range(5):
            frac = i / 4
            y_val = y_lo + frac * (y_hi - y_lo)
            y_px = plot.bottom() - frac * plot.height()
            p.setPen(QPen(QColor(52, 56, 64), 1))
            p.drawLine(plot.left(), int(y_px), plot.right(), int(y_px))
            p.setPen(QColor(150, 156, 166))
            p.drawText(
                plot.left() - 52,
                int(y_px) + 4,
                46,
                14,
                Qt.AlignmentFlag.AlignRight,
                _format(y_val),
            )
            x_val = x_lo + frac * (x_hi - x_lo)
            x_px = plot.left() + frac * plot.width()
            p.drawText(
                int(x_px) - 30,
                plot.bottom() + 6,
                60,
                14,
                Qt.AlignmentFlag.AlignCenter,
                _format(x_val),
            )

        for key, pts in self._series.items():
            colour = COLORS.get(key, QColor(200, 200, 200))
            pen = QPen(colour)
            pen.setWidthF(1.8)
            p.setPen(pen)
            run: list[QPointF] = []
            for x, y in pts:
                if math.isnan(y):
                    if len(run) > 1:
                        p.drawPolyline(run)
                    run = []
                else:
                    run.append(to_px(x, y))
            if len(run) > 1:
                p.drawPolyline(run)

        # Mark the current preview scale/offset so the curve has context.
        if self._marker_x is not None and x_lo <= self._marker_x <= x_hi:
            p.setPen(QPen(QColor(255, 255, 255, 90), 1, Qt.PenStyle.DashLine))
            mx = plot.left() + (self._marker_x - x_lo) / (x_hi - x_lo) * plot.width()
            p.drawLine(QPointF(mx, plot.top()), QPointF(mx, plot.bottom()))

        # Legend.
        x_cursor = plot.left() + 4
        for key in self._series:
            colour = COLORS.get(key, QColor(200, 200, 200))
            p.setPen(QPen(colour, 2))
            p.drawLine(x_cursor, top - 8, x_cursor + 16, top - 8)
            p.setPen(QColor(210, 214, 220))
            text = key
            p.drawText(x_cursor + 20, top - 3, text)
            x_cursor += 24 + p.fontMetrics().horizontalAdvance(text) + 12

        if self._x_label or self._y_label:
            p.setPen(QColor(150, 156, 166))
            p.drawText(
                plot.left(),
                self.height() - 6,
                f"{self._y_label}  vs  {self._x_label}",
            )


def _format(value: float) -> str:
    if abs(value) >= 100:
        return f"{value:.0f}"
    if abs(value) >= 1:
        return f"{value:.2f}"
    return f"{value:.3f}"
