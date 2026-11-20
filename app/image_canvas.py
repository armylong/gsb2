"""可缩放/平移/框选的图像画布。

关键约束: 画布只负责显示，缩放与平移只改变视图变换，绝不参与网点渲染——
网格完全由图像像素坐标和参数决定，所以任何窗口缩放或预览范围变化都不会
让网点重新排布。

两种查看方式:
- pixel:  最近邻，放大后看到的就是导出数据里的实际黑白像素；
- smooth: 双线性平滑，仅用于缩小后的视觉预览，底层数据和导出不受影响。
当前方式以角标形式明确标注在画布上。
"""

from __future__ import annotations

import cv2
import numpy as np
from PySide6.QtCore import QPoint, QRect, QRectF, Qt, Signal
from PySide6.QtGui import QImage, QPixmap, QColor, QPen, QPainter
from PySide6.QtWidgets import (
    QGraphicsPixmapItem,
    QGraphicsRectItem,
    QGraphicsScene,
    QGraphicsView,
    QLabel,
    QRubberBand,
)

MODE_PIXEL = "pixel"
MODE_SMOOTH = "smooth"
MODE_LABELS = {
    MODE_PIXEL: "查看方式：逐像素二值(最近邻，所见即导出像素)",
    MODE_SMOOTH: "查看方式：缩小平滑预览(仅显示效果，不改变导出数据)",
}


def ndarray_to_qpixmap(img: np.ndarray) -> QPixmap:
    """numpy 数组 -> QPixmap，支持 BGR 三通道与单通道灰度。"""
    if img.ndim == 3:
        rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
        h, w, ch = rgb.shape
        qimg = QImage(rgb.data, w, h, ch * w, QImage.Format.Format_RGB888).copy()
    elif img.ndim == 2:
        h, w = img.shape
        qimg = QImage(img.data, w, h, w, QImage.Format.Format_Grayscale8).copy()
    else:
        raise ValueError("不支持的数组维度")
    return QPixmap.fromImage(qimg)


