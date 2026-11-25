from __future__ import annotations

import numpy as np
from PySide6.QtCore import QPoint, QRect, Qt, Signal
from PySide6.QtGui import QColor, QPainter, QPen, QPixmap, QWheelEvent
from PySide6.QtWidgets import QGraphicsRectItem, QGraphicsScene, QGraphicsView

from ..engine import LockRegion
from ..imaging import rgb_to_qimage


class ImageCanvas(QGraphicsView):
    """Fit-to-view pixel canvas whose scene coordinates are source pixels."""

    roiSelected = Signal(str, object)
    doubleClicked = Signal(str)

    def __init__(self, version_key: str, parent=None) -> None:
        super().__init__(parent)
        self.version_key = version_key
        self._scene = QGraphicsScene(self)
        self.setScene(self._scene)
        self._pixmap_item = self._scene.addPixmap(QPixmap())
        self._pixmap_item.setZValue(-10)
        self.setRenderHints(
            QPainter.RenderHint.Antialiasing | QPainter.RenderHint.SmoothPixmapTransform
        )
        self.setBackgroundBrush(QColor("#101418"))
        self.setFrameShape(QGraphicsView.Shape.NoFrame)
        self.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAsNeeded)
        self.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAsNeeded)
        self.setMouseTracking(True)
        self.setMinimumSize(360, 240)

        self._origin: QPoint | None = None
        self._rubber: QGraphicsRectItem | None = None
        self._roi_item: QGraphicsRectItem | None = None
        self._lock_items: list[QGraphicsRectItem] = []
        self._auto_fit = True
        self._has_image = False

    def set_array(self, rgb: np.ndarray | None) -> None:
        if rgb is None:
            self.clear_image()
            return
        pixmap = QPixmap.fromImage(rgb_to_qimage(rgb))
        self._pixmap_item.setPixmap(pixmap)
        self._scene.setSceneRect(0, 0, pixmap.width(), pixmap.height())
        self._has_image = True
        if self._auto_fit:
            self.fit()

    def clear_image(self) -> None:
        self._pixmap_item.setPixmap(QPixmap())
        self._has_image = False
        self._scene.setSceneRect(0, 0, 1, 1)

    def resizeEvent(self, event) -> None:  # noqa: N802 - Qt API
        super().resizeEvent(event)
        if self._auto_fit and self._has_image:
            self.fit()

    def fit(self) -> None:
        if self._has_image:
            self.fitInView(self._pixmap_item, Qt.AspectRatioMode.KeepAspectRatio)
            self._auto_fit = True

    def wheelEvent(self, event: QWheelEvent) -> None:  # noqa: N802
        if not self._has_image:
            return
        factor = 1.18 if event.angleDelta().y() > 0 else 1 / 1.18
        self.scale(factor, factor)
        self._auto_fit = False

    def mouseDoubleClickEvent(self, event) -> None:  # noqa: N802
        self.fit()
        self.doubleClicked.emit(self.version_key)
        super().mouseDoubleClickEvent(event)

    def _image_point(self, event) -> QPoint:
        point = self.mapToScene(event.position().toPoint())
        rect = self._scene.sceneRect()
        x = int(round(min(max(point.x(), rect.left()), rect.right())))
        y = int(round(min(max(point.y(), rect.top()), rect.bottom())))
        return QPoint(x, y)

    def mousePressEvent(self, event) -> None:  # noqa: N802
        if event.button() == Qt.MouseButton.LeftButton and self._has_image:
            self._origin = self._image_point(event)
            if self._rubber is not None:
                self._scene.removeItem(self._rubber)
            pen = QPen(QColor(255, 214, 64, 230))
            pen.setWidth(0)
            pen.setCosmetic(True)
            self._rubber = QGraphicsRectItem()
            self._rubber.setPen(pen)
            self._rubber.setBrush(QColor(255, 214, 64, 38))
            self._rubber.setZValue(20)
            self._scene.addItem(self._rubber)
            self._rubber.setRect(QRect(self._origin, self._origin))
            event.accept()
            return
        super().mousePressEvent(event)

    def mouseMoveEvent(self, event) -> None:  # noqa: N802
        if self._origin is not None and self._rubber is not None:
            current = self._image_point(event)
            rect = QRect(self._origin, current).normalized()
            self._rubber.setRect(rect)
            event.accept()
            return
        super().mouseMoveEvent(event)

    def mouseReleaseEvent(self, event) -> None:  # noqa: N802
        if event.button() == Qt.MouseButton.LeftButton and self._origin is not None:
            end = self._image_point(event)
            rect = QRect(self._origin, end).normalized()
            self._origin = None
            if self._rubber is not None:
                self._scene.removeItem(self._rubber)
                self._rubber = None
            if rect.width() >= 3 and rect.height() >= 3:
                self.set_roi(rect)
                self.roiSelected.emit(self.version_key, rect)
            else:
                self.clear_roi()
                self.roiSelected.emit(self.version_key, QRect())
            event.accept()
            return
        super().mouseReleaseEvent(event)

    def set_roi(self, rect: QRect | tuple[int, int, int, int] | None) -> None:
        if self._roi_item is not None:
            self._scene.removeItem(self._roi_item)
            self._roi_item = None
        if rect is None:
            return
        if isinstance(rect, tuple):
            x, y, w, h = rect
            qrect = QRect(x, y, w, h)
        else:
            qrect = rect
        pen = QPen(QColor(255, 214, 64, 255))
        pen.setWidth(0)
        pen.setCosmetic(True)
        self._roi_item = QGraphicsRectItem(qrect)
        self._roi_item.setPen(pen)
        self._roi_item.setBrush(QColor(255, 214, 64, 28))
        self._roi_item.setZValue(30)
        self._scene.addItem(self._roi_item)

    def clear_roi(self) -> None:
        if self._roi_item is not None:
            self._scene.removeItem(self._roi_item)
            self._roi_item = None

    def set_lock_regions(self, locks: list[LockRegion]) -> None:
        for item in self._lock_items:
            self._scene.removeItem(item)
        self._lock_items.clear()
        pen = QPen(QColor(70, 220, 140, 255))
        pen.setWidth(0)
        pen.setCosmetic(True)
        for lock in locks:
            x, y, w, h = lock.as_rect()
            item = QGraphicsRectItem(QRect(x, y, w, h))
            item.setPen(pen)
            item.setBrush(QColor(70, 220, 140, 34))
            item.setZValue(15)
            self._scene.addItem(item)
            self._lock_items.append(item)
