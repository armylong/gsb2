"""波形视图: 展示包络、播放位置与循环选区, 支持点击 seek / 拖边界。"""
from __future__ import annotations

import numpy as np
from PySide6.QtCore import QPointF, Qt, Signal
from PySide6.QtGui import QColor, QPainter, QPen
from PySide6.QtWidgets import QWidget


class WaveformView(QWidget):
    seekRequested = Signal(float)          # 秒
    loopChanged = Signal(float, float)     # 起止秒

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setMinimumHeight(130)
        self.setMouseTracking(True)
        self._env_lo: np.ndarray | None = None
        self._env_hi: np.ndarray | None = None
        self._duration = 1.0
        self._position = 0.0
        self._loop_start = 0.0
        self._loop_end = 1.0
        self._drag: str | None = None       # "start" | "end" | "play"

    # -- 数据 -------------------------------------------------------------- #
    def set_waveform(self, buf: np.ndarray, sr: int) -> None:
        mono = buf.mean(axis=1)
        bins = max(64, self.width() or 400)
        n = len(mono)
        seg = max(1, n // bins)
        trim = mono[: (n // seg) * seg].reshape(-1, seg)
        self._env_lo = trim.min(axis=1).astype(np.float32)
        self._env_hi = trim.max(axis=1).astype(np.float32)
        self._duration = n / sr

    def set_position(self, seconds: float) -> None:
        self._position = float(np.clip(seconds, 0, self._duration))
        self.update()

    def set_loop(self, start_s: float, end_s: float) -> None:
        self._loop_start = start_s
        self._loop_end = end_s
        self.update()

    def loop_bounds(self) -> tuple[float, float]:
        return self._loop_start, self._loop_end

    # -- 绘制 -------------------------------------------------------------- #
    def paintEvent(self, _event) -> None:  # noqa: N802
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        w, h = self.width(), self.height()
        p.fillRect(self.rect(), QColor("#101418"))
        mid = h / 2

        # 循环选区底色
        if self._env_lo is not None:
            x0 = self._loop_start / self._duration * w
            x1 = self._loop_end / self._duration * w
            p.fillRect(int(x0), 0, max(1, int(x1 - x0)), h, QColor(40, 90, 140, 70))

            pen = QPen(QColor("#5fb3ff"))
            pen.setWidth(1)
            p.setPen(pen)
            n = len(self._env_lo)
            step = w / n
            for i in range(n):
                x = i * step
                y_hi = mid - float(self._env_hi[i]) * (mid - 4)
                y_lo = mid - float(self._env_lo[i]) * (mid - 4)
                p.drawLine(QPointF(x, y_hi), QPointF(x, y_lo))

        # 中线
        p.setPen(QPen(QColor(80, 90, 100), 1, Qt.PenStyle.DotLine))
        p.drawLine(0, int(mid), w, int(mid))

        # 循环边界
        for pos, color in ((self._loop_start, "#ffd166"), (self._loop_end, "#ffd166")):
            x = pos / self._duration * w
            p.setPen(QPen(QColor(color), 2))
            p.drawLine(int(x), 0, int(x), h)

        # 播放头
        x = self._position / self._duration * w
        p.setPen(QPen(QColor("#ff5d5d"), 2))
        p.drawLine(int(x), 0, int(x), h)
        p.end()

    # -- 交互 -------------------------------------------------------------- #
    def _hit_edge(self, x: int) -> str | None:
        w = self.width()
        for name, val in (("start", self._loop_start), ("end", self._loop_end)):
            xe = val / self._duration * w
            if abs(x - xe) < 7:
                return name
        return None

    def mousePressEvent(self, event) -> None:  # noqa: N802
        x = event.position().x()
        edge = self._hit_edge(int(x))
        if edge:
            self._drag = edge
        else:
            self._drag = "play"
            self._emit_seek(x)

    def mouseMoveEvent(self, event) -> None:  # noqa: N802
        if self._drag is None:
            self.setCursor(Qt.CursorShape.SplitHCursor if self._hit_edge(
                int(event.position().x())) else Qt.CursorShape.IBeamCursor)
            return
        x = float(np.clip(event.position().x(), 0, self.width()))
        t = x / self.width() * self._duration
        if self._drag == "start":
            self._loop_start = min(t, self._loop_end - 0.02)
            self.loopChanged.emit(self._loop_start, self._loop_end)
        elif self._drag == "end":
            self._loop_end = max(t, self._loop_start + 0.02)
            self.loopChanged.emit(self._loop_start, self._loop_end)
        else:
            self._emit_seek(x)

    def mouseReleaseEvent(self, _event) -> None:  # noqa: N802
        self._drag = None

    def _emit_seek(self, x: float) -> None:
        self.seekRequested.emit(float(np.clip(x, 0, self.width())) / self.width() * self._duration)
