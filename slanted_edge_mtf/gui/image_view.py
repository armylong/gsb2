"""图像视图: 矩形选区交互、拟合直边与样本叠加。

关键约定: 选区坐标、边缘参数、样本距离全部存图像像素坐标;
视图的缩放/平移/旋转只改变 QGraphicsView 的变换矩阵, 不触碰测量数据。
"""

from __future__ import annotations

from PySide6.QtCore import QPointF, QRect, QRectF, Qt, Signal
from PySide6.QtGui import (QBrush, QColor, QImage, QPainter, QPen, QPixmap,
                           QPolygonF, QTransform)
from PySide6.QtWidgets import (QGraphicsItem, QGraphicsPixmapItem,
                               QGraphicsScene, QGraphicsView)

ROI_COLORS = (QColor(0, 172, 238), QColor(255, 140, 0))
SAMPLE_COLOR = QColor(80, 220, 120)


class OverlayItem(QGraphicsItem):
    """ROI 边框 + 拟合直边 + 进入测量的样本点, 全部按图像坐标绘制。"""

    def __init__(self) -> None:
        super().__init__()
        self.setZValue(10)
        self.rois: list[tuple[int, int, int, int]] = []
        self.roi_ids: list[int] = []            # 全局 ROI 编号(0/1)
        self.edge_segments: list = []          # [(p1, p2) | None]
        self.sample_points: list = []          # [np.ndarray (N,2) | None]
        self.show_samples = True
        self.selected = 0

    def set_data(self, rois, roi_ids, edge_segments, sample_points,
                 selected: int, show_samples: bool) -> None:
        self.rois = rois
        self.roi_ids = roi_ids
        self.edge_segments = edge_segments
        self.sample_points = sample_points
        self.selected = selected
        self.show_samples = show_samples
        self.prepareGeometryChange()
        self.update()

    def boundingRect(self) -> QRectF:
        if not self.rois:
            return QRectF()
        x0 = min(r[0] for r in self.rois)
        y0 = min(r[1] for r in self.rois)
        x1 = max(r[0] + r[2] for r in self.rois)
        y1 = max(r[1] + r[3] for r in self.rois)
        return QRectF(x0, y0, x1 - x0, y1 - y0)

    def paint(self, painter: QPainter, option, widget=None) -> None:
        painter.setRenderHint(QPainter.Antialiasing, True)
        for k, (x, y, w, h) in enumerate(self.rois):
            rid = self.roi_ids[k] if k < len(self.roi_ids) else k
            color = ROI_COLORS[rid % 2]
            pen = QPen(color, 0)
            pen.setCosmetic(True)
            pen.setWidth(2.5 if rid == self.selected else 1.5)
            painter.setPen(pen)
            painter.setBrush(QBrush(QColor(color.red(), color.green(),
                                           color.blue(), 35)))
            painter.drawRect(QRectF(x, y, w, h))
            # 角标编号
            painter.setPen(QPen(QColor(255, 255, 255), 0))
            font = painter.font()
            font.setPointSize(10)
            painter.setFont(font)
            painter.drawText(QPointF(x + 3, y + 13), f"ROI {rid + 1}")

            seg = self.edge_segments[k] if k < len(self.edge_segments) \
                else None
            if seg is not None:
                p1, p2 = seg
                pen = QPen(QColor(255, 60, 90), 0)
                pen.setCosmetic(True)
                pen.setWidth(2.0)
                painter.setPen(pen)
                painter.drawLine(QPointF(*p1), QPointF(*p2))

            if self.show_samples:
                pts = (self.sample_points[k]
                       if k < len(self.sample_points) else None)
                if pts is not None and len(pts):
                    painter.setPen(Qt.NoPen)
                    painter.setBrush(QBrush(SAMPLE_COLOR))
                    poly = QPolygonF([QPointF(px, py) for px, py in pts])
                    painter.drawPoints(poly)


