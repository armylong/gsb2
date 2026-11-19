"""Reusable image canvas with synchronised pixel marker and light overlay.

Rendering scales the *already computed* full-resolution data; it never
recomputes relief from the on-screen size.  Interpolation is disabled when
zooming so the preview does not invent detail.
"""

from __future__ import annotations

import math
from typing import Optional

import numpy as np
from PySide6.QtCore import QPointF, QRectF, Qt, Signal
from PySide6.QtGui import (
    QColor,
    QFont,
    QImage,
    QPainter,
    QPen,
)
from PySide6.QtWidgets import (
    QFrame,
    QLabel,
    QScrollArea,
    QSizePolicy,
    QVBoxLayout,
    QWidget,
)

from ..model import LightSettings, normalised_to_image_position
from ..model import light_plane_position_normalised

MARKER_COLOR = QColor(255, 46, 190)
MARKER_SHADOW = QColor(0, 0, 0, 190)
LIGHT_COLOR = QColor(255, 206, 84)
NORMAL_ARROW_COLOR = QColor(96, 230, 255)
LIGHT_ARROW_COLOR = QColor(255, 206, 84)
LIGHT_MARKER_HIT_RADIUS = 16


def array_to_qimage(arr: np.ndarray) -> QImage:
    a = np.ascontiguousarray(arr)
    if a.dtype != np.uint8:
        raise TypeError("display images must be uint8")
    if a.ndim == 2:
        h, w = a.shape
        return QImage(a.data, w, h, a.strides[0], QImage.Format_Grayscale8).copy()
    if a.ndim == 3 and a.shape[2] == 3:
        h, w, _ = a.shape
        return QImage(a.data, w, h, a.strides[0], QImage.Format_RGB888).copy()
    raise TypeError("display image must be HxW or HxWx3")


