"""An image panel that maps mouse positions to pixels and draws overlays."""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from PySide6.QtCore import QPointF, QRectF, Qt, Signal
from PySide6.QtGui import QBrush, QColor, QFont, QImage, QPainter, QPen, QPolygonF
from PySide6.QtWidgets import QSizePolicy, QWidget

from .. import theme


def numpy_to_qimage(rgb: np.ndarray) -> QImage:
    arr = np.ascontiguousarray(np.asarray(rgb, dtype=np.uint8))
    if arr.ndim == 2:
        arr = np.repeat(arr[..., None], 3, axis=-1)
    h, w = arr.shape[:2]
    image = QImage(arr.data, w, h, 3 * w, QImage.Format.Format_RGB888)
    return image.copy()


@dataclass
class Marker:
    x: int
    y: int
    label: str = ""
    color: str = theme.ACCENT


class ImageView(QWidget):
    """Draws an RGB array scaled to fit, with an optional probe crosshair.

    Emits ``pixelHovered(x, y)`` for the image pixel under the mouse and
    ``pixelClicked(x, y)`` when the user clicks.
    """

    pixelHovered = Signal(int, int)
    pixelClicked = Signal(int, int)
    left = Signal()

    def __init__(self, parent=None, keep_aspect: bool = True):
        super().__init__(parent)
        self._image: QImage | None = None
        self._array: np.ndarray | None = None
        self._markers: list[Marker] = []
        self._cursor: tuple[int, int] | None = None
        self._crosshair = False
        self._pinned: tuple[int, int] | None = None
        self._arrows: list[tuple[int, int, float, float, float]] = []
        self._show_arrows = False
        self._arrow_color = QColor(theme.ACCENT)
        self._badge = ""
        self._empty_text = "暂无图像"
        self._keep_aspect = keep_aspect
        self._zoom = 1.0
        self._pan = QPointF(0, 0)
        self._dragging = False
        self._drag_start = QPointF(0, 0)
        self._pan_start = QPointF(0, 0)
        self._hovering = False
        self.setMouseTracking(True)
        self.setMinimumSize(160, 160)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding)
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)

    # ------------------------------------------------------------------ data
    def set_image(self, rgb: np.ndarray | None, empty_text: str | None = None) -> None:
        self._array = None if rgb is None else np.asarray(rgb, dtype=np.uint8)
        self._image = None if rgb is None else numpy_to_qimage(rgb)
        if empty_text is not None:
            self._empty_text = empty_text
        self.update()

    def set_gray(self, image: np.ndarray | None) -> None:
        if image is None:
            self.set_image(None)
            return
        g = np.clip(np.asarray(image, dtype=np.float64), 0.0, 1.0)
        rgb = np.repeat(np.rint(g * 255.0).astype(np.uint8)[..., None], 3, axis=-1)
        self.set_image(rgb)

    def array(self) -> np.ndarray | None:
        return self._array

    def image_size(self) -> tuple[int, int]:
        if self._array is None:
            return (0, 0)
        return (self._array.shape[1], self._array.shape[0])

    def set_markers(self, markers: list[Marker]) -> None:
        self._markers = list(markers)
        self.update()

    def set_cursor(self, xy: tuple[int, int] | None, crosshair: bool = True) -> None:
        self._cursor = xy
        self._crosshair = crosshair
        self.update()

    def set_pinned(self, xy: tuple[int, int] | None) -> None:
        self._pinned = xy
        self.update()

    def set_arrows(self, arrows: list[tuple[int, int, float, float, float]],
                   color: str = theme.ACCENT) -> None:
        self._arrows = list(arrows)
        self._arrow_color = QColor(color)
        self.update()

    def set_show_arrows(self, on: bool) -> None:
        self._show_arrows = on
        self.update()

    def set_badge(self, text: str) -> None:
        self._badge = text
        self.update()

    def set_zoom(self, zoom: float) -> None:
        self._zoom = float(min(max(zoom, 0.25), 12.0))
        self.update()

    def zoom(self) -> float:
        return self._zoom

    def reset_zoom(self) -> None:
        self._zoom = 1.0
        self._pan = QPointF(0, 0)
        self.update()

    # --------------------------------------------------------------- geometry
    def _fit_scale(self) -> float:
        if self._image is None:
            return 1.0
        iw, ih = self._image.width(), self._image.height()
        if iw <= 0 or ih <= 0:
            return 1.0
        margin = 8
        avail_w = max(1, self.width() - 2 * margin)
        avail_h = max(1, self.height() - 2 * margin)
        return min(avail_w / iw, avail_h / ih)

    def _target_rect(self) -> QRectF:
        if self._image is None:
            return QRectF(0, 0, 0, 0)
        scale = self._fit_scale() * self._zoom
        iw = self._image.width() * scale
        ih = self._image.height() * scale
        x = (self.width() - iw) / 2.0 + self._pan.x()
        y = (self.height() - ih) / 2.0 + self._pan.y()
        return QRectF(x, y, iw, ih)

    def image_to_widget(self, x: int, y: int) -> QPointF:
        rect = self._target_rect()
        if self._image is None:
            return QPointF(0, 0)
        sx = rect.width() / max(1, self._image.width())
        sy = rect.height() / max(1, self._image.height())
        return QPointF(rect.left() + (x + 0.5) * sx, rect.top() + (y + 0.5) * sy)

    def widget_to_image(self, pos: QPointF) -> tuple[int, int] | None:
        if self._image is None:
            return None
        rect = self._target_rect()
        if rect.width() <= 0 or rect.height() <= 0:
            return None
        fx = (pos.x() - rect.left()) / rect.width()
        fy = (pos.y() - rect.top()) / rect.height()
        if not (0.0 <= fx < 1.0 and 0.0 <= fy < 1.0):
            return None
        x = int(fx * self._image.width())
        y = int(fy * self._image.height())
        return (min(x, self._image.width() - 1), min(y, self._image.height() - 1))

    # ----------------------------------------------------------------- events
    def mouseMoveEvent(self, event):
        pos = event.position()
        if self._dragging:
            delta = pos - self._drag_start
            self._pan = self._pan_start + delta
            self.update()
            event.accept()
            return
        xy = self.widget_to_image(pos)
        self._hovering = xy is not None
        if xy is not None:
            self.pixelHovered.emit(*xy)
        self.update()
        super().mouseMoveEvent(event)

    def leaveEvent(self, event):
        self._hovering = False
        self.left.emit()
        self.update()
        super().leaveEvent(event)

    def mousePressEvent(self, event):
        if event.button() == Qt.MouseButton.MiddleButton:
            self._dragging = True
            self._drag_start = event.position()
            self._pan_start = QPointF(self._pan)
            event.accept()
            return
        if event.button() == Qt.MouseButton.LeftButton:
            xy = self.widget_to_image(event.position())
            if xy is not None:
                self.pixelClicked.emit(*xy)
        super().mousePressEvent(event)

    def mouseReleaseEvent(self, event):
        if event.button() == Qt.MouseButton.MiddleButton:
            self._dragging = False
            event.accept()
            return
        super().mouseReleaseEvent(event)

    def mouseDoubleClickEvent(self, event):
        if event.button() == Qt.MouseButton.MiddleButton:
            self.reset_zoom()
            return
        super().mouseDoubleClickEvent(event)

    def wheelEvent(self, event):
        if event.modifiers() & Qt.KeyboardModifier.ControlModifier:
            step = 1.15 if event.angleDelta().y() > 0 else 1 / 1.15
            self.set_zoom(self._zoom * step)
            event.accept()
            return
        super().wheelEvent(event)

    def keyPressEvent(self, event):
        if event.key() == Qt.Key.Key_0:
            self.reset_zoom()
            return
        super().keyPressEvent(event)

    # ------------------------------------------------------------------ paint
    def paintEvent(self, event):
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        painter.fillRect(self.rect(), QColor(theme.BG))
        if self._image is None:
            painter.setPen(QColor(theme.MUTED))
            painter.drawText(self.rect(), Qt.AlignmentFlag.AlignCenter, self._empty_text)
            return

        rect = self._target_rect()
        painter.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform, self._zoom < 4)
        painter.drawImage(rect, self._image)

        if self._show_arrows and self._arrows:
            self._paint_arrows(painter, rect)

        if self._pinned is not None:
            self._paint_marker(painter, rect, self._pinned, QColor(theme.WARN), "采样点", 10)

        for marker in self._markers:
            self._paint_marker(painter, rect, (marker.x, marker.y),
                               QColor(marker.color), marker.label, 8)

        if self._hovering and self._cursor is not None:
            self._paint_crosshair(painter, rect, self._cursor)

        if self._badge:
            self._paint_badge(painter, self._badge)

    def _paint_arrows(self, painter: QPainter, rect: QRectF) -> None:
        if self._image is None:
            return
        sx = rect.width() / max(1, self._image.width())
        sy = rect.height() / max(1, self._image.height())
        arrow_scale = min(sx, sy) * 9.0
        # draw a dark halo first, then the light arrow, so the marks stay
        # legible on both the pastel normal map and the grey photographs.
        halo = QColor(0, 0, 0, 150)
        for stage in ("halo", "line"):
            if stage == "halo":
                pen = QPen(halo, 3.0)
                painter.setBrush(Qt.BrushStyle.NoBrush)
            else:
                pen = QPen(self._arrow_color, 1.3)
                painter.setBrush(QBrush(self._arrow_color))
            pen.setCapStyle(Qt.PenCapStyle.RoundCap)
            painter.setPen(pen)
            for (x, y, dx, dy, tilt) in self._arrows:
                c = self.image_to_widget(x, y)
                mag = tilt / 90.0
                length = arrow_scale * max(0.25, min(1.0, mag))
                norm = max(1e-6, (dx * dx + dy * dy) ** 0.5)
                ux, uy = dx / norm, dy / norm
                tip = QPointF(c.x() + ux * length, c.y() + uy * length)
                head = 2.4
                left_pt = QPointF(tip.x() - ux * head * 2 + uy * head,
                                  tip.y() - uy * head * 2 - ux * head)
                right_pt = QPointF(tip.x() - ux * head * 2 - uy * head,
                                   tip.y() - uy * head * 2 + ux * head)
                if stage == "halo":
                    painter.drawLine(c, tip)
                else:
                    painter.drawLine(c, tip)
                    painter.drawPolygon(QPolygonF([tip, left_pt, right_pt]))

    def _paint_marker(self, painter: QPainter, rect: QRectF,
                      xy: tuple[int, int], colour: QColor, label: str = "",
                      radius: int = 8) -> None:
        p = self.image_to_widget(*xy)
        painter.setPen(QPen(colour, 2))
        painter.setBrush(QBrush(QColor(colour.red(), colour.green(), colour.blue(), 40)))
        painter.drawEllipse(p, radius, radius)
        if label:
            painter.setPen(QColor(theme.TEXT))
            font = QFont(self.font())
            font.setPointSize(9)
            painter.setFont(font)
            painter.drawText(QPointF(p.x() + radius + 4, p.y() - radius + 2), label)

    def _paint_crosshair(self, painter: QPainter, rect: QRectF,
                         xy: tuple[int, int]) -> None:
        p = self.image_to_widget(*xy)
        painter.setPen(QPen(QColor(255, 255, 255, 150), 1, Qt.PenStyle.DashLine))
        painter.setBrush(Qt.BrushStyle.NoBrush)
        size = 12
        painter.drawLine(QPointF(p.x() - size, p.y()), QPointF(p.x() + size, p.y()))
        painter.drawLine(QPointF(p.x(), p.y() - size), QPointF(p.x(), p.y() + size))
        painter.setPen(QPen(QColor(0, 0, 0, 120), 1))
        painter.drawRect(QRectF(p.x() - 3.5, p.y() - 3.5, 7, 7))

    def _paint_badge(self, painter: QPainter, text: str) -> None:
        painter.setFont(QFont(self.font().family(), 9))
        metrics = painter.fontMetrics()
        width = metrics.horizontalAdvance(text) + 14
        height = metrics.height() + 8
        box = QRectF(self.width() - width - 8, 8, width, height)
        painter.setPen(Qt.PenStyle.NoPen)
        painter.setBrush(QColor(0, 0, 0, 150))
        painter.drawRoundedRect(box, 5, 5)
        painter.setPen(QColor(theme.TEXT))
        painter.drawText(box, Qt.AlignmentFlag.AlignCenter, text)
