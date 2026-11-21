"""波形概览 + 段标记的可交互画布。

- 灰色为整段音频的峰值包络;
- 彩色块为当前切分, 高亮的是选中段;
- 拖拽段块可整体平移, 拖拽两端手柄可调边界, 拖空白可直接画新段;
- 所有交互都发出“原始样本”坐标, 由主窗口负责约束与落库。
"""

from __future__ import annotations

from PySide6.QtCore import QPointF, QRectF, Qt, Signal
from PySide6.QtGui import (
    QColor,
    QFont,
    QKeyEvent,
    QMouseEvent,
    QPainter,
    QPen,
    QResizeEvent,
    QWheelEvent,
)
from PySide6.QtWidgets import QWidget

from ..audio import AudioData
from ..segmentation import Segment

_MARGIN_X = 12
_MARGIN_Y = 8
_MIN_DRAG_PX = 3


class WaveformView(QWidget):
    selectionChanged = Signal(int)  # 选中段索引, -1 表示无
    editBegan = Signal()  # 一次拖拽编辑开始, 主窗口据此记录撤销点
    editEnded = Signal()  # 拖拽结束 (无论是否产生修改)
    segmentEdited = Signal(int, int, int)  # index, new_start, new_end
    segmentMoved = Signal(int, int)  # index, 目标起点 (绝对样本)
    createRequested = Signal(int, int)  # start, end (样本)
    seekRequested = Signal(int)  # 样本
    playRequested = Signal()  # 波形区按空格

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setMinimumHeight(180)
        self.setMouseTracking(True)
        self.setFocusPolicy(Qt.StrongFocus)
        self.setToolTip("拖动段块平移 / 拖两端改边界 / 空白处拖拽新建 / 空格试听选中段")
        self._audio: AudioData | None = None
        self._segments: list[Segment] = []
        self._selected = -1
        self._playhead: int | None = None
        self._peaks: list[tuple[float, float]] = []
        self._peaks_width = 0
        self._drag_mode: str | None = None
        self._drag_origin_sample = 0
        self._drag_anchor_start = 0
        self._drag_origin_x = 0.0
        self._draft: tuple[int, int] | None = None
        self._hover_x: float | None = None

    # ---------- 数据 ----------
    def set_audio(self, audio: AudioData | None) -> None:
        self._audio = audio
        self._peaks = []
        self._peaks_width = 0
        self._selected = -1
        self._playhead = None
        self.update()

    def set_segments(self, segments: list[Segment]) -> None:
        self._segments = list(segments)
        if self._selected >= len(self._segments):
            self._selected = len(self._segments) - 1
        self.update()

    def set_selected(self, index: int) -> None:
        self._selected = index if 0 <= index < len(self._segments) else -1
        self.update()

    def selected_index(self) -> int:
        return self._selected

    def playhead(self) -> int | None:
        return self._playhead

    def set_playhead(self, sample: int | None) -> None:
        self._playhead = sample
        self.update()

    # ---------- 坐标换算 ----------
    def _plot_rect(self) -> QRectF:
        return QRectF(
            _MARGIN_X,
            _MARGIN_Y,
            max(1.0, self.width() - 2 * _MARGIN_X),
            max(1.0, self.height() - 2 * _MARGIN_Y),
        )

    def _total(self) -> int:
        return self._audio.frame_count if self._audio else 0

    def x_to_sample(self, x: float) -> int:
        rect = self._plot_rect()
        ratio = (x - rect.left()) / rect.width()
        return int(round(max(0.0, min(1.0, ratio)) * self._total()))

    def sample_to_x(self, sample: int) -> float:
        rect = self._plot_rect()
        total = self._total()
        if total <= 0:
            return rect.left()
        ratio = max(0, min(total, sample)) / total
        return rect.left() + ratio * rect.width()

    def _cell_peaks(self) -> list[tuple[float, float]]:
        rect = self._plot_rect()
        width = max(1, int(rect.width()))
        if self._audio is None:
            return []
        if self._peaks and self._peaks_width == width:
            return self._peaks
        mono, full_scale = self._audio.mono
        total = len(mono)
        buckets: list[tuple[float, float]] = []
        if total <= width:
            for value in mono:
                level = value / full_scale
                buckets.append((level, level))
        else:
            step = total / width
            for i in range(width):
                a = int(i * step)
                b = max(a + 1, int((i + 1) * step))
                chunk = mono[a:b]
                if not chunk:
                    buckets.append((0.0, 0.0))
                    continue
                buckets.append(
                    (min(chunk) / full_scale, max(chunk) / full_scale)
                )
        self._peaks = buckets
        self._peaks_width = width
        return buckets

    # ---------- 绘制 ----------
    def paintEvent(self, event) -> None:  # noqa: N802
        painter = QPainter(self)
        painter.setRenderHint(QPainter.Antialiasing, True)
        rect = self._plot_rect()
        painter.fillRect(self.rect(), QColor("#f7f7f9"))
        painter.fillRect(rect, QColor("#ffffff"))

        if self._audio is None:
            painter.setPen(QColor("#888888"))
            painter.drawText(
                self.rect(), Qt.AlignCenter, "打开 WAV 后可在此查看波形与切分"
            )
            return

        self._paint_grid(painter, rect)
        self._paint_wave(painter, rect)
        self._paint_segments(painter, rect)
        self._paint_playhead(painter, rect)
        self._paint_draft(painter, rect)

    def _paint_grid(self, painter: QPainter, rect: QRectF) -> None:
        total = self._total()
        duration = total / self._audio.sample_rate
        if duration <= 0:
            return
        # 选一个让刻度不超过 ~10 个的“整”间隔
        candidates = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600]
        step = next((c for c in candidates if duration / c <= 10), candidates[-1])
        painter.setPen(QPen(QColor("#e6e6ea"), 1))
        painter.setFont(QFont(self.font().family(), 8))
        mark = 0.0
        while mark <= duration + 1e-9:
            x = rect.left() + (mark / duration) * rect.width()
            painter.drawLine(QPointF(x, rect.top()), QPointF(x, rect.bottom()))
            label = f"{mark:g}s"
            painter.setPen(QColor("#999999"))
            painter.drawText(QPointF(x + 3, rect.bottom() - 3), label)
            painter.setPen(QPen(QColor("#e6e6ea"), 1))
            mark = round(mark + step, 6)

    def _paint_wave(self, painter: QPainter, rect: QRectF) -> None:
        peaks = self._cell_peaks()
        if not peaks:
            return
        mid = rect.center().y()
        height = rect.height() / 2.0 - 4
        painter.setPen(QPen(QColor("#9aa4b2"), 1))
        for i, (low, high) in enumerate(peaks):
            x = rect.left() + i + 0.5
            painter.drawLine(
                QPointF(x, mid - high * height), QPointF(x, mid - low * height)
            )

    def _segment_color(self, index: int) -> QColor:
        if index == self._selected:
            return QColor(37, 99, 235, 90)
        if index % 2:
            return QColor(16, 185, 129, 55)
        return QColor(59, 130, 246, 55)

    def _paint_segments(self, painter: QPainter, rect: QRectF) -> None:
        for index, seg in enumerate(self._segments):
            x0 = self.sample_to_x(seg.start)
            x1 = self.sample_to_x(seg.end)
            block = QRectF(x0, rect.top(), max(1.0, x1 - x0), rect.height())
            painter.fillRect(block, self._segment_color(index))
            border = QColor("#2563eb") if index == self._selected else QColor(
                "#10b981" if index % 2 else "#3b82f6"
            )
            pen = QPen(border, 2 if index == self._selected else 1)
            painter.setPen(pen)
            painter.drawRect(block)
            if seg.pinned:
                painter.setPen(QPen(QColor("#b45309"), 1, Qt.DashLine))
                painter.drawLine(
                    QPointF(x0, rect.top()), QPointF(x0, rect.bottom())
                )
                painter.drawLine(
                    QPointF(x1, rect.top()), QPointF(x1, rect.bottom())
                )
            if block.width() > 26:
                painter.setPen(QColor("#1f2937"))
                painter.setFont(QFont(self.font().family(), 8))
                painter.drawText(
                    block.adjusted(4, 2, -4, 0),
                    Qt.AlignLeft | Qt.AlignTop,
                    f"{index + 1}",
                )

    def _paint_playhead(self, painter: QPainter, rect: QRectF) -> None:
        if self._playhead is None:
            return
        x = self.sample_to_x(self._playhead)
        painter.setPen(QPen(QColor("#ef4444"), 2))
        painter.drawLine(QPointF(x, rect.top()), QPointF(x, rect.bottom()))

    def _paint_draft(self, painter: QPainter, rect: QRectF) -> None:
        if self._draft is None:
            return
        a, b = self._draft
        x0, x1 = self.sample_to_x(a), self.sample_to_x(b)
        painter.setPen(QPen(QColor("#f59e0b"), 1, Qt.DashLine))
        painter.setBrush(QColor(245, 158, 11, 40))
        painter.drawRect(QRectF(x0, rect.top(), max(1.0, x1 - x0), rect.height()))
        painter.setBrush(Qt.NoBrush)

    # ---------- 交互 ----------
    def _hit(self, x: float) -> tuple[str, int]:
        """返回 (区域类型, 段索引)。区域: start/end/body/none。"""
        tolerance = 5.0
        for index in range(len(self._segments)):
            seg = self._segments[index]
            xs = self.sample_to_x(seg.start)
            xe = self.sample_to_x(seg.end)
            if abs(x - xs) <= tolerance:
                return "start", index
            if abs(x - xe) <= tolerance:
                return "end", index
        for index, seg in enumerate(self._segments):
            if self.sample_to_x(seg.start) < x < self.sample_to_x(seg.end):
                return "body", index
        return "none", -1

    def mousePressEvent(self, event: QMouseEvent) -> None:  # noqa: N802
        if self._audio is None:
            return
        if event.button() != Qt.LeftButton:
            return
        self.setFocus(Qt.MouseFocusReason)
        x = event.position().x()
        kind, index = self._hit(x)
        self._drag_origin_sample = self.x_to_sample(x)
        self._drag_origin_x = x
        if kind == "none":
            # 点空白: 立即选中最近段并开始画新段
            self._draft = (self._drag_origin_sample, self._drag_origin_sample)
            self._drag_mode = "create"
            self.selectionChanged.emit(-1)
            self._selected = -1
            self.seekRequested.emit(self._drag_origin_sample)
        else:
            self._drag_mode = kind
            self.editBegan.emit()
            if index != self._selected:
                self._selected = index
                self.selectionChanged.emit(index)
            if kind == "body":
                self._drag_anchor_start = self._segments[index].start
                self.seekRequested.emit(self._drag_origin_sample)
        self.update()

    def mouseMoveEvent(self, event: QMouseEvent) -> None:  # noqa: N802
        if self._audio is None:
            return
        x = event.position().x()
        self._hover_x = x
        if self._drag_mode is None:
            kind, _ = self._hit(x)
            cursor = {
                "start": Qt.SizeHorCursor,
                "end": Qt.SizeHorCursor,
                "body": Qt.OpenHandCursor,
            }.get(kind, Qt.CrossCursor)
            self.setCursor(cursor)
            return
        if self._drag_mode == "create":
            self._draft = (self._drag_origin_sample, self.x_to_sample(x))
        elif self._drag_mode == "body":
            # 用绝对目标起点而不是累加增量: 即使被边界夹住, 松手再拖也不会漂移
            delta = self.x_to_sample(x) - self._drag_origin_sample
            self.segmentMoved.emit(self._selected, self._drag_anchor_start + delta)
        elif self._drag_mode in ("start", "end") and self._selected >= 0:
            sample = self.x_to_sample(x)
            seg = self._segments[self._selected]
            if self._drag_mode == "start":
                self.segmentEdited.emit(self._selected, sample, seg.end)
            else:
                self.segmentEdited.emit(self._selected, seg.start, sample)
        self.update()

    def mouseReleaseEvent(self, event: QMouseEvent) -> None:  # noqa: N802
        if self._audio is None or event.button() != Qt.LeftButton:
            return
        mode = self._drag_mode
        self._drag_mode = None
        self.editEnded.emit()
        if mode == "create" and self._draft is not None:
            a, b = sorted(self._draft)
            self._draft = None
            if abs(self.sample_to_x(b) - self.sample_to_x(a)) >= _MIN_DRAG_PX:
                self.createRequested.emit(a, b)
            else:
                # 单击空白视为定位播放头
                self.seekRequested.emit(a)
        self.unsetCursor()
        self.update()

    def wheelEvent(self, event: QWheelEvent) -> None:  # noqa: N802
        event.ignore()

    def keyPressEvent(self, event: QKeyEvent) -> None:  # noqa: N802
        if event.key() == Qt.Key_Space and not event.isAutoRepeat():
            self.playRequested.emit()
            event.accept()
            return
        super().keyPressEvent(event)

    def resizeEvent(self, event: QResizeEvent) -> None:  # noqa: N802
        self._peaks = []
        super().resizeEvent(event)
