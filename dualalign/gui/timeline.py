"""波形 / 时间轴绘图控件 (纯 QPainter, 不依赖第三方绘图库)."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from PySide6.QtCore import QPointF, QRectF, Qt, Signal
from PySide6.QtGui import (
    QColor,
    QFont,
    QMouseEvent,
    QPainter,
    QPainterPath,
    QPen,
    QWheelEvent,
)
from PySide6.QtWidgets import QSizePolicy, QWidget

from ..align import AlignmentResult
from ..render import preview_envelope

# 色彩: 参考与对齐结果必须视觉上可区分
COLOR_REF = QColor("#2f6fb3")
COLOR_REF_LIGHT = QColor("#8db6e0")
COLOR_ALIGNED = QColor("#d1721a")
COLOR_ALIGNED_LIGHT = QColor("#f0b37e")
COLOR_GAP = QColor(200, 40, 40, 60)
COLOR_GAP_EDGE = QColor(190, 30, 30, 190)
COLOR_LOWCONF = QColor(240, 190, 30, 70)
COLOR_LOWCONF_EDGE = QColor(200, 150, 0, 200)
COLOR_ANCHOR = QColor("#159a5c")
COLOR_ANCHOR_PENDING = QColor("#0c5f3c")
COLOR_GRID = QColor("#d8dde3")
COLOR_TEXT = QColor("#2b3138")
COLOR_BG = QColor("#fbfcfd")
COLOR_CURSOR = QColor("#c0215b")
COLOR_CURSOR_TAKE = QColor("#8a8f98")
COLOR_TAKE = QColor("#6d7681")
COLOR_TAKE_LIGHT = QColor("#c7ccd2")


@dataclass
class ViewRange:
    start: float
    end: float

    @property
    def span(self) -> float:
        return max(1e-6, self.end - self.start)

    def clamp(self, total: float) -> "ViewRange":
        span = min(self.span, max(total, 1e-3))
        start = max(0.0, min(self.start, max(0.0, total - span)))
        return ViewRange(start, start + span)

    def x_of(self, t: float, rect: QRectF) -> float:
        return rect.left() + (t - self.start) / self.span * rect.width()

    def t_of(self, x: float, rect: QRectF) -> float:
        return self.start + (x - rect.left()) / max(rect.width(), 1.0) * self.span


class TakeView(QWidget):
    """待对齐录音自身的波形 (横轴是它自己的时间, 不与参考混用)。

    缺失接缝和参考侧指针在该录音上的对应位置会以虚线标出。
    """

    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self.setMinimumHeight(96)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)
        self.result: AlignmentResult | None = None
        self.cursor_ref: float | None = None
        self.setToolTip("待对齐录音的原始波形 (自身时间轴, 未做任何时间调整)")

    def set_result(self, result: AlignmentResult | None) -> None:
        self.result = result
        self.update()

    def set_cursor(self, ref_time: float | None) -> None:
        self.cursor_ref = ref_time
        self.update()

    def paintEvent(self, _event) -> None:  # noqa: N802
        p = QPainter(self)
        p.fillRect(self.rect(), QColor("#ffffff"))
        p.setPen(QColor("#7a828c"))
        p.drawText(8, 16, "待对齐录音原始波形 (自身时间轴, 未调整)")
        rect = QRectF(self.rect()).adjusted(12, 22, -12, -24)
        if self.result is None:
            p.setPen(QColor("#a4abb3"))
            p.drawText(rect, Qt.AlignmentFlag.AlignCenter, "未载入")
            p.end()
            return
        take = self.result.take_clip
        dur = take.duration
        p.setPen(QPen(QColor("#eef1f4"), 1))
        p.drawRect(rect)
        mono = take.mono()
        bins = max(32, min(int(rect.width()), 1600))
        edges = np.linspace(0, len(mono), bins + 1).astype(np.int64)
        peaks = np.array(
            [float(np.max(np.abs(mono[edges[i]:max(edges[i] + 1, edges[i + 1])])))
             for i in range(bins)]
        )
        scale = 1.0 / max(float(np.percentile(peaks, 99.0)) if peaks.size else 1.0, 1e-6)
        peaks = np.clip(peaks * scale, 0.0, 1.0)
        mid = rect.center().y()
        half = rect.height() * 0.5 - 4
        path = QPainterPath()
        xs = rect.left() + np.linspace(0, rect.width(), bins)
        path.moveTo(xs[0], mid - peaks[0] * half)
        for x, y in zip(xs[1:], peaks[1:]):
            path.lineTo(x, mid - y * half)
        for x, y in zip(xs[::-1], peaks[::-1]):
            path.lineTo(x, mid + y * half)
        path.closeSubpath()
        p.setPen(QPen(COLOR_TAKE_LIGHT, 0.8))
        p.setBrush(COLOR_TAKE)
        p.drawPath(path)
        # 缺失接缝
        for gap in self.result.missing_gaps:
            if 0.0 <= gap.take_time <= dur:
                x = rect.left() + gap.take_time / max(dur, 1e-6) * rect.width()
                p.setPen(QPen(COLOR_GAP_EDGE, 1.5, Qt.PenStyle.DashLine))
                p.drawLine(QPointF(x, rect.top()), QPointF(x, rect.bottom()))
                p.setPen(QColor("#8d1c1c"))
                p.drawText(QRectF(x + 3, rect.top() + 1, 130, 14),
                           Qt.AlignmentFlag.AlignLeft, "缺失接缝")
        # 参考指针在该录音上的对应位置
        if self.cursor_ref is not None:
            t = float(self.result.curve.take_time_at(self.cursor_ref))
            if 0 <= t <= dur:
                x = rect.left() + t / max(dur, 1e-6) * rect.width()
                p.setPen(QPen(COLOR_CURSOR, 1.2))
                p.drawLine(QPointF(x, rect.top()), QPointF(x, rect.bottom()))
        # 时间刻度 (待对齐录音自身时间)
        step = TimelineView._nice_step(dur)
        t = 0.0
        p.setPen(COLOR_TEXT)
        while t <= dur + 1e-9:
            x = rect.left() + t / max(dur, 1e-6) * rect.width()
            p.setPen(QPen(QColor("#9aa2ab"), 1))
            p.drawLine(QPointF(x, rect.bottom()), QPointF(x, rect.bottom() + 3))
            p.setPen(QColor("#5a636c"))
            p.drawText(QRectF(x - 25, rect.bottom() + 3, 50, 14),
                       Qt.AlignmentFlag.AlignHCenter, f"{t:.1f}s")
            t += step
        p.end()


class TimelineView(QWidget):
    """参考时间轴视图: 参考/对齐包络、缺失区间、低置信区间、锚点、指针。"""

    cursorMoved = Signal(float)  # 参考时间
    viewChanged = Signal(float, float)
    anchorAddRequested = Signal(float)  # 参考时间
    anchorRemoveRequested = Signal(object)  # NavAnchor
    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self.setMinimumHeight(210)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding)
        self.setMouseTracking(True)
        self.result: AlignmentResult | None = None
        self.view = ViewRange(0.0, 10.0)
        self.cursor_ref: float | None = None
        self.pending_anchor: float | None = None
        self._envelope: dict | None = None
        self._envelope_key: str = ""
        self._dragging = False
        self._drag_start_view: ViewRange | None = None
        self._drag_start_x = 0.0
        self._selected_anchor: object | None = None
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
        self.setToolTip(
            "滚轮缩放; 中键或 Shift+拖动平移; 单击定位指针; 双击设置候选锚点; "
            "点击绿色圆点删除锚点"
        )

    # ---- 数据 -------------------------------------------------------------

    def set_result(self, result: AlignmentResult | None) -> None:
        self.result = result
        self._envelope = None
        self._envelope_key = ""
        if result is not None:
            self.view = ViewRange(0.0, min(result.ref_duration, 10.0))
            self.cursor_ref = min(1.0, result.ref_duration * 0.25)
        self.update()

    def refresh_envelope(self) -> None:
        self._envelope = None
        self.update()

    def set_view(self, start: float, end: float) -> None:
        if self.result is None:
            return
        self.view = ViewRange(start, end).clamp(self.result.ref_duration)
        self.viewChanged.emit(self.view.start, self.view.end)
        self.update()

    def envelope(self) -> dict | None:
        if self.result is None:
            return None
        key = f"{self.result.ref_duration:.6f}:{id(self.result)}:{id(self.result.curve.knots_take)}"
        if self._envelope is None or key != self._envelope_key:
            self._envelope = preview_envelope(self.result, bins=2200)
            self._envelope_key = key
        return self._envelope

    # ---- 布局 -------------------------------------------------------------

    def _plot_rect(self) -> QRectF:
        # 顶部留出轨道标题行, 底部留出时间刻度
        return QRectF(self.rect()).adjusted(12, 24, -12, -28)

    def _ref_rect(self) -> QRectF:
        r = self._plot_rect()
        return QRectF(r.left(), r.top(), r.width(), r.height() * 0.44)

    def _aligned_rect(self) -> QRectF:
        r = self._plot_rect()
        return QRectF(r.left(), r.top() + r.height() * 0.52, r.width(), r.height() * 0.44)

    def _target_rect(self) -> QRectF:
        """待对齐录音按自身时间轴显示 (不参与参考时间对齐)。"""

        r = self._plot_rect()
        return QRectF(r.left(), r.top() + r.height() * 0.52, r.width(), r.height() * 0.44)

    # ---- 绘制 -------------------------------------------------------------

    def paintEvent(self, _event) -> None:  # noqa: N802 - Qt 命名
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        p.fillRect(self.rect(), COLOR_BG)
        if self.result is None:
            p.setPen(QColor("#7a828c"))
            p.drawText(self.rect(), Qt.AlignmentFlag.AlignCenter, "载入参考录音与待对齐录音后显示波形")
            return
        self._draw_grid(p)
        env = self.envelope()
        if env is None:
            p.end()
            return
        self._draw_tracks(p, env)
        self._draw_overlays(p)
        self._draw_time_axis(p)
        self._draw_cursor(p)
        p.end()

    def _draw_grid(self, p: QPainter) -> None:
        p.setPen(QPen(COLOR_GRID, 1))
        step = self._nice_step(self.view.span)
        t = np.ceil(self.view.start / step) * step
        rect = self._plot_rect()
        font = QFont(self.font())
        font.setPointSizeF(max(8.0, self.font().pointSizeF() - 1))
        p.setFont(font)
        while t <= self.view.end + 1e-9:
            x = self.view.x_of(t, rect)
            p.setPen(QPen(COLOR_GRID, 1, Qt.PenStyle.DotLine))
            p.drawLine(QPointF(x, rect.top()), QPointF(x, rect.bottom()))
            t += step

    def _draw_tracks(self, p: QPainter, env: dict) -> None:
        if self.result is None:
            return
        ref_rect = self._ref_rect()
        al_rect = self._aligned_rect()
        p.setPen(QPen(QColor("#eef1f4"), 1))
        p.drawRect(ref_rect)
        p.drawRect(al_rect)
        self._draw_envelope(p, ref_rect, env["ref_times"], env["ref_peak"], COLOR_REF, COLOR_REF_LIGHT)
        self._draw_envelope(p, al_rect, env["ref_times"], env["aligned_peak"], COLOR_ALIGNED, COLOR_ALIGNED_LIGHT)
        font = QFont(self.font())
        font.setPointSizeF(max(8.0, self.font().pointSizeF() - 1))
        font.setBold(True)
        p.setFont(font)
        # 标签放在轨道左上角的浅色底上, 避免与波形/区间标记重叠
        for rect, color, text in (
            (ref_rect, COLOR_REF, "参考录音 (时间基准, 未调整)"),
            (al_rect, COLOR_ALIGNED, "对齐结果 (待对齐录音经时间映射)"),
        ):
            # 标签靠在右上角: 开头/结尾的缺失区间通常覆盖左侧
            label_rect = QRectF(rect.right() - 270, rect.top() + 2, 266, 15)
            p.fillRect(label_rect, QColor(251, 252, 253, 230))
            p.setPen(color)
            p.drawText(label_rect, Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter, text)

    def _draw_envelope(self, p: QPainter, rect: QRectF, times: np.ndarray,
                       peak: np.ndarray, color: QColor, light: QColor) -> None:
        mid = rect.center().y()
        half = rect.height() * 0.5 - 10
        mask = (times >= self.view.start) & (times <= self.view.end)
        if not mask.any():
            return
        xs = self.view.x_of(times[mask], rect)
        ys = peak[mask]
        scale = 1.0 / max(float(np.percentile(ys, 99.0)) if ys.size else 1.0, 1e-6)
        ys = np.clip(ys * scale, 0.0, 1.0) * half
        path = QPainterPath()
        path.moveTo(xs[0], mid - ys[0])
        for x, y in zip(xs[1:], ys[1:]):
            path.lineTo(x, mid - y)
        for x, y in zip(xs[::-1], ys[::-1]):
            path.lineTo(x, mid + y)
        path.closeSubpath()
        p.setPen(QPen(light, 0.8))
        p.setBrush(color.lighter(150))
        p.drawPath(path)
        p.setPen(QPen(color, 1.0))
        p.drawLine(QPointF(xs[0], mid), QPointF(xs[-1], mid))

    def _draw_overlays(self, p: QPainter) -> None:
        assert self.result is not None
        rect = self._plot_rect()
        # 低置信区间
        for region in self.result.low_confidence:
            if region.ref_end < self.view.start or region.ref_start > self.view.end:
                continue
            x0 = self.view.x_of(max(region.ref_start, self.view.start), rect)
            x1 = self.view.x_of(min(region.ref_end, self.view.end), rect)
            p.fillRect(QRectF(x0, rect.top(), max(1.0, x1 - x0), rect.height()), COLOR_LOWCONF)
            p.setPen(QPen(COLOR_LOWCONF_EDGE, 1, Qt.PenStyle.DashLine))
            p.drawLine(QPointF(x0, rect.top()), QPointF(x0, rect.bottom()))
            p.drawLine(QPointF(x1, rect.top()), QPointF(x1, rect.bottom()))
        # 缺失/边界区间
        for gap in self.result.gaps:
            if gap.ref_end < self.view.start or gap.ref_start > self.view.end:
                continue
            x0 = self.view.x_of(max(gap.ref_start, self.view.start), rect)
            x1 = self.view.x_of(min(gap.ref_end, self.view.end), rect)
            band = QRectF(x0, rect.top(), max(1.0, x1 - x0), rect.height())
            p.fillRect(band, COLOR_GAP)
            p.setPen(QPen(COLOR_GAP_EDGE, 1.5))
            p.drawLine(QPointF(x0, rect.top()), QPointF(x0, rect.bottom()))
            p.drawLine(QPointF(x1, rect.top()), QPointF(x1, rect.bottom()))
            if x1 - x0 > 64:
                p.setPen(QColor("#8d1c1c"))
                label_rect = QRectF(x0 + 2, self._ref_rect().top() + 16, x1 - x0 - 4,
                                    self._ref_rect().height() * 0.5)
                p.drawText(label_rect, Qt.AlignmentFlag.AlignHCenter | Qt.AlignmentFlag.AlignTop,
                           "静音\n" + gap.label)
                aligned_rect = self._aligned_rect()
                p.drawText(QRectF(x0 + 2, aligned_rect.center().y(),
                                  x1 - x0 - 4, aligned_rect.height() * 0.3),
                           Qt.AlignmentFlag.AlignHCenter, "导出静音")
        # 自动匹配点
        p.setPen(QPen(QColor(90, 96, 104, 120), 1))
        y_mid = rect.center().y()
        for m in self.result.matches:
            if m.ref_time < self.view.start or m.ref_time > self.view.end:
                continue
            x = self.view.x_of(m.ref_time, rect)
            p.drawLine(QPointF(x, y_mid - 4), QPointF(x, y_mid + 4))
        # 人工锚点
        for anchor in self.result.anchors:
            self._draw_anchor(p, anchor.ref_time, COLOR_ANCHOR, filled=True)
        if self.pending_anchor is not None:
            self._draw_anchor(p, self.pending_anchor, COLOR_ANCHOR_PENDING, filled=False)

    def _draw_anchor(self, p: QPainter, t: float, color: QColor, filled: bool) -> None:
        rect = self._plot_rect()
        x = self.view.x_of(t, rect)
        p.setPen(QPen(color, 2))
        p.setBrush(color if filled else QColor(255, 255, 255))
        p.drawEllipse(QPointF(x, rect.top() + 9), 6, 6)
        p.drawLine(QPointF(x, rect.top() + 15), QPointF(x, rect.bottom()))

    def _draw_time_axis(self, p: QPainter) -> None:
        rect = self._plot_rect()
        p.setPen(QPen(QColor("#9aa2ab"), 1))
        y = rect.bottom()
        p.drawLine(QPointF(rect.left(), y), QPointF(rect.right(), y))
        step = self._nice_step(self.view.span)
        t = np.ceil(self.view.start / step) * step
        font = QFont(self.font())
        font.setPointSizeF(max(8.0, self.font().pointSizeF() - 1))
        p.setFont(font)
        while t <= self.view.end + 1e-9:
            x = self.view.x_of(t, rect)
            p.setPen(QPen(QColor("#9aa2ab"), 1))
            p.drawLine(QPointF(x, y), QPointF(x, y + 4))
            p.setPen(COLOR_TEXT)
            text = f"{t:.2f}s" if step < 1 else f"{t:.1f}s" if step < 10 else f"{t:.0f}s"
            p.drawText(QRectF(x - 30, y + 4, 60, 16), Qt.AlignmentFlag.AlignHCenter, text)
            t += step

    def _draw_cursor(self, p: QPainter) -> None:
        if self.cursor_ref is None or self.result is None:
            return
        rect = self._plot_rect()
        x = self.view.x_of(self.cursor_ref, rect)
        if x < rect.left() or x > rect.right():
            return
        p.setPen(QPen(COLOR_CURSOR, 1.5))
        p.drawLine(QPointF(x, rect.top()), QPointF(x, rect.bottom()))
        # 待对齐录音侧的对应位置
        t_take = float(self.result.curve.take_time_at(self.cursor_ref))
        take_rect = self._take_rect()
        if 0 <= t_take <= self.result.take_duration and take_rect.width() > 0:
            tx = take_rect.left() + t_take / max(self.result.take_duration, 1e-6) * take_rect.width()
            p.setPen(QPen(COLOR_CURSOR_TAKE, 1, Qt.PenStyle.DashLine))
            p.drawLine(QPointF(tx, take_rect.center().y() - 6),
                       QPointF(tx, take_rect.center().y() + 6))

    def _take_rect(self) -> QRectF:
        # 待对齐录音的对应位置画在参考/对齐两轨之间的小带上
        r = self._plot_rect()
        return QRectF(r.left(), r.top() + r.height() * 0.475, r.width(), r.height() * 0.04)

    @staticmethod
    def _nice_step(span: float) -> float:
        raw = span / 10.0
        if raw <= 0:
            return 1.0
        power = 10 ** np.floor(np.log10(raw))
        for mult in (1, 2, 5, 10):
            if raw <= mult * power:
                return float(mult * power)
        return float(10 * power)

    # ---- 交互 -------------------------------------------------------------

    def mousePressEvent(self, event: QMouseEvent) -> None:  # noqa: N802
        if self.result is None:
            return
        rect = self._plot_rect()
        pos = event.position()
        if rect.contains(pos):
            if event.button() == Qt.MouseButton.MiddleButton or (
                event.button() == Qt.MouseButton.LeftButton
                and event.modifiers() & Qt.KeyboardModifier.ShiftModifier
            ):
                self._dragging = True
                self._drag_start_view = ViewRange(self.view.start, self.view.end)
                self._drag_start_x = pos.x()
                return
            if event.button() == Qt.MouseButton.LeftButton and self._near_anchor(pos):
                return
            if event.button() == Qt.MouseButton.LeftButton:
                t = self.view.t_of(pos.x(), rect)
                self.cursor_ref = min(max(t, 0.0), self.result.ref_duration)
                self.cursorMoved.emit(self.cursor_ref)
                self.update()

    def mouseMoveEvent(self, event: QMouseEvent) -> None:  # noqa: N802
        if self.result is None:
            return
        rect = self._plot_rect()
        pos = event.position()
        if self._dragging and self._drag_start_view is not None:
            if rect.width() > 1:
                delta = (pos.x() - self._drag_start_x) / rect.width() * self._drag_start_view.span
                self.set_view(self._drag_start_view.start - delta,
                              self._drag_start_view.end - delta)
            return
        if rect.contains(pos):
            t = min(max(self.view.t_of(pos.x(), rect), 0.0), self.result.ref_duration)
            self.cursor_ref = t
            self.cursorMoved.emit(t)
            self.update()

    def mouseReleaseEvent(self, event: QMouseEvent) -> None:  # noqa: N802
        if self._dragging:
            self._dragging = False

    def mouseDoubleClickEvent(self, event: QMouseEvent) -> None:  # noqa: N802
        if self.result is None:
            return
        rect = self._plot_rect()
        pos = event.position()
        if rect.contains(pos) and event.button() == Qt.MouseButton.LeftButton:
            t = min(max(self.view.t_of(pos.x(), rect), 0.0), self.result.ref_duration)
            if self._near_anchor(pos):
                return
            self.pending_anchor = t
            self.anchorAddRequested.emit(t)
            self.update()

    def wheelEvent(self, event: QWheelEvent) -> None:  # noqa: N802
        if self.result is None:
            return
        rect = self._plot_rect()
        pos = event.position()
        if not rect.contains(pos):
            return
        anchor_t = self.view.t_of(pos.x(), rect)
        factor = 0.8 if event.angleDelta().y() > 0 else 1.25
        span = max(0.25, min(self.result.ref_duration, self.view.span * factor))
        frac = (anchor_t - self.view.start) / self.view.span
        start = anchor_t - frac * span
        self.set_view(start, start + span)

    def _near_anchor(self, pos: QPointF) -> bool:
        assert self.result is not None
        rect = self._plot_rect()
        for a in self.result.anchors:
            x = self.view.x_of(a.ref_time, rect)
            if abs(pos.x() - x) < 6 and pos.y() < rect.top() + 18:
                self.anchorRemoveRequested.emit(a)
                return True
        return False


class DetailView(QWidget):
    """局部放大视图: 参考与对齐结果叠画, 用于核对前部/后部对齐效果。"""

    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self.setMinimumHeight(150)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding)
        self.timeline: TimelineView | None = None
        self._cache_key = ""
        self._cache: dict | None = None

    def link(self, timeline: TimelineView) -> None:
        self.timeline = timeline
        timeline.viewChanged.connect(lambda *_: self.update())
        timeline.cursorMoved.connect(lambda *_: self.update())

    def paintEvent(self, _event) -> None:  # noqa: N802
        p = QPainter(self)
        p.fillRect(self.rect(), QColor("#ffffff"))
        if self.timeline is None or self.timeline.result is None:
            p.end()
            return
        result = self.timeline.result
        view = self.timeline.view
        rect = QRectF(self.rect()).adjusted(12, 10, -12, -26)
        p.setPen(QPen(QColor("#e2e6ea"), 1))
        p.drawRect(rect)
        # 参考与对齐包络以细线叠加, 上下相反方向, 便于比较同一参考时刻
        env = self.timeline.envelope()
        if env is None:
            p.end()
            return
        times = env["ref_times"]
        mask = (times >= view.start) & (times <= view.end)
        if not mask.any():
            p.end()
            return
        xs = [view.x_of(t, rect) for t in times[mask]]
        mid = rect.center().y()
        half = rect.height() * 0.5 - 8
        for key, color, sign in (
            ("ref_peak", COLOR_REF, -1),
            ("aligned_peak", COLOR_ALIGNED, 1),
        ):
            ys = env[key][mask]
            scale = 1.0 / max(float(np.percentile(ys, 99.0)) if ys.size else 1.0, 1e-6)
            ys = np.clip(ys * scale, 0.0, 1.0) * half
            path = QPainterPath()
            path.moveTo(xs[0], mid + sign * ys[0])
            for x, y in zip(xs[1:], ys[1:]):
                path.lineTo(x, mid + sign * y)
            p.setPen(QPen(color, 1.2))
            p.setBrush(Qt.BrushStyle.NoBrush)
            p.drawPath(path)
        p.setPen(QPen(COLOR_GAP_EDGE, 1))
        for gap in result.gaps:
            if gap.ref_end < view.start or gap.ref_start > view.end:
                continue
            x0 = view.x_of(max(gap.ref_start, view.start), rect)
            x1 = view.x_of(min(gap.ref_end, view.end), rect)
            p.fillRect(QRectF(x0, rect.top(), max(1.0, x1 - x0), rect.height()), COLOR_GAP)
        if self.timeline.cursor_ref is not None:
            x = view.x_of(self.timeline.cursor_ref, rect)
            p.setPen(QPen(COLOR_CURSOR, 1.2))
            p.drawLine(QPointF(x, rect.top()), QPointF(x, rect.bottom()))
        p.setPen(COLOR_REF)
        p.drawText(QPointF(rect.left() + 6, rect.top() + 12), "上: 参考录音")
        p.setPen(COLOR_ALIGNED)
        p.drawText(QPointF(rect.left() + 6, rect.bottom() - 4), "下: 对齐结果")
        p.end()
