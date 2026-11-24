"""三个自定义 QGraphicsView：原图框选、频谱交互、前后对比。"""

from __future__ import annotations

from PySide6.QtCore import Qt, Signal, QPointF, QRectF
from PySide6.QtGui import QPainter, QPen, QColor, QPixmap
from PySide6.QtWidgets import (
    QGraphicsView, QGraphicsScene, QGraphicsRectItem,
)


class _ZoomView(QGraphicsView):
    """公共能力：滚轮缩放、拖拽平移、双击适应窗口。"""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setRenderHints(QPainter.RenderHint.SmoothPixmapTransform
                            | QPainter.RenderHint.Antialiasing)
        self.setTransformationAnchor(QGraphicsView.ViewportAnchor.AnchorUnderMouse)
        self.setDragMode(QGraphicsView.DragMode.NoDrag)
        self.setResizeAnchor(QGraphicsView.ViewportAnchor.AnchorViewCenter)
        self._panning = False
        self._pan_start = None
        self._fitted = False

    def set_pixmap(self, pixmap: QPixmap | None):
        # 同尺寸换图时保留当前缩放/平移，避免预览刷新把视图打回初始状态
        old_rect = self.scene().sceneRect() if self.scene() else QRectF()
        scene = QGraphicsScene(self)
        if pixmap is not None:
            scene.addPixmap(pixmap)
            scene.setSceneRect(QRectF(pixmap.rect()))
        self.setScene(scene)
        if not old_rect.isNull() and old_rect.size() == scene.sceneRect().size():
            self._fitted = True
            return
        self._fitted = False
        self.fitInView(scene.sceneRect(), Qt.AspectRatioMode.KeepAspectRatio)
        self._fitted = True

    def wheelEvent(self, event):
        factor = 1.25 if event.angleDelta().y() > 0 else 0.8
        self.scale(factor, factor)

    def mouseDoubleClickEvent(self, event):
        if self.scene() and not self.scene().sceneRect().isNull():
            self.fitInView(self.scene().sceneRect(),
                           Qt.AspectRatioMode.KeepAspectRatio)

    def _start_pan(self, event):
        if event.button() in (Qt.MouseButton.MiddleButton,
                              Qt.MouseButton.RightButton):
            self._panning = True
            self._pan_start = event.position()
            self.setCursor(Qt.CursorShape.ClosedHandCursor)

    def _do_pan(self, event):
        if self._panning and self._pan_start is not None:
            delta = event.position() - self._pan_start
            self._pan_start = event.position()
            self.horizontalScrollBar().setValue(
                self.horizontalScrollBar().value() - int(delta.x()))
            self.verticalScrollBar().setValue(
                self.verticalScrollBar().value() - int(delta.y()))

    def _end_pan(self):
        self._panning = False
        self.unsetCursor()


class ImageViewer(_ZoomView):
    """原图视图：左键拖拽框选分析区域。"""

    regionChanged = Signal(int, int, int, int)

    def __init__(self, parent=None):
        super().__init__(parent)
        self._selecting = False
        self._origin = QPointF()
        self._rubber: QGraphicsRectItem | None = None

    def set_pixmap(self, pixmap):
        self._rubber = None
        super().set_pixmap(pixmap)

    def clear_region(self):
        if self._rubber is not None and self.scene():
            self.scene().removeItem(self._rubber)
            self._rubber = None

    def mousePressEvent(self, event):
        if event.button() == Qt.MouseButton.LeftButton and self.scene():
            self._selecting = True
            self._origin = self.mapToScene(event.position().toPoint())
            pen = QPen(QColor(0, 200, 255), 0)
            pen.setCosmetic(True)
            if self._rubber is not None:
                self.scene().removeItem(self._rubber)
            self._rubber = self.scene().addRect(QRectF(self._origin, self._origin),
                                                pen)
            self._rubber.setZValue(10)
        else:
            self._start_pan(event)
        super().mousePressEvent(event)

    def mouseMoveEvent(self, event):
        if self._selecting and self._rubber is not None:
            pos = self.mapToScene(event.position().toPoint())
            rect = QRectF(self._origin, pos).normalized()
            bounds = self.scene().sceneRect()
            rect = rect.intersected(bounds)
            self._rubber.setRect(rect)
        else:
            self._do_pan(event)
        super().mouseMoveEvent(event)

    def mouseReleaseEvent(self, event):
        if self._selecting and event.button() == Qt.MouseButton.LeftButton:
            self._selecting = False
            if self._rubber is not None:
                r = self._rubber.rect()
                if r.width() >= 8 and r.height() >= 8:
                    x0 = max(0, int(r.left()))
                    y0 = max(0, int(r.top()))
                    x1 = min(int(self.scene().sceneRect().width()),
                             int(r.right()) + 1)
                    y1 = min(int(self.scene().sceneRect().height()),
                             int(r.bottom()) + 1)
                    self.regionChanged.emit(x0, y0, x1, y1)
        else:
            self._end_pan()
        super().mouseReleaseEvent(event)


class CompareViewer(_ZoomView):
    """处理前后 / 差图对比视图，只做缩放和平移。"""


class SpectrumView(_ZoomView):
    """频谱视图：点选陷波点或拖拽框选椭圆范围。"""

    scenePoint = Signal(float, float)
    sceneRect = Signal(float, float, float, float)
    cursorMoved = Signal(float, float)

    def __init__(self, parent=None):
        super().__init__(parent)
        self.mode = "point"          # "point" | "ellipse" | "pan"
        self._drawing = False
        self._origin = QPointF()
        self._rubber: QGraphicsRectItem | None = None

    def set_mode(self, mode: str):
        self.mode = mode
        self.setCursor(Qt.CursorShape.CrossCursor
                       if mode != "pan" else Qt.CursorShape.ArrowCursor)

    def mousePressEvent(self, event):
        if (event.button() == Qt.MouseButton.LeftButton
                and self.mode != "pan" and self.scene()):
            self._drawing = True
            self._origin = self.mapToScene(event.position().toPoint())
            if self._rubber is not None:
                self.scene().removeItem(self._rubber)
            pen = QPen(QColor(255, 120, 0), 0)
            pen.setCosmetic(True)
            pen.setStyle(Qt.PenStyle.DashLine)
            self._rubber = self.scene().addRect(
                QRectF(self._origin, self._origin), pen)
            self._rubber.setZValue(10)
        else:
            self._start_pan(event)
        super().mousePressEvent(event)

    def mouseMoveEvent(self, event):
        pos = self.mapToScene(event.position().toPoint())
        if self.scene() and self.scene().sceneRect().contains(pos):
            self.cursorMoved.emit(pos.x(), pos.y())
        if self._drawing and self._rubber is not None:
            self._rubber.setRect(
                QRectF(self._origin, pos).normalized())
        else:
            self._do_pan(event)
        super().mouseMoveEvent(event)

    def mouseReleaseEvent(self, event):
        if self._drawing and event.button() == Qt.MouseButton.LeftButton:
            self._drawing = False
            r = self._rubber.rect() if self._rubber else QRectF()
            if self.mode == "point":
                self.scenePoint.emit(self._origin.x(), self._origin.y())
            elif self.mode == "ellipse" and r.width() >= 3 and r.height() >= 3:
                self.sceneRect.emit(r.left(), r.top(), r.right(), r.bottom())
            if self._rubber is not None:
                self.scene().removeItem(self._rubber)
                self._rubber = None
        else:
            self._end_pan()
        super().mouseReleaseEvent(event)
