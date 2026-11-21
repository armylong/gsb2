"""界面组件：关键帧时间轴与前后对比的帧预览。"""

from __future__ import annotations

from pathlib import Path

from PySide6.QtCore import QPointF, QRectF, Qt, Signal
from PySide6.QtGui import (QBrush, QColor, QFont, QPainter,
                           QPainterPath, QPen, QPixmap)
from PySide6.QtWidgets import QFrame, QLabel, QSizePolicy, QVBoxLayout, QWidget

from . import media

COLOR_BG = QColor(22, 26, 36)
COLOR_GRID = QColor(44, 52, 68)
COLOR_KEY = QColor(126, 231, 160)
COLOR_KEY_SEL = QColor(255, 208, 92)
COLOR_RANGE = QColor(86, 180, 255, 46)
COLOR_RANGE_EDGE = QColor(86, 180, 255)
COLOR_TEXT = QColor(216, 224, 240)
COLOR_SUB = QColor(132, 146, 172)


class TimelineWidget(QWidget):
    """把关键帧、请求区间与播放头画在同一条时间轴上。"""

    seekRequested = Signal(float)

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setMinimumHeight(112)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)
        self.setMouseTracking(True)
        self._info: media.MediaInfo | None = None
        self._start = 0.0
        self._end = 0.0
        self._cursor = 0.0
        self._duration = 0.0
        self._hover: media.Keyframe | None = None

    # ---- 数据 ----
    def set_media(self, info: media.MediaInfo | None) -> None:
        self._info = info
        self._duration = info.content_duration() if info else 0.0
        self.update()

    def set_range(self, start: float, end: float) -> None:
        self._start, self._end = start, end
        self.update()

    def set_cursor(self, content_time: float) -> None:
        self._cursor = content_time
        self.update()

    # ---- 几何 ----
    def _plot_rect(self) -> QRectF:
        return QRectF(14, 30, max(1.0, self.width() - 28), 46)

    def _x_of(self, t: float) -> float:
        rect = self._plot_rect()
        if self._duration <= 0:
            return rect.left()
        return rect.left() + rect.width() * (t / self._duration)

    def _t_of(self, x: float) -> float:
        rect = self._plot_rect()
        if rect.width() <= 0 or self._duration <= 0:
            return 0.0
        ratio = (x - rect.left()) / rect.width()
        return max(0.0, min(self._duration, ratio * self._duration))

    # ---- 绘制 ----
    def paintEvent(self, event) -> None:  # noqa: N802
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        painter.fillRect(self.rect(), COLOR_BG)

        rect = self._plot_rect()
        painter.setPen(Qt.PenStyle.NoPen)
        painter.setBrush(QBrush(COLOR_GRID))
        painter.drawRoundedRect(rect, 4, 4)

        if not self._info or self._duration <= 0:
            painter.setPen(COLOR_SUB)
            painter.setFont(QFont(self.font().family(), 12))
            painter.drawText(self.rect(), Qt.AlignmentFlag.AlignCenter,
                             "导入视频后这里显示关键帧位置")
            painter.end()
            return

        # 请求区间
        x0 = self._x_of(max(0.0, min(self._start, self._end)))
        x1 = self._x_of(min(self._duration, max(self._start, self._end)))
        painter.setBrush(QBrush(COLOR_RANGE))
        painter.setPen(QPen(COLOR_RANGE_EDGE, 1.4))
        painter.drawRect(QRectF(x0, rect.top(), max(1.0, x1 - x0), rect.height()))

        # 秒刻度
        painter.setFont(QFont(self.font().family(), 8))
        step = self._nice_step(self._duration)
        t = 0.0
        while t <= self._duration + 1e-6:
            x = self._x_of(t)
            painter.setPen(QPen(COLOR_GRID.lighter(130), 1))
            painter.drawLine(QPointF(x, rect.bottom()), QPointF(x, rect.bottom() + 4))
            painter.setPen(COLOR_SUB)
            painter.drawText(QRectF(x - 20, rect.bottom() + 4, 40, 14),
                             Qt.AlignmentFlag.AlignHCenter, f"{t:g}s")
            t += step

        # 关键帧
        for kf in self._info.keyframes:
            x = self._x_of(kf.content_time)
            inside = self._start - 1e-6 <= kf.content_time <= self._end + 1e-6
            color = COLOR_KEY_SEL if inside else COLOR_KEY
            path = QPainterPath()
            path.moveTo(x, rect.top() + 4)
            path.lineTo(x + 4.2, rect.top() + 9)
            path.lineTo(x, rect.top() + 14)
            path.lineTo(x - 4.2, rect.top() + 9)
            path.closeSubpath()
            painter.setBrush(QBrush(color))
            painter.setPen(Qt.PenStyle.NoPen)
            painter.drawPath(path)

        # 播放头
        cx = self._x_of(self._cursor)
        painter.setPen(QPen(QColor(255, 112, 88), 1.6))
        painter.drawLine(QPointF(cx, rect.top() - 6), QPointF(cx, rect.bottom() + 6))

        # 悬停提示
        if self._hover:
            self._draw_hover(painter, self._hover, rect)

        # 顶部图例
        painter.setPen(COLOR_TEXT)
        painter.setFont(QFont(self.font().family(), 9))
        legend = (f"关键帧 {len(self._info.keyframes)} 个 · "
                  f"GOP ≈ {self._median_gop():.2f}s · "
                  f"{self._info.fps:.3f} fps")
        painter.drawText(QRectF(14, 6, self.width() - 28, 18),
                         Qt.AlignmentFlag.AlignLeft, legend)
        right = f"{self._cursor:.3f}s / {self._duration:.3f}s"
        painter.drawText(QRectF(14, 6, self.width() - 28, 18),
                         Qt.AlignmentFlag.AlignRight, right)
        painter.end()

    def _draw_hover(self, painter: QPainter, kf: media.Keyframe,
                    rect: QRectF) -> None:
        x = self._x_of(kf.content_time)
        painter.setPen(QPen(COLOR_KEY_SEL, 1, Qt.PenStyle.DashLine))
        painter.drawLine(QPointF(x, rect.top()), QPointF(x, rect.bottom()))
        text = f"#{kf.frame_index}  {kf.content_time:.3f}s"
        painter.setFont(QFont(self.font().family(), 8))
        metrics = painter.fontMetrics()
        width = metrics.horizontalAdvance(text) + 12
        bx = min(max(4.0, x - width / 2), self.width() - width - 4)
        box = QRectF(bx, rect.bottom() + 20, width, 18)
        painter.setPen(Qt.PenStyle.NoPen)
        painter.setBrush(QColor(50, 60, 82, 235))
        painter.drawRoundedRect(box, 3, 3)
        painter.setPen(COLOR_TEXT)
        painter.drawText(box, Qt.AlignmentFlag.AlignCenter, text)

    @staticmethod
    def _nice_step(duration: float) -> float:
        for step in (0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300):
            if duration / step <= 12:
                return float(step)
        return max(1.0, duration / 10)

    def _median_gop(self) -> float:
        if not self._info:
            return 0.0
        vals = [kf.gop_seconds for kf in self._info.keyframes if kf.gop_seconds]
        if not vals:
            return 0.0
        vals.sort()
        return vals[len(vals) // 2]

    # ---- 交互 ----
    def mouseMoveEvent(self, event) -> None:  # noqa: N802
        if not self._info:
            return
        x = event.position().x()
        nearest = None
        best = 12.0
        for kf in self._info.keyframes:
            dist = abs(self._x_of(kf.content_time) - x)
            if dist < best:
                best, nearest = dist, kf
        if nearest is not self._hover:
            self._hover = nearest
            self.update()

    def leaveEvent(self, event) -> None:  # noqa: N802
        self._hover = None
        self.update()

    def mousePressEvent(self, event) -> None:  # noqa: N802
        if event.button() == Qt.MouseButton.LeftButton and self._info:
            self.seekRequested.emit(self._t_of(event.position().x()))


class FrameTile(QFrame):
    """带标题与状态行的帧预览图块。"""

    def __init__(self, title: str, parent=None):
        super().__init__(parent)
        self.setFrameShape(QFrame.Shape.StyledPanel)
        self.setObjectName("frameTile")
        self.setMinimumSize(240, 190)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(8, 8, 8, 8)
        layout.setSpacing(6)

        self.title = QLabel(title)
        self.title.setObjectName("tileTitle")
        self.image = QLabel("—")
        self.image.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.image.setMinimumSize(220, 124)
        self.image.setObjectName("tileImage")
        self.caption = QLabel("")
        self.caption.setWordWrap(True)
        self.caption.setObjectName("tileCaption")
        self.caption.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        layout.addWidget(self.title)
        layout.addWidget(self.image, 1)
        layout.addWidget(self.caption)
        self._pixmap: QPixmap | None = None

    def set_image(self, path: str | Path | None) -> None:
        if not path:
            self._pixmap = None
            self.image.setText("—")
            return
        pix = QPixmap(str(path))
        if pix.isNull():
            self._pixmap = None
            self.image.setText("无法读取")
            return
        self._pixmap = pix
        self._refresh()

    def set_placeholder(self, text: str) -> None:
        self._pixmap = None
        self.image.setText(text)

    def set_caption(self, text: str) -> None:
        self.caption.setText(text)

    def resizeEvent(self, event) -> None:  # noqa: N802
        super().resizeEvent(event)
        self._refresh()

    def _refresh(self) -> None:
        if not self._pixmap:
            return
        area = self.image.size()
        scaled = self._pixmap.scaled(
            area, Qt.AspectRatioMode.KeepAspectRatio,
            Qt.TransformationMode.SmoothTransformation)
        self.image.setPixmap(scaled)
