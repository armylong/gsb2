"""自定义 PySide6 画布：显示图像、可拖动控制点、探针标记、缩放。"""

from __future__ import annotations

import numpy as np
from PySide6.QtCore import Qt, QRectF, QPointF, Signal
from PySide6.QtGui import (
    QImage, QPixmap, QPen, QBrush, QColor, QPainter, QFont,
)
from PySide6.QtWidgets import (
    QGraphicsView, QGraphicsScene, QGraphicsEllipseItem,
    QGraphicsItem, QGraphicsTextItem, QLabel, QVBoxLayout, QWidget,
)


def ndarray_to_qpixmap(img: np.ndarray) -> QPixmap:
    """BGR uint8 图像转 QPixmap。"""
    if img.ndim == 2:
        h, w = img.shape
        bytes_per_line = w
        qimg = QImage(img.data, w, h, bytes_per_line,
                      QImage.Format.Format_Grayscale8).copy()
    else:
        h, w, c = img.shape
        rgb = img[..., ::-1].copy()
        qimg = QImage(rgb.data, w, h, 3 * w,
                      QImage.Format.Format_RGB888).copy()
    return QPixmap.fromImage(qimg)


class MovablePointItem(QGraphicsEllipseItem):
    """可在场景内拖动的控制点，坐标始终为图像像素坐标。"""

    def __init__(self, point_id: int, color: QColor, radius: float = 7.0,
                 on_move=None, snap=None):
        super().__init__(-radius, -radius, 2 * radius, 2 * radius)
        self.point_id = point_id
        self._on_move = on_move
        self._snap = snap
        self._suppress = False
        self.setPos(0, 0)
        self.setFlag(QGraphicsItem.GraphicsItemFlag.ItemIsMovable, True)
        self.setFlag(QGraphicsItem.GraphicsItemFlag.ItemIsSelectable, True)
        self.setFlag(QGraphicsItem.GraphicsItemFlag.ItemSendsGeometryChanges,
                     True)
        self.setZValue(10)
        pen = QPen(QColor(20, 20, 20), 1.5)
        self.setPen(pen)
        self.setBrush(QBrush(color))
        self.setCursor(Qt.CursorShape.OpenHandCursor)

        self.label = QGraphicsTextItem(str(point_id + 1), self)
        f = QFont()
        f.setBold(True)
        f.setPointSize(9)
        self.label.setFont(f)
        self.label.setDefaultTextColor(QColor(255, 255, 255))
        self.label.setPos(-radius + 1, -radius - 1)
        self.label.setZValue(11)

    def set_position_silent(self, x: float, y: float):
        """程序化移动（联动另一个视图），不再回调。"""
        self._suppress = True
        try:
            self.setPos(QPointF(x, y))
        finally:
            self._suppress = False

    def itemChange(self, change, value):
        if (change == QGraphicsItem.GraphicsItemChange.ItemPositionChange
                and not self._suppress):
            scene = self.scene()
            if scene is not None:
                p = value
                if self._snap is not None:
                    p = self._snap(p)
                rect = scene.sceneRect()
                x = min(max(p.x(), 0.0), rect.width() - 1.0)
                y = min(max(p.y(), 0.0), rect.height() - 1.0)
                p = QPointF(x, y)
                if self._on_move is not None:
                    self._on_move(self.point_id, x, y)
                return p
        return super().itemChange(change, value)

    def mousePressEvent(self, event):
        self.setCursor(Qt.CursorShape.ClosedHandCursor)
        super().mousePressEvent(event)

    def mouseReleaseEvent(self, event):
        self.setCursor(Qt.CursorShape.OpenHandCursor)
        super().mouseReleaseEvent(event)


