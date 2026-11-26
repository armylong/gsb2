"""共享图像坐标的画布。

ImageCanvas 基于 QGraphicsView, 场景坐标 == 原图像像素坐标 (像素块左上角为整数格点),
因此边缘读数、参考区一律用原像素量。所有画布通过 SyncGroup 联动:
任一画布平移/缩放后, 其余画布套用同一个 transform; 十字线同步。
显示缩放使用最近邻, 不抹掉原始像素边界。
"""

from __future__ import annotations

from typing import Optional

import numpy as np
from PySide6.QtCore import QPoint, QPointF, QRectF, Qt, Signal
from PySide6.QtGui import QColor, QPainter, QPen, QPixmap
from PySide6.QtWidgets import (
    QGraphicsPixmapItem,
    QGraphicsRectItem,
    QGraphicsScene,
    QGraphicsView,
)

from .constants import CROSSHAIR_RGBA, ROI_RGBA


class SyncGroup:
    """多个画布共享同一个视图 transform 与十字线位置。"""

    def __init__(self) -> None:
        self._canvases: list[ImageCanvas] = []
        self._syncing = False

    def add(self, canvas: "ImageCanvas") -> None:
        canvas.sync_group = self
        # 后加入的画布直接套用当前联动 transform, 保证同一图像坐标
        if self._canvases:
            canvas.setTransform(self._canvases[0].transform())
            canvas._inherits_transform = True
        self._canvases.append(canvas)

    def has_zoom_source(self) -> bool:
        """组内是否已有可提供 transform 的画布。"""
        return bool(self._canvases)

    def remove(self, canvas: "ImageCanvas") -> None:
        if canvas in self._canvases:
            self._canvases.remove(canvas)
            canvas.sync_group = None

    def broadcast_transform(self, sender: "ImageCanvas") -> None:
        if self._syncing:
            return
        self._syncing = True
        try:
            t = sender.transform()
            for c in self._canvases:
                if c is not sender:
                    c.setTransform(t)
        finally:
            self._syncing = False

    def broadcast_crosshair(self, sender: "ImageCanvas", pos: Optional[QPointF]) -> None:
        for c in self._canvases:
            if c is not sender:
                c.set_crosshair(pos)


