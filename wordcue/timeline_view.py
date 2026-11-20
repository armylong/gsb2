"""时间轴画布: 波形 + 词块 + 共享游标.

所有坐标换算集中在 ``ms_to_x`` / ``x_to_ms``, 播放位置、拖拽游标和拖动词边界
都走这一对函数, 保证屏幕、音频、导出使用同一时间基准。
"""

from __future__ import annotations

import math

from PySide6.QtCore import QRectF, Qt, Signal
from PySide6.QtGui import (QColor, QFont, QFontMetricsF, QMouseEvent, QPainter,
                           QPainterPath, QPen, QPixmap, QWheelEvent)
from PySide6.QtWidgets import QSizePolicy, QWidget

from .audio import Peaks
from .model import Cue, Timeline


BG = QColor("#10141A")
LANE = QColor("#161C24")
LANE_ALT = QColor("#141A21")
RULER = QColor("#1C2430")
GRID = QColor("#222B37")
TEXT = QColor("#D6DDE8")
MUTED = QColor("#6E798B")
FAINT = QColor("#3E4857")
ACCENT = QColor("#F5B942")
ACCENT_DIM = QColor("#6E5426")
PAUSE_FILL = QColor("#2C3542")
PAUSE_EDGE = QColor("#7C899C")
SELECT = QColor("#7FD1C8")
PLAYHEAD = QColor("#FF6B6B")
BAD = QColor("#E45757")
WARN = QColor("#E0A93C")
WAVE = QColor("#4A90D9")
WAVE_PLAYED = QColor("#7AB8F5")

HANDLE = 7          # 词块两侧抓取区宽度 (px)
MIN_VISIBLE_MS = 300


