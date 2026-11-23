"""轻量自绘绘图控件(QPainter), 避免额外依赖。

支持: 多条曲线、阴影区间(分析窗/无效频段)、竖参考线、
线性/对数 x 轴、鼠标拖拽选区(发出 regionSelected)。
"""
from __future__ import annotations

import numpy as np
from PySide6.QtCore import Qt, Signal
from PySide6.QtGui import QColor, QPainter, QPen, QPolygonF
from PySide6.QtCore import QPointF
from PySide6.QtWidgets import QWidget


def _nice_ticks(v0: float, v1: float, n: int = 6):
    if v1 <= v0:
        return []
    raw = (v1 - v0) / max(1, n)
    mag = 10.0 ** np.floor(np.log10(raw))
    step = raw
    for m in (1, 2, 2.5, 5, 10):
        if m * mag >= raw:
            step = m * mag
            break
    t0 = np.ceil(v0 / step) * step
    return list(np.arange(t0, v1 + 1e-12, step))


def _fmt(v: float) -> str:
    if abs(v) >= 1000:
        return f"{v / 1000:g}k"
    return f"{v:g}"


class PlotWidget(QWidget):
    regionSelected = Signal(float, float)

    ML, MR, MT, MB = 58, 14, 20, 30

    def __init__(self, logx=False, xlabel="", ylabel="", parent=None):
        super().__init__(parent)
        self.logx = logx
        self.xlabel = xlabel
        self.ylabel = ylabel
        self.curves = []   # dict(x, y, color, label, width, dash)
        self.spans = []    # dict(x0, x1, color, alpha, label)
        self.vlines = []   # dict(x, color, dash, label)
        self.xlim = None
        self.ylim = None
        self._press = None
        self._drag = None
        self._geom = None  # (rect, x0, x1) 供鼠标反变换
        self.setMinimumHeight(200)

    def set_data(self, curves=None, spans=None, vlines=None, xlim=None, ylim=None):
        if curves is not None:
            self.curves = curves
        if spans is not None:
            self.spans = spans
        if vlines is not None:
            self.vlines = vlines
        if xlim is not None:
            self.xlim = xlim
        if ylim is not None:
            self.ylim = ylim
        self.update()

    # ------------------------------------------------------------ 坐标

    def _xrange(self):
        if self.xlim:
            return self.xlim
        lo, hi = np.inf, -np.inf
        for c in self.curves:
            x = c["x"]
            if self.logx:
                x = x[x > 0]
            if x.size:
                lo = min(lo, float(x.min()))
                hi = max(hi, float(x.max()))
        if not np.isfinite(lo) or lo >= hi:
            lo, hi = (1.0, 10.0) if self.logx else (0.0, 1.0)
        return lo, hi

    def _yrange(self):
        if self.ylim:
            return self.ylim
        lo, hi = np.inf, -np.inf
        for c in self.curves:
            y = c["y"]
            if y.size:
                lo = min(lo, float(np.min(y)))
                hi = max(hi, float(np.max(y)))
        if not np.isfinite(lo) or lo >= hi:
            lo, hi = -1.0, 1.0
        pad = 0.08 * (hi - lo)
        return lo - pad, hi + pad

    # ------------------------------------------------------------ 绘制

    def paintEvent(self, event):
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing)
        p.fillRect(self.rect(), QColor("#ffffff"))
        r = self.rect().adjusted(self.ML, self.MT, -self.MR, -self.MB)
        if r.width() < 20 or r.height() < 20:
            return
        x0, x1 = self._xrange()
        y0, y1 = self._yrange()
        self._geom = (r, x0, x1)

        la, lb = (np.log10(max(x0, 1e-12)), np.log10(max(x1, 1e-12))) if self.logx else (x0, x1)

        def sx(x):
            v = np.log10(max(x, 1e-12)) if self.logx else x
            return r.left() + (v - la) / (lb - la) * r.width()

        def sy(y):
            return r.bottom() - (y - y0) / (y1 - y0) * r.height()

        # 网格与刻度
        font = p.font()
        font.setPointSize(9)
        p.setFont(font)
        grid_pen = QPen(QColor("#e2e2e2"))
        text_pen = QPen(QColor("#444444"))
        if self.logx:
            xt = []
            dec0, dec1 = int(np.floor(la)), int(np.ceil(lb))
            for d in range(dec0, dec1 + 1):
                for m in (1, 2, 5):
                    v = m * 10.0 ** d
                    if x0 <= v <= x1:
                        xt.append(v)
        else:
            xt = _nice_ticks(x0, x1)
        yt = _nice_ticks(y0, y1, 5)
        for v in xt:
            px = sx(v)
            p.setPen(grid_pen)
            p.drawLine(int(px), r.top(), int(px), r.bottom())
            p.setPen(text_pen)
            p.drawText(int(px) - 30, r.bottom() + 4, 60, 14,
                       Qt.AlignHCenter, _fmt(v))
        for v in yt:
            py = sy(v)
            p.setPen(grid_pen)
            p.drawLine(r.left(), int(py), r.right(), int(py))
            p.setPen(text_pen)
            p.drawText(2, int(py) - 7, self.ML - 6, 14, Qt.AlignRight, _fmt(v))
        p.setPen(QColor("#666666"))
        p.drawText(r.left(), 2, 200, 14, Qt.AlignLeft, self.ylabel)
        p.drawText(r.right() - 200, r.bottom() + 14, 200, 14,
                   Qt.AlignRight, self.xlabel)

        # 阴影区间
        p.setClipRect(r)
        for s in self.spans:
            c = QColor(s["color"])
            c.setAlpha(s.get("alpha", 50))
            p.fillRect(int(sx(s["x0"])), r.top(),
                       max(1, int(sx(s["x1"]) - sx(s["x0"]))), r.height(), c)
            if s.get("label"):
                p.setPen(QColor(s["color"]))
                p.drawText(int(sx(s["x0"])) + 3, r.top() + 12, s["label"])

        # 竖参考线
        for v in self.vlines:
            pen = QPen(QColor(v["color"]))
            if v.get("dash"):
                pen.setStyle(Qt.DashLine)
            p.setPen(pen)
            px = int(sx(v["x"]))
            p.drawLine(px, r.top(), px, r.bottom())

        # 曲线
        for c in self.curves:
            pen = QPen(QColor(c["color"]))
            pen.setWidthF(c.get("width", 1.5))
            if c.get("dash"):
                pen.setStyle(Qt.DashLine)
            p.setPen(pen)
            x, y = c["x"], c["y"]
            if x.size == 0:
                continue
            if x.size > 4000:  # 抽稀加速
                step = int(np.ceil(x.size / 4000))
                x, y = x[::step], y[::step]
            poly = QPolygonF([QPointF(sx(float(xi)), sy(float(yi)))
                              for xi, yi in zip(x, y)])
            p.drawPolyline(poly)
        p.setClipping(False)

        # 图例
        lx = r.right() - 10
        ly = r.top() + 12
        p.setFont(font)
        for c in reversed([c for c in self.curves if c.get("label")]):
            label = c["label"]
            w = p.fontMetrics().horizontalAdvance(label) + 30
            lx -= w
            p.setPen(QPen(QColor(c["color"]), 2))
            p.drawLine(lx, ly - 4, lx + 18, ly - 4)
            p.setPen(text_pen)
            p.drawText(lx + 22, ly, label)

        # 边框
        p.setPen(QPen(QColor("#999999")))
        p.drawRect(r)

        # 拖拽选区
        if self._press is not None and self._drag is not None:
            xa, xb = sorted((self._press, self._drag))
            band = QColor("#2266cc")
            band.setAlpha(60)
            p.fillRect(int(xa), r.top(), max(1, int(xb - xa)), r.height(), band)

    # ------------------------------------------------------------ 鼠标

    def _px_to_data(self, px: float) -> float:
        r, x0, x1 = self._geom
        frac = (px - r.left()) / r.width()
        if self.logx:
            la, lb = np.log10(max(x0, 1e-12)), np.log10(max(x1, 1e-12))
            return float(10.0 ** (la + frac * (lb - la)))
        return x0 + frac * (x1 - x0)

    def mousePressEvent(self, e):
        if self._geom and e.button() == Qt.LeftButton:
            r = self._geom[0]
            if r.contains(e.position().toPoint()):
                self._press = self._drag = e.position().x()

    def mouseMoveEvent(self, e):
        if self._press is not None:
            self._drag = e.position().x()
            self.update()

    def mouseReleaseEvent(self, e):
        if self._press is not None and self._drag is not None:
            if abs(self._drag - self._press) > 4:
                xa = self._px_to_data(min(self._press, self._drag))
                xb = self._px_to_data(max(self._press, self._drag))
                self.regionSelected.emit(xa, xb)
        self._press = self._drag = None
        self.update()
