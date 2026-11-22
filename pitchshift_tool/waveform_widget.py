"""波形显示控件: 区域选择、削波标记、播放头、左右声道分绘。"""

from __future__ import annotations

import numpy as np
from PySide6.QtCore import Qt, QRectF, Signal
from PySide6.QtGui import QColor, QPainter, QPen
from PySide6.QtWidgets import QWidget

from .analysis import ClipRegion

_BG = QColor("#1e1f24")
_GRID = QColor("#3a3d46")
_WAVE_L = QColor("#6fb3ff")
_WAVE_R = QColor("#ffb86b")
_WAVE_M = QColor("#9aa4b2")
_SUSTAIN = QColor(80, 200, 120, 70)
_ONSET = QColor(255, 190, 80, 70)
_CLIP = QColor(255, 70, 70, 95)
_PLAYHEAD = QColor("#ffffff")
_SELECTION = QColor(255, 255, 255, 45)


class WaveformView(QWidget):
    selectionMade = Signal(float, float)  # 拖动选择发出的起止秒

    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self.setMinimumHeight(180)
        self.setMouseTracking(True)
        self._samples: np.ndarray | None = None
        self._sr = 0
        self._duration = 0.0
        self._sustain: tuple[float, float] | None = None
        self._onset: tuple[float, float] | None = None
        self._clips: list[ClipRegion] = []
        self._playhead = 0.0
        self._sel: tuple[float, float] | None = None
        self._dragging = False
        self._drag_x = 0

    # ---------- 数据 ----------
    def set_audio(self, samples: np.ndarray | None, sr: int) -> None:
        self._samples = samples
        self._sr = sr
        self._duration = 0.0 if samples is None else len(samples) / sr
        self._playhead = 0.0
        self._sel = None
        self._sustain = None
        self._onset = None
        self._clips = []
        self.update()

    def set_regions(
        self,
        sustain: tuple[float, float] | None,
        onset: tuple[float, float] | None,
    ) -> None:
        self._sustain = sustain
        self._onset = onset
        self.update()

    def set_clips(self, clips: list[ClipRegion]) -> None:
        self._clips = clips
        self.update()

    def set_playhead(self, t: float) -> None:
        if abs(t - self._playhead) > 0.5 / max(1, self._sr):
            self._playhead = t
            self.update()

    def time_at_x(self, x: float) -> float:
        if self._duration <= 0:
            return 0.0
        return float(np.clip(x / max(1, self.width()), 0.0, 1.0)) * self._duration

    def _x(self, t: float) -> float:
        return t / max(1e-9, self._duration) * self.width()

    # ---------- 鼠标: 单击定位, 拖动选段 ----------
    def mousePressEvent(self, event) -> None:
        if self._duration <= 0:
            return
        t = self.time_at_x(event.position().x())
        self._dragging = True
        self._drag_x = int(event.position().x())
        self._sel = (t, t)
        self.update()

    def mouseMoveEvent(self, event) -> None:
        if not self._dragging:
            return
        t = self.time_at_x(event.position().x())
        t0 = self.time_at_x(self._drag_x)
        self._sel = (min(t0, t), max(t0, t))
        self.update()

    def mouseReleaseEvent(self, event) -> None:
        if not self._dragging:
            return
        self._dragging = False
        if self._sel and self._sel[1] - self._sel[0] >= 0.02:
            self.selectionMade.emit(self._sel[0], self._sel[1])
        else:
            self._sel = None
        self.update()

    # ---------- 绘制 ----------
    def paintEvent(self, event) -> None:
        self._paint()

    def _paint(self) -> None:
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing, False)
        p.fillRect(self.rect(), _BG)

        if self._samples is None or self._duration <= 0:
            p.setPen(QColor("#777d88"))
            p.drawText(self.rect(), Qt.AlignCenter, "导入 wav 或生成测试信号后显示波形")
            return

        w, h = self.width(), self.height()
        for frac in (0.25, 0.5, 0.75):
            p.setPen(QPen(_GRID, 1, Qt.DotLine))
            y = int(h * frac)
            p.drawLine(0, y, w, y)

        # 区域底色
        if self._sustain:
            self._fill_region(p, self._sustain, _SUSTAIN)
        if self._onset:
            self._fill_region(p, self._onset, _ONSET)
        for c in self._clips:
            self._fill_region(p, (c.start, c.end), _CLIP)
        if self._sel:
            self._fill_region(p, self._sel, _SELECTION)

        stereo = self._samples.ndim == 2
        if stereo:
            self._draw_channel(p, self._samples[:, 0], QRectF(0, 0, w, h / 2), _WAVE_L)
            self._draw_channel(
                p, self._samples[:, 1], QRectF(0, h / 2, w, h / 2), _WAVE_R
            )
            p.setPen(QPen(_GRID, 1))
            p.drawLine(0, h // 2, w, h // 2)
        else:
            self._draw_channel(p, self._samples, QRectF(0, 0, w, h), _WAVE_M)

        # 播放头
        x = self._x(self._playhead)
        p.setPen(QPen(_PLAYHEAD, 1))
        p.drawLine(int(x), 0, int(x), h)
        p.end()

    def _fill_region(self, p: QPainter, region: tuple[float, float], color: QColor):
        x0, x1 = self._x(region[0]), self._x(region[1])
        p.fillRect(QRectF(x0, 0, max(1.0, x1 - x0), self.height()), color)

    def _draw_channel(self, p: QPainter, data: np.ndarray, rect: QRectF, color: QColor):
        """按像素列做 min/max 包络, 保证长文件也能看到瞬态。"""
        n = len(data)
        w = max(1, int(rect.width()))
        cols = np.array_split(data, w)
        mid = rect.y() + rect.height() / 2
        amp = rect.height() / 2
        p.setPen(QPen(color, 1))
        for i, col in enumerate(cols):
            if len(col) == 0:
                continue
            lo = float(col.min())
            hi = float(col.max())
            p.drawLine(
                int(rect.x() + i), int(mid - hi * amp),
                int(rect.x() + i), int(mid - lo * amp),
            )