class TimelineView(QWidget):
    """可横向滚动的逐词时间轴。

    交互:
      * 单击词块: 选中; Ctrl/Shift 多选
      * 拖动词块中部: 整体搬运 (保持长度)
      * 拖动词块两侧 7px: 调整开始/结束边界 (ripple 时同步前一词)
      * 单击空白/标尺: 移动播放游标
      * 在标尺上拖动: 拖动游标 (scrub)
      * 滚轮: 缩放; Shift+滚轮 / 触控板横向: 平移
      * 双击词块: 循环播放该词 (由主窗口响应 cueActivated)
    """

    positionClicked = Signal(int)          # ms
    selectionChanged = Signal(list)        # list[int]
    cueActivated = Signal(int)             # 双击
    edgeDragged = Signal(int, str, int, bool)   # cue_id, "start"/"end", value_ms, finished
    cueMoved = Signal(int, int, bool)      # cue_id, new_start, finished
    viewChanged = Signal()

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.timeline = Timeline(duration=10_000)
        self.peaks: Peaks | None = None
        self.position_ms = 0
        self.selected: set[int] = set()
        self.ripple = True
        self._zoom = 1.0                 # 1.0 = 整段音轨铺满宽度
        self._offset = 0.0               # 0..1, 视口起点占全长的比例
        self._bad_ids: set[int] = set()
        self._warn_ids: set[int] = set()
        self._active_loop_id: int | None = None
        self._wave_key = None
        self._wave_cache = None
        self._drag: dict | None = None
        self._scrubbing = False
        self.setMouseTracking(True)
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
        self.setMinimumHeight(190)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)

    # ------------------------------------------------------------------ 数据
    def set_timeline(self, timeline: Timeline, peaks: Peaks | None = None) -> None:
        self.timeline = timeline
        if peaks is not None:
            self.peaks = peaks
        self.selected &= {c.id for c in timeline.cues}
        self._clamp_view()
        self.refresh_issues()
        self.update()

    def refresh_issues(self) -> None:
        self._bad_ids = set()
        self._warn_ids = set()
        for issue in self.timeline.conflicts():
            if issue.level == "error":
                self._bad_ids.update(issue.cue_ids)
            elif issue.level == "warning":
                self._warn_ids.update(issue.cue_ids)
        self.update()

    def set_position(self, ms: int) -> None:
        ms = max(0, min(self.timeline.duration, int(ms)))
        if ms != self.position_ms:
            self.position_ms = ms
            self.update()

    def set_selection(self, ids: list[int]) -> None:
        new = set(ids)
        if new != self.selected:
            self.selected = new
            self.update()
            self.selectionChanged.emit(sorted(self.selected))

    def select_cue(self, cue_id: int, additive: bool = False) -> None:
        if additive:
            if cue_id in self.selected:
                self.selected.discard(cue_id)
            else:
                self.selected.add(cue_id)
        else:
            self.selected = {cue_id}
        self.update()
        self.selectionChanged.emit(sorted(self.selected))

    def set_active_loop(self, cue_id: int | None) -> None:
        self._active_loop_id = cue_id
        self.update()

    # ------------------------------------------------------------- 坐标换算
    @property
    def span_ms(self) -> float:
        total = max(1, self.timeline.duration)
        return total / self._zoom

    @property
    def view_start_ms(self) -> float:
        total = max(1, self.timeline.duration)
        start = self._offset * total
        return max(0.0, min(total - self.span_ms, start))

    def ms_to_x(self, ms: float) -> float:
        left = self._plot_rect().left()
        width = max(1.0, self._plot_rect().width())
        return left + (ms - self.view_start_ms) / self.span_ms * width

    def x_to_ms(self, x: float) -> int:
        left = self._plot_rect().left()
        width = max(1.0, self._plot_rect().width())
        ratio = (x - left) / width
        return int(round(self.view_start_ms + ratio * self.span_ms))

    def _plot_rect(self) -> QRectF:
        return QRectF(12, 30, max(10, self.width() - 24), max(10, self.height() - 42))

    # ------------------------------------------------------------------ 缩放
    def zoom_at(self, factor: float, anchor_x: float | None = None) -> None:
        if anchor_x is None:
            anchor_x = self._plot_rect().center().x()
        anchor_ms = self.x_to_ms(anchor_x)
        new_zoom = max(1.0, min(200.0, self._zoom * factor))
        if math.isclose(new_zoom, self._zoom):
            return
        self._zoom = new_zoom
        left = self._plot_rect().left()
        width = max(1.0, self._plot_rect().width())
        ratio = (anchor_x - left) / width
        total = max(1, self.timeline.duration)
        target_start = anchor_ms - ratio * self.span_ms
        self._offset = max(0.0, min(1.0, target_start / total))
        self._clamp_view()
        self.update()
        self.viewChanged.emit()

    def fit(self) -> None:
        self._zoom = 1.0
        self._offset = 0.0
        self.update()
        self.viewChanged.emit()

    def ensure_visible(self, ms: int, margin: float = 0.2) -> None:
        if self._zoom <= 1.0:
            return
        start = self.view_start_ms
        end = start + self.span_ms
        if start <= ms <= end:
            return
        total = max(1, self.timeline.duration)
        self._offset = max(0.0, min(1.0, (ms - self.span_ms * 0.5) / total))
        self._clamp_view()
        self.update()
        self.viewChanged.emit()

    def _clamp_view(self) -> None:
        total = max(1, self.timeline.duration)
        span = min(total, self.span_ms)
        max_offset = max(0.0, (total - span) / total)
        self._offset = max(0.0, min(max_offset, self._offset))

    def pan(self, fraction: float) -> None:
        self._offset = max(0.0, min(1.0, self._offset + fraction))
        self._clamp_view()
        self.update()
        self.viewChanged.emit()

    # ------------------------------------------------------------------ 绘制
    def paintEvent(self, event) -> None:  # noqa: N802
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        p.fillRect(self.rect(), BG)
        rect = self._plot_rect()
        self._paint_ruler(p, rect)
        self._paint_lanes(p, rect)
        self._paint_playhead(p, rect)
        p.end()

    def _paint_ruler(self, p: QPainter, rect: QRectF) -> None:
        p.fillRect(QRectF(rect.left(), 0, rect.width(), 28), RULER)
        step = self._nice_step()
        first = int(self.view_start_ms // step) * step
        f = QFont()
        f.setPixelSize(10)
        p.setFont(f)
        ms = first
        while ms <= self.view_start_ms + self.span_ms:
            x = self.ms_to_x(ms)
            if rect.left() - 1 <= x <= rect.right() + 1:
                p.setPen(QPen(FAINT, 1))
                p.drawLine(int(x), 20, int(x), 28)
                p.setPen(MUTED)
                p.drawText(QRectF(x + 4, 2, 90, 16), Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter,
                           self._tick_label(ms, step))
            ms += step

    def _tick_label(self, ms: int, step: int) -> str:
        if step >= 1000:
            s = ms / 1000
            return f"{int(s // 60)}:{s % 60:04.1f}"
        return f"{ms / 1000:.2f}s" if step < 500 else f"{ms / 1000:.1f}s"

    def _nice_step(self) -> int:
        target_px = 90
        raw = self.span_ms * target_px / max(1.0, self._plot_rect().width())
        candidates = [10, 20, 50, 100, 200, 250, 500, 1000, 2000, 5000, 10000, 30000, 60000]
        for c in candidates:
            if c >= raw:
                return c
        return 120000

    def _lane_rects(self, rect: QRectF) -> tuple[QRectF, QRectF]:
        wave_h = rect.height() * 0.38
        wave = QRectF(rect.left(), rect.top() + 4, rect.width(), wave_h)
        blocks = QRectF(rect.left(), wave.bottom() + 10, rect.width(), rect.height() - wave_h - 16)
        return wave, blocks

    def _paint_lanes(self, p: QPainter, rect: QRectF) -> None:
        wave_rect, block_rect = self._lane_rects(rect)
        p.fillRect(wave_rect, LANE)
        p.fillRect(block_rect, LANE_ALT)
        # 网格
        step = self._nice_step()
        ms = int(self.view_start_ms // step) * step
        p.setPen(QPen(GRID, 1))
        while ms <= self.view_start_ms + self.span_ms:
            x = int(self.ms_to_x(ms))
            p.drawLine(x, int(wave_rect.top()), x, int(block_rect.bottom()))
            ms += step
        self._paint_wave(p, wave_rect)
        cues = sorted(self.timeline.cues, key=lambda c: (c.start, c.id))
        for cue in cues:
            self._paint_block(p, block_rect, cue)
        # 选中词之间的连线 (阅读顺序)
        self._paint_order_links(p, block_rect)

    def _paint_wave(self, p: QPainter, rect: QRectF) -> None:
        if not self.peaks or not self.peaks.samples:
            p.setPen(MUTED)
            f = QFont(); f.setPixelSize(11); p.setFont(f)
            p.drawText(rect, Qt.AlignmentFlag.AlignCenter, "尚未载入音频")
            return
        key = self._wave_cache_key()
        if self._wave_key != key:
            self._wave_cache = self._rasterize_wave(rect)
            self._wave_key = key
        if self._wave_cache is not None:
            p.drawPixmap(int(rect.left()), int(rect.top()), self._wave_cache)
        mid = rect.center().y()
        p.setPen(QPen(GRID, 1))
        p.drawLine(int(rect.left()), int(mid), int(rect.right()), int(mid))

    def _wave_cache_key(self):
        rect = self._plot_rect()
        return (id(self.peaks), rect.width(), round(self.view_start_ms, 2),
                round(self.span_ms, 2), self.timeline.duration)

    def _rasterize_wave(self, rect: QRectF):
        """把波形画进一张 pixmap 缓存; 只有视口/缩放/数据变化时才重画。

        直接用 QPainterPath 画上万个点每帧要 40 ms, 拖游标会卡; 光栅化后
        每帧只剩一次 blit。
        """
        w = max(1, int(rect.width()))
        h = max(1, int(rect.height()))
        pix = QPixmap(w, h)
        pix.fill(Qt.GlobalColor.transparent)
        pp = QPainter(pix)
        pp.setRenderHint(QPainter.RenderHint.Antialiasing, False)
        mid = h / 2
        half = h / 2 - 2
        bucket = self.peaks.bucket_ms
        start_ms = self.view_start_ms
        span = max(1.0, self.span_ms)
        px_per_ms = w / span
        first = max(0, int(start_ms // bucket))
        last = min(len(self.peaks.samples), int((start_ms + span) // bucket) + 1)
        play_x = (self.position_ms - start_ms) * px_per_ms
        pending = QPainterPath()
        played = QPainterPath()
        pending.moveTo(0, mid)
        played.moveTo(0, mid)
        for idx in range(first, last):
            lo, hi = self.peaks.samples[idx]
            x = (idx * bucket - start_ms) * px_per_ms
            for path in (played, pending):
                path.lineTo(x, mid - hi * half)
                path.lineTo(x, mid - lo * half)
                path.lineTo(x, mid)
        line_width = max(1.0, min(3.0, px_per_ms * bucket))
        pp.setPen(QPen(WAVE, line_width))
        pp.drawPath(pending)
        pp.save()
        pp.setClipRect(QRectF(0, 0, max(0.0, play_x), h))
        pp.setPen(QPen(WAVE_PLAYED, line_width))
        pp.drawPath(played)
        pp.restore()
        pp.end()
        return pix

    def _block_rect(self, block_rect: QRectF, cue: Cue) -> QRectF:
        x1 = self.ms_to_x(cue.start)
        x2 = self.ms_to_x(cue.end)
        if x2 - x1 < 2:
            x2 = x1 + 2
        return QRectF(x1, block_rect.top() + 6, max(2.0, x2 - x1), block_rect.height() - 12)

    def _paint_block(self, p: QPainter, block_rect: QRectF, cue: Cue) -> None:
        if cue.end < self.view_start_ms or cue.start > self.view_start_ms + self.span_ms:
            return
        r = self._block_rect(block_rect, cue)
        selected = cue.id in self.selected
        bad = cue.id in self._bad_ids
        warn = cue.id in self._warn_ids
        is_pause = cue.kind == "pause"
        if is_pause:
            fill = PAUSE_FILL.darker(115)
            edge = PAUSE_EDGE
        else:
            fill = QColor("#2A3A4D")
            edge = QColor("#4C6C8F")
        if selected:
            fill = QColor("#24463F")
            edge = SELECT
        if bad:
            edge = BAD
        elif warn:
            edge = WARN
        if cue.id == self._active_loop_id:
            p.setBrush(Qt.BrushStyle.NoBrush)
            p.setPen(QPen(ACCENT, 2, Qt.PenStyle.DashLine))
            p.drawRoundedRect(r.adjusted(-2, -2, 2, 2), 5, 5)
        p.setBrush(fill)
        p.setPen(QPen(edge, 1.4 if selected else 1.0))
        p.drawRoundedRect(r, 4, 4)
        if cue.duration <= 0:
            p.setPen(QPen(BAD, 2))
            p.drawLine(int(r.left()), int(r.top()), int(r.left()), int(r.bottom()))
        # 文本
        if r.width() > 12:
            f = QFont(); f.setPixelSize(12)
            p.setFont(f)
            p.setPen(TEXT if not is_pause else MUTED)
            fm = QFontMetricsF(f)
            label = cue.text if not is_pause else (cue.text.strip() or "停顿")
            if fm.horizontalAdvance(label) > r.width() - 6:
                label = label[:max(1, int(len(label) * (r.width() - 6) / max(1.0, fm.horizontalAdvance(label))))]
            p.drawText(r.adjusted(4, 0, -2, 0),
                       Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter, label)
        # 边界手柄
        if selected or r.width() < 26:
            p.setPen(Qt.PenStyle.NoPen)
            p.setBrush(SELECT if selected else edge)
            p.drawRoundedRect(QRectF(r.left() + 1, r.top() + 3, 2.5, r.height() - 6), 1, 1)
            p.drawRoundedRect(QRectF(r.right() - 3.5, r.top() + 3, 2.5, r.height() - 6), 1, 1)
        if r.width() > 48:
            p.setPen(QPen(FAINT, 1))
            p.drawLine(int(r.left()), int(r.bottom()) + 2, int(r.left()), int(block_rect.bottom()))

    def _paint_order_links(self, p: QPainter, block_rect: QRectF) -> None:
        if not (self.selected or self._active_loop_id):
            return
        order = self.timeline.ordered_cues()
        by_id = {c.id: c for c in order}
        ids = sorted(self.selected) if self.selected else ([self._active_loop_id] if self._active_loop_id else [])
        if len(ids) < 2:
            return
        positions = {c.id: i for i, c in enumerate(order)}
        chain = sorted((by_id[i] for i in ids if i in by_id), key=lambda c: positions[c.id])
        p.setPen(QPen(SELECT, 1, Qt.PenStyle.DotLine))
        for a, b in zip(chain, chain[1:]):
            ra = self._block_rect(block_rect, a)
            rb = self._block_rect(block_rect, b)
            if ra.right() < rb.left():
                y = ra.center().y()
                p.drawLine(int(ra.right()) + 2, int(y), int(rb.left()) - 2, int(y))

    def _paint_playhead(self, p: QPainter, rect: QRectF) -> None:
        x = self.ms_to_x(self.position_ms)
        if x < rect.left() - 2 or x > rect.right() + 2:
            return
        p.setPen(QPen(PLAYHEAD, 1.5))
        p.drawLine(int(x), 26, int(x), int(rect.bottom()) + 2)
        path = QPainterPath()
        path.moveTo(x - 5, 28)
        path.lineTo(x + 5, 28)
        path.lineTo(x, 36)
        path.closeSubpath()
        p.setPen(Qt.PenStyle.NoPen)
        p.setBrush(PLAYHEAD)
        p.drawPath(path)

    # ------------------------------------------------------------------ 交互
    def _cue_at(self, pos) -> tuple[Cue, str] | None:
        rect = self._plot_rect()
        wave_rect, block_rect = self._lane_rects(rect)
        if not block_rect.adjusted(-2, -4, 2, 4).contains(pos):
            return None
        candidates = [c for c in self.timeline.cues
                      if self._block_rect(block_rect, c).adjusted(-HANDLE, 0, HANDLE, 0).contains(pos)]
        if not candidates:
            return None
        cue = min(candidates, key=lambda c: self._block_rect(block_rect, c).width())
        r = self._block_rect(block_rect, cue)
        mode = "move"
        if abs(pos.x() - r.left()) <= HANDLE:
            mode = "start"
        elif abs(pos.x() - r.right()) <= HANDLE:
            mode = "end"
        return cue, mode

    def mousePressEvent(self, event: QMouseEvent) -> None:  # noqa: N802
        if event.button() != Qt.MouseButton.LeftButton:
            return
        pos = event.position()
        if event.position().y() < 30:
            self._scrubbing = True
            self.positionClicked.emit(self.x_to_ms(pos.x()))
            return
        hit = self._cue_at(pos)
        additive = bool(event.modifiers() & (Qt.KeyboardModifier.ControlModifier
                                             | Qt.KeyboardModifier.MetaModifier
                                             | Qt.KeyboardModifier.ShiftModifier))
        if hit is None:
            if not additive:
                self.set_selection([])
            self._scrubbing = True
            self.positionClicked.emit(self.x_to_ms(pos.x()))
            return
        cue, mode = hit
        if not additive and cue.id not in self.selected:
            self.set_selection([cue.id])
        elif additive:
            self.select_cue(cue.id, additive=True)
        self._drag = {
            "mode": mode, "cue": cue.id, "press_ms": self.x_to_ms(pos.x()),
            "orig_start": cue.start, "orig_end": cue.end, "moved": False,
            "last_value": cue.start if mode != "end" else cue.end,
        }
        self.setCursor(Qt.CursorShape.SizeHorCursor if mode != "move" else Qt.CursorShape.ClosedHandCursor)

    def mouseMoveEvent(self, event: QMouseEvent) -> None:  # noqa: N802
        pos = event.position()
        if self._scrubbing:
            self.positionClicked.emit(self.x_to_ms(pos.x()))
            return
        if self._drag:
            cue = self.timeline.cue(self._drag["cue"])
            ms = self.x_to_ms(pos.x())
            delta = ms - self._drag["press_ms"]
            self._drag["moved"] = True
            if self._drag["mode"] == "move":
                new_start = max(0, self._drag["orig_start"] + delta)
                self._drag["last_value"] = new_start
                self.cueMoved.emit(cue.id, new_start, False)
            else:
                value = self._drag["orig_start"] if self._drag["mode"] == "start" else self._drag["orig_end"]
                value += delta
                self._drag["last_value"] = value
                self.edgeDragged.emit(cue.id, self._drag["mode"], value, False)
            return
        hit = self._cue_at(pos)
        if event.position().y() < 30:
            self.setCursor(Qt.CursorShape.SplitHCursor)
        elif hit is None:
            self.unsetCursor()
        elif hit[1] == "move":
            self.setCursor(Qt.CursorShape.OpenHandCursor)
        else:
            self.setCursor(Qt.CursorShape.SizeHorCursor)

    def mouseReleaseEvent(self, event: QMouseEvent) -> None:  # noqa: N802
        if self._scrubbing:
            self._scrubbing = False
            return
        if self._drag:
            drag = self._drag
            self._drag = None
            self.unsetCursor()
            if drag["moved"]:
                if drag["mode"] == "move":
                    self.cueMoved.emit(drag["cue"], drag["last_value"], True)
                else:
                    self.edgeDragged.emit(drag["cue"], drag["mode"], drag["last_value"], True)
            else:
                # 单击选中, 并把游标对到词的开头
                self.positionClicked.emit(self.timeline.cue(drag["cue"]).start)

    def mouseDoubleClickEvent(self, event: QMouseEvent) -> None:  # noqa: N802
        hit = self._cue_at(event.position())
        if hit:
            self.cueActivated.emit(hit[0].id)
            event.accept()
            return
        super().mouseDoubleClickEvent(event)

    def wheelEvent(self, event: QWheelEvent) -> None:  # noqa: N802
        if event.modifiers() & Qt.KeyboardModifier.ShiftModifier or abs(event.angleDelta().x()) > abs(event.angleDelta().y()):
            dx = event.angleDelta().x() or event.angleDelta().y()
            self.pan(-dx / 1200 / max(1.0, self._zoom))
            event.accept()
            return
        steps = event.angleDelta().y() / 120.0
        self.zoom_at(math.pow(1.18, steps), event.position().x())
        event.accept()

    def resizeEvent(self, event) -> None:  # noqa: N802
        self._clamp_view()
        super().resizeEvent(event)

    def keyPressEvent(self, event) -> None:  # noqa: N802
        if event.key() in (Qt.Key.Key_Left, Qt.Key.Key_Right):
            step = 1 if event.key() == Qt.Key.Key_Right else -1
            if event.modifiers() & Qt.KeyboardModifier.ShiftModifier:
                step *= 100
            self.positionClicked.emit(max(0, min(self.timeline.duration, self.position_ms + step)))
            event.accept()
            return
        super().keyPressEvent(event)
