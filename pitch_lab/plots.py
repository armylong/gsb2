"""波形 / 音高 / 音分三个联动绘图控件。

共同约定：
- 共享同一时间轴（ViewState），缩放、平移、光标、圈选三图同步；
- 音高曲线遇到 NaN（不可靠帧）按连续段分别绘制，视觉上留缺口，
  不会把无声/噪声段两端悄悄连起来；
- 频率轴为对数轴，音名标签随 A4 与升降号设置刷新，Hz 读数不变。
"""

from __future__ import annotations

import math

import numpy as np
from PySide6.QtCore import Qt, QPoint, Signal
from PySide6.QtGui import QColor, QFont, QPainter, QPen, QPolygonF
from PySide6.QtWidgets import QWidget

from . import notes
from .analysis import AnalysisResult
from .signals import ReferenceSegment
from .state import ViewState

COLOR_RELIABLE = QColor("#2563eb")
COLOR_UNCERTAIN = QColor("#d97706")
COLOR_GAP = QColor(148, 163, 184, 60)
COLOR_CURSOR = QColor("#111827")
COLOR_SELECT = QColor(37, 99, 235, 38)
COLOR_REF = QColor(16, 122, 87, 90)
COLOR_REF_LINE = QColor("#059669")
COLOR_GRID = QColor(226, 232, 240)
COLOR_TEXT = QColor(71, 85, 105)


def draw_gapped_lines(p: QPainter, xs: np.ndarray, ys: np.ndarray) -> None:
    """按 NaN 分段画折线，缺口处不连线。"""
    finite = np.isfinite(ys)
    i = 0
    n = len(ys)
    while i < n:
        if not finite[i]:
            i += 1
            continue
        j = i
        poly = QPolygonF()
        while j < n and finite[j]:
            poly.append(QPoint(int(round(xs[j])), int(round(ys[j]))))
            j += 1
        if poly.size() > 1:
            p.drawPolyline(poly)
        elif poly.size() == 1:
            p.drawPoint(poly[0])
        i = j