class ImageView(QGraphicsView):
    roi_created = Signal(int, tuple)          # roi_index, (x,y,w,h)
    roi_selected = Signal(int)

    def __init__(self) -> None:
        super().__init__()
        self._scene = QGraphicsScene(self)
        self.setScene(self._scene)
        self.setRenderHints(QPainter.SmoothPixmapTransform)
        self.setDragMode(QGraphicsView.NoDrag)   # 拖框由本类自绘
        self.setTransformationAnchor(QGraphicsView.AnchorUnderMouse)
        self.setResizeAnchor(QGraphicsView.AnchorUnderMouse)
        self.setMouseTracking(True)
        self.setBackgroundBrush(QColor(30, 30, 34))

        self._pix_item: QGraphicsPixmapItem | None = None
        self.overlay = OverlayItem()
        self._scene.addItem(self.overlay)
        self._rois: list[tuple[int, int, int, int]] = []
        self._roi_ids: list[int] = []
        self._active = 0
        self._rotation = 0
        self._panning = False
        self._pan_start = QPointF()
        self._origin = QPointF()
        self._drawing = False
        self._draw_start = QPointF()
        self._rubber = QRect()

    # ------------------------------------------------------------------ 数据
    def set_image(self, gray) -> None:
        """gray: float64 0..1 或 uint8/uint16 二维数组。"""
        import numpy as np
        arr = np.asarray(gray)
        if arr.dtype != np.uint8:
            arr = np.clip(arr, 0, 1)
            arr = (arr * 255.0 + 0.5).astype(np.uint8)
        h, w = arr.shape
        qimg = QImage(arr.data, w, h, w, QImage.Format_Grayscale8).copy()
        pix = QPixmap.fromImage(qimg)
        self._scene.clear()
        self._pix_item = self._scene.addPixmap(pix)
        self._scene.setSceneRect(QRectF(0, 0, w, h))
        self.overlay = OverlayItem()
        self._scene.addItem(self.overlay)
        self._rois = []
        self._roi_ids = []
        self.reset_view()

    def reset_view(self) -> None:
        self._rotation = 0
        self.resetTransform()
        if self._pix_item is not None and self.sceneRect().isValid():
            self.fitInView(self.sceneRect(), Qt.KeepAspectRatio)

    def rotate_view(self, delta_deg: float) -> None:
        self._rotation = (self._rotation + delta_deg) % 360
        self.setTransform(QTransform().rotate(self._rotation)
                          * self.transform())

    # -------------------------------------------------------------- ROI 管理
    def set_rois(self, rois: list, roi_ids: list, edge_segments,
                 sample_points, selected: int, show_samples: bool) -> None:
        self._rois = [tuple(r) for r in rois]
        self._roi_ids = list(roi_ids)
        self._active = selected
        self.overlay.set_data(self._rois, self._roi_ids, edge_segments,
                              sample_points, selected, show_samples)

    def select_roi_at(self, image_pos: QPointF) -> int:
        """返回被点中的全局 ROI 编号(0/1), 未命中返回 -1。"""
        for k in range(len(self._rois) - 1, -1, -1):
            x, y, w, h = self._rois[k]
            if QRectF(x, y, w, h).contains(image_pos):
                return self._roi_ids[k]
        return -1

    # ---------------------------------------------------------------- 交互
    def _is_pan(self, event) -> bool:
        return event.button() == Qt.MiddleButton or (
            event.button() == Qt.LeftButton
            and bool(event.modifiers() & Qt.AltModifier))

    def mousePressEvent(self, event) -> None:
        if self._is_pan(event):
            self._panning = True
            self._pan_start = event.position()
            self._origin = QPointF(self.horizontalScrollBar().value(),
                                   self.verticalScrollBar().value())
            self.setCursor(Qt.ClosedHandCursor)
            event.accept()
            return
        if event.button() == Qt.LeftButton:
            scene_pos = self.mapToScene(event.position().toPoint())
            hit = self.select_roi_at(scene_pos)
            if hit >= 0:
                # 点中已有选区: 仅切换选中, 不新建
                self._active = hit
                self.overlay.selected = hit
                self.overlay.update()
                self.roi_selected.emit(hit)
                event.accept()
                return
            # 空白处开始自绘拖框, 结果写入当前激活槽位
            self._drawing = True
            self._draw_start = event.position()
            self._rubber = QRect(
                event.position().toPoint(), event.position().toPoint())
            event.accept()
            return
        super().mousePressEvent(event)

    def mouseMoveEvent(self, event) -> None:
        if self._panning:
            dx = event.position().x() - self._pan_start.x()
            dy = event.position().y() - self._pan_start.y()
            ox, oy = self._origin
            self.horizontalScrollBar().setValue(int(ox - dx))
            self.verticalScrollBar().setValue(int(oy - dy))
            event.accept()
            return
        if self._drawing:
            self._rubber = QRect(
                self._draw_start.toPoint(),
                event.position().toPoint()).normalized()
            self.viewport().update()
            event.accept()
            return
        super().mouseMoveEvent(event)

    def mouseReleaseEvent(self, event) -> None:
        if self._panning:
            self._panning = False
            self.unsetCursor()
            event.accept()
            return
        if self._drawing and event.button() == Qt.LeftButton:
            self._drawing = False
            self._rubber = QRect()
            self.viewport().update()
            if (self._draw_start - event.position()).manhattanLength() < 6:
                event.accept()
                return
            tl = self.mapToScene(self._draw_start.toPoint())
            br = self.mapToScene(event.position().toPoint())
            r = QRectF(tl, br).normalized()
            if self._pix_item is not None:
                r = r.intersected(self.sceneRect())
            if r.width() >= 4 and r.height() >= 4:
                roi = (max(0, int(r.left())), max(0, int(r.top())),
                       int(r.width()), int(r.height()))
                idx = self._active if self._active in (0, 1) else 0
                self._store_roi(idx, roi)
                self.roi_created.emit(idx, roi)
            event.accept()
            return
        super().mouseReleaseEvent(event)

    def _store_roi(self, idx: int,
                   roi: tuple[int, int, int, int]) -> None:
        if idx in self._roi_ids:
            k = self._roi_ids.index(idx)
            self._rois[k] = roi
        else:
            # 保持按全局编号排序插入
            inserted = False
            for k, rid in enumerate(self._roi_ids):
                if idx < rid:
                    self._rois.insert(k, roi)
                    self._roi_ids.insert(k, idx)
                    inserted = True
                    break
            if not inserted:
                self._rois.append(roi)
                self._roi_ids.append(idx)
        self.overlay.set_data(self._rois, self._roi_ids,
                              self.overlay.edge_segments,
                              self.overlay.sample_points,
                              idx, self.overlay.show_samples)

    def paintEvent(self, event) -> None:
        super().paintEvent(event)
        if self._drawing and not self._rubber.isNull():
            p = QPainter(self.viewport())
            color = ROI_COLORS[self._active % 2]
            pen = QPen(color, 1.5, Qt.DashLine)
            p.setPen(pen)
            p.setBrush(QBrush(QColor(color.red(), color.green(),
                                     color.blue(), 40)))
            p.drawRect(self._rubber)

    def wheelEvent(self, event) -> None:
        factor = 1.25 if event.angleDelta().y() > 0 else 0.8
        self.scale(factor, factor)
