"""可缩放频谱视图与波形概览视图。

坐标约定
========
- 选区以 *绝对样本号 + 绝对频率 Hz* 存储, 缩放/平移只改变视口
  (t_view/f_view), 绝不修改选区数值, 因此改变显示缩放不会让选区漂移。
- 像素坐标 <-> 时间/频率 的映射集中在 time_to_x / x_to_time 等四个方法,
  绘制与鼠标交互共用同一套映射。
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from PySide6.QtCore import Qt, QPoint, QRectF, Signal
from PySide6.QtGui import (QColor, QImage, QPainter, QPen, QFont,
                           QPolygonF)
from PySide6.QtWidgets import QWidget
from scipy import signal as scipy_signal

from ..processing import STFTParams, Selection


# ---------------------------------------------------------------------------
# 辅助
# ---------------------------------------------------------------------------

def nice_ticks(lo: float, hi: float, max_ticks: int = 8) -> np.ndarray:
    """生成易读的坐标轴刻度。"""
    if hi <= lo:
        return np.array([lo])
    raw_step = (hi - lo) / max_ticks
    mag = 10 ** np.floor(np.log10(raw_step))
    norm = raw_step / mag
    if norm < 1.5:
        step = 1 * mag
    elif norm < 3:
        step = 2 * mag
    elif norm < 7:
        step = 5 * mag
    else:
        step = 10 * mag
    start = np.ceil(lo / step) * step
    ticks = []
    v = start
    while v <= hi + step * 1e-9:
        ticks.append(v)
        v += step
    return np.array(ticks[:max_ticks + 2])


_MAGMA_STOPS = [
    (0.00, (0, 0, 4)),
    (0.25, (59, 16, 99)),
    (0.50, (155, 45, 113)),
    (0.75, (237, 105, 37)),
    (1.00, (252, 253, 191)),
]


def build_lut() -> np.ndarray:
    lut = np.zeros((256, 3), dtype=np.uint8)
    xs = np.linspace(0, 1, 256)
    for i, x in enumerate(xs):
        for j in range(len(_MAGMA_STOPS) - 1):
            x0, c0 = _MAGMA_STOPS[j]
            x1, c1 = _MAGMA_STOPS[j + 1]
            if x0 <= x <= x1:
                a = (x - x0) / max(x1 - x0, 1e-12)
                lut[i] = [int(c0[k] * (1 - a) + c1[k] * a) for k in range(3)]
                break
    return lut


LUT = build_lut()


@dataclass
class ViewRect:
    """频谱视图内部的时频矩形 (不含通道信息)。"""
    start_sample: int
    end_sample: int
    f0: float
    f1: float

    def to_selection(self, channels: tuple[int, ...]) -> Selection:
        return Selection(self.start_sample, self.end_sample,
                         self.f0, self.f1, channels)


# ---------------------------------------------------------------------------
# 频谱视图
# ---------------------------------------------------------------------------

class SpectrogramView(QWidget):
    selectionDragged = Signal(object)   # ViewRect | None
    seekRequested = Signal(float)
    message = Signal(str, str)

    MARGIN_L = 66
    MARGIN_R = 14
    MARGIN_T = 26
    MARGIN_B = 30
    MIN_DRAG_PX = 4

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setMinimumHeight(320)
        self.setMouseTracking(True)
        self._audio: np.ndarray | None = None
        self._sr = 0
        self._n_channels = 0
        self._channel = 0
        self._params = STFTParams()
        self._spec_db: np.ndarray | None = None
        self._spec_t: np.ndarray | None = None
        self._spec_f: np.ndarray | None = None
        self._image: QImage | None = None
        self._db_lo = -100.0
        self._db_hi = 0.0
        # 视口 (秒 / Hz)
        self._t_view: tuple[float, float] = (0.0, 1.0)
        self._f_view: tuple[float, float] = (0.0, 1.0)
        # 选区 (绝对单位)
        self._rect: ViewRect | None = None
        self._drag_anchor: QPoint | None = None
        self._drag_now: QPoint | None = None
        self._panning = False
        self._pan_anchor: QPoint | None = None
        self._pan_view = None
        self._playhead = -1.0

    # -------------------------------------------------------------- 数据
    def set_audio(self, audio: np.ndarray, sr: int, channel: int = 0) -> None:
        self._audio = audio
        self._sr = sr
        self._n_channels = 1 if audio.ndim == 1 else audio.shape[1]
        self._channel = max(0, min(channel, self._n_channels - 1))
        dur = audio.shape[0] / sr
        self._t_view = (0.0, dur)
        self._f_view = (0.0, sr / 2.0)
        self._rect = None
        self._playhead = -1.0
        self._recompute_spectrogram()
        self.update()

    def update_audio_keep_view(self, audio: np.ndarray,
                               keep_rect: bool = True,
                               sr: int | None = None) -> None:
        """数据变化 (预览/确认) 后重算频谱, 保留视口缩放、选区与播放头。"""
        if self._audio is None or not self._sr:
            if sr:
                self.set_audio(audio, sr, self._channel)
            return
        rect = self._rect if keep_rect else None
        playhead = self._playhead
        t_view, f_view = self._t_view, self._f_view
        channel = self._channel
        self._audio = audio
        self._n_channels = 1 if audio.ndim == 1 else audio.shape[1]
        self._channel = max(0, min(channel, self._n_channels - 1))
        self._recompute_spectrogram()
        self._t_view, self._f_view = t_view, f_view
        self._rect = rect
        self._playhead = playhead
        self.update()

    def set_channel(self, channel: int) -> None:
        if self._audio is None:
            return
        channel = max(0, min(channel, self._n_channels - 1))
        if channel == self._channel:
            return
        self._channel = channel
        self._recompute_spectrogram()
        self.update()

    @property
    def channel(self) -> int:
        return self._channel

    @property
    def n_channels(self) -> int:
        return self._n_channels

    def _current_channel_data(self) -> np.ndarray:
        if self._audio.ndim == 1:
            return self._audio
        return self._audio[:, self._channel]

    def _recompute_spectrogram(self) -> None:
        x = self._current_channel_data()
        with np.errstate(divide="ignore", invalid="ignore"):
            f, t, S = scipy_signal.spectrogram(
                x, fs=self._sr,
                nperseg=self._params.win_length,
                noverlap=self._params.n_overlap,
                nfft=self._params.n_fft,
                mode="magnitude",
            )
        eps = 1e-12
        Sdb = 20.0 * np.log10(S + eps)
        # 固定动态范围, 基于该通道 98 分位能量, 避免缩放时亮度跳变
        hi = float(np.percentile(Sdb, 99.5))
        lo = hi - 85.0
        self._db_lo, self._db_hi = lo, hi
        norm = np.clip((Sdb - lo) / (hi - lo), 0, 1)
        idx = (norm * 255).astype(np.uint8)
        rgb = LUT[idx]  # (n_f, n_t, 3)
        h, w = rgb.shape[:2]
        packed = np.ascontiguousarray(np.flipud(rgb))
        img = QImage(packed.data, w, h, 3 * w, QImage.Format_RGB888)
        self._image = img.copy()  # 脱离 numpy 缓冲
        self._spec_db = Sdb
        self._spec_t = t
        self._spec_f = f

    def set_rect(self, rect: ViewRect | None) -> None:
        self._rect = rect
        self.update()

    def selection_rect(self) -> ViewRect | None:
        return self._rect

    def set_playhead(self, t: float) -> None:
        self._playhead = t
        self.update()

    # -------------------------------------------------------------- 视口
    def plot_rect(self) -> QRectF:
        return QRectF(self.MARGIN_L, self.MARGIN_T,
                      max(self.width() - self.MARGIN_L - self.MARGIN_R, 10),
                      max(self.height() - self.MARGIN_T - self.MARGIN_B, 10))

    def time_to_x(self, t: float) -> float:
        r = self.plot_rect()
        t0, t1 = self._t_view
        return r.left() + (t - t0) / (t1 - t0) * r.width()

    def x_to_time(self, x: float) -> float:
        r = self.plot_rect()
        t0, t1 = self._t_view
        frac = (x - r.left()) / r.width()
        return t0 + np.clip(frac, 0.0, 1.0) * (t1 - t0)

    def freq_to_y(self, f: float) -> float:
        r = self.plot_rect()
        f0, f1 = self._f_view
        return r.bottom() - (f - f0) / (f1 - f0) * r.height()

    def y_to_freq(self, y: float) -> float:
        r = self.plot_rect()
        f0, f1 = self._f_view
        frac = (r.bottom() - y) / r.height()
        return f0 + np.clip(frac, 0.0, 1.0) * (f1 - f0)

    def zoom_time(self, factor: float, center_t: float | None = None) -> None:
        t0, t1 = self._t_view
        dur = self._audio.shape[0] / self._sr
        c = (t0 + t1) / 2 if center_t is None else center_t
        span = max((t1 - t0) * factor, 0.01)
        nt0 = max(0.0, c - span * (c - t0) / max(t1 - t0, 1e-12))
        nt1 = min(dur, nt0 + span)
        nt0 = max(0.0, nt1 - span)
        self._t_view = (nt0, nt1)
        self.update()

    def zoom_freq(self, factor: float, center_f: float | None = None) -> None:
        f0, f1 = self._f_view
        nyq = self._sr / 2.0
        c = (f0 + f1) / 2 if center_f is None else center_f
        span = max((f1 - f0) * factor, 20.0)
        nf0 = max(0.0, c - span * (c - f0) / max(f1 - f0, 1e-12))
        nf1 = min(nyq, nf0 + span)
        nf0 = max(0.0, nf1 - span)
        self._f_view = (nf0, nf1)
        self.update()

    def reset_view(self) -> None:
        dur = self._audio.shape[0] / self._sr
        self._t_view = (0.0, dur)
        self._f_view = (0.0, self._sr / 2.0)
        self.update()

    # -------------------------------------------------------------- 绘制
    def paintEvent(self, event):
        widget_rect = QWidget.rect(self)
        p = QPainter(self)
        try:
            p.fillRect(widget_rect, QColor(24, 24, 28))
            if self._image is None or not self._sr:
                p.setPen(QColor(200, 200, 200))
                p.drawText(widget_rect, Qt.AlignCenter,
                           "载入 WAV 后在此显示频谱")
                return
            r = self.plot_rect()
            self._draw_spectrogram(p, r)
            self._draw_axes(p, r)
            self._draw_selection(p, r)
            self._draw_playhead(p, r)
            self._draw_channel_tag(p, r)
        finally:
            p.end()

    def _draw_spectrogram(self, p: QPainter, r: QRectF) -> None:
        img = self._image
        iw, ih = img.width(), img.height()
        t0, t1 = self._t_view
        f0, f1 = self._f_view
        dur = self._audio.shape[0] / self._sr
        # 源图像坐标: 图像第 0 行对应最高频 (已 flipud), 列对应时间
        sx0 = t0 / dur * iw
        sx1 = t1 / dur * iw
        sy0 = (1 - f1 / (self._sr / 2.0)) * ih
        sy1 = (1 - f0 / (self._sr / 2.0)) * ih
        src = QRectF(sx0, sy0, max(sx1 - sx0, 1), max(sy1 - sy0, 1))
        p.setRenderHint(QPainter.SmoothPixmapTransform, True)
        p.drawImage(r, img, src)

    def _draw_axes(self, p: QPainter, r: QRectF) -> None:
        pen = QPen(QColor(90, 90, 96))
        pen.setWidth(1)
        p.setPen(pen)
        p.drawRect(r)
        p.setFont(QFont("", 9))
        # 时间刻度
        t0, t1 = self._t_view
        for t in nice_ticks(t0, t1):
            x = self.time_to_x(t)
            if not r.left() <= x <= r.right():
                continue
            p.setPen(QPen(QColor(70, 70, 76), 1, Qt.DotLine))
            p.drawLine(QPoint(int(x), int(r.top())),
                       QPoint(int(x), int(r.bottom())))
            p.setPen(QColor(180, 180, 185))
            label = f"{t:.3f}s" if (t1 - t0) < 2 else f"{t:.2f}s"
            p.drawText(QRectF(x - 45, r.bottom() + 4, 90, 20),
                       Qt.AlignCenter, label)
        # 频率刻度
        f0, f1 = self._f_view
        for f in nice_ticks(f0, f1):
            y = self.freq_to_y(f)
            if not r.top() <= y <= r.bottom():
                continue
            p.setPen(QPen(QColor(70, 70, 76), 1, Qt.DotLine))
            p.drawLine(QPoint(int(r.left()), int(y)),
                       QPoint(int(r.right()), int(y)))
            p.setPen(QColor(180, 180, 185))
            label = f"{f/1000:.2f}k" if f >= 1000 else f"{f:.0f}"
            p.drawText(QRectF(2, y - 9, self.MARGIN_L - 8, 18),
                       Qt.AlignRight | Qt.AlignVCenter, label)
        p.setPen(QColor(210, 210, 215))
        p.drawText(QRectF(r.left(), 2, r.width(), 18),
                   Qt.AlignLeft | Qt.AlignVCenter, "频率 Hz")
        p.drawText(QRectF(r.left(), r.bottom() + 10, r.width(), 18),
                   Qt.AlignRight | Qt.AlignVCenter, "时间 (秒)")

    def _draw_selection(self, p: QPainter, r: QRectF) -> None:
        rect = self._rect
        drag = self._drag_anchor is not None and self._drag_now is not None
        if drag:
            x0 = min(self._drag_anchor.x(), self._drag_now.x())
            x1 = max(self._drag_anchor.x(), self._drag_now.x())
            y0 = min(self._drag_anchor.y(), self._drag_now.y())
            y1 = max(self._drag_anchor.y(), self._drag_now.y())
            rect = QRectF(x0, y0, x1 - x0, y1 - y0)
        elif rect is not None:
            x0 = self.time_to_x(rect.start_sample / self._sr)
            x1 = self.time_to_x(rect.end_sample / self._sr)
            y0 = self.freq_to_y(rect.f1)
            y1 = self.freq_to_y(rect.f0)
            rect = QRectF(x0, y0, x1 - x0, y1 - y0)
        else:
            return
        fill = QColor(80, 170, 255, 45)
        p.fillRect(rect, fill)
        pen = QPen(QColor(110, 190, 255), 1, Qt.DashLine)
        p.setPen(pen)
        p.drawRect(rect)

    def _draw_playhead(self, p: QPainter, r: QRectF) -> None:
        if self._playhead < 0:
            return
        x = self.time_to_x(self._playhead)
        if not r.left() <= x <= r.right():
            return
        pen = QPen(QColor(255, 210, 90), 1.6)
        p.setPen(pen)
        p.drawLine(QPoint(int(x), int(r.top())),
                   QPoint(int(x), int(r.bottom())))

    def _draw_channel_tag(self, p: QPainter, r: QRectF) -> None:
        ch_name = "单声道" if self._n_channels == 1 else (
            "左声道 L" if self._channel == 0 else "右声道 R")
        p.setPen(QColor(230, 230, 235))
        p.fillRect(QRectF(r.left() + 6, r.top() + 4, 92, 18),
                   QColor(0, 0, 0, 150))
        p.drawText(QRectF(r.left() + 6, r.top() + 4, 92, 18),
                   Qt.AlignCenter, f"当前通道: {ch_name}")
        if self._rect is not None:
            rc = self._rect
            txt = (f"选区 {rc.start_sample/self._sr:.3f}–"
                   f"{rc.end_sample/self._sr:.3f}s | "
                   f"{rc.f0:.0f}–{rc.f1:.0f} Hz")
            p.fillRect(QRectF(r.left() + 104, r.top() + 4, 300, 18),
                       QColor(0, 0, 0, 150))
            p.drawText(QRectF(r.left() + 110, r.top() + 4, 290, 18),
                       Qt.AlignLeft | Qt.AlignVCenter, txt)

    # -------------------------------------------------------------- 鼠标
    def mousePressEvent(self, e):
        if self._image is None:
            return
        if e.button() == Qt.LeftButton:
            self._drag_anchor = e.position().toPoint()
            self._drag_now = e.position().toPoint()
        elif e.button() == Qt.RightButton:
            self._panning = True
            self._pan_anchor = e.position().toPoint()
            self._pan_view = (self._t_view, self._f_view)
            self.setCursor(Qt.ClosedHandCursor)

    def mouseMoveEvent(self, e):
        if self._drag_anchor is not None:
            self._drag_now = e.position().toPoint()
            self.update()
        elif self._panning and self._pan_anchor is not None:
            r = self.plot_rect()
            dx = e.position().x() - self._pan_anchor.x()
            dy = e.position().y() - self._pan_anchor.y()
            (t0, t1), (f0, f1) = self._pan_view
            dt = -dx / r.width() * (t1 - t0)
            df = dy / r.height() * (f1 - f0)
            dur = self._audio.shape[0] / self._sr
            tspan, fspan = t1 - t0, f1 - f0
            nt0 = np.clip(t0 + dt, 0, dur - tspan)
            nf0 = np.clip(f0 + df, 0, self._sr / 2.0 - fspan)
            self._t_view = (nt0, nt0 + tspan)
            self._f_view = (nf0, nf0 + fspan)
            self.update()

    def mouseReleaseEvent(self, e):
        if e.button() == Qt.LeftButton and self._drag_anchor is not None:
            a, b = self._drag_anchor, self._drag_now
            self._drag_anchor = self._drag_now = None
            if a is None or b is None:
                return
            if (abs(b.x() - a.x()) < self.MIN_DRAG_PX
                    or abs(b.y() - a.y()) < self.MIN_DRAG_PX):
                # 空选区: 清除并给出明确反馈, 不保留残留框
                self._rect = None
                self.selectionDragged.emit(None)
                self.message.emit(
                    "warn", "选区为空: 请按住左键拖出一个时间×频率矩形。")
                self.update()
                return
            r = self.plot_rect()
            xa = np.clip([a.x(), b.x()], r.left(), r.right())
            ya = np.clip([a.y(), b.y()], r.top(), r.bottom())
            t0 = self.x_to_time(min(xa))
            t1 = self.x_to_time(max(xa))
            f0 = self.y_to_freq(max(ya))
            f1 = self.y_to_freq(min(ya))
            n = self._audio.shape[0]
            self._rect = ViewRect(
                int(round(t0 * self._sr)),
                int(round(t1 * self._sr)),
                float(max(f0, 0.0)),
                float(min(f1, self._sr / 2.0)),
            )
            if self._rect.end_sample > n or self._rect.start_sample < 0:
                self.message.emit("warn", "选区越界, 已限制在音频范围内。")
            self.selectionDragged.emit(self._rect)
            self.update()
        elif e.button() == Qt.RightButton:
            self._panning = False
            self._pan_anchor = None
            self.unsetCursor()

    def mouseDoubleClickEvent(self, e):
        if self._image is None or e.button() != Qt.LeftButton:
            return
        r = self.plot_rect()
        if r.contains(e.position()):
            self.seekRequested.emit(self.x_to_time(e.position().x()))

    def wheelEvent(self, e):
        if self._image is None:
            return
        factor = 1.25 if e.angleDelta().y() < 0 else 1 / 1.25
        pos = e.position()
        if e.modifiers() & Qt.ShiftModifier:
            self.zoom_freq(factor, self.y_to_freq(pos.y()))
        else:
            self.zoom_time(factor, self.x_to_time(pos.x()))


# ---------------------------------------------------------------------------
# 波形概览
# ---------------------------------------------------------------------------

class WaveformView(QWidget):
    seekRequested = Signal(float)

    MARGIN_L = 66
    MARGIN_R = 14
    MARGIN_T = 8
    MARGIN_B = 22

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setMinimumHeight(110)
        self._audio: np.ndarray | None = None
        self._sr = 0
        self._playhead = -1.0
        self._sel_range: tuple[int, int] | None = None
        self._peaks: np.ndarray | None = None

    def set_audio(self, audio: np.ndarray, sr: int) -> None:
        self._audio = audio
        self._sr = sr
        self._playhead = -1.0
        self._sel_range = None
        self._peaks = None
        self._rebuild_peaks(audio)
        self.update()

    def update_audio_keep_marks(self, audio: np.ndarray,
                                sr: int | None = None) -> None:
        if self._audio is None or not self._sr:
            if sr:
                self.set_audio(audio, sr)
            return
        playhead = self._playhead
        sel = self._sel_range
        self._audio = audio
        self._rebuild_peaks(audio)
        self._playhead = playhead
        self._sel_range = sel
        self.update()

    def _rebuild_peaks(self, audio: np.ndarray) -> None:
        # 降采样峰值包络, 控制绘制量
        mono = audio if audio.ndim == 1 else audio.mean(axis=1)
        target = 1600
        step = max(1, mono.shape[0] // target)
        trim = mono.shape[0] - mono.shape[0] % step
        blocks = mono[:trim].reshape(-1, step)
        self._peaks = np.concatenate(
            [blocks.min(axis=1), blocks.max(axis=1)])

    def set_playhead(self, t: float) -> None:
        self._playhead = t
        self.update()

    def set_selection_range(self, s0: int | None, s1: int | None) -> None:
        if s0 is None or s1 is None:
            self._sel_range = None
        else:
            self._sel_range = (s0, s1)
        self.update()

    def plot_rect(self) -> QRectF:
        return QRectF(self.MARGIN_L, self.MARGIN_T,
                      max(self.width() - self.MARGIN_L - self.MARGIN_R, 10),
                      max(self.height() - self.MARGIN_T - self.MARGIN_B, 10))

    def time_to_x(self, t: float) -> float:
        r = self.plot_rect()
        dur = self._audio.shape[0] / self._sr
        return r.left() + t / dur * r.width()

    def paintEvent(self, event):
        widget_rect = QWidget.rect(self)
        p = QPainter(self)
        try:
            p.fillRect(widget_rect, QColor(24, 24, 28))
            if self._audio is None or not self._sr:
                p.setPen(QColor(200, 200, 200))
                p.drawText(widget_rect, Qt.AlignCenter, "波形概览")
                return
            r = self.plot_rect()
            n = self._audio.shape[0]
            if self._sel_range is not None:
                x0 = self.time_to_x(self._sel_range[0] / self._sr)
                x1 = self.time_to_x(self._sel_range[1] / self._sr)
                p.fillRect(QRectF(x0, r.top(), x1 - x0, r.height()),
                           QColor(80, 170, 255, 35))
            step = max(1, n // 1600)
            nblocks = n // step
            mono = (self._audio if self._audio.ndim == 1
                    else self._audio.mean(axis=1))
            trim = nblocks * step
            blocks = mono[:trim].reshape(nblocks, step)
            mins = blocks.min(axis=1)
            maxs = blocks.max(axis=1)
            mid = r.center().y()
            half = r.height() / 2
            poly = QPolygonF()
            xs = np.linspace(r.left(), r.right(), nblocks)
            for x, v in zip(xs, maxs):
                poly.append(QPoint(int(x), int(mid - v * half)))
            for x, v in zip(xs[::-1], mins[::-1]):
                poly.append(QPoint(int(x), int(mid - v * half)))
            p.setPen(Qt.NoPen)
            p.setBrush(QColor(120, 200, 140))
            p.drawPolygon(poly)
            p.setPen(QPen(QColor(90, 90, 96)))
            p.drawRect(r)
            # 时间刻度
            p.setFont(QFont("", 9))
            dur = n / self._sr
            for t in nice_ticks(0, dur, max_ticks=10):
                x = self.time_to_x(t)
                p.setPen(QPen(QColor(70, 70, 76), 1, Qt.DotLine))
                p.drawLine(QPoint(int(x), int(r.top())),
                           QPoint(int(x), int(r.bottom())))
                p.setPen(QColor(180, 180, 185))
                p.drawText(QRectF(x - 45, r.bottom() + 2, 90, 18),
                           Qt.AlignCenter, f"{t:.2f}s")
            if self._playhead >= 0:
                x = self.time_to_x(self._playhead)
                p.setPen(QPen(QColor(255, 210, 90), 1.6))
                p.drawLine(QPoint(int(x), int(r.top())),
                           QPoint(int(x), int(r.bottom())))
        finally:
            p.end()

    def mousePressEvent(self, e):
        if self._audio is None or e.button() != Qt.LeftButton:
            return
        r = self.plot_rect()
        if not r.contains(e.position()):
            return
        dur = self._audio.shape[0] / self._sr
        frac = (e.position().x() - r.left()) / r.width()
        self.seekRequested.emit(float(np.clip(frac, 0, 1) * dur))
