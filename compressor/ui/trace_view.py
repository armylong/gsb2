"""统一时间轴的四个绘图视图（纯 QPainter 绘制，数据来自当前处理结果）。"""

from __future__ import annotations

import numpy as np
from PySide6.QtCore import Qt, Signal
from PySide6.QtGui import QColor, QFont, QPainter, QPen
from PySide6.QtWidgets import QWidget

from .axis_model import TimeAxisModel

COLOR_L = QColor("#4aa3ff")
COLOR_R = QColor("#ff9f43")
COLOR_ENV = QColor("#2ecc71")
COLOR_DET = QColor(120, 120, 120, 130)
COLOR_GR = QColor("#e74c3c")
COLOR_THRESH = QColor("#f1c40f")
COLOR_CURSOR = QColor("#ecf0f1")
COLOR_SELECT = QColor(255, 255, 255, 38)
COLOR_GRID = QColor(70, 74, 82)
COLOR_BG = QColor(24, 26, 30)

MODE_WAVE = "wave"
MODE_ENVELOPE = "envelope"
MODE_GR = "gr"


class TraceView(QWidget):
    """单条轨迹视图。mode 决定纵坐标口径与数据源。"""

    cursorClicked = Signal(float)
    selectionMade = Signal(object)  # (t0, t1) 或 None

    def __init__(self, axis: TimeAxisModel, mode: str, title: str,
                 parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.axis = axis
        self.mode = mode
        self.title = title
        self.setMinimumHeight(140)
        self.setMouseTracking(True)
        self.setAutoFillBackground(True)
        pal = self.palette()
        pal.setColor(self.backgroundRole(), COLOR_BG)
        self.setPalette(pal)

        self.fs = 48000
        self._wave: np.ndarray | None = None       # (n,) 或 (n,2)
        self._det: np.ndarray | None = None
        self._env: np.ndarray | None = None
        self._gr: np.ndarray | None = None
        self._threshold_db: float | None = None
        self._gen = -1
        self._cache_key: tuple | None = None
        self._cache: dict = {}
        self._drag_start: float | None = None

        axis.rangeChanged.connect(lambda *_: self.update())
        axis.selectionChanged.connect(lambda *_: self.update())
        axis.cursorChanged.connect(lambda *_: self.update())

    # ---- 数据 ----
    def set_data(self, result, gen: int) -> None:
        self.fs = result.fs
        self._wave = result.input if self.mode == MODE_WAVE else result.output
        self._det = result.detected_db
        self._env = result.envelope_db
        self._gr = result.gain_reduction_db
        self._threshold_db = result.params.threshold_db
        self._gen = gen
        self._cache_key = None
        self.update()

    # ---- 坐标换算 ----
    def _margins(self) -> tuple[int, int, int, int]:
        return 56, 8, 8, 22  # left, right, top, bottom
    def _time_to_x(self, t: float) -> float:
        l, r, _, _ = self._margins()
        t0, t1 = self.axis.view_range()
        return float(l + (t - t0) / max(t1 - t0, 1e-12)
                     * (self.width() - l - r))

    def _x_to_time(self, x: float) -> float:
        l, r, _, _ = self._margins()
        t0, t1 = self.axis.view_range()
        return float(t0 + (x - l) / max(self.width() - l - r, 1)
                     * (t1 - t0))

    def _y_limits(self) -> tuple[float, float]:
        """统一返回升序 (lo, hi)。GR 视图通过 _gr_zero_top 翻转纵轴。"""
        if self.mode == MODE_WAVE:
            return -1.0, 1.0
        if self.mode == MODE_ENVELOPE:
            return -60.0, 0.0
        # gain reduction：数值范围 0..top，绘制时 0 在顶部（翻转）
        top = 6.0
        if self._gr is not None and self._gr.size:
            top = max(6.0, float(np.nanmax(self._gr)) * 1.15)
        return 0.0, float(top)

    def _gr_zero_top(self) -> bool:
        return self.mode == MODE_GR

    def _val_to_y(self, v: float, lo: float, hi: float) -> float:
        _, _, top, bottom = self._margins()
        h = self.height() - top - bottom
        if self._gr_zero_top():
            # GR: v=0 在顶部，v 越大越靠下
            return float(top + (v - lo) / max(hi - lo, 1e-12) * h)
        return float(top + (hi - v) / max(hi - lo, 1e-12) * h)

    # ---- 绘制 ----
    def paintEvent(self, event) -> None:  # noqa: ARG002, N802
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing)
        p.fillRect(self.rect(), COLOR_BG)
        l, r, top, bottom = self._margins()
        plot_w = self.width() - l - r
        t0, t1 = self.axis.view_range()
        lo, hi = self._y_limits()

        self._draw_grid(p, l, r, top, bottom, lo, hi)
        p.setClipRect(l, top, plot_w, self.height() - top - bottom)

        # 选择区间
        sel = self.axis.selection()
        if sel:
            x0 = self._time_to_x(sel[0])
            x1 = self._time_to_x(sel[1])
            p.fillRect(int(x0), top, int(x1 - x0),
                       self.height() - top - bottom, COLOR_SELECT)

        if self.mode == MODE_WAVE:
            self._draw_wave(p, l, plot_w, t0, t1, lo, hi)
        elif self.mode == MODE_ENVELOPE:
            self._draw_envelope(p, l, plot_w, t0, t1, lo, hi)
        else:
            self._draw_gr(p, l, plot_w, t0, t1, lo, hi)

        p.setClipping(False)

        # 阈值线（仅包络视图）
        if self.mode == MODE_ENVELOPE and self._threshold_db is not None:
            if lo <= self._threshold_db <= hi:
                y = self._val_to_y(self._threshold_db, lo, hi)
                pen = QPen(COLOR_THRESH, 1, Qt.DashLine)
                p.setPen(pen)
                p.drawLine(l, int(y), l + plot_w, int(y))
                p.setPen(COLOR_THRESH)
                p.drawText(l + 4, int(y) - 2,
                           f"阈值 {self._threshold_db:.1f} dBFS")

        # 光标
        cur = self.axis.cursor()
        if cur is not None and t0 <= cur <= t1:
            x = int(self._time_to_x(cur))
            p.setPen(QPen(COLOR_CURSOR, 1))
            p.drawLine(x, top, x, self.height() - bottom)

        self._draw_title_and_ticks(p, l, r, top, bottom, lo, hi, t0, t1)
        p.end()

    def _draw_grid(self, p: QPainter, l: int, r: int, top: int,
                   bottom: int, lo: float, hi: float) -> None:
        p.setPen(QPen(COLOR_GRID, 1))
        if self.mode == MODE_WAVE:
            vals = [-1.0, -0.5, 0.0, 0.5, 1.0]
        elif self.mode == MODE_ENVELOPE:
            vals = [0, -12, -24, -36, -48, -60]
        else:
            vals = list(np.linspace(lo, hi, 5))
        for v in vals:
            y = int(self._val_to_y(v, lo, hi))
            p.drawLine(l, y, self.width() - r, y)
            p.setPen(QColor(150, 154, 160))
            p.drawText(4, y + 4, self._format_v(v))
            p.setPen(QPen(COLOR_GRID, 1))

    def _format_v(self, v: float) -> str:
        if self.mode == MODE_WAVE:
            return f"{v:g}"
        if self.mode == MODE_ENVELOPE:
            return f"{v:g} dB"
        return f"{v:.1f}"

    def _draw_title_and_ticks(self, p: QPainter, l: int, r: int, top: int,
                              bottom: int, lo: float, hi: float,
                              t0: float, t1: float) -> None:
        p.setPen(QColor(220, 224, 230))
        p.setFont(QFont("", 10, QFont.Bold))
        p.drawText(l, 14, self.title)
        p.setFont(QFont("", 9))
        n_ticks = 8
        for i in range(n_ticks + 1):
            t = t0 + (t1 - t0) * i / n_ticks
            x = int(self._time_to_x(t))
            p.setPen(QPen(COLOR_GRID, 1))
            p.drawLine(x, self.height() - bottom,
                       x, self.height() - bottom + 4)
            p.setPen(QColor(150, 154, 160))
            p.drawText(x - 22, self.height() - 6, f"{t:.2f}s")

    # ---- 各模式数据聚合（按像素列 min/max）----
    def _column_bounds(self, sig: np.ndarray, l: int, plot_w: int,
                       t0: float, t1: float) -> np.ndarray:
        key = (id(sig), self._gen, l, plot_w, round(t0, 6), round(t1, 6),
               self.fs)
        if self._cache_key != key:
            n = sig.shape[0]
            i0 = max(0, int(np.floor(t0 * self.fs)))
            i1 = min(n, int(np.ceil(t1 * self.fs)) + 1)
            cols = max(plot_w, 1)
            idx = np.arange(i0, i1)
            bounds = np.full((cols, 2), np.nan)
            if idx.size:
                col = np.clip(
                    ((idx / self.fs - t0) / max(t1 - t0, 1e-12) * cols)
                    .astype(int), 0, cols - 1)
                seg = sig[i0:i1]
                # col 单调非递减：用 unique 边界 + reduceat 向量化聚合
                uniq, first = np.unique(col, return_index=True)
                mins = np.minimum.reduceat(seg, first)
                maxs = np.maximum.reduceat(seg, first)
                bounds[uniq, 0] = mins
                bounds[uniq, 1] = maxs
            self._cache = {"bounds": bounds}
            self._cache_key = key
        return self._cache["bounds"]

    def _polyline(self, painter: QPainter, xs: np.ndarray, ys: np.ndarray,
                  color: QColor, width: int = 1) -> None:
        pen = QPen(QColor(color), int(width))
        pen.setCosmetic(True)
        painter.setPen(pen)
        finite = np.isfinite(ys)
        run = False
        px = py = 0
        for x, y, ok in zip(xs, ys, finite):
            if ok:
                ix, iy = int(x), int(y)
                if run:
                    painter.drawLine(px, py, ix, iy)
                px, py, run = ix, iy, True
            else:
                run = False

    def _draw_wave(self, p: QPainter, l: int, plot_w: int, t0: float,
                   t1: float, lo: float, hi: float) -> None:
        if self._wave is None:
            return
        cols = max(plot_w, 1)
        xs = l + np.arange(cols) + 0.5
        if self._wave.ndim == 1:
            b = self._column_bounds(self._wave, l, plot_w, t0, t1)
            self._draw_minmax(p, xs, b, COLOR_L, lo, hi)
        else:
            bl = self._column_bounds(self._wave[:, 0], l, plot_w, t0, t1)
            br = self._column_bounds(self._wave[:, 1], l, plot_w, t0, t1)
            self._draw_minmax(p, xs, bl, COLOR_L, lo, hi)
            self._draw_minmax(p, xs, br, COLOR_R, lo, hi)

    def _draw_minmax(self, p: QPainter, xs: np.ndarray, bounds: np.ndarray,
                     color: QColor, lo: float, hi: float) -> None:
        pen = QPen(QColor(color), 1)
        pen.setCosmetic(True)
        p.setPen(pen)
        for x, mn, mx in zip(xs, bounds[:, 0], bounds[:, 1]):
            if not np.isfinite(mn):
                continue
            y0 = self._val_to_y(mn, lo, hi)
            y1 = self._val_to_y(mx, lo, hi)
            p.drawLine(int(x), int(y1), int(x), int(y0))

    def _draw_envelope(self, p: QPainter, l: int, plot_w: int, t0: float,
                       t1: float, lo: float, hi: float) -> None:
        if self._env is None:
            return
        cols = max(plot_w, 1)
        xs = l + np.arange(cols) + 0.5
        # 检测包络：按列取最大值（细灰线，透明度高）
        det = np.where(np.isneginf(self._det), np.nan, self._det)
        bdet = self._column_bounds(np.nan_to_num(det, nan=lo),
                                   l, plot_w, t0, t1)
        self._polyline(p, xs, np.array([
            self._val_to_y(v, lo, hi) if np.isfinite(v) else np.nan
            for v in bdet[:, 1]]), COLOR_DET, 1)
        # 平滑包络：按列取最大值
        env = np.where(np.isneginf(self._env), np.nan, self._env)
        benv = self._column_bounds(np.nan_to_num(env, nan=lo),
                                   l, plot_w, t0, t1)
        ys = np.array([
            self._val_to_y(v, lo, hi) if np.isfinite(v) else np.nan
            for v in benv[:, 1]])
        self._polyline(p, xs, ys, COLOR_ENV, 2)

    def _draw_gr(self, p: QPainter, l: int, plot_w: int, t0: float,
                 t1: float, lo: float, hi: float) -> None:
        if self._gr is None:
            return
        cols = max(plot_w, 1)
        xs = l + np.arange(cols) + 0.5
        b = self._column_bounds(self._gr, l, plot_w, t0, t1)
        ys = np.array([self._val_to_y(v, lo, hi)
                       if np.isfinite(v) else np.nan for v in b[:, 1]])
        # 衰减曲线 + 填充
        self._polyline(p, xs, ys, COLOR_GR, 2)
        color_fill = QColor(COLOR_GR)
        color_fill.setAlpha(60)
        p.setPen(Qt.NoPen)
        p.setBrush(color_fill)
        baseline = self._val_to_y(0.0, lo, hi)  # 0 衰减在顶部
        for x, y in zip(xs, ys):
            if np.isfinite(y):
                # 从顶部 baseline 向下填充到衰减曲线
                top_y = int(min(baseline, y))
                height = int(abs(y - baseline))
                p.drawRect(int(x) - 1, top_y, 2, height)

    # ---- 鼠标交互 ----
    def mousePressEvent(self, event) -> None:  # noqa: N802
        if event.button() == Qt.LeftButton:
            t = self._x_to_time(event.position().x())
            self._drag_start = t
            self.axis.set_cursor(t)
            self.cursorClicked.emit(t)

    def mouseMoveEvent(self, event) -> None:  # noqa: N802
        if event.buttons() & Qt.LeftButton and self._drag_start is not None:
            t = self._x_to_time(event.position().x())
            self.axis.set_selection((self._drag_start, t))

    def mouseReleaseEvent(self, event) -> None:  # noqa: N802
        if event.button() == Qt.LeftButton and self._drag_start is not None:
            sel = self.axis.selection()
            self.selectionMade.emit(sel)
            self._drag_start = None

    def mouseDoubleClickEvent(self, event) -> None:  # noqa: N802
        if event.button() == Qt.LeftButton:
            self.axis.set_selection(None)
            self.selectionMade.emit(None)