class ImageCanvas(QGraphicsView):
    """单张图的视图。模式: 'nav' 平移缩放, 'roi' 框参考区。"""

    cursor_moved = Signal(str, object)   # (画布名, QPointF 场景坐标或 None)
    roi_changed = Signal(str, object)    # (画布名, (x0,y0,x1,y1) 或 None)
    transform_changed = Signal()

    def __init__(self, name: str, parent=None) -> None:
        super().__init__(parent)
        self.name = name
        self.sync_group: Optional[SyncGroup] = None

        self._scene = QGraphicsScene(self)
        self.setScene(self._scene)
        self._pixmap_item = QGraphicsPixmapItem()
        self._scene.addItem(self._pixmap_item)

        # 像素块保持锐利: 最近邻, 不做平滑插值
        self.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform, False)
        self.setTransformationAnchor(QGraphicsView.ViewportAnchor.AnchorUnderMouse)
        self.setResizeAnchor(QGraphicsView.ViewportAnchor.AnchorUnderMouse)
        self.setDragMode(QGraphicsView.DragMode.NoDrag)
        self.setMouseTracking(True)
        self.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)

        self._mode = "nav"
        self._panning = False
        self._pan_start: Optional[QPoint] = None
        self._drawing_roi = False
        self._has_fit = False
        self._inherits_transform = False
        self._roi_item = QGraphicsRectItem()
        self._roi_item.setPen(QPen(QColor(*ROI_RGBA[:3]), 0))
        self._roi_item.setBrush(QColor(0, 255, 120, 35))
        self._roi_item.hide()
        self._scene.addItem(self._roi_item)
        self._roi_rect: Optional[QRectF] = None

        self._crosshair_h = self._scene.addLine(0, 0, 0, 0, QPen(QColor(*CROSSHAIR_RGBA[:3]), 0))
        self._crosshair_v = self._scene.addLine(0, 0, 0, 0, QPen(QColor(*CROSSHAIR_RGBA[:3]), 0))
        self._crosshair_h.setZValue(10)
        self._crosshair_v.setZValue(10)
        self._crosshair_h.hide()
        self._crosshair_v.hide()

        self._image_rect = QRectF()

    # ---------- 内容 ----------
    def set_pixmap(self, pixmap: QPixmap) -> None:
        first = self._pixmap_item.pixmap().isNull()
        self._pixmap_item.setPixmap(pixmap)
        if pixmap.isNull():
            self._image_rect = QRectF()
            self._scene.setSceneRect(self._image_rect)
            return
        r = pixmap.rect()
        self._image_rect = QRectF(0, 0, r.width(), r.height())
        self._scene.setSceneRect(self._image_rect)
        # 首批画布首次有内容时适应窗口; 继承了组 transform (如后加的 NDVI 视图)
        # 或之后的重渲染, 都保留当前缩放平移。
        if first and not self._has_fit and not self._inherits_transform:
            self.fit_to_view()
            self._has_fit = True

    def fit_to_view(self) -> None:
        if self._image_rect.isNull():
            return
        self.fitInView(self._image_rect, Qt.AspectRatioMode.KeepAspectRatio)
        if self.sync_group:
            self.sync_group.broadcast_transform(self)

    # ---------- 模式与参考区 ----------
    def set_mode(self, mode: str) -> None:
        self._mode = mode
        if mode == "roi":
            self.setCursor(Qt.CursorShape.CrossCursor)
        else:
            self.setCursor(Qt.CursorShape.ArrowCursor)
            self.viewport().unsetCursor()

    def roi(self) -> Optional[tuple[int, int, int, int]]:
        if self._roi_rect is None:
            return None
        r = self._roi_rect
        return (
            int(np.rint(r.left())),
            int(np.rint(r.top())),
            int(np.rint(r.right())),
            int(np.rint(r.bottom())),
        )

    def set_roi(self, rect: Optional[tuple[int, int, int, int]]) -> None:
        if rect is None:
            self._roi_rect = None
            self._roi_item.hide()
        else:
            self._roi_rect = QRectF(rect[0], rect[1], rect[2] - rect[0], rect[3] - rect[1])
            self._roi_item.setRect(self._roi_rect)
            self._roi_item.show()

    def clear_roi(self) -> None:
        self.set_roi(None)
        self.roi_changed.emit(self.name, None)

    # ---------- 十字线 ----------
    def set_crosshair(self, pos: Optional[QPointF]) -> None:
        if pos is None or not self._image_rect.contains(pos):
            self._crosshair_h.hide()
            self._crosshair_v.hide()
            return
        self._crosshair_h.show()
        self._crosshair_v.show()
        r = self._image_rect
        self._crosshair_h.setLine(r.left(), pos.y(), r.right(), pos.y())
        self._crosshair_v.setLine(pos.x(), r.top(), pos.x(), r.bottom())

    def _update_crosshair_lines(self) -> None:
        # 十字线位置由 set_crosshair 维护, 场景尺寸变化后无需额外处理
        return None

    def drawBackground(self, painter: QPainter, rect: QRectF) -> None:
        super().drawBackground(painter, rect)
        # 放大到单像素 >= 8 屏幕像素时画整数格点网格, 强化「原像素量」
        if self.transform().m11() < 8.0:
            return
        painter.save()
        pen = QPen(QColor(255, 255, 255, 60), 0)
        painter.setPen(pen)
        left = int(np.floor(rect.left()))
        right = int(np.ceil(rect.right()))
        top = int(np.floor(rect.top()))
        bottom = int(np.ceil(rect.bottom()))
        for x in range(left, right + 1):
            painter.drawLine(x, top, x, bottom)
        for y in range(top, bottom + 1):
            painter.drawLine(left, y, right, y)
        painter.restore()

    # ---------- 交互 ----------
    def wheelEvent(self, event) -> None:
        factor = 1.25 if event.angleDelta().y() > 0 else 0.8
        self.scale(factor, factor)
        if self.sync_group:
            self.sync_group.broadcast_transform(self)
        self.transform_changed.emit()

    def mousePressEvent(self, event) -> None:
        if self._mode == "roi" and event.button() == Qt.MouseButton.LeftButton:
            self._drawing_roi = True
            start = self.mapToScene(event.position().toPoint())
            self._roi_rect = QRectF(start, start)
            self._roi_item.setRect(self._roi_rect)
            self._roi_item.show()
            return
        if event.button() == Qt.MouseButton.MiddleButton or (
            self._mode == "nav" and event.button() == Qt.MouseButton.LeftButton
        ):
            self._panning = True
            self._pan_start = event.position().toPoint()
            self.setCursor(Qt.CursorShape.ClosedHandCursor)
            return
        super().mousePressEvent(event)

    def mouseMoveEvent(self, event) -> None:
        pos = self.mapToScene(event.position().toPoint())
        if self._panning and self._pan_start is not None:
            delta = event.position().toPoint() - self._pan_start
            self._pan_start = event.position().toPoint()
            self.horizontalScrollBar().setValue(
                self.horizontalScrollBar().value() - delta.x()
            )
            self.verticalScrollBar().setValue(
                self.verticalScrollBar().value() - delta.y()
            )
            if self.sync_group:
                self.sync_group.broadcast_transform(self)
            self.transform_changed.emit()
            return
        if self._drawing_roi and self._roi_rect is not None:
            self._roi_rect.setBottomRight(QPointF(pos))
            self._roi_item.setRect(self._roi_rect.normalized())
            return

        if self._image_rect.contains(pos):
            self.set_crosshair(pos)
            if self.sync_group:
                self.sync_group.broadcast_crosshair(self, pos)
            self.cursor_moved.emit(self.name, QPointF(pos))
        else:
            self.set_crosshair(None)
            if self.sync_group:
                self.sync_group.broadcast_crosshair(self, None)
            self.cursor_moved.emit(self.name, None)
        super().mouseMoveEvent(event)

    def mouseReleaseEvent(self, event) -> None:
        if self._drawing_roi:
            self._drawing_roi = False
            rect = self._roi_rect.normalized()
            # 吸附到原像素整数格点, 并裁进图像
            x0 = max(0, int(np.rint(rect.left())))
            y0 = max(0, int(np.rint(rect.top())))
            x1 = min(int(self._image_rect.width()), int(np.rint(rect.right())))
            y1 = min(int(self._image_rect.height()), int(np.rint(rect.bottom())))
            if x1 - x0 >= 1 and y1 - y0 >= 1:
                self._roi_rect = QRectF(x0, y0, x1 - x0, y1 - y0)
                self._roi_item.setRect(self._roi_rect)
                self.roi_changed.emit(self.name, (x0, y0, x1, y1))
            else:
                self.clear_roi()
            return
        if self._panning:
            self._panning = False
            self.set_mode(self._mode)
            return
        super().mouseReleaseEvent(event)

    def leaveEvent(self, event) -> None:
        self.set_crosshair(None)
        if self.sync_group:
            self.sync_group.broadcast_crosshair(self, None)
        self.cursor_moved.emit(self.name, None)
        super().leaveEvent(event)

    def resizeEvent(self, event) -> None:
        super().resizeEvent(event)