class ImageCanvas(QWidget):
    """Draws an image, a synced selection marker and optional light overlays."""

    pixelPicked = Signal(int, int)          # row, col
    lightMoved = Signal(float, float)       # normalised plane_x, plane_y

    def __init__(self, role: str, parent: Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self.role = role
        self._image: Optional[np.ndarray] = None
        self._qimage: Optional[QImage] = None
        self._driven_rect = QRectF()
        self.zoom = 0
        self.setMouseTracking(True)
        self.setMinimumSize(64, 64)
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)
        self.setAttribute(Qt.WA_OpaquePaintEvent, True)
        self._selection: Optional[tuple[int, int]] = None
        self._light: Optional[LightSettings] = None
        self._normal_xyz: Optional[np.ndarray] = None
        self._light_xyz: Optional[np.ndarray] = None
        self._drag_mode: Optional[str] = None
        self._message: Optional[str] = None

    # ---------------------------------------------------------------- data --
    def set_image(self, image: Optional[np.ndarray]) -> None:
        if image is None:
            self._image = None
            self._qimage = None
            self.update()
            return
        self._image = image
        self._qimage = array_to_qimage(image)
        self._apply_zoom_geometry()
        self.update()

    def set_message(self, text: str) -> None:
        self._image = None
        self._qimage = None
        self._message = text
        self.update()

    def set_zoom(self, zoom: int) -> None:
        self.zoom = int(zoom)
        self._apply_zoom_geometry()
        self.update()

    def _apply_zoom_geometry(self) -> None:
        if self._image is None:
            return
        h, w = self._image.shape[:2]
        if self.zoom > 0:
            self.setFixedSize(w * self.zoom, h * self.zoom)
        else:
            self.setMinimumSize(1, 1)
            self.setMaximumSize(16777215, 16777215)

    def set_selection(self, row: Optional[int], col: Optional[int]) -> None:
        self._selection = None if row is None or col is None else (int(row), int(col))
        self.update()

    def set_light(self, light: Optional[LightSettings]) -> None:
        self._light = light
        self.update()

    def set_vectors(
        self,
        normal_xyz: Optional[np.ndarray],
        light_xyz: Optional[np.ndarray],
    ) -> None:
        self._normal_xyz = None if normal_xyz is None else np.asarray(normal_xyz)
        self._light_xyz = None if light_xyz is None else np.asarray(light_xyz)
        self.update()

    # --------------------------------------------------------------- paint --
    def _target_rect(self) -> QRectF:
        if self._image is None:
            return QRectF(self.rect())
        img_h, img_w = self._image.shape[:2]
        avail_w = max(self.width(), 1)
        avail_h = max(self.height(), 1)
        if self.zoom > 0:
            return QRectF(0, 0, img_w * self.zoom, img_h * self.zoom)
        scale = min(avail_w / img_w, avail_h / img_h)
        draw_w = img_w * scale
        draw_h = img_h * scale
        return QRectF((avail_w - draw_w) / 2.0, (avail_h - draw_h) / 2.0,
                      draw_w, draw_h)

    def _image_to_screen(self, row: float, col: float) -> QPointF:
        rect = self._target_rect()
        if self._image is None:
            return QPointF()
        img_h, img_w = self._image.shape[:2]
        x = rect.left() + (col + 0.5) / img_w * rect.width()
        y = rect.top() + (row + 0.5) / img_h * rect.height()
        return QPointF(x, y)

    def _screen_to_image(self, pos: QPointF) -> Optional[tuple[int, int]]:
        if self._image is None:
            return None
        rect = self._target_rect()
        if not rect.contains(pos):
            return None
        img_h, img_w = self._image.shape[:2]
        col = int((pos.x() - rect.left()) / rect.width() * img_w)
        row = int((pos.y() - rect.top()) / rect.height() * img_h)
        return min(max(row, 0), img_h - 1), min(max(col, 0), img_w - 1)

    def paintEvent(self, event) -> None:  # noqa: N802
        painter = QPainter(self)
        painter.fillRect(self.rect(), QColor(24, 25, 29))
        if self._qimage is None:
            painter.setPen(QColor(150, 153, 162))
            font = painter.font()
            font.setPointSize(12)
            painter.setFont(font)
            painter.drawText(self.rect(), Qt.AlignCenter | Qt.TextWordWrap,
                             self._message or "无数据")
            painter.end()
            return

        rect = self._target_rect()
        painter.setRenderHint(QPainter.SmoothPixmapTransform, False)
        painter.drawImage(rect, self._qimage)
        painter.setRenderHint(QPainter.Antialiasing, True)

        if self._light is not None and self.role in ("material", "flat"):
            self._draw_light_marker(painter, rect)
        if self._normal_xyz is not None and self.role == "material":
            self._draw_vector_arrow(
                painter, rect, self._normal_xyz, NORMAL_ARROW_COLOR, "N"
            )
        if self._light_xyz is not None and self.role in ("material", "flat"):
            self._draw_vector_arrow(
                painter, rect, self._light_xyz, LIGHT_ARROW_COLOR, "L"
            )
        if self._selection is not None:
            self._draw_marker(painter, rect)
        painter.end()

    def _draw_marker(self, painter: QPainter, rect: QRectF) -> None:
        row, col = self._selection
        p = self._image_to_screen(row, col)
        for color, width in ((MARKER_SHADOW, 3.0), (MARKER_COLOR, 1.2)):
            pen = QPen(color, width)
            painter.setPen(pen)
            painter.drawLine(QPointF(rect.left(), p.y()), QPointF(rect.right(), p.y()))
            painter.drawLine(QPointF(p.x(), rect.top()), QPointF(p.x(), rect.bottom()))
        painter.setBrush(Qt.NoBrush)
        painter.setPen(QPen(MARKER_SHADOW, 3.0))
        painter.drawEllipse(p, 7.0, 7.0)
        painter.setPen(QPen(MARKER_COLOR, 1.6))
        painter.drawEllipse(p, 7.0, 7.0)

    def _draw_light_marker(self, painter: QPainter, rect: QRectF) -> None:
        assert self._light is not None
        if self._image is None:
            return
        img_h, img_w = self._image.shape[:2]
        c, r = normalised_to_image_position(
            self._light.plane_x, self._light.plane_y, img_w, img_h
        )
        p = self._image_to_screen(r, c)
        radius = 8.0 + 3.0 * float(np.clip(self._light.height, 0.0, 2.0))
        painter.setBrush(QColor(255, 206, 84, 60))
        painter.setPen(QPen(QColor(255, 206, 84, 120), 1.0))
        painter.drawEllipse(p, radius + 5.0, radius + 5.0)
        painter.setBrush(LIGHT_COLOR)
        painter.setPen(QPen(QColor(90, 62, 0), 1.5))
        painter.drawEllipse(p, radius, radius)
        painter.setPen(QPen(LIGHT_COLOR, 1.6))
        for k in range(8):
            ang = math.pi * 2.0 * k / 8.0
            a = QPointF(p.x() + math.cos(ang) * (radius + 4.0),
                        p.y() + math.sin(ang) * (radius + 4.0))
            b = QPointF(p.x() + math.cos(ang) * (radius + 9.0),
                        p.y() + math.sin(ang) * (radius + 9.0))
            painter.drawLine(a, b)
        font = QFont(painter.font())
        font.setBold(True)
        font.setPointSize(8)
        painter.setFont(font)
        painter.setPen(QColor(30, 22, 0))
        painter.drawText(QRectF(p.x() - 12, p.y() - radius - 2, 24, 14),
                         Qt.AlignCenter, "L")

    def _draw_vector_arrow(
        self,
        painter: QPainter,
        rect: QRectF,
        vector: np.ndarray,
        color: QColor,
        label: str,
    ) -> None:
        if self._selection is None:
            return
        row, col = self._selection
        p = self._image_to_screen(row, col)
        vx, vy = float(vector[0]), float(vector[1])
        horiz = math.hypot(vx, vy)
        painter.setPen(QPen(color.darker(160), 4.0, Qt.SolidLine, Qt.RoundCap))
        if horiz < 0.03:
            painter.setBrush(Qt.NoBrush)
            painter.drawEllipse(p, 4.0, 4.0)
            painter.setPen(QPen(color, 2.0))
            painter.drawEllipse(p, 4.0, 4.0)
            return
        length = 26.0 + 34.0 * min(horiz, 1.0)
        ux, uy = vx / horiz, -vy / horiz  # screen y points down
        tip = QPointF(p.x() + ux * length, p.y() + uy * length)
        painter.drawLine(QPointF(p.x(), p.y()), tip)
        painter.setPen(QPen(QColor(0, 0, 0, 180), 4.0))
        head_ang = math.atan2(uy, ux)
        for sign in (+1, -1):
            ang = head_ang + math.pi + sign * 0.42
            q = QPointF(tip.x() + math.cos(ang) * 9.0,
                        tip.y() + math.sin(ang) * 9.0)
            painter.drawLine(tip, q)
        painter.setPen(QPen(color, 2.0))
        for sign in (+1, -1):
            ang = head_ang + math.pi + sign * 0.42
            q = QPointF(tip.x() + math.cos(ang) * 9.0,
                        tip.y() + math.sin(ang) * 9.0)
            painter.drawLine(tip, q)
        font = QFont(painter.font())
        font.setBold(True)
        font.setPointSize(10)
        painter.setFont(font)
        painter.setPen(QColor(0, 0, 0, 200))
        painter.drawText(QPointF(tip.x() + 6, tip.y() - 4 + 1), label)
        painter.setPen(color)
        painter.drawText(QPointF(tip.x() + 6, tip.y() - 4), label)

    # ----------------------------------------------------------- interaction --
    def _light_screen_pos(self) -> Optional[QPointF]:
        if self._light is None or self._image is None:
            return None
        img_h, img_w = self._image.shape[:2]
        c, r = normalised_to_image_position(
            self._light.plane_x, self._light.plane_y, img_w, img_h
        )
        return self._image_to_screen(r, c)

    def mousePressEvent(self, event) -> None:  # noqa: N802
        if event.button() != Qt.LeftButton or self._image is None:
            return
        pos = event.position()
        if self.role == "material" and self._light is not None:
            lp = self._light_screen_pos()
            if lp is not None:
                if math.hypot(pos.x() - lp.x(), pos.y() - lp.y()) <= (
                    LIGHT_MARKER_HIT_RADIUS + 6
                ):
                    self._drag_mode = "light"
                    self.setCursor(Qt.ClosedHandCursor)
                    return
        hit = self._screen_to_image(pos)
        if hit is None:
            return
        self._drag_mode = "select"
        self.pixelPicked.emit(hit[0], hit[1])

    def mouseMoveEvent(self, event) -> None:  # noqa: N802
        pos = event.position()
        if self._drag_mode == "light" and self._light is not None and self._image is not None:
            img_h, img_w = self._image.shape[:2]
            rect = self._target_rect()
            if rect.width() > 1 and rect.height() > 1:
                c = (pos.x() - rect.left()) / rect.width() * img_w
                r = (pos.y() - rect.top()) / rect.height() * img_h
                lx, ly = light_plane_position_normalised(c, r, img_w, img_h)
                lx = min(max(lx, -0.98), 0.98)
                ly = min(max(ly, -0.98), 0.98)
                self.lightMoved.emit(lx, ly)
            return
        if self._drag_mode == "select":
            hit = self._screen_to_image(pos)
            if hit is not None:
                self.pixelPicked.emit(hit[0], hit[1])
            return
        if self.role == "material" and self._light is not None:
            lp = self._light_screen_pos()
            if lp is not None and math.hypot(
                pos.x() - lp.x(), pos.y() - lp.y()
            ) <= LIGHT_MARKER_HIT_RADIUS + 6:
                self.setCursor(Qt.OpenHandCursor)
                return
        self.setCursor(Qt.CrossCursor)

    def mouseReleaseEvent(self, event) -> None:  # noqa: N802
        self._drag_mode = None
        self.setCursor(Qt.CrossCursor)