class BasePlot(QWidget):
    """时间轴、坐标映射与鼠标交互的公共实现。"""

    cursorPicked = Signal(float)
    selectionPicked = Signal(float, float)
    viewZoomed = Signal(float, float)   # factor, center time
    viewPanned = Signal(float)
    viewReset = Signal()

    MARGIN_L = 58
    MARGIN_R = 14
    MARGIN_T = 24
    MARGIN_B = 22

    def __init__(self, state: ViewState, parent=None):
        super().__init__(parent)
        self.state = state
        self.setMinimumHeight(140)
        self.setMouseTracking(True)
        self._press_pos: QPoint | None = None
        self._press_t: float | None = None
        self._drag_t: float | None = None
        self._panning = False
        self._pan_anchor_x: int | None = None
        state.viewChanged.connect(self.update)
        state.cursorChanged.connect(lambda _t: self.update())
        state.selectionChanged.connect(lambda *_a: self.update())

    # ---- 坐标映射 ----
    def plot_rect(self):
        return (self.MARGIN_L, self.MARGIN_T,
                self.width() - self.MARGIN_L - self.MARGIN_R,
                self.height() - self.MARGIN_T - self.MARGIN_B)

    def t_to_x(self, t: float) -> float:
        x0, _y0, w, _h = self.plot_rect()
        t0, t1 = self.state.view
        return x0 + (t - t0) / (t1 - t0) * w

    def x_to_t(self, x: float) -> float:
        x0, _y0, w, _h = self.plot_rect()
        t0, t1 = self.state.view
        return t0 + (x - x0) / w * (t1 - t0)

    def in_plot(self, pos: QPoint) -> bool:
        x0, y0, w, h = self.plot_rect()
        return x0 <= pos.x() <= x0 + w and y0 <= pos.y() <= y0 + h

    # ---- 交互 ----
    def mousePressEvent(self, ev):
        if not self.in_plot(ev.position().toPoint()):
            return
        t = self.x_to_t(ev.position().x())
        if ev.modifiers() & Qt.KeyboardModifier.ShiftModifier:
            self._panning = True
            self._pan_anchor_x = ev.position().x()
            self.setCursor(Qt.CursorShape.ClosedHandCursor)
            return
        self._press_pos = ev.position().toPoint()
        self._press_t = t
        self._drag_t = t
        self.state.set_cursor(t)
        self.cursorPicked.emit(t)

    def mouseMoveEvent(self, ev):
        if self._panning and self._pan_anchor_x is not None:
            _x0, _y0, w, _h = self.plot_rect()
            dx = self._pan_anchor_x - ev.position().x()
            self._pan_anchor_x = ev.position().x()
            self.viewPanned.emit(dx / max(w, 1))
            return
        if self._press_t is not None and self.in_plot(ev.position().toPoint()):
            self._drag_t = self.x_to_t(ev.position().x())
            self.update()

    def mouseReleaseEvent(self, ev):
        if self._panning:
            self._panning = False
            self._pan_anchor_x = None
            self.setCursor(Qt.CursorShape.ArrowCursor)
            return
        if self._press_t is not None:
            t_end = self.x_to_t(ev.position().x()) if self.in_plot(
                ev.position().toPoint()) else self._drag_t
            if t_end is not None and abs(t_end - self._press_t) > 0.008:
                self.selectionPicked.emit(self._press_t, t_end)
            self._press_t = None
            self._drag_t = None
            self.update()

    def wheelEvent(self, ev):
        factor = 1.0 / 1.2 if ev.angleDelta().y() > 0 else 1.2
        center = self.x_to_t(ev.position().x()) if self.in_plot(
            ev.position().toPoint()) else None
        self.viewZoomed.emit(factor, center if center is not None else 0.0)

    def mouseDoubleClickEvent(self, ev):
        self.viewReset.emit()

    # ---- 公共装饰 ----
    def draw_frame(self, p: QPainter) -> tuple[int, int, int, int]:
        x0, y0, w, h = self.plot_rect()
        p.fillRect(x0, y0, w, h, QColor("#ffffff"))
        pen = QPen(COLOR_GRID)
        p.setPen(pen)
        p.drawRect(x0, y0, w, h)
        self._draw_time_grid(p, x0, y0, w, h)
        return x0, y0, w, h

    def _draw_time_grid(self, p, x0, y0, w, h):
        t0, t1 = self.state.view
        span = t1 - t0
        raw_step = span / 8.0
        mag = 10 ** math.floor(math.log10(max(raw_step, 1e-9)))
        for step in (0.1, 0.2, 0.5, 1, 2, 5, 10):
            if step * mag <= raw_step * 1.5:
                grid = step * mag
            else:
                break
        grid = max(grid, 1e-3)
        p.setFont(QFont("", 8))
        k = math.ceil(t0 / grid)
        pen = QPen(COLOR_GRID, 1, Qt.PenStyle.DotLine)
        p.setPen(pen)
        while k * grid <= t1:
            t = k * grid
            x = self.t_to_x(t)
            p.drawLine(int(x), y0, int(x), y0 + h)
            p.setPen(COLOR_TEXT)
            p.drawText(int(x) + 2, y0 + h + 13, f"{t:.3g}s")
            p.setPen(pen)
            k += 1

    def draw_overlay(self, p: QPainter) -> None:
        x0, y0, w, h = self.plot_rect()
        if self.state.selection is not None:
            a, b = self.state.selection
            xa, xb = self.t_to_x(a), self.t_to_x(b)
            p.fillRect(int(min(xa, xb)), y0, int(abs(xb - xa)), h, COLOR_SELECT)
        if self.state.cursor is not None:
            x = self.t_to_x(self.state.cursor)
            if x0 <= x <= x0 + w:
                p.setPen(QPen(COLOR_CURSOR, 1.4))
                p.drawLine(int(x), y0, int(x), y0 + h)
        if self._press_t is not None and self._drag_t is not None:
            xa, xb = self.t_to_x(self._press_t), self.t_to_x(self._drag_t)
            p.setPen(QPen(COLOR_RELIABLE, 1, Qt.PenStyle.DashLine))
            p.drawRect(int(min(xa, xb)), y0, int(abs(xb - xa)), h)


class WaveformPlot(BasePlot):
    def __init__(self, state: ViewState, parent=None):
        super().__init__(state, parent)
        self.x: np.ndarray | None = None
        self.fs = 0

    def set_data(self, x: np.ndarray, fs: int) -> None:
        self.x, self.fs = x, fs
        self.update()

    def paintEvent(self, _ev):
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing, False)
        x0, y0, w, h = self.draw_frame(p)
        p.setPen(QPen(COLOR_TEXT))
        p.drawText(6, y0 + 12, "波形")
        if self.x is None:
            self.draw_overlay(p)
            return
        t0, t1 = self.state.view
        i0 = max(0, int(t0 * self.fs) - 2)
        i1 = min(self.x.size, int(t1 * self.fs) + 2)
        seg = self.x[i0:i1]
        if seg.size < 2:
            self.draw_overlay(p)
            return
        mid = y0 + h / 2
        p.setPen(QPen(QColor(30, 41, 59, 180), 1))
        p.drawLine(x0, int(mid), x0 + w, int(mid))
        # 每像素列取 min/max，缩放时仍能看到峰
        cols = max(w, 1)
        bounds = np.linspace(0, seg.size, cols + 1).astype(int)
        pen = QPen(QColor("#334155"))
        p.setPen(pen)
        for c in range(cols):
            a, b = bounds[c], bounds[c + 1]
            if b <= a:
                continue
            chunk = seg[a:b]
            ymax = mid - float(np.max(chunk)) * (h / 2 - 2)
            ymin = mid - float(np.min(chunk)) * (h / 2 - 2)
            xx = x0 + c
            p.drawLine(xx, int(ymax), xx, int(ymin))
        self.draw_overlay(p)


