"""可平移缩放的图像视图。场景坐标 == 图像像素坐标, 视图变换不影响读数。"""
from __future__ import annotations

import cv2
from PySide6.QtCore import Qt, Signal
from PySide6.QtGui import QColor, QImage, QPainter, QPixmap
from PySide6.QtWidgets import QGraphicsPixmapItem, QGraphicsScene, QGraphicsView


def np_to_qpixmap(bgr) -> QPixmap:
    rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
    h, w, _ = rgb.shape
    img = QImage(rgb.data, w, h, 3 * w, QImage.Format.Format_RGB888).copy()
    return QPixmap.fromImage(img)


class ImageView(QGraphicsView):
    # x, y 为图像像素坐标 (浮点, 与缩放无关)
    pressed = Signal(float, float, int)   # x, y, Qt.MouseButton 值
    dragged = Signal(float, float)
    released = Signal(float, float)
    hovered = Signal(float, float, bool)  # x, y, 是否在图像内

    def __init__(self, parent=None):
        super().__init__(parent)
        self._scene = QGraphicsScene(self)
        self.setScene(self._scene)
        self._item = QGraphicsPixmapItem()
        self._scene.addItem(self._item)
        self.overlay = None  # callable(painter), 在 drawForeground 中调用
        self._pan_start = None
        self._mouse_down = False
        self.setRenderHint(QPainter.RenderHint.Antialiasing)
        self.setTransformationAnchor(QGraphicsView.ViewportAnchor.AnchorUnderMouse)
        self.setResizeAnchor(QGraphicsView.ViewportAnchor.AnchorViewCenter)
        self.setDragMode(QGraphicsView.DragMode.NoDrag)
        self.setMouseTracking(True)
        self.setBackgroundBrush(QColor(45, 45, 45))

    # ---- 图像 ----
    def set_pixmap(self, pm: QPixmap):
        resize_needed = (
            self._item.pixmap().isNull() or self._item.pixmap().size() != pm.size()
        )
        self._item.setPixmap(pm)
        self._scene.setSceneRect(self._item.boundingRect())
        if resize_needed:
            self.fitInView(self._item, Qt.AspectRatioMode.KeepAspectRatio)
        self.viewport().update()

    def clear_image(self):
        self._item.setPixmap(QPixmap())
        self.viewport().update()

    def has_image(self) -> bool:
        return not self._item.pixmap().isNull()

    def scale_factor(self) -> float:
        return self.transform().m11()

    def _inside(self, p) -> bool:
        if not self.has_image():
            return False
        pm = self._item.pixmap()
        return 0 <= p.x() <= pm.width() - 1 and 0 <= p.y() <= pm.height() - 1

    # ---- 绘制 ----
    def drawForeground(self, painter, rect):
        if self.overlay is not None and self.has_image():
            self.overlay(painter)

    # ---- 交互 ----
    def wheelEvent(self, event):
        if not self.has_image():
            return
        factor = 1.25 if event.angleDelta().y() > 0 else 0.8
        self.scale(factor, factor)

    def mousePressEvent(self, event):
        if event.button() == Qt.MouseButton.MiddleButton:
            self._pan_start = event.position()
            self.viewport().setCursor(Qt.CursorShape.ClosedHandCursor)
            event.accept()
            return
        if self.has_image():
            p = self.mapToScene(event.position().toPoint())
            if self._inside(p):
                self._mouse_down = True
                self.pressed.emit(p.x(), p.y(), int(event.button()))
        super().mousePressEvent(event)

    def mouseMoveEvent(self, event):
        if self._pan_start is not None:
            d = event.position() - self._pan_start
            self._pan_start = event.position()
            self.horizontalScrollBar().setValue(
                self.horizontalScrollBar().value() - int(d.x())
            )
            self.verticalScrollBar().setValue(
                self.verticalScrollBar().value() - int(d.y())
            )
            return
        if self.has_image():
            p = self.mapToScene(event.position().toPoint())
            if self._mouse_down:
                self.dragged.emit(p.x(), p.y())
            self.hovered.emit(p.x(), p.y(), self._inside(p))
        super().mouseMoveEvent(event)

    def mouseReleaseEvent(self, event):
        if event.button() == Qt.MouseButton.MiddleButton:
            self._pan_start = None
            self.viewport().unsetCursor()
            return
        if self._mouse_down and event.button() == Qt.MouseButton.LeftButton:
            self._mouse_down = False
            p = self.mapToScene(event.position().toPoint())
            self.released.emit(p.x(), p.y())
        super().mouseReleaseEvent(event)
