"""自绘轻量图表组件(只用 QPainter, 不引入额外绘图依赖)。

TimePlot: 共享时间轴的基类, 支持背景区间着色、游标与点击 seek。
DeviationPlot: 参考偏差轨迹(Hz / 音分), 弱/脏帧与噪声帧分段着色。
WaveformPlot: 波形包络 + 检测到的打点事件 + 未校正区间。
MappingPlot: 输入时间 -> 校正后时间的映射曲线与 y=x 参考线。
"""
from __future__ import annotations

import numpy as np
from PySide6.QtCore import Qt, Signal, QRectF
from PySide6.QtGui import (QPainter, QPen, QColor, QBrush, QFont,
                           QPainterPath, QPolygonF)
from PySide6.QtGui import QMouseEvent
from PySide6.QtCore import QPointF
from PySide6.QtWidgets import QWidget


# 统一的语义配色(品牌中性, 便于区分状态)
COLOR_VALID = QColor("#2f6fdb")       # 可信轨迹/有效区
COLOR_WEAK = QColor("#e0a32e")        # 太弱/太脏
COLOR_NOISE = QColor("#d1495b")       # 噪声/丢失
COLOR_GAP_SHORT = QColor(224, 163, 46, 48)
COLOR_GAP_LONG = QColor(209, 73, 91, 56)
COLOR_EVENT = QColor("#2a9d8f")
COLOR_CURSOR = QColor("#222222")
COLOR_GRID = QColor(220, 222, 226)
COLOR_REF_LINE = QColor(150, 154, 160)


class TimePlot(QWidget):
    """共享时间轴的绘图基类。"""

    seekRequested = Signal(float)

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setMinimumHeight(150)
        self.setMouseTracking(True)
        self._duration = 1.0
        self._cursor = -1.0
        self._regions: list[tuple[float, float, QColor]] = []
        self._margin_l, self._margin_r = 58.0, 12.0
        self._margin_t, self._margin_b = 22.0, 22.0
        self._hover_x = -1.0

    # --- 公共 API ---
    def set_duration(self, duration_s: float):
        self._duration = max(1e-6, float(duration_s))
        self.update()

    def set_cursor(self, t: float):
        self._cursor = float(t)
        self.update()

    def set_regions(self, regions: list[tuple[float, float, QColor]]):
        self._regions = list(regions)
        self.update()

    # --- 坐标变换 ---
    def _plot_rect(self) -> QRectF:
        return QRectF(self._margin_l, self._margin_t,
                      max(10.0, self.width() - self._margin_l - self._margin_r),
                      max(10.0, self.height() - self._margin_t - self._margin_b))

    def _x_of_t(self, t: float, r: QRectF) -> float:
        return r.left() + (t / self._duration) * r.width()

    def _t_of_x(self, x: float, r: QRectF) -> float:
        return (x - r.left()) / max(r.width(), 1e-6) * self._duration

    def mousePressEvent(self, ev: QMouseEvent):
        r = self._plot_rect()
        if r.contains(ev.position()):
            self.seekRequested.emit(
                float(np.clip(self._t_of_x(ev.position().x(), r),
                              0.0, self._duration)))
        super().mousePressEvent(ev)

    def mouseMoveEvent(self, ev: QMouseEvent):
        r = self._plot_rect()
        self._hover_x = ev.position().x() if r.contains(ev.position()) else -1.0
        self.update()
        super().mouseMoveEvent(ev)

    def leaveEvent(self, ev):
        self._hover_x = -1.0
        self.update()

    # --- 通用背景/网格/游标 ---
    def _draw_regions(self, p: QPainter, r: QRectF):
        for t0, t1, color in self._regions:
            x0, x1 = self._x_of_t(t0, r), self._x_of_t(t1, r)
            p.fillRect(QRectF(x0, r.top(), x1 - x0, r.height()), color)

    def _draw_grid(self, p: QPainter, r: QRectF):
        pen = QPen(COLOR_GRID, 1.0)
        p.setPen(pen)
        step = 1.0 if self._duration <= 12 else 5.0
        t = 0.0
        while t <= self._duration + 1e-9:
            x = self._x_of_t(t, r)
            p.drawLine(QPointF(x, r.top()), QPointF(x, r.bottom()))
            p.setPen(QColor(110, 114, 120))
            p.drawText(QRectF(x - 30, r.bottom() + 3, 60, 16),
                       Qt.AlignCenter, f"{t:.0f}s")
            p.setPen(pen)
            t += step

    def _draw_cursor(self, p: QPainter, r: QRectF):
        if self._cursor < 0:
            return
        x = self._x_of_t(self._cursor, r)
        pen = QPen(COLOR_CURSOR, 1.4, Qt.DashLine)
        p.setPen(pen)
        p.drawLine(QPointF(x, r.top()), QPointF(x, r.bottom()))

    def paintEvent(self, ev):
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing, True)
        r = self._plot_rect()
        p.fillRect(self.rect(), QColor(250, 250, 252))
        p.fillRect(r, Qt.white)
        self._draw_regions(p, r)
        self._draw_grid(p, r)
        self._paint_data(p, r)
        self._draw_cursor(p, r)
        p.setPen(QPen(QColor(200, 202, 206)))
        p.setBrush(Qt.NoBrush)
        p.drawRect(r)
        p.end()

    def _paint_data(self, p: QPainter, r: QRectF):
        raise NotImplementedError


