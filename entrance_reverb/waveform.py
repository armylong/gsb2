"""波形显示控件。

一个控件同时画干声 / 前置湿声 / 合成三种视图，共用同一条时间轴，因此起音标记、
前置区边界在三个视图里指向完全相同的采样。左键点击设置干声起音，滚轮缩放，
左键拖拽平移。
"""
from __future__ import annotations

import numpy as np
from PySide6.QtCore import QPoint, Qt, Signal
from PySide6.QtGui import QColor, QMouseEvent, QPainter, QPen, QWheelEvent
from PySide6.QtWidgets import QWidget

from .dsp import RenderResult


class WaveformView(QWidget):
    onsetChanged = Signal(int)  # 用户点击后发出：干声坐标系下的起音采样

    PAD_TOP = 18
    PAD_BOTTOM = 22
    PAD_LEFT = 8
    PAD_RIGHT = 8

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setMinimumHeight(240)
        self.setMouseTracking(True)
        self._dry: np.ndarray | None = None
        self._render: RenderResult | None = None
        self._view = "mix"          # dry / wet / mix
        self._onset_dry = 0         # 干声坐标系下的起音
        self._cursor = -1           # 输出坐标系下的播放光标
        self._markers: list[tuple[int, str]] = []  # 干声坐标系标记（击掌点等）
        self._sr = 48000           # 当前波形的采样率（时间刻度/起音标签用）
        self._scale = 1.0           # 每采样像素
        self._scroll = 0            # 左边缘对应的输出采样
        self._drag_pos: QPoint | None = None
        self._drag_scroll = 0
        self._peak_cache: dict[str, np.ndarray] = {}

    # ------------------------------------------------------------------
    def set_dry(self, dry: np.ndarray, onset: int, markers=None,
                sr: int = 48000) -> None:
        self._dry = dry
        self._sr = sr
        self._onset_dry = max(0, min(onset, dry.shape[0] - 1))
        self._markers = list(markers or [])
        self._render = None
        self._peak_cache.clear()
        self._scroll = 0
        self.update()

    def set_render(self, render: RenderResult) -> None:
        self._render = render
        self._sr = render.sr
        self._peak_cache.clear()
        self.update()

    def set_view(self, view: str) -> None:
        self._view = view
        self.update()

    def set_cursor(self, sample: int) -> None:
        self._cursor = sample
        self.update()

    def set_onset(self, onset_dry: int) -> None:
        if self._dry is not None:
            self._onset_dry = max(0, min(onset_dry, self._dry.shape[0] - 1))
            self.update()

    # ------------------------------------------------------------------
    @property
    def onset_dry(self) -> int:
        return self._onset_dry

    def _current_audio(self) -> np.ndarray | None:
        if self._render is not None:
            return {"dry": self._render.dry, "wet": self._render.wet,
                    "mix": self._render.mix}[self._view]
        return self._dry

    def _sample_count(self) -> int:
        audio = self._current_audio()
        return 0 if audio is None else audio.shape[0]

    def _x_for_sample(self, sample: float) -> float:
        return self.PAD_LEFT + (sample - self._scroll) * self._scale

    def _sample_for_x(self, x: float) -> int:
        return int(round((x - self.PAD_LEFT) / self._scale + self._scroll))

    def fit_scale(self) -> None:
        n = self._sample_count()
        if n:
            self._scale = max(1e-6, (self.width() - self.PAD_LEFT - self.PAD_RIGHT) / n)
        self._scroll = 0
        self.update()

    # ------------------------------------------------------------------
    def _peaks(self, audio: np.ndarray) -> np.ndarray:
        """按像素列做 min/max 分箱，返回 (可视列数, 2, 声道数)。"""
        key = f"{audio.shape}-{audio.dtype}-{self.width()}"
        if self._view in self._peak_cache and key in self._peak_cache:
            return self._peak_cache[key]
        usable = max(1, self.width() - self.PAD_LEFT - self.PAD_RIGHT)
        n, ch = audio.shape
        cols = min(usable, max(1, n))
        idx = np.minimum((np.arange(cols) * n / cols).astype(int), n - 1)
        idx_next = np.minimum(idx + max(1, n // cols), n)
        lo = np.zeros((cols, ch))
        hi = np.zeros((cols, ch))
        for c in range(ch):
            for j in range(cols):
                seg = audio[idx[j] : idx_next[j], c]
                lo[j, c] = seg.min() if seg.size else 0.0
                hi[j, c] = seg.max() if seg.size else 0.0
        peaks = np.stack([lo, hi], axis=1)
        self._peak_cache = {key: peaks}
        return peaks

    # ------------------------------------------------------------------
    def paintEvent(self, event) -> None:  # noqa: N802 (Qt 命名)
        p = QPainter(self)
        p.fillRect(self.rect(), QColor("#1e1f24"))
        audio = self._current_audio()
        if audio is None or audio.shape[0] == 0:
            p.setPen(QColor("#888"))
            p.drawText(self.rect(), Qt.AlignmentFlag.AlignCenter, "导入 wav 后在此显示波形")
            return
        n, ch = audio.shape
        usable_h = self.height() - self.PAD_TOP - self.PAD_BOTTOM
        lane_h = usable_h / ch
        center = [self.PAD_TOP + lane_h * (c + 0.5) for c in range(ch)]

        # 中线与网格
        pen = QPen(QColor("#3a3d45"))
        pen.setWidth(1)
        p.setPen(pen)
        for c in range(ch):
            y = int(center[c])
            p.drawLine(self.PAD_LEFT, y, self.width() - self.PAD_RIGHT, y)

        # 前置区（仅渲染后存在）：起音之前的补静音/湿声区域
        if self._render is not None and self._render.prepend > 0:
            x0 = self._x_for_sample(0)
            x1 = self._x_for_sample(self._render.prepend)
            p.fillRect(int(x0), self.PAD_TOP, int(max(0, x1 - x0)),
                       int(usable_h), QColor(64, 120, 200, 38))

        # 波形
        peaks = self._peaks(audio)
        wave_color = {"dry": QColor("#7fb3ff"), "wet": QColor("#ffb86b"),
                      "mix": QColor("#9be29b")}[self._view] if self._render else QColor("#cfd3da")
        p.setPen(wave_color)
        cols = peaks.shape[0]
        for j in range(cols):
            x = int(self.PAD_LEFT + j)
            for c in range(ch):
                y_lo = int(center[c] - peaks[j, 1, c] * lane_h * 0.46)
                y_hi = int(center[c] - peaks[j, 0, c] * lane_h * 0.46)
                p.drawLine(x, y_lo, x, max(y_lo, y_hi))

        # 击掌标记（干声坐标 -> 输出坐标要加 prepend）
        prepend = self._render.prepend if self._render is not None else 0
        p.setPen(QPen(QColor("#c792ea"), 1, Qt.PenStyle.DashLine))
        for sample, label in self._markers:
            x = int(self._x_for_sample(sample + prepend))
            if self.PAD_LEFT <= x <= self.width() - self.PAD_RIGHT:
                p.drawLine(x, self.PAD_TOP, x, self.height() - self.PAD_BOTTOM)
                p.drawText(x + 3, self.PAD_TOP + 10, label)

        # 起音标记（三种视图同一时间）
        onset_out = self._onset_dry + prepend
        x = int(self._x_for_sample(onset_out))
        pen = QPen(QColor("#ff5577"), 2)
        p.setPen(pen)
        p.drawLine(x, self.PAD_TOP - 4, x, self.height() - self.PAD_BOTTOM)
        p.drawText(x + 4, self.PAD_TOP + 22, f"起音 {onset_out / self._sr:.3f}s")

        # 交界淡变窗
        if self._render is not None and self._render.fade_samples > 0:
            xf = int(self._x_for_sample(onset_out - self._render.fade_samples))
            p.setPen(QPen(QColor("#ffd166"), 1, Qt.PenStyle.DotLine))
            p.drawLine(xf, self.PAD_TOP, xf, self.height() - self.PAD_BOTTOM)

        # 播放光标
        if self._cursor >= 0:
            xc = int(self._x_for_sample(self._cursor))
            p.setPen(QPen(QColor("#ffffff"), 1))
            p.drawLine(xc, self.PAD_TOP, xc, self.height() - self.PAD_BOTTOM)

        # 时间刻度
        p.setPen(QColor("#9aa0aa"))
        for sec in range(0, n // self._sr + 1):
            xt = int(self._x_for_sample(sec * self._sr))
            if self.PAD_LEFT <= xt <= self.width() - self.PAD_RIGHT:
                p.drawText(xt - 12, self.height() - 6, f"{sec}s")

    # ------------------------------------------------------------------
    def mousePressEvent(self, event: QMouseEvent) -> None:  # noqa: N802
        if event.button() == Qt.MouseButton.LeftButton and self._dry is not None:
            self._drag_pos = event.position().toPoint()
            self._drag_scroll = self._scroll

    def mouseMoveEvent(self, event: QMouseEvent) -> None:  # noqa: N802
        if self._drag_pos is not None:
            dx = event.position().toPoint().x() - self._drag_pos.x()
            self._scroll = max(0, int(self._drag_scroll - dx / self._scale))
            self.update()

    def mouseReleaseEvent(self, event: QMouseEvent) -> None:  # noqa: N802
        if event.button() != Qt.MouseButton.LeftButton or self._dry is None:
            return
        moved = self._drag_pos is not None and (
            event.position().toPoint() - self._drag_pos
        ).manhattanLength() > 4
        self._drag_pos = None
        if moved:
            self.update()
            return
        # 点击：输出坐标 -> 干声坐标（减掉 prepend）；忽略波形区域外的点击
        if not (self.PAD_LEFT <= event.position().x()
                <= self.width() - self.PAD_RIGHT
                and self.PAD_TOP <= event.position().y()
                <= self.height() - self.PAD_BOTTOM):
            return
        out_sample = self._sample_for_x(event.position().x())
        prepend = self._render.prepend if self._render is not None else 0
        dry_sample = max(0, min(out_sample - prepend, self._dry.shape[0] - 1))
        self._onset_dry = dry_sample
        self.onsetChanged.emit(dry_sample)
        self.update()

    def wheelEvent(self, event: QWheelEvent) -> None:  # noqa: N802
        if self._dry is None:
            return
        anchor = self._sample_for_x(event.position().x())
        factor = 1.25 if event.angleDelta().y() > 0 else 1 / 1.25
        n = self._sample_count()
        max_scale = (self.width() - self.PAD_LEFT - self.PAD_RIGHT) / max(1, n) * 40
        self._scale = float(np.clip(self._scale * factor, 1e-6, max(1.0, max_scale)))
        self._scroll = max(0, int(anchor - (event.position().x() - self.PAD_LEFT) / self._scale))
        self.update()

    def resizeEvent(self, event) -> None:  # noqa: N802
        self._peak_cache.clear()
        super().resizeEvent(event)
