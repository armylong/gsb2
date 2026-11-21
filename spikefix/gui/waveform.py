"""波形视图: 概览条带 + 可缩放细节视图, 支持候选高亮与范围拖拽."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from PySide6.QtCore import QPointF, QRectF, Qt, Signal
from PySide6.QtGui import QBrush, QColor, QFont, QPainter, QPen
from PySide6.QtWidgets import QLabel, QSizePolicy, QVBoxLayout, QWidget

from ..model import Candidate, Project
from ..dsp import merge_spans


CH_COLORS = [
    (QColor(56, 142, 255), QColor(115, 182, 255)),
    (QColor(255, 145, 64), QColor(255, 190, 120)),
    (QColor(90, 200, 120), QColor(150, 230, 170)),
    (QColor(200, 120, 220), QColor(225, 170, 240)),
]


@dataclass
class ViewRange:
    start: int
    end: int

    @property
    def span(self) -> int:
        return max(1, self.end - self.start)


class WaveformView(QWidget):
    """显示指定声道的原始波形 (及可选修复叠加)."""

    seeked = Signal(int)            # 单击定位 (帧)
    range_selected = Signal(int, int)  # 拖动选择区间 (帧)
    candidate_clicked = Signal(int)    # 点击候选 id
    candidate_dragged = Signal(int, int, int)  # 拖动中: id, start, end
    candidate_committed = Signal(int, int, int)  # 松开鼠标: id, start, end
    view_changed = Signal(int, int)    # 用户缩放/平移后 (帧)

    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self.setMinimumHeight(150)
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)
        self.setMouseTracking(True)
        self.setFocusPolicy(Qt.StrongFocus)
        self.project: Project | None = None
        self.channel = 0
        self.view = ViewRange(0, 1)
        self.repaired_overlay = False
        self.selected_id: int | None = None
        self.playhead: int | None = None
        self.loop_range: tuple[int, int] | None = None
        self.show_protected = True
        self._drag_start: QPointF | None = None
        self._last_mouse_x = 0.0
        self._drag_mode = None
        self._drag_cand: Candidate | None = None
        self._drag_orig_span = None
        self._drag_preview = None
        self._cand_rects: dict[int, QRectF] = {}
        self._envelope_cache = None

    # ---------------------------------------------------------------- 数据
    def set_project(self, project: Project | None) -> None:
        self.project = project
        self.update()

    def set_channel(self, channel: int) -> None:
        self.channel = channel
        self.update()

    def set_view(self, start: int, end: int) -> None:
        if self.project is None:
            return
        n = self.project.frames
        start = int(max(0, min(start, n - 1)))
        end = int(max(start + 1, min(end, n)))
        self.view = ViewRange(start, end)
        self._sync_overview()
        self.update()

    def _sync_overview(self) -> None:
        ov = getattr(self, "_overview", None)
        if ov is not None:
            ov.set_view(self.view.start, self.view.end)

    def set_selected(self, cid: int | None) -> None:
        self.selected_id = cid
        self.update()

    def set_playhead(self, frame: int | None) -> None:
        self.playhead = frame
        self.update()

    def set_loop_range(self, start: int | None, end: int | None) -> None:
        self.loop_range = (start, end) if start is not None and end is not None else None
        self.update()

    # ---------------------------------------------------------------- 坐标
    def _x_of(self, frame: float, width: float) -> float:
        return (frame - self.view.start) / max(1, self.view.span) * width

    def _frame_at(self, x: float, width: float) -> int:
        f = self.view.start + x / max(1.0, width) * self.view.span
        return int(round(f))

    # ---------------------------------------------------------------- 绘制
    def paintEvent(self, event) -> None:  # noqa: N802
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing, False)
        rect = self.rect()
        p.fillRect(rect, QColor(22, 24, 28))
        if self.project is None or not self.project.loaded:
            p.setPen(QColor(150, 150, 150))
            p.drawText(rect, Qt.AlignCenter, "打开 WAV 文件或生成样例")
            return
        if self.channel >= self.project.channels:
            return
        w = rect.width()
        h = rect.height()
        x0, x1 = self.view.start, self.view.end
        n = self.project.frames
        x0 = max(0, min(x0, n))
        x1 = max(x0 + 1, min(x1, n))
        orig = self.project.original.samples
        # 主波形始终画原始采样, 修复结果用绿色叠加, 便于看清"改了什么"
        audio = orig[x0:x1, self.channel]
        width_px = max(1, int(w))
        p.setPen(QPen(QColor(70, 74, 82), 1, Qt.DotLine))
        mid = h / 2.0
        p.drawLine(0, int(mid), w, int(mid))

        # 循环区间底色
        if self.loop_range:
            a, b = self.loop_range
            xa = self._x_of(max(a, x0), w)
            xb = self._x_of(min(b, x1), w)
            p.fillRect(QRectF(xa, 0, xb - xa, h), QColor(80, 130, 90, 45))

        # 波形 (密集时用最小/最大包络)
        color = CH_COLORS[self.channel % len(CH_COLORS)][0]
        if len(audio) <= width_px * 2:
            p.setPen(QPen(color, 1))
            if len(audio) > 1:
                for i in range(1, len(audio)):
                    p.drawLine(QPointF(self._x_of(x0 + i - 1, w),
                                       mid - audio[i - 1] * mid * 0.95),
                               QPointF(self._x_of(x0 + i, w),
                                       mid - audio[i] * mid * 0.95))
            elif len(audio) == 1:
                xc = self._x_of(x0, w)
                yc = mid - audio[0] * mid * 0.95
                p.drawEllipse(QPointF(xc, yc), 2.0, 2.0)
        else:
            chunks = np.array_split(audio, width_px)
            mins = np.array([c.min() if c.size else 0.0 for c in chunks])
            maxs = np.array([c.max() if c.size else 0.0 for c in chunks])
            p.setPen(QPen(color, 1))
            for i in range(width_px):
                ya = mid - maxs[i] * mid * 0.95
                yb = mid - mins[i] * mid * 0.95
                p.drawLine(QPointF(i + 0.5, ya), QPointF(i + 0.5, yb))

        # 修复叠加 (绿色) —— 原始采样保持为底色, 只叠加被修复/预览的区间
        rep = self.project.repaired_samples(include_preview=True)
        overlay_spans: list[tuple[int, int]] = []
        if self.repaired_overlay:
            overlay_spans.extend(self.project.applied_spans().get(self.channel, []))
        sel = self.project.candidate(self.selected_id) if self.selected_id else None
        if (self.repaired_overlay and self.project.include_preview
                and sel is not None and sel.channel == self.channel
                and sel.state != "rejected"):
            overlay_spans.append((sel.start, sel.end))
        if overlay_spans:
            overlay_spans = merge_spans(overlay_spans, gap=0)[0]
            for a, b in overlay_spans:
                if b < x0 or a > x1:
                    continue
                lo, hi = max(a - 1, x0), min(b + 2, x1)
                # 绿色曲线: 区间内外锚点 + 修复值
                p.setPen(QPen(QColor(90, 235, 150, 200), 1.5))
                prev = None
                for f in range(lo, hi):
                    pt = QPointF(self._x_of(f, w), mid - rep[f, self.channel] * mid * 0.95)
                    if prev is not None:
                        p.drawLine(prev, pt)
                    prev = pt
                # 每个被改动的采样: 从原值到新值的连线 + 圆点
                p.setPen(QPen(QColor(255, 170, 90, 220), 1))
                for f in range(a, min(b + 1, x1)):
                    if f < x0:
                        continue
                    xc = self._x_of(f, w)
                    y_old = mid - orig[f, self.channel] * mid * 0.95
                    y_new = mid - rep[f, self.channel] * mid * 0.95
                    p.drawLine(QPointF(xc, y_old), QPointF(xc, y_new))
                p.setPen(QPen(QColor(40, 120, 70), 1))
                p.setBrush(QBrush(QColor(90, 235, 150)))
                for f in range(a, min(b + 1, x1)):
                    if f < x0:
                        continue
                    pt = QPointF(self._x_of(f, w), mid - rep[f, self.channel] * mid * 0.95)
                    p.drawEllipse(pt, 3.0, 3.0)
                p.setBrush(Qt.NoBrush)

        # 高倍缩放时在选中候选附近画出采样刻度, 便于核对是哪几个采样被改动
        px_per_sample = w / max(1, x1 - x0)
        if px_per_sample >= 4.0 and sel is not None and sel.channel == self.channel:
            margin = max(6, int((sel.end - sel.start + 1) * 2))
            lo = max(sel.start - margin, x0)
            hi = min(sel.end + 1 + margin, x1)
            if hi > lo:
                p.setPen(QPen(QColor(130, 138, 150, 120), 1))
                step = max(1, int(np.ceil(2.0 / px_per_sample)))
                for f in range(lo, hi, step):
                    xc = self._x_of(f, w)
                    p.drawLine(QPointF(xc, h - 8), QPointF(xc, h - 2))
                p.setPen(QPen(QColor(150, 158, 170, 180), 1))
                for f in range(lo, hi, max(1, int(round(1 / px_per_sample)) * 5)):
                    xc = self._x_of(f, w)
                    p.drawLine(QPointF(xc, mid - 4), QPointF(xc, mid + 4))

        # 候选标记
        self._cand_rects.clear()
        font = QFont()
        font.setPointSize(8)
        p.setFont(font)
        for cand in self.project.sorted_candidates(self.channel):
            c_start, c_end = cand.start, cand.end
            if (self._drag_preview is not None and self._drag_cand is not None
                    and cand.id == self._drag_cand.id):
                c_start, c_end = self._drag_preview
            if c_end < x0 or c_start > x1:
                continue
            if cand.kind == "protected" and not self.show_protected:
                continue
            xa = self._x_of(c_start, w)
            xb = self._x_of(c_end + 1, w)
            if xb - xa < 3:
                xb = xa + 3
            rect_c = QRectF(xa - 1, 0, max(3.0, xb - xa + 2), h)
            self._cand_rects[cand.id] = rect_c
            if cand.state == "accepted":
                fill = QColor(60, 200, 120, 55)
                edge = QColor(70, 230, 140)
            elif cand.state == "rejected":
                fill = QColor(120, 120, 120, 35)
                edge = QColor(120, 120, 120)
            elif cand.kind == "protected":
                fill = QColor(230, 170, 40, 40)
                edge = QColor(240, 190, 70)
            else:
                fill = QColor(230, 70, 70, 45)
                edge = QColor(255, 110, 110)
            if cand.kind == "protected" and cand.state == "pending":
                pen = QPen(edge, 1, Qt.DashLine)
            else:
                pen = QPen(edge, 1.5 if cand.id == self.selected_id else 1)
            p.setPen(pen)
            p.setBrush(QBrush(fill))
            p.drawRect(rect_c)
            p.setBrush(Qt.NoBrush)
            if cand.id == self.selected_id:
                p.setPen(QPen(QColor(255, 255, 255), 1, Qt.DotLine))
                p.drawLine(QPointF(rect_c.left(), 0), QPointF(rect_c.left(), h))
                p.drawLine(QPointF(rect_c.right(), 0), QPointF(rect_c.right(), h))

        # 播放头
        if self.playhead is not None and x0 <= self.playhead <= x1:
            xp = self._x_of(self.playhead, w)
            p.setPen(QPen(QColor(255, 255, 255, 180), 1))
            p.drawLine(QPointF(xp, 0), QPointF(xp, h))

        # 拖动选择中的临时区间
        if self._drag_mode == "select" and self._drag_start is not None:
            cur = self._last_mouse_x
            xa = self._x_of(self._frame_at(self._drag_start.x(), w), w)
            xb = self._x_of(self._frame_at(cur, w), w)
            p.setBrush(QBrush(QColor(120, 160, 255, 45)))
            p.setPen(QPen(QColor(140, 170, 255), 1, Qt.DashLine))
            p.drawRect(QRectF(min(xa, xb), 0, abs(xb - xa), h))

        # 左上角信息
        p.setPen(QColor(190, 195, 205))
        text = (f"CH{self.channel + 1}  {x0}–{x1} 帧  "
                f"({(x1 - x0) / self.project.sample_rate * 1000:.1f} ms)")
        p.drawText(8, 16, text)
        p.end()

    # ---------------------------------------------------------------- 交互
    def mousePressEvent(self, event) -> None:  # noqa: N802
        if self.project is None or not self.project.loaded:
            return
        pos = event.position()
        self._last_mouse_x = pos.x()
        if event.button() == Qt.LeftButton:
            for cid, rect in self._cand_rects.items():
                if rect.adjusted(-2, 0, 2, 0).contains(pos):
                    cand = self.project.candidate(cid)
                    if cand is not None:
                        self._drag_cand = cand
                        self._drag_orig_span = (cand.start, cand.end)
                        left = abs(pos.x() - rect.left()) < 4
                        right = abs(pos.x() - rect.right()) < 4
                        if cand.state == "accepted" and (left or right):
                            self._drag_mode = "resize-left" if left else "resize-right"
                        else:
                            self._drag_mode = "move"
                        self.candidate_clicked.emit(cid)
                    return
            self._drag_mode = "select"
            self._drag_start = pos
            self.seeked.emit(self._frame_at(pos.x(), self.width()))

    def mouseMoveEvent(self, event) -> None:  # noqa: N802
        pos = event.position()
        self._last_mouse_x = pos.x()
        if self._drag_mode in ("move", "resize-left", "resize-right") and self._drag_cand is not None:
            frame = self._frame_at(pos.x(), self.width())
            s, e = self._drag_orig_span
            if self._drag_mode == "move":
                width = e - s
                new_s = max(0, min(frame - width // 2, self.project.frames - 1 - width))
                self._drag_preview = (new_s, new_s + width)
            elif self._drag_mode == "resize-left":
                self._drag_preview = (min(frame, e), e)
            else:
                self._drag_preview = (s, max(frame, s))
            self.update()
        elif self._drag_mode == "select" and self._drag_start is not None:
            self.update()
        elif self._drag_mode is None:
            self.setCursor(Qt.ArrowCursor)

    def mouseReleaseEvent(self, event) -> None:  # noqa: N802
        if self._drag_mode == "select" and self._drag_start is not None:
            w = self.width()
            a = self._frame_at(self._drag_start.x(), w)
            b = self._frame_at(event.position().x(), w)
            self._drag_start = None
            self._drag_mode = None
            if abs(a - b) >= 1:
                self.range_selected.emit(min(a, b), max(a, b))
            self.update()
            return
        if self._drag_mode == "move" and self._drag_cand is not None:
            if self._drag_preview is not None:
                s, e = self._drag_preview
                self.candidate_committed.emit(self._drag_cand.id, s, e)
        elif self._drag_mode in ("resize-left", "resize-right") and self._drag_cand is not None:
            if self._drag_preview is not None:
                s, e = self._drag_preview
                self.candidate_committed.emit(self._drag_cand.id, s, e)
        self._drag_mode = None
        self._drag_cand = None
        self._drag_start = None
        self._drag_preview = None
        self.update()

    def wheelEvent(self, event) -> None:  # noqa: N802
        if self.project is None or not self.project.loaded:
            return
        delta = event.angleDelta().y()
        if delta == 0:
            return
        factor = 0.8 if delta > 0 else 1.25
        anchor = self._frame_at(event.position().x(), self.width())
        span = int(self.view.span * factor)
        n = self.project.frames
        span = int(np.clip(span, 16, n))
        frac = (anchor - self.view.start) / max(1, self.view.span)
        start = int(anchor - frac * span)
        start = max(0, min(start, n - span))
        self.set_view(start, start + span)
        self.view_changed.emit(self.view.start, self.view.end)

    def keyPressEvent(self, event) -> None:  # noqa: N802
        if self.project is None:
            return
        if event.key() == Qt.Key_Left:
            shift = self.view.start - max(1, self.view.span // 8)
            self.set_view(shift, shift + self.view.span)
            self.view_changed.emit(self.view.start, self.view.end)
        elif event.key() == Qt.Key_Right:
            shift = self.view.start + max(1, self.view.span // 8)
            self.set_view(shift, shift + self.view.span)
            self.view_changed.emit(self.view.start, self.view.end)


class OverviewBar(QWidget):
    """整段波形概览, 可拖动视窗."""

    view_changed = Signal(int, int)

    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self.setMinimumHeight(46)
        self.setMaximumHeight(60)
        self.project: Project | None = None
        self.channel = 0
        self.view = ViewRange(0, 1)
        self._drag = False

    def set_project(self, project: Project | None) -> None:
        self.project = project
        self.update()

    def set_channel(self, channel: int) -> None:
        self.channel = channel
        self.update()

    def set_view(self, start: int, end: int) -> None:
        self.view = ViewRange(start, end)
        self.update()

    def paintEvent(self, event) -> None:  # noqa: N802
        p = QPainter(self)
        rect = self.rect()
        p.fillRect(rect, QColor(30, 32, 38))
        if self.project is None or not self.project.loaded:
            return
        audio = self.project.original.samples[:, self.channel]
        w = rect.width()
        cols = max(1, int(w))
        chunks = np.array_split(audio, cols)
        mins = np.array([c.min() if c.size else 0.0 for c in chunks])
        maxs = np.array([c.max() if c.size else 0.0 for c in chunks])
        mid = rect.height() / 2.0
        p.setPen(QPen(CH_COLORS[self.channel % len(CH_COLORS)][1], 1))
        for i in range(len(chunks)):
            p.drawLine(QPointF(i + 0.5, mid - maxs[i] * mid * 0.9),
                       QPointF(i + 0.5, mid - mins[i] * mid * 0.9))
        n = self.project.frames
        xa = self.view.start / max(1, n) * w
        xb = self.view.end / max(1, n) * w
        p.fillRect(QRectF(0, 0, xa, rect.height()), QColor(0, 0, 0, 110))
        p.fillRect(QRectF(xb, 0, w - xb, rect.height()), QColor(0, 0, 0, 110))
        p.setPen(QPen(QColor(220, 220, 220), 1))
        p.drawRect(QRectF(xa, 0, max(2, xb - xa), rect.height()))
        p.end()

    def _emit(self, x: float) -> None:
        if self.project is None:
            return
        n = self.project.frames
        center = int(x / max(1, self.width()) * n)
        span = self.view.span
        start = int(np.clip(center - span / 2, 0, max(0, n - span)))
        self.view_changed.emit(start, start + span)

    def mousePressEvent(self, event) -> None:  # noqa: N802
        self._drag = True
        self._emit(event.position().x())

    def mouseMoveEvent(self, event) -> None:  # noqa: N802
        if self._drag:
            self._emit(event.position().x())

    def mouseReleaseEvent(self, event) -> None:  # noqa: N802
        self._drag = False


class ChannelStrip(QWidget):
    """单个声道的概览 + 细节视图 + 声道信息."""

    def __init__(self, channel: int, parent=None) -> None:
        super().__init__(parent)
        self.channel = 0
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(2)
        self.header = QLabel("CH1")
        self.header.setStyleSheet("color:#c8ccd4; font-weight:600; padding-left:4px;")
        self.overview = OverviewBar()
        self.detail = WaveformView()
        layout.addWidget(self.header)
        layout.addWidget(self.overview)
        layout.addWidget(self.detail, 1)
        self.detail.set_channel(channel)
        self.overview.set_channel(channel)
        self.channel = channel
        self.header.setText(f"CH{channel + 1}")
        self.overview.view_changed.connect(self.detail.set_view)
        self.detail._overview = self.overview

    def set_project(self, project: Project | None) -> None:
        self.overview.set_project(project)
        self.detail.set_project(project)

    def set_view(self, start: int, end: int) -> None:
        self.detail.set_view(start, end)
        self.overview.set_view(start, end)

    def sync_view(self, start: int, end: int) -> None:
        self.overview.set_view(start, end)