class PitchPlot(BasePlot):
    def __init__(self, state: ViewState, parent=None):
        super().__init__(state, parent)
        self.setMinimumHeight(260)
        self.result: AnalysisResult | None = None
        self.references: list[ReferenceSegment] = []
        self.a4 = 440.0
        self.prefer_flat = False

    def set_analysis(self, result: AnalysisResult,
                     references: list[ReferenceSegment]) -> None:
        self.result = result
        self.references = references
        self.update()

    def set_naming(self, a4: float, prefer_flat: bool) -> None:
        self.a4, self.prefer_flat = a4, prefer_flat
        self.update()

    def _ylim(self) -> tuple[float, float]:
        if self.result is not None:
            lo = self.result.params.fmin / 1.5
            hi = self.result.params.fmax * 1.5
        else:
            lo, hi = 40.0, 2000.0
        return lo, hi

    def f_to_y(self, f: float) -> float:
        lo, hi = self._ylim()
        _x0, y0, _w, h = self.plot_rect()
        return y0 + h * (1.0 - (math.log(f) - math.log(lo))
                         / (math.log(hi) - math.log(lo)))

    def paintEvent(self, _ev):
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        x0, y0, w, h = self.draw_frame(p)
        p.setPen(COLOR_TEXT)
        p.drawText(6, y0 - 4, "估计音高 (Hz，对数轴)")
        if self.result is None:
            self.draw_overlay(p)
            return

        lo, hi = self._ylim()
        # 半音网格 + 音名标签（A4 只影响这里的标签），按像素间距抽稀
        m_lo = int(math.floor(notes.freq_to_midi(lo, self.a4)))
        m_hi = int(math.ceil(notes.freq_to_midi(hi, self.a4)))
        p.setFont(QFont("", 8))
        last_label_y = -1e9
        for m in range(m_lo, m_hi + 1):
            f = notes.midi_to_freq(m, self.a4)
            if not (lo <= f <= hi):
                continue
            y = self.f_to_y(f)
            is_a = m % 12 == 9
            pen = QPen(QColor(203, 213, 225) if not is_a else QColor(148, 163, 184),
                       1, Qt.PenStyle.DotLine)
            p.setPen(pen)
            p.drawLine(x0, int(y), x0 + w, int(y))
            if y - last_label_y >= 15:  # 标签至少间隔 15px，避免重叠
                p.setPen(COLOR_TEXT)
                p.drawText(4, int(y) + 3, notes.midi_to_note_name(m, self.prefer_flat))
                last_label_y = y

        # 分析音域边界
        for f in (self.result.params.fmin, self.result.params.fmax):
            y = self.f_to_y(f)
            p.setPen(QPen(QColor("#dc2626"), 1, Qt.PenStyle.DashLine))
            p.drawLine(x0, int(y), x0 + w, int(y))
        p.setPen(QPen(QColor("#dc2626")))
        p.setFont(QFont("", 8))
        p.drawText(x0 + 6, y0 + 12,
                   f"分析音域 {self.result.params.fmin:g}–{self.result.params.fmax:g} Hz"
                   "（红虚线）")

        self._draw_references(p)
        self._draw_curve(p)
        self.draw_overlay(p)

    def _draw_references(self, p: QPainter) -> None:
        for r in self.references:
            xa, xb = self.t_to_x(r.t0), self.t_to_x(r.t1)
            _x0, y0, _w, h = self.plot_rect()
            if r.kind == "gap":
                p.fillRect(int(xa), y0, int(xb - xa), h, COLOR_GAP)
                p.setPen(COLOR_TEXT)
                p.drawText(int(xa) + 3, y0 + 14, r.note)
                continue
            p.fillRect(int(xa), y0, int(xb - xa), h, QColor(16, 122, 87, 28))
            if r.kind == "steady":
                y = self.f_to_y(r.f0)
                p.setPen(QPen(COLOR_REF_LINE, 1.5, Qt.PenStyle.DashLine))
                p.drawLine(int(xa), int(y), int(xb), int(y))
            else:  # gliss 参考真值曲线
                ts = np.linspace(r.t0, r.t1, 120)
                fs = r.f0 * (r.f1 / r.f0) ** ((ts - r.t0) / (r.t1 - r.t0))
                xs = np.array([self.t_to_x(t) for t in ts])
                ys = np.array([self.f_to_y(f) for f in fs])
                p.setPen(QPen(COLOR_REF_LINE, 1.5, Qt.PenStyle.DashLine))
                draw_gapped_lines(p, xs, ys)
            p.setPen(COLOR_REF_LINE)
            p.drawText(int(xa) + 3, y0 + h - 6, r.describe())

    def _draw_curve(self, p: QPainter) -> None:
        r = self.result
        t0, t1 = self.state.view
        sel = (r.times >= t0) & (r.times <= t1)
        idx = np.where(sel)[0]
        if idx.size == 0:
            return
        xs = np.array([self.t_to_x(t) for t in r.times[idx]])
        # 可靠帧：f0（NaN 自动留缺口）
        ys = np.full(idx.size, np.nan)
        for k, i in enumerate(idx):
            if r.reliable[i]:
                ys[k] = self.f_to_y(r.f0[i])
        p.setPen(QPen(COLOR_RELIABLE, 2.0))
        draw_gapped_lines(p, xs, ys)
        # 不确定帧：单独画点，不与可靠曲线相连
        ux, uy = [], []
        for k, i in enumerate(idx):
            if r.uncertain[i] and np.isfinite(r.f0_est[i]):
                f = r.f0_est[i]
                lo, hi = self._ylim()
                f = min(max(f, lo * 1.02), hi * 0.98)
                ux.append(xs[k])
                uy.append(self.f_to_y(f))
        if ux:
            p.setPen(Qt.PenStyle.NoPen)
            p.setBrush(COLOR_UNCERTAIN)
            for x, y in zip(ux, uy):
                p.drawEllipse(QPoint(int(x), int(y)), 2.6, 2.6)


