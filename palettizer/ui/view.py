"""Zoom/pan-aware pixel preview widgets.

Design notes that the requirements depend on:

* The widget only ever knows about *image* coordinates and a zoom/pan
  transform.  Dither patterns are baked into the ``QImage`` by the
  quantiser before it reaches this module, so panning or zooming cannot
  change any pixel value - it only changes where pixels are drawn.
* Transparency is drawn over a checkerboard that is a UI affordance.  The
  exported PNG and the pixel data never contain checkerboard colours.
* Pixel grid lines follow the image lattice (every ``zoom`` screen pixels),
  not a fixed screen spacing.
"""

from __future__ import annotations

import numpy as np
from PySide6.QtCore import QObject, QPoint, QPointF, QRectF, QSize, Qt, Signal
from PySide6.QtGui import QColor, QImage, QPainter, QPen
from PySide6.QtWidgets import QWidget

ZOOM_LEVELS = (1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, 32)
CHECKER_LIGHT = QColor(58, 58, 62)
CHECKER_DARK = QColor(42, 42, 46)
BACKGROUND = QColor(24, 24, 28)
GRID_COLOR = QColor(0, 0, 0, 70)
BORDER = QColor(70, 70, 78)
ACCENT = QColor(97, 168, 255)


def rgba_to_qimage(rgba: np.ndarray) -> QImage:
    arr = np.ascontiguousarray(rgba, dtype=np.uint8)
    h, w = arr.shape[:2]
    img = QImage(arr.data, w, h, w * 4, QImage.Format_RGBA8888)
    return img.copy()  # detach from the numpy buffer


