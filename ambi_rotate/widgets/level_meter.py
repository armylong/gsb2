"""立体声电平表: RMS 条 + 峰值刻度 + 削波灯。"""

from __future__ import annotations

from PySide6.QtCore import Qt
from PySide6.QtGui import QColor, QPainter, QPen
from PySide6.QtWidgets import QWidget


class LevelMeter(QWidget):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setMinimumSize(120, 150)
        self._levels = [(-60.0, -60.0), (-60.0, -60.0)]
        self._clip = [False, False]
        self._labels = ("L", "R")

    def set_labels(self, labels: tuple[str, str]) -> None:
        self._labels = labels
        self.update()

    def set_levels(self, levels: list[tuple[float, float]], clipped: bool) -> None:
        self._levels = [(rms, peak) for rms, peak in levels]
        if clipped:
            for i, (_, peak) in enumerate(levels):
                if peak >= -0.5:
                    self._clip[i] = True
        self.update()

    def reset_clip(self) -> None:
        self._clip = [False, False]
        self.update()

    @staticmethod
    def _frac(db: float) -> float:
        return max(0.0, min(1.0, (db + 60.0) / 60.0))

    def paintEvent(self, _ev):
        p = QPainter(self)
        p.fillRect(self.rect(), QColor("#1B1D23"))
        bar_w = 26
        gap = 18
        total = 2 * bar_w + gap
        x0 = (self.width() - total) // 2
        top, h = 18, self.height() - 38
        for i in range(2):
            x = x0 + i * (bar_w + gap)
            p.setPen(QPen(QColor("#444"), 1))
            p.drawRect(x, top, bar_w, h)
            rms, peak = self._levels[i]
            fr = self._frac(rms)
            for s in range(int(h * fr)):
                yy = top + h - s - 1
                frac = s / h
                col = QColor("#7EE787") if frac < 0.7 else (
                    QColor("#FFD166") if frac < 0.9 else QColor("#FF6B6B"))
                p.fillRect(x + 2, yy, bar_w - 4, 1, col)
            # 峰值刻线
            pf = self._frac(peak)
            p.setPen(QPen(QColor("#FFF"), 2))
            yp = int(top + h * (1 - pf))
            p.drawLine(x, yp, x + bar_w, yp)
            # 削波灯
            p.setBrush(QColor("#FF3333") if self._clip[i] else QColor("#442222"))
            p.setPen(Qt.PenStyle.NoPen)
            p.drawEllipse(x + bar_w // 2 - 5, top - 14, 10, 10)
            p.setPen(QColor("#CCC"))
            p.drawText(x - 6, top + h + 4, bar_w + 12, 14,
                       Qt.AlignmentFlag.AlignCenter,
                       f"{self._labels[i]} {rms:5.1f} dB")
        p.end()
