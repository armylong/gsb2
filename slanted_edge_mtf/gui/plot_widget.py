"""轻量曲线绘制(QPainter), 不引入额外绘图依赖。

每个 PlotWidget 可叠加多条 Series; 提供坐标轴、网格、参考线与悬停读数。
"""

from __future__ import annotations

from dataclasses import dataclass, field

from PySide6.QtCore import QPointF, QRectF, Qt, Signal
from PySide6.QtGui import QColor, QFont, QPainter, QPen
from PySide6.QtWidgets import QWidget


@dataclass
class Series:
    xs: list
    ys: list
    color: QColor
    label: str = ""
    width: float = 1.6
    scatter: bool = False
    vline: float | None = None          # 竖参考线(如 MTF50)
    hline: float | None = None          # 横参考线(如 MTF=0.5)


@dataclass
class PlotConfig:
    title: str = ""
    x_label: str = ""
    y_label: str = ""
    x_lim: tuple[float, float] | None = None
    y_lim: tuple[float, float] | None = None
    series: list[Series] = field(default_factory=list)


class PlotWidget(QWidget):
    hovered = Signal(str)

    def __init__(self, config: PlotConfig | None = None,
                 parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setMinimumHeight(170)
        self.setMouseTracking(True)
        self.cfg = config or PlotConfig()
        self._mouse_x: float | None = None
        self._margin_l = 52
        self._margin_r = 12
        self._margin_t = 22
        self._margin_b = 34

    def set_config(self, cfg: PlotConfig) -> None:
        self.cfg = cfg
        self._mouse_x = None
        self.update()

    # ------------------------------------------------------------- 坐标映射
    def _bounds(self) -> tuple[float, float, float, float]:
        if self.cfg.x_lim:
            x0, x1 = self.cfg.x_lim
        else:
            xs = [v for s in self.cfg.series for v in s.xs]
            x0, x1 = (min(xs), max(xs)) if xs else (0.0, 1.0)
        if self.cfg.y_lim:
            y0, y1 = self.cfg.y_lim
        else:
            ys = [v for s in self.cfg.series for v in s.ys]
            y0, y1 = (min(ys), max(ys)) if ys else (0.0, 1.0)
        if x1 == x0:
            x1 = x0 + 1.0
        if y1 == y0:
            y1 = y0 + 1.0
        # y 轴留 6% 余量
        pad = (y1 - y0) * 0.06
        return x0, x1, y0 - pad, y1 + pad

    def _plot_rect(self) -> QRectF:
        return QRectF(self._margin_l, self._margin_t,
                      max(10, self.width() - self._margin_l - self._margin_r),
                      max(10, self.height() - self._margin_t - self._margin_b))

    def _to_pixel(self, x: float, y: float,
                  bounds: tuple[float, float, float, float],
                  pr: QRectF) -> QPointF:
        x0, x1, y0, y1 = bounds
        px = pr.left() + (x - x0) / (x1 - x0) * pr.width()
        py = pr.bottom() - (y - y0) / (y1 - y0) * pr.height()
        return QPointF(px, py)

    def _to_data_x(self, px: float, bounds, pr: QRectF) -> float:
        x0, x1, _, _ = bounds
        return x0 + (px - pr.left()) / pr.width() * (x1 - x0)

    # ----------------------------------------------------------------- 绘制
    def paintEvent(self, event) -> None:
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing)
        p.fillRect(self.rect(), QColor(250, 250, 252))
        bounds = self._bounds()
        pr = self._plot_rect()
        x0, x1, y0, y1 = bounds

        # 网格 + 刻度(4 档), 数字按量级整洁化
        pen = QPen(QColor(225, 226, 232), 1)
        p.setPen(pen)
        small = QFont()
        small.setPointSize(8)
        p.setFont(small)

        def fmt(v: float) -> str:
            if v == 0:
                return "0"
            av = abs(v)
            if av >= 100:
                return f"{v:.0f}"
            if av >= 10:
                return f"{v:.1f}"
            if av >= 1:
                return f"{v:.2f}"
            if av >= 0.1:
                return f"{v:.3f}"
            return f"{v:.1e}"

        for i in range(5):
            gx = pr.left() + i * pr.width() / 4
            gy = pr.bottom() - i * pr.height() / 4
            p.drawLine(QPointF(gx, pr.top()), QPointF(gx, pr.bottom()))
            p.drawLine(QPointF(pr.left(), gy), QPointF(pr.right(), gy))
            xv = x0 + i * (x1 - x0) / 4
            yv = y0 + i * (y1 - y0) / 4
            p.setPen(QColor(120, 122, 130))
            p.drawText(QRectF(gx - 34, pr.bottom() + 4, 68, 14),
                       Qt.AlignHCenter, fmt(xv))
            p.drawText(QRectF(pr.left() - 50, gy - 7, 46, 14),
                       Qt.AlignRight | Qt.AlignVCenter, fmt(yv))
            p.setPen(pen)

        # 轴线
        p.setPen(QPen(QColor(90, 92, 100), 1.2))
        p.drawRect(pr)

        # 参考线
        ref_pen = QPen(QColor(180, 60, 60), 1.0, Qt.DashLine)
        for s in self.cfg.series:
            if s.vline is not None and x0 <= s.vline <= x1:
                q = self._to_pixel(s.vline, y0, bounds, pr)
                p.setPen(ref_pen)
                p.drawLine(QPointF(q.x(), pr.top()),
                           QPointF(q.x(), pr.bottom()))
            if s.hline is not None and y0 <= s.hline <= y1:
                q = self._to_pixel(x0, s.hline, bounds, pr)
                p.setPen(ref_pen)
                p.drawLine(QPointF(pr.left(), q.y()),
                           QPointF(pr.right(), q.y()))

        # 曲线
        for s in self.cfg.series:
            pen = QPen(s.color, s.width)
            pen.setCosmetic(True)
            p.setPen(pen)
            if not s.scatter and len(s.xs) >= 2:
                poly = [self._to_pixel(x, y, bounds, pr)
                        for x, y in zip(s.xs, s.ys)]
                p.drawPolyline(poly)
            if s.scatter:
                p.setBrush(s.color)
                p.setPen(Qt.NoPen)
                for x, y in zip(s.xs, s.ys):
                    q = self._to_pixel(x, y, bounds, pr)
                    if pr.contains(q):
                        p.drawEllipse(q, 1.6, 1.6)
                p.setPen(QPen(s.color, s.width))

        # 悬停竖线 + 读数
        if self._mouse_x is not None and x0 <= self._mouse_x <= x1:
            qx = self._to_pixel(self._mouse_x, y0, bounds, pr).x()
            p.setPen(QPen(QColor(70, 110, 200), 1.0, Qt.DotLine))
            p.drawLine(QPointF(qx, pr.top()), QPointF(qx, pr.bottom()))
            vals = []
            for s in self.cfg.series:
                if len(s.xs) >= 2 and s.xs[0] <= self._mouse_x <= s.xs[-1]:
                    import numpy as np
                    yv = float(np.interp(self._mouse_x, s.xs, s.ys))
                    vals.append(f"{s.label or 'y'}={yv:.4g}")
            if vals:
                txt = f"x={self._mouse_x:.4g}  " + "  ".join(vals)
                p.setPen(QColor(40, 42, 50))
                p.drawText(QRectF(pr.left() + 6, pr.top() + 2,
                                  pr.width() - 12, 16),
                           Qt.AlignLeft, txt)

        # 标题与轴标签
        p.setPen(QColor(40, 42, 50))
        title_f = QFont()
        title_f.setPointSize(10)
        title_f.setBold(True)
        p.setFont(title_f)
        p.drawText(QRectF(pr.left(), 2, pr.width(), 18),
                   Qt.AlignLeft | Qt.AlignVCenter, self.cfg.title)
        p.setFont(small)
        p.drawText(QRectF(pr.left(), pr.bottom() + 18, pr.width(), 14),
                   Qt.AlignHCenter, self.cfg.x_label)
        p.save()
        p.translate(12, pr.center().y())
        p.rotate(-90)
        p.drawText(QRectF(-pr.height() / 2, -8, pr.height(), 16),
                   Qt.AlignHCenter, self.cfg.y_label)
        p.restore()

        # 图例
        lx = pr.right() - 8
        ly = pr.top() + 4
        for s in reversed(self.cfg.series):
            if not s.label:
                continue
            fm = p.fontMetrics()
            tw = fm.horizontalAdvance(s.label) + 14
            p.setPen(QPen(s.color, 2))
            p.drawLine(QPointF(lx - tw + 4, ly + 6),
                       QPointF(lx - tw + 12, ly + 6))
            p.setPen(QColor(40, 42, 50))
            p.drawText(QRectF(lx - tw + 14, ly, tw - 14, 14),
                       Qt.AlignLeft | Qt.AlignVCenter, s.label)
            ly += 16

    def mouseMoveEvent(self, event) -> None:
        pr = self._plot_rect()
        if pr.contains(event.position()):
            self._mouse_x = self._to_data_x(event.position().x(),
                                            self._bounds(), pr)
        else:
            self._mouse_x = None
        self.update()

    def leaveEvent(self, event) -> None:
        self._mouse_x = None
        self.update()
