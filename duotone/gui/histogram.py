"""覆盖率/误差直方图控件（单轴、中性坐标、直接文字标签）。"""

from __future__ import annotations

import numpy as np
from PySide6.QtCore import Qt
from PySide6.QtGui import QColor, QPainter, QPen
from PySide6.QtWidgets import QSizePolicy, QWidget


class HistogramWidget(QWidget):
    def __init__(self, title: str, bar_hex: str, parent=None):
        super().__init__(parent)
        self.title = title
        self.bar = QColor(bar_hex)
        self.values: np.ndarray | None = None
        self.bins = 32
        self.range = (0.0, 1.0)
        self.setMinimumHeight(130)
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Fixed)

    def set_values(self, values: np.ndarray, rng: tuple[float, float] | None = None) -> None:
        self.values = np.asarray(values, dtype=np.float64).ravel()
        if rng is not None:
            self.range = rng
        self.update()

    def paintEvent(self, event):
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing)
        m = 8
        p.setPen(QColor("#222222"))
        p.drawText(m, m + 8, self.title)
        x0, y0, x1, y1 = m + 6, m + 22, self.width() - m, self.height() - m - 16
        p.setPen(QPen(QColor("#cccccc"), 1))
        p.drawLine(x0, y1, x1, y1)
        if self.values is None or self.values.size == 0:
            p.end()
            return
        hist, edges = np.histogram(self.values, bins=self.bins, range=self.range)
        hmax = max(hist.max(), 1)
        bw = (x1 - x0) / self.bins
        p.setBrush(self.bar)
        p.setPen(Qt.NoPen)
        for i, h in enumerate(hist):
            hh = (h / hmax) * (y1 - y0)
            p.drawRect(int(x0 + i * bw) + 1, int(y1 - hh),
                       max(int(bw) - 2, 1), int(hh))
        # 轴刻度文字（中性灰，不用墨色）
        p.setPen(QColor("#666666"))
        lo, hi = self.range
        for i in range(5):
            v = lo + (hi - lo) * i / 4
            p.drawText(int(x0 + i / 4 * (x1 - x0)) - 10, y1 + 13, f"{v:.2f}")
        p.drawText(x0, y0 - 4, f"峰值像素数 {hmax}｜样本 {self.values.size}")
        p.end()
