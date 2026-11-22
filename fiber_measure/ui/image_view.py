"""图像视图:原图 + 掩膜预览 + 路径/节点覆盖层 + ROI 框选。"""
from __future__ import annotations

from PySide6.QtCore import Qt, QRectF, Signal
from PySide6.QtGui import (QColor, QPainter, QPainterPath, QPen, QBrush,
                           QPolygonF, QPixmap)
from PySide6.QtCore import QPointF
from PySide6.QtWidgets import QGraphicsView, QGraphicsScene, QGraphicsPixmapItem, QGraphicsRectItem

PATH_COLORS = [
    "#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4",
    "#46f0f0", "#f032e6", "#bcf60c", "#008080", "#9a6324",
]

NODE_ROLE = "node"       # item.data: ("node", node_id)
CROSSING_ROLE = "crossing"


class ImageView(QGraphicsView):
    roiSelected = Signal(tuple)      # (x, y, w, h) 图像坐标
    crossingClicked = Signal(int)    # 交叉节点 id

    MODE_PAN = "pan"
    MODE_ROI = "roi"

    def __init__(self, parent=None):
        super().__init__(parent)
        self._scene = QGraphicsScene(self)
        self.setScene(self._scene)
        self.setRenderHint(QPainter.Antialiasing)
        self.setDragMode(QGraphicsView.ScrollHandDrag)
        self.setTransformationAnchor(QGraphicsView.AnchorUnderMouse)

        self._pix = QGraphicsPixmapItem()
        self._pix.setZValue(0)
        self._scene.addItem(self._pix)
        self._mask_item = QGraphicsPixmapItem()
        self._mask_item.setZValue(1)
        self._mask_item.setOpacity(0.4)
        self._scene.addItem(self._mask_item)

        self._roi_item: QGraphicsRectItem | None = None
        self._rubber: QGraphicsRectItem | None = None
        self._overlay_items: list = []
        self._path_items: dict = {}
        self._mode = self.MODE_PAN
        self._origin = None

    # ---------- 内容 ----------
    def set_image(self, qimg):
        self._pix.setPixmap(QPixmap.fromImage(qimg))
        self._scene.setSceneRect(QRectF(qimg.rect()))
        self.fitInView(self._pix, Qt.KeepAspectRatio)

    def set_mask_overlay(self, qimg):
        if qimg is None:
            self._mask_item.setPixmap(QPixmap())
        else:
            self._mask_item.setPixmap(QPixmap.fromImage(qimg))

    def set_roi_rect(self, rect):
        if self._roi_item is not None:
            self._scene.removeItem(self._roi_item)
            self._roi_item = None
        if rect is not None:
            x, y, w, h = rect
            self._roi_item = self._scene.addRect(
                QRectF(x, y, w, h), QPen(QColor("#ffd700"), 0, Qt.DashLine))
            self._roi_item.setZValue(3)

    def clear_overlays(self):
        for it in self._overlay_items:
            self._scene.removeItem(it)
        self._overlay_items.clear()
        self._path_items.clear()

    def set_overlays(self, graph, paths, selected_path_id=None):
        self.clear_overlays()
        # 路径
        for p in paths:
            qpath = QPainterPath(QPointF(*p.points[0]))
            for x, y in p.points[1:]:
                qpath.lineTo(x, y)
            color = QColor(PATH_COLORS[p.id % len(PATH_COLORS)])
            pen = QPen(color, 0)
            pen.setCosmetic(True)
            pen.setWidth(4 if p.id == selected_path_id else 2)
            item = self._scene.addPath(qpath, pen)
            item.setZValue(4)
            self._overlay_items.append(item)
            self._path_items[p.id] = item
        # 节点
        for n in graph.nodes.values():
            cx, cy = n.center
            if n.kind == "endpoint":
                it = self._scene.addEllipse(cx - 3, cy - 3, 6, 6,
                                            QPen(Qt.NoPen), QBrush(QColor("#00c853")))
                it.setToolTip(f"端点 #{n.id}")
                it.setData(0, (NODE_ROLE, n.id))
            elif n.kind == "branch":
                it = self._scene.addRect(cx - 3.5, cy - 3.5, 7, 7,
                                         QPen(Qt.NoPen), QBrush(QColor("#2979ff")))
                it.setToolTip(f"分叉 #{n.id} (度{n.degree})")
                it.setData(0, (NODE_ROLE, n.id))
            else:  # crossing
                tri = QPolygonF([QPointF(cx, cy - 5), QPointF(cx - 5, cy + 4),
                                 QPointF(cx + 5, cy + 4)])
                it = self._scene.addPolygon(tri, QPen(QColor("white"), 1),
                                            QBrush(QColor("#ff1744")))
                it.setToolTip(f"疑似交叉 #{n.id} (度{n.degree}),点击选中")
                it.setData(0, (CROSSING_ROLE, n.id))
                it.setCursor(Qt.PointingHandCursor)
            it.setZValue(5)
            self._overlay_items.append(it)

    def highlight_path(self, path_id):
        for pid, item in self._path_items.items():
            pen = item.pen()
            pen.setWidth(4 if pid == path_id else 2)
            item.setPen(pen)

    # ---------- 交互 ----------
    def set_mode(self, mode):
        self._mode = mode
        self.setDragMode(QGraphicsView.NoDrag if mode == self.MODE_ROI
                         else QGraphicsView.ScrollHandDrag)

    def mousePressEvent(self, ev):
        if self._mode == self.MODE_ROI and ev.button() == Qt.LeftButton:
            self._origin = self.mapToScene(ev.pos())
            if self._rubber is not None:
                self._scene.removeItem(self._rubber)
            self._rubber = self._scene.addRect(
                QRectF(self._origin, self._origin),
                QPen(QColor("#ffd700"), 0, Qt.DashLine))
            self._rubber.setZValue(6)
            return
        if ev.button() == Qt.LeftButton:
            item = self.scene().itemAt(self.mapToScene(ev.pos()), self.transform())
            if item is not None:
                data = item.data(0)
                if data and data[0] == CROSSING_ROLE:
                    self.crossingClicked.emit(data[1])
        super().mousePressEvent(ev)

    def mouseMoveEvent(self, ev):
        if self._rubber is not None and self._origin is not None:
            rect = QRectF(self._origin, self.mapToScene(ev.pos())).normalized()
            self._rubber.setRect(rect)
            return
        super().mouseMoveEvent(ev)

    def mouseReleaseEvent(self, ev):
        if self._rubber is not None and ev.button() == Qt.LeftButton:
            rect = self._rubber.rect()
            self._scene.removeItem(self._rubber)
            self._rubber = None
            self._origin = None
            if rect.width() >= 3 and rect.height() >= 3:
                self.roiSelected.emit((rect.x(), rect.y(), rect.width(), rect.height()))
            return
        super().mouseReleaseEvent(ev)

    def wheelEvent(self, ev):
        factor = 1.25 if ev.angleDelta().y() > 0 else 0.8
        self.scale(factor, factor)