class DeviationPlot(TimePlot):
    """参考音频率偏差轨迹。"""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setMinimumHeight(190)
        self._t: np.ndarray | None = None
        self._values: np.ndarray | None = None      # 与 t 等长, nan 表示无效
        self._weak: np.ndarray | None = None
        self._unit = "hz"
        self._f_nom = 1000.0
        self._zero_y = None

    def set_data(self, frame_time, deviation_hz, weak, f_nom, unit="hz"):
        self._t = np.asarray(frame_time)
        self._values = np.asarray(deviation_hz, dtype=float)
        self._weak = np.asarray(weak, dtype=bool)
        self._f_nom = float(f_nom)
        self._unit = unit
        self.update()

    def set_unit(self, unit: str):
        self._unit = unit
        self.update()

    def _display_values(self):
        if self._values is None:
            return None
        if self._unit == "cents":
            with np.errstate(invalid="ignore"):
                return 1200.0 * np.log2(1.0 + self._values)
        return self._values * self._f_nom       # 相对偏差 -> Hz

    def _paint_data(self, p: QPainter, r: QRectF):
        vals = self._display_values()
        if vals is None or self._t is None or vals.size == 0:
            self._draw_hint(p, r, "载入并分析参考轨后显示偏差轨迹")
            return
        finite = vals[np.isfinite(vals)]
        if finite.size == 0:
            self._draw_hint(p, r, "没有可信的参考帧")
            return
        span = max(1e-6, float(np.nanmax(np.abs(finite))) * 1.25)
        y0 = r.top() + r.height() / 2.0
        scale = (r.height() / 2.0 - 6.0) / span
        self._zero_y = y0

        def y_of(v):
            return y0 - v * scale

        # 零偏差参考线 + 纵轴刻度
        p.setPen(QPen(COLOR_REF_LINE, 1.0, Qt.DashLine))
        p.drawLine(QPointF(r.left(), y0), QPointF(r.right(), y0))
        p.setPen(QColor(110, 114, 120))
        unit = "音分" if self._unit == "cents" else "Hz"
        for v in (-span, 0.0, span):
            label = f"{v:+.1f}" if abs(v) < 1000 else f"{v:+.0f}"
            p.drawText(QRectF(2, y_of(v) - 8, self._margin_l - 6, 16),
                       Qt.AlignRight | Qt.AlignVCenter, label)
        p.drawText(QRectF(2, r.top() - 16, self._margin_l - 4, 14),
                   Qt.AlignRight, f"偏差({unit})")

        # 分段: 有效(蓝) / 弱脏(橙) / 噪声(红, 用零轴上的短标记表示)
        valid = np.isfinite(vals) & ~self._weak
        weak = np.isfinite(vals) & self._weak
        for mask, color, width in ((valid, COLOR_VALID, 1.8),
                                   (weak, COLOR_WEAK, 1.4)):
            self._draw_segments(p, r, mask, vals, y_of, color, width)

        # 无效帧标记(噪声/丢失): 零轴下方红色小竖线
        bad_t = self._t[~np.isfinite(vals)]
        if bad_t.size:
            pen = QPen(COLOR_NOISE, 1.0)
            p.setPen(pen)
            for tt in bad_t[::max(1, bad_t.size // 400)]:
                x = self._x_of_t(tt, r)
                p.drawLine(QPointF(x, y0 + 4), QPointF(x, y0 + 9))

        # 图例(置于零轴下方, 避开上方轨迹)
        self._draw_legend(p, r, [
            (COLOR_VALID, "可信帧"),
            (COLOR_WEAK, "太弱/太脏"),
            (COLOR_NOISE, "噪声/丢失"),
        ])

    def _draw_segments(self, p, r, mask, vals, y_of, color, width):
        if not mask.any():
            return
        pen = QPen(color, width)
        p.setPen(pen)
        path = QPainterPath()
        started = False
        for i in range(mask.size):
            if not mask[i]:
                started = False
                continue
            x = self._x_of_t(self._t[i], r)
            y = y_of(vals[i])
            if not started:
                path.moveTo(x, y)
                started = True
            else:
                path.lineTo(x, y)
        p.drawPath(path)

    def _draw_legend(self, p, r, items):
        f = QFont()
        f.setPointSize(9)
        p.setFont(f)
        step_x = 78
        total_w = step_x * len(items)
        x = r.right() - total_w
        y = r.bottom() - 18
        for color, label in items:
            p.setPen(QPen(color, 2.5))
            p.drawLine(QPointF(x, y + 6), QPointF(x + 16, y + 6))
            p.setPen(QColor(70, 72, 78))
            p.drawText(QRectF(x + 20, y, 56, 14), Qt.AlignVCenter, label)
            x += step_x

    def _draw_hint(self, p, r, text):
        p.setPen(QColor(140, 144, 150))
        p.drawText(r, Qt.AlignCenter, text)


class WaveformPlot(TimePlot):
    """波形包络 + 打点事件 + 未校正区间, 可叠两条波形。"""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setMinimumHeight(170)
        self._primary: np.ndarray | None = None
        self._secondary: np.ndarray | None = None
        self._sr = 1
        self._events_primary: np.ndarray | None = None
        self._events_secondary: np.ndarray | None = None
        self._show_secondary = False

    def set_waveforms(self, sr, primary, secondary=None,
                      events_primary=None, events_secondary=None):
        self._sr = int(sr)
        self._primary = np.asarray(primary, dtype=float)
        self._secondary = None if secondary is None \
            else np.asarray(secondary, dtype=float)
        self._events_primary = events_primary
        self._events_secondary = events_secondary
        self.set_duration(self._primary.size / sr)
        self.update()

    def set_show_secondary(self, on: bool):
        self._show_secondary = on
        self.update()

    def _bins(self, n_samples: int, r: QRectF, n_bins: int = 1400):
        n_bins = max(50, min(n_bins, int(r.width())))
        edges = np.linspace(0, n_samples, n_bins + 1).astype(int)
        return edges, n_bins

    def _paint_wave(self, p, r, sig, color, fill_alpha: int):
        if sig is None:
            return
        edges, n_bins = self._bins(sig.size, r)
        poly_top, poly_bot = QPolygonF(), QPolygonF()
        for b in range(n_bins):
            seg = sig[edges[b]:edges[b + 1]]
            if seg.size == 0:
                continue
            peak = float(np.max(np.abs(seg))) + 1e-9
            t_c = ((edges[b] + edges[b + 1]) / 2.0) / self._sr
            x = self._x_of_t(t_c, r)
            yc = r.top() + r.height() / 2.0
            h = (peak / max(np.abs(sig).max(), 1e-9)) * (r.height() / 2 - 4)
            poly_top.append(QPointF(x, yc - h))
            poly_bot.append(QPointF(x, yc + h))
        fill = QColor(color)
        fill.setAlpha(fill_alpha)
        p.setPen(QPen(color, 1.0))
        p.setBrush(QBrush(fill))
        whole = QPolygonF(poly_top)
        for i in range(poly_bot.size() - 1, -1, -1):
            whole.append(poly_bot[i])
        p.drawPolygon(whole)
        p.setBrush(Qt.NoBrush)

    def _paint_events(self, p, r, events, color, y_offset: float):
        if events is None:
            return
        pen = QPen(color, 2.0)
        p.setPen(pen)
        for t in np.asarray(events):
            x = self._x_of_t(float(t), r)
            p.drawLine(QPointF(x, r.top() + 4 + y_offset),
                       QPointF(x, r.top() + 14 + y_offset))

    def _paint_data(self, p, r):
        if self._primary is None:
            self._draw_hint(p, r, "校正后在此显示波形与打点事件")
            return
        if self._show_secondary and self._secondary is not None:
            self._paint_wave(p, r, self._secondary,
                             QColor(150, 154, 160), 36)
        self._paint_wave(p, r, self._primary, COLOR_VALID, 60)
        self._paint_events(p, r, self._events_primary, COLOR_EVENT, 0.0)
        if self._show_secondary and self._events_secondary is not None:
            self._paint_events(p, r, self._events_secondary,
                               QColor(110, 114, 120), 12.0)
        self._draw_legend(p, r)

    def _draw_legend(self, p, r):
        f = QFont()
        f.setPointSize(9)
        p.setFont(f)
        items = [(COLOR_VALID, "当前波形"), (COLOR_EVENT, "打点事件")]
        if self._show_secondary:
            items.insert(1, (QColor(150, 154, 160), "对比波形(半透明)"))
        step_x = 132
        x = r.right() - step_x * len(items)
        y = r.top() + 6
        for color, label in items:
            p.setPen(QPen(color, 2.5))
            p.drawLine(QPointF(x, y + 6), QPointF(x + 16, y + 6))
            p.setPen(QColor(70, 72, 78))
            p.drawText(QRectF(x + 20, y, 112, 14), Qt.AlignVCenter, label)
            x += step_x

    def _draw_hint(self, p, r, text):
        p.setPen(QColor(140, 144, 150))
        p.drawText(r, Qt.AlignCenter, text)


class MappingPlot(TimePlot):
    """输入(文件)时间 -> 校正后时间的映射, 与 y=x 参考线对照。"""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setMinimumHeight(180)
        self._map_in: np.ndarray | None = None
        self._map_out: np.ndarray | None = None
        self._uncorrected: np.ndarray | None = None

    def set_mapping(self, t_in, t_out, uncorrected_mask=None):
        self._map_in = np.asarray(t_in, dtype=float)
        self._map_out = np.asarray(t_out, dtype=float)
        self._uncorrected = None if uncorrected_mask is None \
            else np.asarray(uncorrected_mask, dtype=bool)
        self.set_duration(float(self._map_in[-1]))
        self.update()

    def _paint_data(self, p, r):
        if self._map_in is None:
            self._draw_hint(p, r, "校正后显示输入时间 → 输出时间映射")
            return
        d = float(self._map_in[-1])

        def pt(tin, tout):
            return QPointF(self._x_of_t(tin, r),
                           r.bottom() - (tout / d) * r.height())

        # y = x 参考线
        p.setPen(QPen(COLOR_REF_LINE, 1.2, Qt.DashLine))
        p.drawLine(pt(0, 0), pt(d, d))
        p.setPen(QColor(110, 114, 120))
        p.drawText(QRectF(r.left() - 2, r.top() - 4, 120, 14),
                   Qt.AlignLeft, "校正后时间 (s)")
        p.drawText(QRectF(r.right() - 110, r.bottom() + 4, 110, 14),
                   Qt.AlignRight, "虚线 = 无校正 y=x")

        # 映射曲线: 校正区蓝色, 未校正区与 y=x 重合(画灰色强调"原样")
        pen = QPen(COLOR_VALID, 1.8)
        p.setPen(pen)
        path = QPainterPath()
        step = max(1, self._map_in.size // 4000)
        started = False
        for i in range(0, self._map_in.size, step):
            pt_i = pt(self._map_in[i], self._map_out[i])
            if not started:
                path.moveTo(pt_i)
                started = True
            else:
                path.lineTo(pt_i)
        p.drawPath(path)

        if self._uncorrected is not None:
            pen2 = QPen(QColor(120, 124, 130), 2.2)
            p.setPen(pen2)
            path2 = QPainterPath()
            started = False
            for i in range(0, self._map_in.size, step):
                if not self._uncorrected[i]:
                    started = False
                    continue
                pt_i = pt(self._map_in[i], self._map_out[i])
                if not started:
                    path2.moveTo(pt_i)
                    started = True
                else:
                    path2.lineTo(pt_i)
            p.drawPath(path2)

        # 终点累积偏差注释
        drift = float(self._map_out[-1] - self._map_in[-1])
        p.setPen(QColor(70, 72, 78))
        p.drawText(QRectF(r.left(), r.top(), r.width() - 8, 16),
                   Qt.AlignRight | Qt.AlignTop,
                   f"输出末端相对输入累计偏移: {drift:+.3f} s")

    def _draw_hint(self, p, r, text):
        p.setPen(QColor(140, 144, 150))
        p.drawText(r, Qt.AlignCenter, text)