class ProbeMarker(QGraphicsItem):
    """探针标记：十字 + 外圈，颜色区分原始/畸变/还原三类点。"""

    def __init__(self, x: float, y: float, color: QColor,
                 text: str = "", radius: float = 9.0):
        super().__init__()
        self.r = radius
        self.text = text
        self.setPos(x, y)
        self.setZValue(20)
        self.color = color
        self.setFlag(QGraphicsItem.GraphicsItemFlag.ItemIsSelectable, False)

    def boundingRect(self) -> QRectF:
        return QRectF(-self.r - 2, -self.r - 14,
                      2 * self.r + 40, 2 * self.r + 30)

    def paint(self, painter: QPainter, option, widget=None):
        painter.setPen(QPen(self.color, 2))
        painter.drawEllipse(QPointF(0, 0), self.r, self.r)
        painter.drawLine(QPointF(-self.r - 2, 0),
                         QPointF(self.r + 2, 0))
        painter.drawLine(QPointF(0, -self.r - 2),
                         QPointF(0, self.r + 2))
        if self.text:
            f = QFont()
            f.setPointSize(8)
            f.setBold(True)
            painter.setFont(f)
            painter.setPen(self.color)
            painter.drawText(QPointF(self.r + 3, -self.r), self.text)


class ImageCanvas(QWidget):
    """带标题的图像视图，承载控制点/探针，支持滚轮缩放与自适应。"""

    probe_clicked = Signal(str, float, float)  # canvas_name, u, v（像素）

    def __init__(self, name: str, title: str, parent=None):
        super().__init__(parent)
        self.name = name
        self._image_size: tuple[int, int] | None = None
        self._probe_mode = False
        self._fit = True

        layout = QVBoxLayout(self)
        layout.setContentsMargins(2, 2, 2, 2)
        self.title_label = QLabel(title)
        f = self.title_label.font()
        f.setBold(True)
        self.title_label.setFont(f)
        layout.addWidget(self.title_label)

        self.scene = QGraphicsScene(self)
        self.view = QGraphicsView(self.scene)
        self.view.setRenderHints(QPainter.RenderHint.SmoothPixmapTransform)
        self.view.setTransformationAnchor(
            QGraphicsView.ViewportAnchor.AnchorUnderMouse)
        self.view.setDragMode(QGraphicsView.DragMode.ScrollHandDrag)
        self.view.wheelEvent = self._wheel_event
        layout.addWidget(self.view)
        self._pixmap_item = None

    def set_title(self, text: str):
        self.title_label.setText(text)

    def set_probe_mode(self, on: bool):
        self._probe_mode = on
        self.view.setDragMode(
            QGraphicsView.DragMode.NoDrag if on
            else QGraphicsView.DragMode.ScrollHandDrag)
        self.view.viewport().setCursor(
            Qt.CursorShape.CrossCursor if on
            else Qt.CursorShape.ArrowCursor)

    def set_image(self, img: np.ndarray, keep_zoom: bool = False):
        self._image_size = (img.shape[1], img.shape[0])
        pixmap = ndarray_to_qpixmap(img)
        if self._pixmap_item is None:
            self._pixmap_item = self.scene.addPixmap(pixmap)
        else:
            self._pixmap_item.setPixmap(pixmap)
        self.scene.setSceneRect(QRectF(0, 0, pixmap.width(), pixmap.height()))
        if not keep_zoom:
            self.fit_in_view()

    def fit_in_view(self):
        if self._image_size is not None:
            self.view.fitInView(self.scene.sceneRect(),
                                Qt.AspectRatioMode.KeepAspectRatio)

    def _wheel_event(self, event):
        factor = 1.2 if event.angleDelta().y() > 0 else 1 / 1.2
        self.view.scale(factor, factor)

    def add_movable_point(self, item: MovablePointItem):
        self.scene.addItem(item)

    def remove_item(self, item: QGraphicsItem):
        self.scene.removeItem(item)

    def clear_probes(self):
        for item in list(self.scene.items()):
            if isinstance(item, ProbeMarker):
                self.scene.removeItem(item)

    def add_probe(self, x, y, color, text="") -> ProbeMarker:
        marker = ProbeMarker(x, y, QColor(color), text)
        self.scene.addItem(marker)
        return marker

    def attach_probe_click(self):
        self.view.viewport().installEventFilter(self)

    def eventFilter(self, obj, event):
        from PySide6.QtCore import QEvent
        if (self._probe_mode and obj is self.view.viewport()
                and event.type() == QEvent.Type.MouseButtonPress):
            scene_pt = self.view.mapToScene(event.pos())
            rect = self.scene.sceneRect()
            if rect.contains(scene_pt):
                self.probe_clicked.emit(
                    self.name, float(scene_pt.x()), float(scene_pt.y()))
                return True
        return super().eventFilter(obj, event)
