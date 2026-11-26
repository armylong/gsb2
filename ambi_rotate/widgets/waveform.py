"""四通道波形视图: 分通道绘制, 点击定位, 拖拽选择导出区间。"""

from __future__ import annotations

import numpy as np
from PySide6.QtCore import Qt, Signal
from PySide6.QtGui import QColor, QPainter, QPen
from PySide6.QtWidgets import QWidget

from ..dsp import ACN_NAMES

CHANNEL_COLORS = ("#4C9BE8", "#E8744C", "#7BB661", "#B06CC9")


class WaveformWidget(QWidget):
    positionMoved = Signal(int)          # 帧
    rangeChanged = Signal(int, int)      # 起始帧, 结束帧

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setMinimumHeight(220)
        self.setMouseTracking(True)
        self._n = 0
        self._sr = 48000
        self._mins: list[np.ndarray] = []
        self._maxs: list[np.ndarray] = []
        self._pos = 0
        self._sel: tuple[int, int] | None = None
        self._drag = False

    def set_data(self, b: np.ndarray, sr: int) -> None:
        self._n = b.shape[0]
        self._sr = sr
        self._pos = 0
        self._sel = None
        # 预算每通道的降采样 min/max, 按控件宽度每像素约 1 桶重算见 paintEvent
        self._raw = [b[:, ch].astype(np.float32) for ch in range(4)]
        self.update()

    def set_position(self, frame: int) -> None:
        self._pos = int(frame)
        self.update()

    def selection(self) -> tuple[int, int] | None:
        return self._sel

    def set_selection(self, start: int, end: int) -> None:
        self._sel = (max(0, start), min(self._n, end))
        self.rangeChanged.emit(*self._sel)
        self.update()

    def clear_selection(self) -> None:
        self._sel = None
        self.update()

    def _frame_at_x(self, x: float) -> int:
        w = self.width()
        if self._n == 0:
            return 0
        return int(np.clip(x / max(1, w), 0, 1) * self._n)

    def mousePressEvent(self, ev):
        f = self._frame_at_x(ev.position().x())
        if ev.button() == Qt.MouseButton.LeftButton:
            self._drag = True
            self._drag_start = f
            self._sel = (f, f)
            self.update()

    def mouseMoveEvent(self, ev):
        if self._drag:
            f = self._frame_at_x(ev.position().x())
            self._sel = (min(self._drag_start, f), max(self._drag_start, f))
            self.update()

    def mouseReleaseEvent(self, ev):
        if self._drag:
            self._drag = False
            f = self._frame_at_x(ev.position().x())
            self.positionMoved.emit(f)
            if self._sel and self._sel[1] - self._sel[0] > self._sr // 100:
                self.rangeChanged.emit(*self._sel)
            else:
                self._sel = None
            self.update()

    def paintEvent(self, _ev):
        p = QPainter(self)
        p.fillRect(self.rect(), QColor("#1B1D23"))
        if self._n == 0:
            p.setPen(QColor("#888"))
            p.drawText(self.rect(), Qt.AlignmentFlag.AlignCenter, "导入或生成四声道 WAV 后显示波形")
            return
        w, h = self.width(), self.height()
        row_h = h / 4
        label_w = 26
        plot_w = max(1, w - label_w)
        # 选择区间背景
        if self._sel:
            x0 = self._sel[0] / self._n * plot_w + label_w
            x1 = self._sel[1] / self._n * plot_w + label_w
            p.fillRect(int(x0), 0, int(x1 - x0), h, QColor(255, 200, 80, 38))
        for ch in range(4):
            y0 = ch * row_h
            p.fillRect(0, int(y0), w, int(row_h), QColor("#22252D"))
            p.setPen(QColor("#AAA"))
            p.drawText(2, int(y0), label_w - 4, int(row_h),
                       Qt.AlignmentFlag.AlignVCenter | Qt.AlignmentFlag.AlignHCenter,
                       ACN_NAMES[ch])
            mid = y0 + row_h / 2
            p.setPen(QPen(QColor("#3A3F4A"), 1))
            p.drawLine(label_w, int(mid), w, int(mid))
            x = self._raw[ch]
            bins = max(1, plot_w)
            re = np.linspace(0, self._n, bins + 1).astype(np.int64)
            mins = np.full(bins, 0.0, np.float32)
            maxs = np.full(bins, 0.0, np.float32)
            for i in range(bins):
                seg = x[re[i]:re[i + 1]]
                if seg.size:
                    mins[i] = seg.min()
                    maxs[i] = seg.max()
            col = QColor(CHANNEL_COLORS[ch])
            p.setPen(QPen(col, 1))
            scale = row_h * 0.42
            for i in range(bins):
                xx = label_w + i
                p.drawLine(xx, int(mid - maxs[i] * scale),
                           xx, int(mid - mins[i] * scale))
            p.setPen(QPen(QColor("#555"), 1))
            p.drawLine(0, int(y0), w, int(y0))
        # 播放头
        if self._n:
            xp = int(self._pos / self._n * plot_w) + label_w
            p.setPen(QPen(QColor("#FFD166"), 2))
            p.drawLine(xp, 0, xp, h)
        p.end()
