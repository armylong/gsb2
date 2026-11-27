"""自绘 Qt 控件: 波形图、包络/输出贡献曲线、载波能量条。

不依赖 matplotlib, 全部 QPainter 绘制; 长信号先在 DSP 层降采样。
"""
from __future__ import annotations

import numpy as np
from PySide6.QtCore import QPointF, Qt, Signal
from PySide6.QtGui import QColor, QPainter, QPen
from PySide6.QtGui import QPolygonF
from PySide6.QtWidgets import QSizePolicy, QWidget

BG = QColor("#1e1f24")
GRID = QColor("#33363d")
TEXT = QColor("#b8bcc4")
ENV_COLOR = QColor("#4aa8ff")          # 调制包络
OUT_COLOR = QColor("#ffb347")          # 该带对输出的贡献
WAVE_COLOR = QColor("#9aa4b2")
DEAD_COLOR = QColor("#55595f")         # 载波无能量的带
ALIVE_COLOR = QColor("#4aa8ff")
SELECT_COLOR = QColor("#ffd34d")


class _Canvas(QWidget):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setMinimumHeight(110)
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Fixed)
        self.setAutoFillBackground(True)
        pal = self.palette()
        pal.setColor(self.backgroundRole(), BG)
        self.setPalette(pal)

    def _axes(self):
        m = 26
        return m, m, self.width() - m - 6, self.height() - m - 18

    def paintEvent(self, event):
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing)
        x0, y0, w, h = self._axes()
        p.fillRect(self.rect(), BG)
        p.setPen(QPen(GRID, 1))
        for frac in (0.25, 0.5, 0.75):
            yy = y0 + h * frac
            p.drawLine(x0, int(yy), x0 + w, int(yy))
        p.setPen(QPen(TEXT, 1))
        p.drawLine(x0, y0, x0, y0 + h)
        p.drawLine(x0, y0 + h, x0 + w, y0 + h)
        self._draw_data(p, x0, y0, w, h)
        p.end()

    def _draw_data(self, p: QPainter, x0, y0, w, h):
        raise NotImplementedError


class WaveformPlot(_Canvas):
    """带符号波形: 用 min/max 降采样包络带绘制。"""

    def __init__(self, title: str, parent=None):
        super().__init__(parent)
        self._title = title
        self._lo = self._hi = None
        self.setMinimumHeight(90)

    def set_waveform(self, lo: np.ndarray, hi: np.ndarray):
        self._lo, self._hi = lo, hi
        self.update()

    def clear(self):
        self._lo = self._hi = None
        self.update()

    def _draw_data(self, p, x0, y0, w, h):
        p.setPen(QPen(TEXT))
        p.drawText(4, 16, self._title)
        if self._lo is None or len(self._lo) == 0:
            return
        n = len(self._lo)
        mid = y0 + h / 2
        p.setPen(QPen(WAVE_COLOR, 1))
        for i in range(n):
            xx = x0 + w * i / max(1, n - 1)
            y_hi = mid - (self._hi[i] * h / 2)
            y_lo = mid - (self._lo[i] * h / 2)
            p.drawLine(int(xx), int(y_hi), int(xx), int(y_lo))


class EnvelopePlot(_Canvas):
    """选中频带: 调制包络(蓝)与该带输出贡献(橙)两条非负曲线。

    点击图上任意位置会发出 band_time_clicked, 比例位置即时间位置。
    """

    band_time_clicked = Signal(float)

    def __init__(self, parent=None):
        super().__init__(parent)
        self._env = None
        self._out = None
        self._dead = False
        self.setMinimumHeight(150)
        self.setCursor(Qt.PointingHandCursor)

    def set_curves(self, envelope: np.ndarray, band_output: np.ndarray,
                   dead: bool):
        self._env, self._out, self._dead = envelope, band_output, dead
        self.update()

    def clear(self):
        self._env = self._out = None
        self._dead = False
        self.update()

    def mousePressEvent(self, event):
        x0, _, w, _ = self._axes()
        if w > 0:
            frac = (event.position().x() - x0) / w
            self.band_time_clicked.emit(float(np.clip(frac, 0, 1)))
        super().mousePressEvent(event)

    def _draw_data(self, p, x0, y0, w, h):
        p.setPen(QPen(TEXT))
        p.drawText(4, 16, "选中频带: 蓝=调制包络起伏  橙=该带对输出的贡献")
        if self._env is None:
            return
        scale = max(float(np.max(self._env)), float(np.max(self._out)), 1e-9)

        def poly(y, color):
            pen = QPen(DEAD_COLOR if self._dead else color, 1.6)
            p.setPen(pen)
            n = len(y)
            polyline = QPolygonF(
                [QPointF(x0 + w * i / max(1, n - 1),
                         y0 + h * (1 - min(1.0, y[i] / scale)))
                 for i in range(n)])
            p.drawPolyline(polyline)

        poly(self._env, ENV_COLOR)
        poly(self._out, OUT_COLOR)
        if self._dead:
            p.setPen(QPen(DEAD_COLOR))
            p.drawText(x0 + w - 150, 16, "载波在该带无能量 → 输出恒为零")


class EnergyBars(_Canvas):
    """各频带载波能量柱状图, 死带画灰, 选中带描黄边; 点击选带。"""

    band_selected = Signal(int)

    def __init__(self, parent=None):
        super().__init__(parent)
        self._energy = None
        self._selected = 0
        self.setMinimumHeight(130)
        self.setCursor(Qt.PointingHandCursor)

    def set_energy(self, energy: np.ndarray, selected: int):
        self._energy = energy
        self._selected = int(np.clip(selected, 0,
                                     len(energy) - 1 if energy is not None else 0))
        self.update()

    def mousePressEvent(self, event):
        if self._energy is not None and len(self._energy):
            x0, _, w, _ = self._axes()
            frac = (event.position().x() - x0) / max(1, w)
            idx = int(frac * len(self._energy))
            self.band_selected.emit(int(np.clip(idx, 0, len(self._energy) - 1)))
        super().mousePressEvent(event)

    def _draw_data(self, p, x0, y0, w, h):
        p.setPen(QPen(TEXT))
        p.drawText(4, 16, "载波在各频带的原始能量(灰=无能量, 黄框=选中)")
        if self._energy is None or not len(self._energy):
            return
        n = len(self._energy)
        peak = max(float(self._energy.max()), 1e-9)
        dead = self._energy < 0.01 * peak
        bw = w / n
        for i, e in enumerate(self._energy):
            bh = h * float(e) / peak
            xx = x0 + i * bw + 1
            color = DEAD_COLOR if dead[i] else ALIVE_COLOR
            p.fillRect(int(xx), int(y0 + h - bh), max(1, int(bw - 2)),
                       int(bh), color)
            if i == self._selected:
                p.setPen(QPen(SELECT_COLOR, 2))
                p.drawRect(int(xx), int(y0 + h - bh),
                           max(1, int(bw - 2)), int(bh))
                p.setPen(QPen(TEXT, 1))
            p.setPen(QPen(TEXT))
            p.drawText(int(xx), int(y0 + h + 14), str(i))
