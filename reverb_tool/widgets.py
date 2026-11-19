"""Qt 绘制部件：波形视图、电平表、状态标签。

这些部件只负责画图和发信号，不持有渲染状态；所有时间都使用调用方给定的
"输出时间轴帧号"，因此播放头与波形天然对齐。
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
from PySide6.QtCore import QPointF, QRectF, Qt, Signal
from PySide6.QtGui import (
    QColor,
    QFont,
    QFontMetrics,
    QMouseEvent,
    QPainter,
    QPainterPath,
    QPen,
    QPolygonF,
)
from PySide6.QtWidgets import QSizePolicy, QWidget

# 参考调色板（深色模式）
SURFACE = QColor("#1a1a19")
SURFACE_RAISED = QColor("#222221")
PAGE = QColor("#0d0d0d")
INK = QColor("#f0efec")
INK_SECONDARY = QColor("#c3c2b7")
INK_MUTED = QColor("#898781")
GRID = QColor("#2c2c2a")
BASELINE = QColor("#383835")
SERIES_L = QColor("#3987e5")  # 左声道 / 干声
SERIES_R = QColor("#d95926")  # 右声道 / 响应
ACCENT = QColor("#3987e5")
DRY_MARK = QColor("#fab219")  # 干声终点
TAIL_MARK = QColor("#c3c2b7")  # 尾音终点
PREDELAY = QColor("#9085e9")  # 预延迟
GOOD = QColor("#0ca30c")
WARNING = QColor("#fab219")
CRITICAL = QColor("#d03b3b")

RULER_HEIGHT = 26
TOP_PAD = 46  # 给标记标签留的空间（最多三行错开）
SIDE_PAD = 8


@dataclass(frozen=True)
class Marker:
    label: str
    frame: int
    color: QColor
    row: int = 0  # 标签上下错行，避免重叠


@dataclass(frozen=True)
class Band:
    start_frame: int
    end_frame: int
    color: QColor
    label: str = ""


def _with_alpha(color: QColor, alpha: float) -> QColor:
    out = QColor(color)
    out.setAlphaF(max(0.0, min(1.0, alpha)))
    return out


def _envelope(data: np.ndarray, width: int) -> tuple[np.ndarray, np.ndarray]:
    """把任意长度信号压缩成每像素列的最小/最大值。"""
    n = data.shape[0]
    if width <= 0:
        empty = np.zeros(0)
        return empty, empty
    if n == 0:
        return np.zeros(width), np.zeros(width)
    if n <= width:
        # 样本少于像素：每个样本占一列，空列补零
        lo = np.zeros(width)
        hi = np.zeros(width)
        cols = (np.arange(n) * width / n).astype(int)
        np.minimum.at(lo, cols, data)
        np.maximum.at(hi, cols, data)
        return lo, hi
    bounds = np.linspace(0, n, width + 1).astype(int)
    lo = np.minimum.reduceat(data, bounds[:-1])
    hi = np.maximum.reduceat(data, bounds[:-1])
    lo = np.minimum(lo, 0.0)
    hi = np.maximum(hi, 0.0)
    return lo, hi


class WaveformView(QWidget):
    """单/双声道波形。interactive=True 时带时间尺、选区与播放头。"""

    seek_requested = Signal(int)  # 输出时间轴帧号
    scrub_started = Signal()
    selection_changed = Signal(int, int)
    selection_cleared = Signal()
    scrub_finished = Signal()

    def __init__(self, *, interactive: bool = False, parent=None) -> None:
        super().__init__(parent)
        self.interactive = interactive
        self._lanes: list[np.ndarray] = []
        self._frames = 0
        self._sample_rate = 48000
        self._colors = [SERIES_L, SERIES_R]
        self._markers: list[Marker] = []
        self._bands: list[Band] = []
        self._selection: tuple[int, int] | None = None
        self._playhead: int | None = None
        self._hover_x: float | None = None
        self._envelope_cache: dict[tuple[int, int], tuple[np.ndarray, np.ndarray]] = {}
        self._drag: dict | None = None
        self._press_x: float | None = None
        self.setMinimumHeight(72)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding)
        self.setMouseTracking(interactive)
        self.setCursor(Qt.CursorShape.CrossCursor)
        self.setToolTip("波形纵向按自身峰值缩放；峰值的真实数值见界面读数。")

    # ---------- 数据 ----------
    def set_audio(
        self,
        samples: np.ndarray | None,
        sample_rate: int,
        colors: list[QColor] | None = None,
    ) -> None:
        if samples is None:
            self._lanes = []
            self._frames = 0
        else:
            array = np.asarray(samples, dtype=np.float64)
            if array.ndim == 1:
                array = array[:, None]
            self._lanes = [np.ascontiguousarray(array[:, ch]) for ch in range(array.shape[1])]
            self._frames = int(array.shape[0])
        self._sample_rate = int(sample_rate) if sample_rate else 48000
        if colors:
            self._colors = list(colors)
        self._envelope_cache.clear()
        self._selection = None
        self._playhead = None
        self.update()

    def set_colors(self, colors: list[QColor]) -> None:
        self._colors = list(colors)
        self.update()

    def set_markers(self, markers: list[Marker], bands: list[Band] | None = None) -> None:
        self._markers = list(markers)
        self._bands = list(bands or [])
        self.update()

    def set_selection(self, selection: tuple[int, int] | None) -> None:
        if selection is not None:
            start, end = selection
            if start > end:
                start, end = end, start
            if end <= start:
                selection = None
        self._selection = selection
        self.update()

    def selection(self) -> tuple[int, int] | None:
        return self._selection

    def set_playhead(self, frame: int | None) -> None:
        self._playhead = None if frame is None else int(frame)
        self.update()

    @property
    def frames(self) -> int:
        return self._frames

    def resizeEvent(self, event) -> None:  # noqa: N802
        # 宽度变了，包络缓存里的列数就不再匹配；清掉后重画。
        self._envelope_cache.clear()
        super().resizeEvent(event)

    def clear(self) -> None:
        self.set_audio(None, 0)
        self.set_markers([])
        self._selection = None
        self._playhead = None
        self.update()

    # ---------- 几何 ----------
    def _content_rect(self) -> QRectF:
        bottom = RULER_HEIGHT if self.interactive else 0
        return QRectF(
            SIDE_PAD,
            TOP_PAD,
            max(1.0, self.width() - 2 * SIDE_PAD),
            max(1.0, self.height() - TOP_PAD - bottom - 4),
        )

    def _frame_to_x(self, frame: float, rect: QRectF | None = None) -> float:
        rect = rect or self._content_rect()
        if self._frames <= 0:
            return rect.left()
        ratio = float(np.clip(frame, 0, self._frames)) / self._frames
        return rect.left() + ratio * rect.width()

    def _x_to_frame(self, x: float) -> int:
        rect = self._content_rect()
        if rect.width() <= 0 or self._frames <= 0:
            return 0
        ratio = (x - rect.left()) / rect.width()
        return int(round(np.clip(ratio, 0.0, 1.0) * self._frames))

    # ---------- 绘制 ----------
    def paintEvent(self, event) -> None:
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        painter.fillRect(self.rect(), SURFACE)
        rect = self._content_rect()

        if self._frames <= 0 or not self._lanes:
            painter.setPen(INK_MUTED)
            painter.drawText(
                self.rect(),
                Qt.AlignmentFlag.AlignCenter,
                "尚未加载" if not self.interactive else "尚未生成输出",
            )
            return

        self._draw_bands(painter, rect)
        self._draw_grid(painter, rect)
        self._draw_lanes(painter, rect)
        self._draw_selection(painter, rect)
        self._draw_markers(painter, rect)
        self._draw_playhead(painter, rect)
        if self.interactive:
            self._draw_ruler(painter, rect)
        if self._hover_x is not None and self.interactive:
            self._draw_hover(painter, rect)

    def _draw_bands(self, painter: QPainter, rect: QRectF) -> None:
        for band in self._bands:
            x0 = self._frame_to_x(band.start_frame, rect)
            x1 = self._frame_to_x(band.end_frame, rect)
            if x1 - x0 < 0.5:
                continue
            painter.fillRect(
                QRectF(x0, rect.top(), x1 - x0, rect.height()),
                _with_alpha(band.color, 0.10),
            )
            if band.label:
                painter.setPen(_with_alpha(band.color, 0.9))
                painter.setFont(self._small_font())
                painter.drawText(
                    QPointF(x0 + 4, rect.top() + 12), band.label
                )

    def _draw_grid(self, painter: QPainter, rect: QRectF) -> None:
        painter.setPen(QPen(GRID, 1))
        painter.drawLine(QPointF(rect.left(), rect.bottom()), QPointF(rect.right(), rect.bottom()))
        lanes = max(1, len(self._lanes))
        lane_h = rect.height() / lanes
        for lane in range(lanes):
            y = rect.top() + lane_h * (lane + 0.5)
            painter.drawLine(QPointF(rect.left(), y), QPointF(rect.right(), y))

    def _draw_lanes(self, painter: QPainter, rect: QRectF) -> None:
        width = max(1, round(rect.width()))
        lanes = max(1, len(self._lanes))
        lane_h = rect.height() / lanes
        usable_h = lane_h - (6 if lanes > 1 else 0)
        for lane_index, data in enumerate(self._lanes):
            key = (lane_index, width)
            cache = self._envelope_cache.get(key)
            if cache is None:
                lo, hi = _envelope(data, width)
                self._envelope_cache[key] = (lo, hi)
            else:
                lo, hi = cache
            if lo.size == 0:
                continue
            center_y = rect.top() + lane_h * (lane_index + 0.5)
            half = usable_h / 2.0
            # 纵向按当前波形自身峰值缩放（至少 0.1 满幅），幅度的真实大小看界面峰值读数。
            peak = float(max(np.max(np.abs(hi)), np.max(np.abs(lo)), 0.0))
            scale = 1.0 / max(peak, 0.1)
            xs = rect.left() + (np.arange(width) + 0.5) * rect.width() / width

            # 先按峰值归一化再限制在 ±1 车道内（超幅波形不会提前被削平显示）
            scaled_hi = np.clip(hi * scale, -1.0, 1.0)
            scaled_lo = np.clip(lo * scale, -1.0, 1.0)
            # 闭合轮廓：左基线 → 上沿（左到右）→ 右基线 → 下沿（右到左）。
            # 顺序错了会让多边形自交，填充出横贯全图的楔形。
            polygon = QPolygonF()
            polygon.append(QPointF(xs[0], center_y))
            for x, y in zip(xs, scaled_hi):
                polygon.append(QPointF(x, center_y - y * half))
            polygon.append(QPointF(xs[-1], center_y))
            for x, y in zip(xs[::-1], scaled_lo[::-1]):
                polygon.append(QPointF(x, center_y - y * half))
            color = self._colors[lane_index % len(self._colors)]
            painter.setPen(Qt.PenStyle.NoPen)
            painter.setBrush(_with_alpha(color, 0.38))
            painter.drawPolygon(polygon)

            pen = QPen(_with_alpha(color, 0.95), 1.0)
            painter.setPen(pen)
            painter.setBrush(Qt.BrushStyle.NoBrush)
            path = QPainterPath()
            path.addPolygon(polygon)
            painter.drawPath(path)

            if lanes > 1:
                label = "L" if lane_index == 0 else "R"
                painter.setFont(self._small_font())
                painter.setPen(INK_MUTED)
                painter.drawText(
                    QPointF(rect.left() + 3, rect.top() + lane_h * (lane_index + 1) - 4),
                    label,
                )

    def _draw_selection(self, painter: QPainter, rect: QRectF) -> None:
        if self._selection is None:
            return
        start, end = self._selection
        x0 = self._frame_to_x(start, rect)
        x1 = self._frame_to_x(end, rect)
        painter.fillRect(
            QRectF(x0, rect.top(), max(1.0, x1 - x0), rect.height()),
            _with_alpha(ACCENT, 0.16),
        )
        painter.setPen(QPen(_with_alpha(ACCENT, 0.95), 1.5))
        painter.drawLine(QPointF(x0, rect.top()), QPointF(x0, rect.bottom()))
        painter.drawLine(QPointF(x1, rect.top()), QPointF(x1, rect.bottom()))

    def _draw_markers(self, painter: QPainter, rect: QRectF) -> None:
        font = self._small_font()
        painter.setFont(font)
        metrics = QFontMetrics(font)
        rows: list[list[tuple[float, float]]] = [[], [], []]
        for marker in self._markers:
            x = self._frame_to_x(marker.frame, rect)
            painter.setPen(QPen(_with_alpha(marker.color, 0.85), 1.2))
            painter.drawLine(QPointF(x, rect.top()), QPointF(x, rect.bottom()))
            text = marker.label
            width = metrics.horizontalAdvance(text) + 8
            left = float(np.clip(x + 4, rect.left(), rect.right() - width))
            chosen = None
            # 优先使用调用方指定的行，其次按 0/1/2 找一行不重叠的。
            for row in (marker.row % 3, 0, 1, 2):
                box = QRectF(left, rect.top() - TOP_PAD + 2 + row * 14, width, 14)
                if not any(
                    not (box.right() < o[0] or box.left() > o[1]) for o in rows[row]
                ):
                    chosen = (row, box)
                    break
            if chosen is None:
                continue  # 位置过密：保留竖线，数值仍在界面其他位置可见
            row, box = chosen
            rows[row].append((box.left(), box.right()))
            painter.setPen(Qt.PenStyle.NoPen)
            painter.setBrush(SURFACE_RAISED)
            painter.drawRoundedRect(box, 3, 3)
            painter.setPen(marker.color)
            painter.drawText(box.adjusted(4, 0, -2, 0), Qt.AlignmentFlag.AlignVCenter, text)

    def _draw_playhead(self, painter: QPainter, rect: QRectF) -> None:
        if self._playhead is None:
            return
        x = self._frame_to_x(self._playhead, rect)
        painter.setPen(QPen(INK, 2.0))
        painter.drawLine(QPointF(x, rect.top() - 8), QPointF(x, rect.bottom()))
        painter.setPen(Qt.PenStyle.NoPen)
        painter.setBrush(INK)
        painter.drawPolygon(
            QPolygonF(
                [
                    QPointF(x - 5, rect.top() - 8),
                    QPointF(x + 5, rect.top() - 8),
                    QPointF(x, rect.top() - 1),
                ]
            )
        )

    def _draw_ruler(self, painter: QPainter, rect: QRectF) -> None:
        y = rect.bottom() + 3
        ruler = QRectF(rect.left(), y, rect.width(), RULER_HEIGHT - 4)
        painter.fillRect(ruler, PAGE)
        painter.setFont(self._small_font())
        duration = self._frames / self._sample_rate if self._sample_rate else 0.0
        if duration <= 0:
            return
        target_px = 110.0
        raw = duration * target_px / max(1.0, rect.width())
        nice_steps = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1.0, 2.0, 5.0, 10.0, 20.0]
        step = next((s for s in nice_steps if s >= raw), nice_steps[-1])
        decimals = 0 if step >= 1 else (1 if step >= 0.1 else 2)
        t = 0.0
        metrics = QFontMetrics(self._small_font())
        while t <= duration + 1e-9:
            x = rect.left() + (t / duration) * rect.width()
            painter.setPen(QPen(BASELINE, 1))
            painter.drawLine(QPointF(x, ruler.top() + 4), QPointF(x, ruler.bottom()))
            text = f"{t:.{decimals}f}s"
            if x + metrics.horizontalAdvance(text) + 4 < rect.right():
                painter.setPen(INK_MUTED)
                painter.drawText(QPointF(x + 3, ruler.top() + 12), text)
            t += step

    def _draw_hover(self, painter: QPainter, rect: QRectF) -> None:
        x = float(np.clip(self._hover_x, rect.left(), rect.right()))
        painter.setPen(QPen(_with_alpha(INK_MUTED, 0.5), 1, Qt.PenStyle.DashLine))
        painter.drawLine(QPointF(x, rect.top()), QPointF(x, rect.bottom()))
        frame = self._x_to_frame(x)
        painter.setFont(self._small_font())
        painter.setPen(INK_SECONDARY)
        text = f"{frame / self._sample_rate:.3f}s"
        painter.drawText(QPointF(min(x + 6, rect.right() - 60), rect.bottom() - 6), text)

    def _small_font(self) -> QFont:
        font = QFont(self.font())
        font.setPointSizeF(max(9.0, font.pointSizeF() - 2.0))
        return font

    # ---------- 交互 ----------
    def _in_ruler(self, pos) -> bool:
        if not self.interactive:
            return False
        rect = self._content_rect()
        return pos.y() > rect.bottom()

    def mousePressEvent(self, event: QMouseEvent) -> None:
        if not self.interactive or self._frames <= 0:
            return
        if event.button() != Qt.MouseButton.LeftButton:
            return
        pos = event.position()
        if self._in_ruler(pos):
            self.scrub_started.emit()
            self.seek_requested.emit(self._x_to_frame(pos.x()))
            self._drag = {"mode": "scrub"}
        else:
            self.scrub_started.emit()
            self._press_x = pos.x()
            self._drag = {
                "mode": "select",
                "start": self._x_to_frame(pos.x()),
                "start_x": pos.x(),
            }
        event.accept()

    def mouseMoveEvent(self, event: QMouseEvent) -> None:
        if not self.interactive:
            return
        pos = event.position()
        self._hover_x = pos.x()
        if self._drag is not None:
            if self._drag["mode"] == "scrub":
                self.seek_requested.emit(self._x_to_frame(pos.x()))
            else:
                frame = self._x_to_frame(pos.x())
                self.set_selection((self._drag["start"], frame))
        self.update()

    def mouseReleaseEvent(self, event: QMouseEvent) -> None:
        if not self.interactive:
            return
        drag = self._drag
        self._drag = None
        if drag is None:
            return
        if drag["mode"] == "select":
            pos = event.position()
            distance = abs(pos.x() - drag["start_x"])
            if distance < 4:
                # 视为单击：只移动播放头，保留既有选区
                self.set_selection(self._selection)
                self.seek_requested.emit(self._x_to_frame(pos.x()))
            else:
                start = drag["start"]
                end = self._x_to_frame(pos.x())
                if start > end:
                    start, end = end, start
                if end - start >= 2:
                    self.set_selection((start, end))
                    self.selection_changed.emit(start, end)
                else:
                    # 拖得太短：按单击处理，移动播放头，不改动既有选区
                    self.set_selection(self._selection)
                    self.seek_requested.emit(end)
        self.scrub_finished.emit()
        self.update()

    def mouseDoubleClickEvent(self, event: QMouseEvent) -> None:
        if not self.interactive:
            return
        if event.button() == Qt.MouseButton.LeftButton:
            self.set_selection(None)
            self.selection_cleared.emit()

    def leaveEvent(self, event) -> None:
        self._hover_x = None
        self.update()


class LevelMeter(QWidget):
    """-60..+6 dBFS 横向电平条；超幅时整条变红并显示提示文字。"""

    MIN_DB = -60.0
    MAX_DB = 6.0

    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self._db = -math.inf
        self._label = ""
        self.setMinimumHeight(18)
        self.setMinimumWidth(120)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)

    def set_level(self, db: float, label: str = "") -> None:
        self._db = db
        self._label = label
        self.update()

    def paintEvent(self, event) -> None:
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        rect = QRectF(0, 1, self.width(), self.height() - 2)
        painter.setPen(Qt.PenStyle.NoPen)
        painter.setBrush(GRID)
        painter.drawRoundedRect(rect, 3, 3)
        span = self.MAX_DB - self.MIN_DB
        if self._db > self.MIN_DB:
            ratio = (min(self._db, self.MAX_DB) - self.MIN_DB) / span
            if self._db > 0:
                color = CRITICAL
            elif self._db > -6:
                color = WARNING
            else:
                color = GOOD
            fill = QRectF(rect.left(), rect.top(), max(2.0, rect.width() * ratio), rect.height())
            painter.setBrush(color)
            painter.drawRoundedRect(fill, 3, 3)
        # 0 dBFS 刻度
        x = rect.left() + (0 - self.MIN_DB) / span * rect.width()
        painter.setPen(QPen(_with_alpha(INK, 0.55), 1))
        painter.drawLine(QPointF(x, rect.top()), QPointF(x, rect.bottom()))
        if self._label:
            painter.setFont(self.font())
            painter.setPen(INK)
            flags = Qt.AlignmentFlag.AlignVCenter | Qt.AlignmentFlag.AlignRight
            painter.drawText(rect.adjusted(0, 0, -6, 0), flags, self._label)


class StatusPill(QWidget):
    """带图标+文字的状态胶囊；颜色从不单独承担含义。"""

    def __init__(self, text: str = "", parent=None) -> None:
        super().__init__(parent)
        self._text = text
        self._level = "muted"
        self.setMinimumHeight(22)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)

    def set_status(self, text: str, level: str = "muted") -> None:
        self._text = text
        self._level = level
        self.setToolTip(text)
        self.update()

    def paintEvent(self, event) -> None:
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        color = {
            "good": GOOD,
            "warning": WARNING,
            "critical": CRITICAL,
            "muted": INK_MUTED,
        }.get(self._level, INK_MUTED)
        icon = {"good": "✓", "warning": "!", "critical": "▲", "muted": "•"}.get(
            self._level, "•"
        )
        painter.setPen(color)
        painter.setBrush(Qt.BrushStyle.NoBrush)
        painter.setFont(self.font())
        text = f"{icon} {self._text}" if self._text else ""
        painter.drawText(
            self.rect().adjusted(2, 0, -2, 0),
            Qt.AlignmentFlag.AlignVCenter | Qt.AlignmentFlag.AlignLeft,
            text,
        )
