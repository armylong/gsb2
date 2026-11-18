"""波形控件：左、右、中间、侧边四条泳道同屏对照。

- 四条泳道共享同一时间轴，可直观看到 L/R 与 M/S 之间的对应关系。
- 点击：跳转播放位置；按住拖动：选择观察区间；双击或按 Esc：清除区间。
- Ctrl/⌘ + 滚轮：以指针处为中心缩放；普通滚轮：平移。
- 绘制采用 min/max 下采样，缩放到任意级别都保留峰值轮廓。
"""

from __future__ import annotations

import numpy as np
from PySide6.QtCore import QPointF, QRectF, Qt, Signal
from PySide6.QtGui import QColor, QFont, QPainter, QPen, QPolygonF
from PySide6.QtWidgets import QWidget

# 统一的中性配色（浅底）
COLOR_LEFT = QColor("#2563eb")      # 蓝
COLOR_RIGHT = QColor("#7c3aed")     # 紫
COLOR_MID = QColor("#059669")       # 绿
COLOR_SIDE = QColor("#d97706")      # 橙
COLOR_CURSOR = QColor("#dc2626")    # 红
COLOR_REGION = QColor(251, 191, 36, 70)
COLOR_REGION_BORDER = QColor("#b45309")
COLOR_GRID = QColor("#e5e7eb")
COLOR_ZERO = QColor("#9ca3af")
COLOR_TEXT = QColor("#374151")