class ImageCanvas(QGraphicsView):
    """显示单张图像，支持滚轮缩放、拖拽平移、左键框选。"""

    selectionChanged = Signal(object)          # (x, y, w, h) 或 None
    viewChanged = Signal(object)                # 自身，用于多画布同步
    cursorInfo = Signal(str)                    # 鼠标位置/取值的状态文本

    def __init__(self, title: str = "", parent=None):
        super().__init__(parent)
        self._title = title
        self._mode = MODE_PIXEL
        self._image_size = (0, 0)

        self._scene = QGraphicsScene(self)
        self.setScene(self._scene)
        self._pix_item = QGraphicsPixmapItem()
        self._scene.addItem(self._pix_item)
        self._sel_item = QGraphicsRectItem()
        self._sel_item.setPen(QPen(QColor(255, 80, 80), 0))
        self._sel_item.setBrush(QColor(255, 80, 80, 40))
        self._sel_item.hide()
        self._scene.addItem(self._sel_item)

        self.setTransformationAnchor(QGraphicsView.ViewportAnchor.AnchorUnderMouse)
        self.setResizeAnchor(QGraphicsView.ViewportAnchor.AnchorViewCenter)
        self.setDragMode(QGraphicsView.DragMode.NoDrag)
        self.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAsNeeded)
        self.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAsNeeded)
        self.setBackgroundBrush(QColor(210, 210, 210))

        self._rubber: QRubberBand | None = None
        self._rubber_origin = QPoint()
        self._panning = False
        self._pan_start = QPoint()
        self._selection: QRect | None = None
        self._syncing = False

        # 标题角标 + 查看方式角标
        self._title_label = QLabel(self._title, self)
        self._title_label.setStyleSheet(
            "background: rgba(30,30,30,180); color: white; padding: 2px 8px;"
            "font-weight: bold;"
        )
        self._mode_label = QLabel(MODE_LABELS[self._mode], self)
        self._mode_label.setStyleSheet(
            "background: rgba(20,60,120,200); color: white; padding: 2px 8px;"
        )
        self._mode_label.setWordWrap(False)

    # ------------------------------------------------------------------ 数据
    def set_image(self, img: np.ndarray) -> None:
        pix = ndarray_to_qpixmap(img)
        self._image_size = (pix.height(), pix.width())
        self._pix_item.setPixmap(pix)
        self.setSceneRect(QRectF(0, 0, pix.width(), pix.height()))
        self._scene.setSceneRect(QRectF(0, 0, pix.width(), pix.height()))

    def image_size(self) -> tuple[int, int]:
        return self._image_size

    def set_mode(self, mode: str) -> None:
        assert mode in MODE_LABELS
        self._mode = mode
        keep = self.transformationAnchor()
        no_hints = QPainter.RenderHint(0)
        if mode == MODE_PIXEL:
            self.setRenderHints(no_hints)
            self._pix_item.setTransformationMode(
                Qt.TransformationMode.FastTransformation
            )
        else:
            self.setRenderHints(no_hints)
            self._pix_item.setTransformationMode(
                Qt.TransformationMode.SmoothTransformation
            )
        self.setTransformationAnchor(keep)
        self._mode_label.setText(MODE_LABELS[mode])
        self.viewport().update()

    def mode(self) -> str:
        return self._mode

    # -------------------------------------------------------------- 视图变换
    def fit_to_window(self) -> None:
        if self._image_size == (0, 0):
            return
        self.fitInView(self._pix_item, Qt.AspectRatioMode.KeepAspectRatio)
        self._emit_view_changed()

    def zoom_actual(self) -> None:
        if self._image_size == (0, 0):
            return
        self.resetTransform()
        self._emit_view_changed()

    def wheelEvent(self, event) -> None:
        if self._image_size == (0, 0):
            return
        factor = 1.25 if event.angleDelta().y() > 0 else 1 / 1.25
        self.scale(factor, factor)
        self._emit_view_changed()

    def sync_from(self, other: "ImageCanvas") -> None:
        """复制另一画布的变换与滚动状态(同尺寸图像间使用)。"""
        if self._image_size != other._image_size or self._image_size == (0, 0):
            return
        self._syncing = True
        try:
            self.setTransform(other.transform())
            self.horizontalScrollBar().setValue(other.horizontalScrollBar().value())
            self.verticalScrollBar().setValue(other.verticalScrollBar().value())
        finally:
            self._syncing = False

    def scrollContentsBy(self, dx, dy) -> None:
        super().scrollContentsBy(dx, dy)
        if not self._syncing:
            self._emit_view_changed()

    def _emit_view_changed(self) -> None:
        if not self._syncing:
            self.viewChanged.emit(self)

    # ------------------------------------------------------------------ 平移
    def mousePressEvent(self, event) -> None:
        if self._image_size == (0, 0):
            return
        if event.button() == Qt.MouseButton.MiddleButton or (
            event.button() == Qt.MouseButton.LeftButton
            and event.modifiers() & Qt.KeyboardModifier.SpaceModifier
        ):
            self._panning = True
            self._pan_start = event.position().toPoint()
            self.setCursor(Qt.CursorShape.ClosedHandCursor)
            event.accept()
            return
        if event.button() == Qt.MouseButton.LeftButton:
            self._rubber_origin = event.position().toPoint()
            if self._rubber is None:
                self._rubber = QRubberBand(QRubberBand.Shape.Rectangle, self)
            self._rubber.setGeometry(QRect(self._rubber_origin, self._rubber_origin))
            self._rubber.show()
            event.accept()
            return
        super().mousePressEvent(event)

    def mouseMoveEvent(self, event) -> None:
        if self._panning:
            pos = event.position().toPoint()
            delta = pos - self._pan_start
            self._pan_start = pos
            bar_h = self.horizontalScrollBar()
            bar_v = self.verticalScrollBar()
            bar_h.setValue(bar_h.value() - int(delta.x()))
            bar_v.setValue(bar_v.value() - int(delta.y()))
            event.accept()
            return
        if self._rubber is not None and self._rubber.isVisible():
            self._rubber.setGeometry(
                QRect(self._rubber_origin, event.position().toPoint()).normalized()
            )
            event.accept()
            return
        self._update_cursor_info(event.position().toPoint())
        super().mouseMoveEvent(event)

    def mouseReleaseEvent(self, event) -> None:
        if self._panning and event.button() in (
            Qt.MouseButton.MiddleButton,
            Qt.MouseButton.LeftButton,
        ):
            self._panning = False
            self.setCursor(Qt.CursorShape.ArrowCursor)
            event.accept()
            return
        if (
            self._rubber is not None
            and self._rubber.isVisible()
            and event.button() == Qt.MouseButton.LeftButton
        ):
            self._rubber.hide()
            view_rect = QRect(
                self._rubber_origin, event.position().toPoint()
            ).normalized()
            if view_rect.width() >= 2 and view_rect.height() >= 2:
                tl = self.mapToScene(view_rect.topLeft())
                br = self.mapToScene(view_rect.bottomRight())
                h, w = self._image_size
                x0 = max(0, int(np.floor(tl.x())))
                y0 = max(0, int(np.floor(tl.y())))
                x1 = min(w, int(np.ceil(br.x())))
                y1 = min(h, int(np.ceil(br.y())))
                if x1 - x0 > 0 and y1 - y0 > 0:
                    self.set_selection((x0, y0, x1 - x0, y1 - y0))
                else:
                    self.clear_selection()
            event.accept()
            return
        super().mouseReleaseEvent(event)

    def leaveEvent(self, event) -> None:
        self.cursorInfo.emit("")
        super().leaveEvent(event)

    def _update_cursor_info(self, view_pos: QPoint) -> None:
        scene = self.mapToScene(view_pos)
        h, w = self._image_size
        ix, iy = int(np.floor(scene.x())), int(np.floor(scene.y()))
        if 0 <= ix < w and 0 <= iy < h:
            self.cursorInfo.emit(
                f"{self._title} | 像素坐标 (x={ix}, y={iy}) | 缩放 {self.transform().m11():.2f}x"
            )
        else:
            self.cursorInfo.emit("")

    # ------------------------------------------------------------------ 选区
    def set_selection(self, rect: tuple[int, int, int, int] | None) -> None:
        new_sel = QRect(*rect) if rect is not None else None
        # 值未变化则不再发信号，避免与主窗口的回设形成无限递归
        if new_sel == self._selection:
            return
        self._selection = new_sel
        if rect is None:
            self._sel_item.hide()
        else:
            x, y, w, h = rect
            self._sel_item.setRect(QRectF(x - 0.5, y - 0.5, w, h))
            self._sel_item.show()
        self.selectionChanged.emit(rect)

    def clear_selection(self) -> None:
        self.set_selection(None)

    def selection(self) -> tuple[int, int, int, int] | None:
        if self._selection is None:
            return None
        r = self._selection
        return (r.x(), r.y(), r.width(), r.height())

    # ------------------------------------------------------------------ 布局
    def resizeEvent(self, event) -> None:
        super().resizeEvent(event)
        self._reposition_overlays()

    def showEvent(self, event) -> None:
        super().showEvent(event)
        self._reposition_overlays()

    def _reposition_overlays(self) -> None:
        self._title_label.adjustSize()
        self._mode_label.adjustSize()
        self._title_label.move(8, 8)
        self._mode_label.move(8, 8 + self._title_label.height() + 4)
