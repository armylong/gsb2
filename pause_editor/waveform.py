"""波形绘制与区间手调组件 (QWidget, numpy 抽峰, 无第三方绘图库)。

两种模式:
- editable=True  : 原声视图, 可拖边/拖体/框选新建修改区, 显示冲突与计划状态
- editable=False : 成品视图, 只读, 显示拼接点 (junction) 与被删段的反馈标记

坐标一律以采样序号为模型单位, 视图维护 [view_start, view_end] 窗口。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional, Sequence, Tuple

import numpy as np
from PySide6.QtCore import QPoint, QRectF, Qt, Signal
from PySide6.QtGui import QColor, QFont, QPainter, QPen, QPolygonF
from PySide6.QtWidgets import QWidget

from .model import (
    CONFLICT,
    EDIT,
    INVALID,
    TOO_SHORT,
    DeletedSpan,
    EditRegion,
    Junction,
    PlannedRegion,
    format_time,
)

HANDLE_W = 7.0
MIN_DRAG_SAMPLES = 8

_STATUS_COLOR = {
    EDIT: QColor(64, 150, 255, 70),
    CONFLICT: QColor(235, 64, 52, 90),
    TOO_SHORT: QColor(240, 180, 40, 80),
    INVALID: QColor(120, 120, 120, 70),
}
_STATUS_EDGE = {
    EDIT: QColor(40, 110, 220),
    CONFLICT: QColor(200, 40, 30),
    TOO_SHORT: QColor(200, 140, 20),
    INVALID: QColor(90, 90, 90),
}


@dataclass
class Highlight:
    """原声/成品联动定位时的高亮反馈。"""

    ranges: List[Tuple[int, int]]      # 本视图坐标下的采样区间
    label: str = ""
    color: QColor = field(default_factory=lambda: QColor(46, 204, 113))


class WaveformView(QWidget):
    cursor_changed = Signal(int)          # 指针移动到新采样
    region_changed = Signal()             # 任何区间被手调
    region_create_requested = Signal(int, int)
    region_selected = Signal(int)         # -1 表示取消选择
    double_clicked = Signal(int)          # 双击: 请求在该点附近试听

    def __init__(self, title: str, editable: bool, parent=None):
        super().__init__(parent)
        self.setMinimumHeight(180)
        self.setMouseTracking(True)
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
        self.title = title
        self.editable = editable

        self.samples: Optional[np.ndarray] = None   # (n, ch)
        self.sample_rate = 0
        self.regions: List[EditRegion] = []
        self.plan: List[PlannedRegion] = []
        self.junctions: List[Junction] = []
        self.deleted: List[DeletedSpan] = []        # 成品视图里映射回来的删除段
        self.marks: List[Tuple[str, int]] = []
        self.orphan_marks: List[Tuple[str, int]] = []  # 被删标注 -> 成品拼接点位置

        self.view_start = 0
        self.view_end = 1
        self.cursor = 0
        self.selected_region = -1
        self.highlight: Optional[Highlight] = None

        self._drag = None       # ("move"/"l"/"r"/"pan"/"create", ...)
        self._rubber: Optional[Tuple[int, int]] = None
        self._peaks_cache = None

    # ---- 数据装载 ----
    def set_audio(self, samples: np.ndarray, sample_rate: int) -> None:
        self.samples = samples if samples.ndim == 2 else samples[:, None]
        self.sample_rate = sample_rate
        self.view_start = 0
        self.view_end = max(1, self.samples.shape[0])
        self.cursor = 0
        self._peaks_cache = None
        self.update()

    def set_regions(self, regions: Sequence[EditRegion],
                    plan: Sequence[PlannedRegion]) -> None:
        self.regions = list(regions)
        self.plan = list(plan)
        self.update()

    def set_marks(self, marks: Sequence[Tuple[str, int]]) -> None:
        self.marks = list(marks)
        self.update()

    def set_orphan_marks(self, orphans: Sequence[Tuple[str, int]]) -> None:
        """被删标注点: (标签, 成品中对应拼接点采样)。红色虚线反馈。"""
        self.orphan_marks = list(orphans)
        self.update()

    def set_feedback(self, junctions: Sequence[Junction],
                     deleted: Sequence[DeletedSpan]) -> None:
        self.junctions = list(junctions)
        self.deleted = list(deleted)
        self.update()

    def set_highlight(self, ranges: Sequence[Tuple[int, int]], label: str,
                      color: QColor = QColor(46, 204, 113)) -> None:
        self.highlight = Highlight(list(ranges), label, color)
        self.update()

    def clear_highlight(self) -> None:
        self.highlight = None
        self.update()

    def set_cursor(self, sample: int, move_view: bool = True) -> None:
        n = self.samples.shape[0] if self.samples is not None else 1
        self.cursor = int(max(0, min(sample, n - 1)))
        if move_view and not (self.view_start <= self.cursor < self.view_end):
            self.center_on(self.cursor)
        self.update()

    def center_on(self, sample: int) -> None:
        width = self.view_end - self.view_start
        half = width // 2
        n = self.samples.shape[0] if self.samples is not None else 1
        s = max(0, min(sample - half, n - width))
        self.view_start = s
        self.view_end = min(n, s + width)
        self.update()

    # ---- 坐标换算 ----
    def _plot_rect(self) -> QRectF:
        return QRectF(8.0, 22.0, max(1.0, self.width() - 16.0),
                      max(10.0, self.height() - 44.0))

    def sample_to_x(self, sample: int) -> float:
        r = self._plot_rect()
        span = max(1, self.view_end - self.view_start)
        return r.left() + (sample - self.view_start) / span * r.width()

    def x_to_sample(self, x: float) -> int:
        r = self._plot_rect()
        span = max(1, self.view_end - self.view_start)
        s = self.view_start + (x - r.left()) / max(1.0, r.width()) * span
        n = self.samples.shape[0] if self.samples is not None else 1
        return int(max(0, min(round(s), n - 1)))

    # ---- 绘制 ----
    def _compute_peaks(self) -> np.ndarray:
        """按像素列抽 min/max 峰, 缩放到当前视图; 结果缓存到下次视图变化。"""
        r = self._plot_rect()
        cols = max(1, int(r.width()))
        n, ch = self.samples.shape
        bounds = np.linspace(self.view_start, self.view_end, cols + 1).astype(np.int64)
        peaks = np.zeros((cols, ch, 2), dtype=np.float64)
        for c in range(cols):
            s0, s1 = bounds[c], bounds[c + 1]
            if s1 <= s0:
                s1 = s0 + 1
            block = self.samples[s0:min(s1, n), :]
            if block.size:
                peaks[c, :, 0] = block.min(axis=0)
                peaks[c, :, 1] = block.max(axis=0)
        return peaks

    def paintEvent(self, event):  # noqa: N802 (Qt 命名)
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing, False)
        p.fillRect(self.rect(), QColor(24, 26, 30))

        title_pen = QPen(QColor(220, 224, 230))
        p.setPen(title_pen)
        p.setFont(QFont("", 10, QFont.Weight.DemiBold))
        p.drawText(10, 15, self.title)

        if self.samples is None:
            p.setPen(QColor(150, 150, 150))
            p.drawText(self.rect(), Qt.AlignmentFlag.AlignCenter, "未载入音频")
            return

        r = self._plot_rect()
        p.fillRect(r, QColor(16, 18, 22))
        self._draw_grid(p, r)

        peaks = self._compute_peaks()
        n, ch = self.samples.shape
        row_h = r.height() / ch
        wave_pen = QPen(QColor(90, 170, 255), 1.0)
        p.setPen(wave_pen)
        for c in range(ch):
            cy = r.top() + row_h * (c + 0.5)
            half = row_h * 0.42
            for col in range(peaks.shape[0]):
                x = r.left() + col + 0.5
                y_lo = cy - peaks[col, c, 0] * half
                y_hi = cy - peaks[col, c, 1] * half
                p.drawLine(QPoint(int(x), int(y_lo)), QPoint(int(x), int(y_hi)))
            if ch > 1:
                p.setPen(QPen(QColor(90, 90, 100), 1.0, Qt.PenStyle.DashLine))
                p.drawLine(QPoint(int(r.left()), int(cy + half)),
                           QPoint(int(r.right()), int(cy + half)))
                p.setPen(wave_pen)

        self._draw_regions(p, r)
        self._draw_feedback(p, r)
        self._draw_marks(p, r)
        self._draw_orphan_marks(p, r)
        self._draw_highlight(p, r)
        self._draw_cursor(p, r)
        self._draw_rubber(p, r)

    def _draw_grid(self, p: QPainter, r: QRectF) -> None:
        span = max(1, self.view_end - self.view_start)
        # 选一个让刻度间距在 60~160 px 的"漂亮"步长 (采样数)
        target = span / max(1.0, r.width()) * 100.0
        nice = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000,
                10000, 20000, 50000, 100000, 200000, 500000, 1000000]
        step = nice[-1]
        for cand in nice:
            if cand >= target:
                step = cand
                break
        pen = QPen(QColor(45, 48, 55), 1.0)
        p.setPen(pen)
        first = ((self.view_start // step) + 1) * step
        s = first
        while s < self.view_end:
            x = self.sample_to_x(s)
            p.drawLine(QPoint(int(x), int(r.top())), QPoint(int(x), int(r.bottom())))
            p.setPen(QColor(130, 135, 145))
            p.drawText(QRectF(x - 45, r.bottom() + 2, 90, 16),
                       Qt.AlignmentFlag.AlignCenter, format_time(self.sample_rate, s))
            p.setPen(pen)
            s += step

    def _status_of(self, idx: int) -> str:
        for pr in self.plan:
            if pr.index == idx:
                return pr.status
        return EDIT

    def _draw_regions(self, p: QPainter, r: QRectF) -> None:
        if not self.editable:
            return
        for idx, reg in enumerate(self.regions):
            x0 = self.sample_to_x(reg.start)
            x1 = self.sample_to_x(reg.end)
            rect = QRectF(x0, r.top(), max(2.0, x1 - x0), r.height())
            status = self._status_of(idx)
            p.fillRect(rect, _STATUS_COLOR[status])
            edge = _STATUS_EDGE[status]
            width = 2.0 if idx == self.selected_region else 1.2
            p.setPen(QPen(edge, width))
            p.drawRect(rect)
            # 两侧拖动手柄
            p.fillRect(QRectF(x0 - HANDLE_W / 2, r.top(), HANDLE_W, r.height()),
                       edge)
            p.fillRect(QRectF(x1 - HANDLE_W / 2, r.top(), HANDLE_W, r.height()),
                       edge)
            # 保留长度标注
            p.setPen(QColor(235, 238, 245))
            p.drawText(QRectF(x0, r.top() + 2, max(40.0, x1 - x0), 14),
                       Qt.AlignmentFlag.AlignCenter, f"{reg.keep_ms:g}ms")

    def _draw_feedback(self, p: QPainter, r: QRectF) -> None:
        if self.editable:
            return
        # 成品视图: 拼接点画竖线, 被删段用红色阴影 + 叉号反馈
        for sp in self.deleted:
            x = self.sample_to_x(sp.dst_start)
            p.setPen(QPen(QColor(235, 64, 52), 1.5))
            p.drawLine(QPoint(int(x), int(r.top())), QPoint(int(x), int(r.bottom())))
            # 小三角指向拼接点
            tri = QPolygonF([
                QPoint(int(x) - 4, int(r.top())),
                QPoint(int(x) + 4, int(r.top())),
                QPoint(int(x), int(r.top()) + 6),
            ])
            p.setBrush(QColor(235, 64, 52))
            p.drawPolygon(tri)
            p.setBrush(Qt.BrushStyle.NoBrush)
        for jc in self.junctions:
            x0, x1 = self.sample_to_x(jc.dst_start), self.sample_to_x(jc.dst_end)
            p.fillRect(QRectF(x0, r.top(), max(2.0, x1 - x0), r.height()),
                       QColor(46, 204, 113, 45))

    def _draw_marks(self, p: QPainter, r: QRectF) -> None:
        p.setFont(QFont("", 8))
        for label, sample in self.marks:
            if not (self.view_start <= sample < self.view_end):
                continue
            x = self.sample_to_x(sample)
            p.setPen(QPen(QColor(255, 214, 70), 1.4))
            p.drawLine(QPoint(int(x), int(r.top())), QPoint(int(x), int(r.bottom())))
            p.setPen(QColor(255, 214, 70))
            p.drawText(QPoint(int(x) + 2, int(r.top()) + 12), str(label))

    def _draw_orphan_marks(self, p: QPainter, r: QRectF) -> None:
        """被删标注: 红色虚线 + 叉号, 落在成品拼接点上。"""
        if not self.orphan_marks:
            return
        pen = QPen(QColor(255, 90, 80), 1.4, Qt.PenStyle.DashLine)
        p.setPen(pen)
        p.setFont(QFont("", 8))
        for label, sample in self.orphan_marks:
            x = self.sample_to_x(sample)
            p.drawLine(QPoint(int(x), int(r.top())), QPoint(int(x), int(r.bottom())))
            d = 5
            p.drawLine(QPoint(int(x) - d, int(r.top()) + 3),
                       QPoint(int(x) + d, int(r.top()) + 3 + 2 * d))
            p.drawLine(QPoint(int(x) + d, int(r.top()) + 3),
                       QPoint(int(x) - d, int(r.top()) + 3 + 2 * d))
            p.setPen(QColor(255, 120, 110))
            p.drawText(QPoint(int(x) + 3, int(r.bottom()) - 4),
                       f"{label}(已删)")
            p.setPen(pen)

    def _draw_highlight(self, p: QPainter, r: QRectF) -> None:
        if not self.highlight:
            return
        p.setBrush(QColor(self.highlight.color.red(), self.highlight.color.green(),
                          self.highlight.color.blue(), 55))
        pen = QPen(self.highlight.color, 1.6, Qt.PenStyle.DashLine)
        p.setPen(pen)
        for s0, s1 in self.highlight.ranges:
            x0, x1 = self.sample_to_x(s0), self.sample_to_x(s1)
            p.drawRect(QRectF(x0, r.top(), max(2.0, x1 - x0), r.height()))
        p.setBrush(Qt.BrushStyle.NoBrush)
        if self.highlight.label:
            p.setPen(self.highlight.color)
            p.drawText(QPoint(int(r.left() + 6), int(r.bottom() - 4)),
                       self.highlight.label)

    def _draw_cursor(self, p: QPainter, r: QRectF) -> None:
        x = self.sample_to_x(self.cursor)
        p.setPen(QPen(QColor(245, 245, 245), 1.2))
        p.drawLine(QPoint(int(x), int(r.top())), QPoint(int(x), int(r.bottom())))

    def _draw_rubber(self, p: QPainter, r: QRectF) -> None:
        if not self._rubber:
            return
        s0, s1 = self._rubber
        x0, x1 = self.sample_to_x(s0), self.sample_to_x(s1)
        p.fillRect(QRectF(x0, r.top(), x1 - x0, r.height()), QColor(64, 150, 255, 45))
        p.setPen(QPen(QColor(120, 180, 255), 1.0, Qt.PenStyle.DashLine))
        p.drawRect(QRectF(x0, r.top(), x1 - x0, r.height()))

    # ---- 鼠标交互 ----
    def _hit_region(self, x: float) -> Tuple[int, str]:
        """返回 (区间序号, 'l'/'r'/'body')；未命中返回 (-1, '')。"""
        for idx in range(len(self.regions) - 1, -1, -1):
            reg = self.regions[idx]
            x0, x1 = self.sample_to_x(reg.start), self.sample_to_x(reg.end)
            if abs(x - x0) <= HANDLE_W:
                return idx, "l"
            if abs(x - x1) <= HANDLE_W:
                return idx, "r"
            if x0 < x < x1:
                return idx, "body"
        return -1, ""

    def mousePressEvent(self, event):  # noqa: N802
        if self.samples is None:
            return
        x = event.position().x()
        s = self.x_to_sample(x)
        if event.button() == Qt.MouseButton.MiddleButton or (
            event.button() == Qt.MouseButton.LeftButton
            and event.modifiers() & Qt.KeyboardModifier.ShiftModifier
        ):
            self._drag = ("pan", self.view_start, self.view_end, x)
            return
        if event.button() == Qt.MouseButton.LeftButton:
            if self.editable:
                idx, where = self._hit_region(x)
                if idx >= 0:
                    self.selected_region = idx
                    self.region_selected.emit(idx)
                    reg = self.regions[idx]
                    self._drag = (where, idx, reg.start, reg.end, s)
                    self.update()
                    return
                # 空白处: 开始框选新区间
                self.selected_region = -1
                self.region_selected.emit(-1)
                self._rubber = (s, s)
                self._drag = ("create", s)
            self.set_cursor(s)
            self.cursor_changed.emit(s)

    def mouseMoveEvent(self, event):  # noqa: N802
        if self.samples is None:
            return
        x = event.position().x()
        s = self.x_to_sample(x)
        if not self._drag:
            if self.editable:
                idx, where = self._hit_region(x)
                self.setCursor(Qt.CursorShape.SizeHorCursorCursor if where in ("l", "r")
                               else Qt.CursorShape.OpenHandCursor if where == "body"
                               else Qt.CursorShape.IBeamCursor)
            return
        kind = self._drag[0]
        if kind == "pan":
            _, vs, ve, x0 = self._drag
            span = ve - vs
            delta = int((x0 - x) / max(1.0, self._plot_rect().width()) * span)
            n = self.samples.shape[0]
            self.view_start = max(0, min(vs + delta, n - span))
            self.view_end = self.view_start + span
            self.update()
        elif kind == "create":
            self._rubber = (self._drag[1], s)
            self.update()
        elif self.editable and kind in ("l", "r", "move"):
            _, idx, ostart, oend, anchor = self._drag
            reg = self.regions[idx]
            n = self.samples.shape[0]
            if kind == "l":
                reg.start = max(0, min(s, reg.end - 1))
            elif kind == "r":
                reg.end = min(n, max(s, reg.start + 1))
            else:
                delta = s - anchor
                length = oend - ostart
                new0 = max(0, min(ostart + delta, n - length))
                reg.start, reg.end = new0, new0 + length
            self.region_changed.emit()
            self.update()

    def mouseReleaseEvent(self, event):  # noqa: N802
        if not self._drag:
            return
        kind = self._drag[0]
        if kind == "create" and self._rubber:
            s0, s1 = self._rubber
            s0, s1 = min(s0, s1), max(s0, s1)
            if s1 - s0 >= MIN_DRAG_SAMPLES:
                self.region_create_requested.emit(s0, s1)
            self._rubber = None
        self._drag = None
        self.update()

    def mouseDoubleClickEvent(self, event):  # noqa: N802
        if self.samples is None:
            return
        s = self.x_to_sample(event.position().x())
        self.set_cursor(s)
        self.cursor_changed.emit(s)
        self.double_clicked.emit(s)

    def wheelEvent(self, event):  # noqa: N802
        if self.samples is None:
            return
        anchor = self.x_to_sample(event.position().x())
        factor = 1.0 / 1.25 if event.angleDelta().y() > 0 else 1.25
        span = max(20, int((self.view_end - self.view_start) * factor))
        n = self.samples.shape[0]
        span = min(span, n)
        rel = (anchor - self.view_start) / max(1, self.view_end - self.view_start)
        s0 = int(anchor - rel * span)
        s0 = max(0, min(s0, n - span))
        self.view_start, self.view_end = s0, min(n, s0 + span)
        self.update()

    def zoom_all(self) -> None:
        if self.samples is not None:
            self.view_start, self.view_end = 0, self.samples.shape[0]
            self.update()