class SharedView(QObject):
    """Zoom, pan and pixel selection shared by every preview pane."""

    changed = Signal()
    selectionChanged = Signal()

    def __init__(self, parent=None):
        super().__init__(parent)
        self.zoom = 1
        self.pan = QPointF(0.0, 0.0)
        self.image_size = QSize(0, 0)
        self.selected: QPoint | None = None

    def set_image_size(self, w: int, h: int) -> None:
        self.image_size = QSize(int(w), int(h))
        self.selected = None
        self.selectionChanged.emit()
        self.changed.emit()

    def set_zoom(self, zoom: int) -> None:
        zoom = max(ZOOM_LEVELS[0], min(ZOOM_LEVELS[-1], int(zoom)))
        if zoom == self.zoom:
            return
        self.zoom = zoom
        self.changed.emit()

    def set_pan(self, pan: QPointF) -> None:
        self.pan = QPointF(pan)
        self.changed.emit()

    def select(self, x: int, y: int) -> None:
        self.selected = QPoint(int(x), int(y))
        self.selectionChanged.emit()

    def clear_selection(self) -> None:
        self.selected = None
        self.selectionChanged.emit()

    def fit(self, viewport: QSize) -> None:
        """Pick the largest integer zoom that fits and centre the image."""
        w, h = self.image_size.width(), self.image_size.height()
        if w <= 0 or h <= 0:
            self.zoom = 1
        else:
            z = min((viewport.width() - 16) // w, (viewport.height() - 16) // h)
            self.zoom = max(1, min(ZOOM_LEVELS[-1], int(z)))
        self.pan = QPointF(0.0, 0.0)
        self.changed.emit()


class PixelView(QWidget):
    """Draws one 1:1 QImage with shared zoom/pan, nearest-neighbour scaling."""

    pixelClicked = Signal(int, int)

    def __init__(self, view: SharedView, parent=None):
        super().__init__(parent)
        self.view = view
        self.image: QImage = QImage()
        self.show_grid = True
        self.empty_message = "尚未载入图像"
        self._drag_origin: QPoint | None = None
        self._drag_pan: QPointF = QPointF(0.0, 0.0)
        self._dragged = False
        self.setMinimumSize(140, 140)
        self.setMouseTracking(True)
        self.setFocusPolicy(Qt.StrongFocus)
        view.changed.connect(self.update)
        view.selectionChanged.connect(self.update)

    # -- content -------------------------------------------------------
    def set_image(self, image: QImage | None) -> None:
        self.image = image if image is not None else QImage()
        self.update()

    def set_grid(self, enabled: bool) -> None:
        self.show_grid = bool(enabled)
        self.update()

    def image_rect(self) -> QRectF:
        """Where the image lands in widget coordinates (logical pixels)."""
        iw = self.image.width()
        ih = self.image.height()
        if iw <= 0 or ih <= 0:
            return QRectF()
        z = self.view.zoom
        x = (self.width() - iw * z) / 2.0 + self.view.pan.x()
        y = (self.height() - ih * z) / 2.0 + self.view.pan.y()
        return QRectF(x, y, iw * z, ih * z)

    def screen_to_image(self, pos: QPointF) -> QPoint | None:
        rect = self.image_rect()
        if rect.isNull() or not rect.contains(pos):
            return None
        z = self.view.zoom
        x = int((pos.x() - rect.x()) // z)
        y = int((pos.y() - rect.y()) // z)
        if 0 <= x < self.image.width() and 0 <= y < self.image.height():
            return QPoint(x, y)
        return None

    # -- painting ------------------------------------------------------
    def paintEvent(self, event):  # noqa: N802 (Qt naming)
        p = QPainter(self)
        p.fillRect(self.rect(), BACKGROUND)
        rect = self.image_rect()
        if rect.isNull():
            p.setPen(QColor(150, 150, 158))
            p.drawText(self.rect(), Qt.AlignCenter, self.empty_message)
            p.end()
            return
        p.setRenderHint(QPainter.Antialiasing, False)
        p.setRenderHint(QPainter.SmoothPixmapTransform, False)
        p.save()
        p.setClipRect(rect)
        self._draw_checkerboard(p, rect)
        p.drawImage(rect, self.image)
        if self.show_grid and self.view.zoom >= 3:
            self._draw_grid(p, rect)
        p.restore()
        p.setPen(QPen(BORDER, 1))
        p.setBrush(Qt.NoBrush)
        p.drawRect(rect.adjusted(-0.5, -0.5, 0.5, 0.5))
        if self.view.selected is not None:
            self._draw_selection(p, rect)
        p.end()

    def _draw_checkerboard(self, p: QPainter, rect: QRectF) -> None:
        cell = 8
        p.fillRect(rect, CHECKER_LIGHT)
        left = int(rect.left())
        top = int(rect.top())
        right = int(rect.right()) + 1
        bottom = int(rect.bottom()) + 1
        for y in range(top - (top % cell), bottom, cell):
            for x in range(left - (left % cell), right, cell):
                if ((x // cell) + (y // cell)) % 2 == 0:
                    p.fillRect(x, y, cell, cell, CHECKER_DARK)

    def _draw_grid(self, p: QPainter, rect: QRectF) -> None:
        z = self.view.zoom
        pen = QPen(GRID_COLOR, 1)
        pen.setCosmetic(True)
        p.setPen(pen)
        p.setRenderHint(QPainter.Antialiasing, False)
        x = rect.left()
        # Grid anchored to image pixel boundaries, so it scrolls with pixels.
        while x <= rect.right() + 0.01:
            p.drawLine(QPointF(x, rect.top()), QPointF(x, rect.bottom()))
            x += z
        y = rect.top()
        while y <= rect.bottom() + 0.01:
            p.drawLine(QPointF(rect.left(), y), QPointF(rect.right(), y))
            y += z

    def _draw_selection(self, p: QPainter, rect: QRectF) -> None:
        sel = self.view.selected
        z = self.view.zoom
        r = QRectF(rect.left() + sel.x() * z, rect.top() + sel.y() * z, z, z)
        p.setRenderHint(QPainter.Antialiasing, False)
        p.setPen(QPen(QColor(255, 255, 255), 1))
        p.setBrush(Qt.NoBrush)
        p.drawRect(r.adjusted(0.5, 0.5, -0.5, -0.5))
        p.setPen(QPen(QColor(0, 0, 0), 1))
        p.drawRect(r.adjusted(-0.5, -0.5, 0.5, 0.5))

    # -- interaction ---------------------------------------------------
    def wheelEvent(self, event):  # noqa: N802
        delta = event.angleDelta().y()
        if delta == 0:
            return
        old_zoom = self.view.zoom
        rect = self.image_rect()
        cursor = event.position()
        # Keep the image point under the cursor fixed while zooming.
        if not rect.isNull() and rect.width() > 0:
            rel_x = (cursor.x() - rect.left()) / old_zoom
            rel_y = (cursor.y() - rect.top()) / old_zoom
            direction = 1 if delta > 0 else -1
            view = self.view
            idx = min(range(len(ZOOM_LEVELS)), key=lambda i: abs(ZOOM_LEVELS[i] - view.zoom))
            idx = max(0, min(len(ZOOM_LEVELS) - 1, idx + direction))
            new_zoom = ZOOM_LEVELS[idx]
            if new_zoom != old_zoom:
                view.zoom = new_zoom
                new_w = self.image.width() * new_zoom
                new_h = self.image.height() * new_zoom
                self.view.pan = QPointF(
                    cursor.x() - (self.width() - new_w) / 2.0 - rel_x * new_zoom,
                    cursor.y() - (self.height() - new_h) / 2.0 - rel_y * new_zoom,
                )
                view.changed.emit()
        event.accept()

    def mousePressEvent(self, event):  # noqa: N802
        if event.button() in (Qt.LeftButton, Qt.MiddleButton):
            self._drag_origin = event.position().toPoint()
            self._drag_pan = QPointF(self.view.pan)
            self._dragged = False
            self.setCursor(Qt.ClosedHandCursor)
        if event.button() == Qt.RightButton:
            self.view.clear_selection()

    def mouseMoveEvent(self, event):  # noqa: N802
        if self._drag_origin is None:
            return
        delta = event.position().toPoint() - self._drag_origin
        if abs(delta.x()) > 3 or abs(delta.y()) > 3:
            self._dragged = True
        if self._dragged:
            self.view.set_pan(self._drag_pan + QPointF(delta))

    def mouseReleaseEvent(self, event):  # noqa: N802
        if self._drag_origin is None:
            return
        pos = event.position()
        dragged = self._dragged
        self._drag_origin = None
        self._dragged = False
        self.unsetCursor()
        if not dragged and event.button() == Qt.LeftButton:
            pixel = self.screen_to_image(pos)
            if pixel is not None:
                self.view.select(pixel.x(), pixel.y())
                self.pixelClicked.emit(pixel.x(), pixel.y())

    def mouseDoubleClickEvent(self, event):  # noqa: N802
        self.view.fit(self.size())