class CanvasBox(QFrame):
    """Titled scrollable canvas, shared by all five views."""

    def __init__(self, title: str, role: str, caption: str = "",
                 parent: Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self.setObjectName("canvasBox")
        self.canvas = ImageCanvas(role, self)
        self.scroll = QScrollArea(self)
        self.scroll.setWidget(self.canvas)
        self.scroll.setWidgetResizable(True)
        self.scroll.setAlignment(Qt.AlignCenter)
        self.scroll.setFrameShape(QFrame.NoFrame)
        self.scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarAsNeeded)
        self.scroll.setVerticalScrollBarPolicy(Qt.ScrollBarAsNeeded)
        self.title_label = QLabel(title, self)
        self.title_label.setObjectName("canvasTitle")
        self.caption_label = QLabel(caption, self)
        self.caption_label.setObjectName("canvasCaption")
        self.caption_label.setWordWrap(True)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(8, 6, 8, 6)
        layout.setSpacing(4)
        layout.addWidget(self.title_label)
        layout.addWidget(self.scroll, 1)
        layout.addWidget(self.caption_label)

    def set_image(self, image: Optional[np.ndarray]) -> None:
        self.canvas.set_image(image)
        self.apply_zoom()

    def set_message(self, text: str) -> None:
        self.canvas.set_message(text)

    def set_caption(self, text: str) -> None:
        self.caption_label.setText(text)

    def set_light(self, light) -> None:
        self.canvas.set_light(light)

    def set_vectors(self, normal_xyz, light_xyz) -> None:
        self.canvas.set_vectors(normal_xyz, light_xyz)

    def set_selection(self, row, col) -> None:
        self.canvas.set_selection(row, col)

    def set_zoom(self, zoom: int) -> None:
        self.canvas.set_zoom(zoom)
        self.apply_zoom()

    def apply_zoom(self) -> None:
        if self.canvas.zoom > 0:
            self.scroll.setWidgetResizable(False)
        else:
            self.scroll.setWidgetResizable(True)