class CentsPlot(BasePlot):
    def __init__(self, state: ViewState, parent=None):
        super().__init__(state, parent)
        self.result: AnalysisResult | None = None
        self.a4 = 440.0

    def set_analysis(self, result: AnalysisResult) -> None:
        self.result = result
        self.update()

    def set_a4(self, a4: float) -> None:
        self.a4 = a4
        self.update()

    def paintEvent(self, _ev):
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        x0, y0, w, h = self.draw_frame(p)
        p.setPen(COLOR_TEXT)
        p.drawText(6, y0 - 4, "相对最近半音的音分偏差 (cent)")
        if self.result is None:
            self.draw_overlay(p)
            return

        def c_to_y(c: float) -> float:
            return y0 + h * (1.0 - (c + 50.0) / 100.0)

        for c in (-50, -25, 0, 25, 50):
            y = c_to_y(c)
            p.setPen(QPen(COLOR_GRID if c else QColor(148, 163, 184),
                          1, Qt.PenStyle.DotLine))
            p.drawLine(x0, int(y), x0 + w, int(y))
            p.setPen(COLOR_TEXT)
            p.drawText(8, int(y) - 2, f"{c:+d}")

        r = self.result
        t0, t1 = self.state.view
        idx = np.where((r.times >= t0) & (r.times <= t1))[0]
        if idx.size:
            xs = np.array([self.t_to_x(t) for t in r.times[idx]])
            ys = np.full(idx.size, np.nan)
            for k, i in enumerate(idx):
                f = r.f0[i] if r.reliable[i] else np.nan
                if np.isfinite(f):
                    ys[k] = c_to_y(float(notes.cents_from_nearest(f, self.a4)))
            p.setPen(QPen(COLOR_RELIABLE, 1.8))
            draw_gapped_lines(p, xs, ys)
            p.setPen(Qt.PenStyle.NoPen)
            p.setBrush(COLOR_UNCERTAIN)
            for k, i in enumerate(idx):
                if r.uncertain[i] and np.isfinite(r.f0_est[i]):
                    c = float(notes.cents_from_nearest(r.f0_est[i], self.a4))
                    p.drawEllipse(QPoint(int(xs[k]), int(c_to_y(c))), 2.6, 2.6)
        self.draw_overlay(p)
