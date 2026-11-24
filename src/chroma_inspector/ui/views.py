"""可缩放、可平移、可框选锁定区域的像素视图。"""
from __future__ import annotations

import numpy as np
from PySide6.QtCore import QPoint, QRect, Qt, Signal
from PySide6.QtGui import QImage, QPainter, QPixmap
from PySide6.QtWidgets import QGraphicsPixmapItem, QGraphicsScene, QGraphicsView


class PixelView(QGraphicsView):
    pixelClicked = Signal(int, int)
    """点击画面时发出图像坐标 (x, y)。"""
    regionLocked = Signal(tuple)
    """框选结束发出 (x0, y0, x1, y1)；发出 None 表示清除锁定。"""
    transformChangedView = Signal(object)
    """本视图缩放/平移变化时发出 QTransform，供另一视图同步。"""

    def __init__(self, title: str, parent=None):
        super().__init__(parent)
        self.title = title
        self._scene = QGraphicsScene(self)
        self.setScene(self._scene)
        self._item: QGraphicsPixmapItem | None = None
        self._image_shape: tuple[int, int] | None = None
        # 像素级查看：关闭抗锯齿与平滑，放大后每个像素保持硬边
        self.setRenderHint(QPainter.RenderHint.Antialiasing, False)
        self.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform, False)
        self.setTransformationAnchor(QGraphicsView.ViewportAnchor.AnchorUnderMouse)
        self.setDragMode(QGraphicsView.DragMode.NoDrag)
        self._panning = False
        self._pan_start: QPoint | None = None
        self._rubber_origin: QPoint | None = None
        self._rubber_rect: QRect | None = QRect()
        self.locked_rect: QRect | None = None
        self.setMouseTracking(True)

    # ---------- 数据 ----------
    def show_gray(self, plane: np.ndarray):
        h, w = plane.shape
        img = QImage(plane.tobytes(), w, h, w, QImage.Format.Format_Grayscale8).copy()
        self._set_image(img, (h, w))

    def show_rgb(self, rgb: np.ndarray):
        h, w = rgb.shape[:2]
        cont = np.ascontiguousarray(rgb)
        img = QImage(cont.data, w, h, 3 * w, QImage.Format.Format_RGB888).copy()
        self._set_image(img, (h, w))

    def show_placeholder(self, text: str):
        img = QImage(320, 200, QImage.Format.Format_RGB888)
        img.fill(Qt.GlobalColor.lightGray)
        painter = QPainter(img)
        painter.setPen(Qt.GlobalColor.darkGray)
        painter.drawText(img.rect(), Qt.AlignmentFlag.AlignCenter, text)
        painter.end()
        self._set_image(img, (200, 320))

    def _set_image(self, img: QImage, shape: tuple[int, int]):
        self._scene.clear()
        self._item = self._scene.addPixmap(QPixmap.fromImage(img))
        self._scene.setSceneRect(0, 0, img.width(), img.height())
        self._image_shape = shape
        self.locked_rect = None
        self.fitInView(self._item, Qt.AspectRatioMode.KeepAspectRatio)

    # ---------- 缩放/平移 ----------
    def wheelEvent(self, event):
        if self._item is None:
            return
        factor = 1.25 if event.angleDelta().y() > 0 else 0.8
        self.scale(factor, factor)
        self.transformChangedView.emit(self.transform())
        self.viewport().update()

    def mousePressEvent(self, event):
        if event.button() == Qt.MouseButton.MiddleButton or (
            event.button() == Qt.MouseButton.LeftButton
            and event.modifiers() & Qt.KeyboardModifier.ShiftModifier
        ):
            self._panning = True
            self._pan_start = event.position().toPoint()
            self.setCursor(Qt.CursorShape.ClosedHandCursor)
            return
        if (
            event.button() == Qt.MouseButton.LeftButton
            and event.modifiers() & Qt.KeyboardModifier.AltModifier
        ):
            self._rubber_origin = event.position().toPoint()
            self._rubber_rect = QRect(self._rubber_origin, self._rubber_origin)
            return
        super().mousePressEvent(event)

    def mouseMoveEvent(self, event):
        if self._panning and self._pan_start is not None:
            delta = event.position().toPoint() - self._pan_start
            self._pan_start = event.position().toPoint()
            self.horizontalScrollBar().setValue(
                self.horizontalScrollBar().value() - delta.x()
            )
            self.verticalScrollBar().setValue(
                self.verticalScrollBar().value() - delta.y()
            )
            self.transformChangedView.emit(self.transform())
            return
        if self._rubber_origin is not None:
            self._rubber_rect = QRect(
                self._rubber_origin, event.position().toPoint()
            ).normalized()
            self.viewport().update()
            return
        super().mouseMoveEvent(event)

    def mouseReleaseEvent(self, event):
        if self._panning:
            self._panning = False
            self._pan_start = None
            self.setCursor(Qt.CursorShape.ArrowCursor)
            return
        if self._rubber_origin is not None and self._rubber_rect is not None:
            rect = self._rubber_rect.normalized()
            self._rubber_origin = None
            self._rubber_rect = None
            self.viewport().update()
            if rect.width() >= 4 and rect.height() >= 4:
                tl = self.mapToScene(rect.topLeft())
                br = self.mapToScene(rect.bottomRight())
                x0 = max(0, int(tl.x()))
                y0 = max(0, int(tl.y()))
                x1 = min(self._image_shape[1], int(br.x()) + 1)
                y1 = min(self._image_shape[0], int(br.y()) + 1)
                if x1 > x0 and y1 > y0:
                    self.locked_rect = QRect(x0, y0, x1 - x0, y1 - y0)
                    self.regionLocked.emit((x0, y0, x1, y1))
                    return
            self.regionLocked.emit(None)
            return
        # 普通左键：报告像素坐标
        if event.button() == Qt.MouseButton.LeftButton and self._item is not None:
            scene_pt = self.mapToScene(event.position().toPoint())
            x, y = int(scene_pt.x()), int(scene_pt.y())
            h, w = self._image_shape
            if 0 <= x < w and 0 <= y < h:
                self.pixelClicked.emit(x, y)
        super().mouseReleaseEvent(event)

    def sync_from(self, transform) -> None:
        self.setTransform(transform)
        self.viewport().update()

    def paintEvent(self, event):
        super().paintEvent(event)
        painter = QPainter(self.viewport())
        # 框选橡皮筋
        if self._rubber_rect is not None and not self._rubber_rect.isNull():
            painter.setPen(Qt.GlobalColor.yellow)
            painter.setBrush(Qt.BrushStyle.NoBrush)
            painter.drawRect(self._rubber_rect)
        # 锁定区域描边（映射到视口）
        if self.locked_rect is not None and self._item is not None:
            poly = self.mapFromScene(self.locked_rect)
            painter.setPen(Qt.GlobalColor.cyan)
            painter.setBrush(Qt.BrushStyle.NoBrush)
            painter.drawRect(poly.boundingRect())
        painter.end()

    def reset_zoom(self):
        if self._item is not None:
            self.fitInView(self._item, Qt.AspectRatioMode.KeepAspectRatio)
            self.transformChangedView.emit(self.transform())