class WaveformView(QWidget):
    seekRequested = Signal(int)               # 请求跳转到某帧
    regionChanged = Signal(object)            # (start,end) 或 None

    def __init__(self, parent=None):
        super().__init__(parent)
        self._samples: np.ndarray | None = None  # (n,2)
        self._sr = 1
        self._pos = 0
        self._region: tuple[int, int] | None = None

        self._view_start = 0.0     # 视口左沿（帧，浮点）
        self._view_end = 1.0
        self._drag_anchor: int | None = None
        self._pan_anchor_x = 0
        self._pan_anchor_view = 0.0
        self.setMinimumHeight(220)
        self.setMouseTracking(True)
        self.setFocusPolicy(Qt.StrongFocus)

    # ------------------------------------------------------------ 数据

    def set_data(self, samples: np.ndarray, samplerate: int) -> None:
        self._samples = np.ascontiguousarray(samples, dtype=np.float64)
        self._sr = int(samplerate)
        self._pos = 0
        self._region = None
        self.zoom_to_all()

    def zoom_to_all(self) -> None:
        if self._samples is None:
            return
        self._view_start = 0.0
        self._view_end = float(self._samples.shape[0])
        self.update()

    def set_position(self, frame: int) -> None:
        self._pos = int(frame)
        self.update()

    def region(self) -> tuple[int, int] | None:
        return self._region

    def clear_region(self) -> None:
        if self._region is not None:
            self._region = None
            self.regionChanged.emit(None)
            self.update()

    def set_region(self, start: int, end: int) -> None:
        if self._samples is None or end <= start:
            return
        start = int(np.clip(start, 0, self._samples.shape[0]))
        end = int(np.clip(end, 0, self._samples.shape[0]))
        if end > start:
            self._region = (start, end)
            self.regionChanged.emit(self._region)
            self.update()

    # ------------------------------------------------------------ 坐标换算

    def _plot_rect(self) -> QRectF:
        m = 8
        label_w = 56
        return QRectF(m + label_w, m,
                      max(1, self.width() - m * 2 - label_w),
                      max(1, self.height() - m * 2 - 22))

    def _lane_rect(self, index: int) -> QRectF:
        rect = self._plot_rect()
        gap = 6
        h = (rect.height() - gap * 3) / 4.0
        return QRectF(rect.x(), rect.y() + index * (h + gap),
                      rect.width(), h)

    def frame_at_x(self, x: float) -> int:
        rect = self._plot_rect()
        ratio = (x - rect.x()) / max(1.0, rect.width())
        ratio = float(np.clip(ratio, 0.0, 1.0))
        if self._samples is None:
            return 0
        frame = self._view_start + ratio * (self._view_end - self._view_start)
        return int(np.clip(frame, 0, self._samples.shape[0] - 1))

    def x_at_frame(self, frame: float) -> float:
        rect = self._plot_rect()
        span = max(1.0, self._view_end - self._view_start)
        ratio = (frame - self._view_start) / span
        return rect.x() + ratio * rect.width()

    def zoom_frames(self, center_frame: float, factor: float) -> None:
        if self._samples is None:
            return
        n = self._samples.shape[0]
        span = self._view_end - self._view_start
        new_span = float(np.clip(span * factor, 32.0, float(n)))
        center_frame = float(np.clip(center_frame, 0.0, float(n)))
        start = center_frame - (center_frame - self._view_start) * (new_span / span)
        start = float(np.clip(start, 0.0, n - new_span))
        self._view_start = start
        self._view_end = start + new_span
        self.update()

    # ------------------------------------------------------------ 绘制

    def paintEvent(self, event) -> None:  # noqa: ANN001, N802
        painter = QPainter(self)
        painter.setRenderHint(QPainter.Antialiasing, False)
        painter.fillRect(self.rect(), QColor("#ffffff"))

        rect = self._plot_rect()
        painter.setPen(QPen(COLOR_GRID, 1))
        for i in range(6):
            x = rect.x() + rect.width() * i / 5.0
            painter.drawLine(QPointF(x, rect.y()),
                             QPointF(x, rect.bottom()))
        self._draw_time_axis(painter, rect)
        if self._samples is None:
            painter.setPen(COLOR_TEXT)
            painter.drawText(self.rect(), Qt.AlignCenter, "打开 WAV 文件后显示波形")
            painter.end()
            return

        mid = (self._samples[:, 0] + self._samples[:, 1]) * 0.5
        side = (self._samples[:, 0] - self._samples[:, 1]) * 0.5
        lanes = [
            ("左 L", self._samples[:, 0], COLOR_LEFT),
            ("右 R", self._samples[:, 1], COLOR_RIGHT),
            ("中 M", mid, COLOR_MID),
            ("侧 S", side, COLOR_SIDE),
        ]
        for i, (label, signal, color) in enumerate(lanes):
            self._draw_lane(painter, self._lane_rect(i), label, signal, color)

        self._draw_region(painter)
        self._draw_cursor(painter)
        painter.end()

    def _draw_lane(self, painter: QPainter, lane: QRectF, label: str,
                   signal: np.ndarray, color: QColor) -> None:
        painter.fillRect(lane, QColor("#f9fafb"))
        painter.setPen(QPen(COLOR_ZERO, 1, Qt.DashLine))
        painter.drawLine(QPointF(lane.x(), lane.center().y()),
                         QPointF(lane.right(), lane.center().y()))
        painter.setPen(COLOR_TEXT)
        font = QFont()
        font.setPointSize(9)
        painter.setFont(font)
        painter.drawText(QRectF(lane.x() - 52, lane.y(), 48, lane.height()),
                         Qt.AlignVCenter | Qt.AlignRight, label)

        start = max(0, int(self._view_start))
        end = min(signal.shape[0], int(np.ceil(self._view_end)) + 1)
        if end <= start:
            return
        view = signal[start:end]
        px_per_frame = lane.width() / max(1.0, self._view_end - self._view_start)
        frame_step = max(1, int(1.0 / max(px_per_frame, 1e-9)))

        n = view.shape[0]
        chunks = n // frame_step
        if chunks == 0:
            return
        trim = chunks * frame_step
        reshaped = view[:trim].reshape(chunks, frame_step)
        mins = reshaped.min(axis=1)
        maxs = reshaped.max(axis=1)
        # 末尾不足一个块宽的样本并入最后一块，避免 reshape 越界
        if trim < n:
            mins[-1] = min(mins[-1], float(view[trim:].min()))
            maxs[-1] = max(maxs[-1], float(view[trim:].max()))

        half_h = lane.height() * 0.46
        cy = lane.center().y()
        frame_idx = np.arange(chunks) * frame_step
        xs = lane.x() + (frame_idx + start - self._view_start) * px_per_frame
        valid = (xs >= lane.x() - 2) & (xs <= lane.right() + 2)
        if not np.any(valid):
            return
        xs_v = xs[valid]
        mins_v = mins[valid]
        maxs_v = maxs[valid]

        pen = QPen(color, 1)
        painter.setPen(pen)
        # 每个下采样块画一条 min->max 竖线
        for x, lo, hi in zip(xs_v, mins_v, maxs_v):
            painter.drawLine(QPointF(x, cy - hi * half_h),
                             QPointF(x, cy - lo * half_h))
        # 再叠加上下包络多边形，填充淡色
        upper = QPolygonF([QPointF(x, cy - hi * half_h)
                           for x, hi in zip(xs_v, maxs_v)])
        lower = QPolygonF([QPointF(x, cy - lo * half_h)
                           for x, lo in zip(xs_v, mins_v)])
        fill = QColor(color)
        fill.setAlpha(45)
        painter.setBrush(fill)
        painter.setPen(Qt.NoPen)
        painter.drawPolygon(upper)
        painter.drawPolygon(lower)

    def _draw_region(self, painter: QPainter) -> None:
        if self._region is None:
            return
        rect = self._plot_rect()
        x0 = self.x_at_frame(self._region[0])
        x1 = self.x_at_frame(self._region[1])
        painter.fillRect(QRectF(x0, rect.y(), x1 - x0, rect.height()),
                         COLOR_REGION)
        painter.setPen(QPen(COLOR_REGION_BORDER, 1, Qt.DashLine))
        painter.drawLine(QPointF(x0, rect.y()), QPointF(x0, rect.bottom()))
        painter.drawLine(QPointF(x1, rect.y()), QPointF(x1, rect.bottom()))

    def _draw_cursor(self, painter: QPainter) -> None:
        rect = self._plot_rect()
        x = self.x_at_frame(self._pos)
        painter.setPen(QPen(COLOR_CURSOR, 1.6))
        painter.drawLine(QPointF(x, rect.y() - 2),
                         QPointF(x, rect.bottom() + 2))
        tri = QPolygonF([
            QPointF(x - 5, rect.y() - 2),
            QPointF(x + 5, rect.y() - 2),
            QPointF(x, rect.y() + 5),
        ])
        painter.setBrush(COLOR_CURSOR)
        painter.drawPolygon(tri)

    def _draw_time_axis(self, painter: QPainter, rect: QRectF) -> None:
        painter.setPen(COLOR_TEXT)
        font = QFont()
        font.setPointSize(8)
        painter.setFont(font)
        if self._samples is None:
            return
        ticks = 6
        for i in range(ticks + 1):
            frame = self._view_start + (self._view_end - self._view_start) * i / ticks
            t = frame / self._sr
            x = rect.x() + rect.width() * i / ticks
            text = f"{t:6.2f}s"
            painter.drawText(QRectF(x - 34, rect.bottom() + 4, 68, 16),
                             Qt.AlignCenter, text)

    # ------------------------------------------------------------ 鼠标/键盘

    def mousePressEvent(self, event) -> None:  # noqa: N802
        if self._samples is None:
            return
        if event.button() == Qt.LeftButton:
            frame = self.frame_at_x(event.position().x())
            if event.modifiers() & Qt.ShiftModifier:
                # Shift+拖动：平移
                self._pan_anchor_x = int(event.position().x())
                self._pan_anchor_view = self._view_start
            else:
                self._drag_anchor = frame
                self.seekRequested.emit(frame)

    def mouseMoveEvent(self, event) -> None:  # noqa: N802
        if self._samples is None:
            return
        if event.buttons() & Qt.LeftButton and self._drag_anchor is not None:
            frame = self.frame_at_x(event.position().x())
            a, b = sorted((self._drag_anchor, frame))
            if b > a:
                self._region = (a, b)
                self.regionChanged.emit(self._region)
                self.update()
        elif event.buttons() & Qt.LeftButton and (event.modifiers() & Qt.ShiftModifier):
            dx = event.position().x() - self._pan_anchor_x
            span = self._view_end - self._view_start
            shift_frames = -dx / max(1.0, self._plot_rect().width()) * span
            n = self._samples.shape[0]
            start = float(np.clip(self._pan_anchor_view + shift_frames,
                                  0.0, max(0.0, n - span)))
            self._view_start = start
            self._view_end = start + span
            self.update()

    def mouseReleaseEvent(self, event) -> None:  # noqa: N802
        if event.button() == Qt.LeftButton:
            self._drag_anchor = None

    def mouseDoubleClickEvent(self, event) -> None:  # noqa: N802
        self.clear_region()

    def keyPressEvent(self, event) -> None:  # noqa: N802
        if event.key() == Qt.Key_Escape:
            self.clear_region()
        else:
            super().keyPressEvent(event)

    def wheelEvent(self, event) -> None:  # noqa: N802
        if self._samples is None:
            return
        frame = self.frame_at_x(event.position().x())
        if event.modifiers() & (Qt.ControlModifier | Qt.MetaModifier):
            factor = 1.0 / 1.25 if event.angleDelta().y() > 0 else 1.25
            self.zoom_frames(frame, factor)
        else:
            # 普通滚轮平移
            span = self._view_end - self._view_start
            step = span * 0.15 * (-1 if event.angleDelta().y() > 0 else 1)
            n = self._samples.shape[0]
            start = float(np.clip(self._view_start + step,
                                  0.0, max(0.0, n - span)))
            self._view_start = start
            self._view_end = start + span
            self.update()
