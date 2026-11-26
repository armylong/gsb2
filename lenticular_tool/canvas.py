"""主画布: QGraphicsView 显示原像素图, 支持缩放与框选区段。

框选坐标一律映射回 *原始 PNG 像素*, 界面缩放 / 缩略图清晰度都不影响统计与导出。
"""
from __future__ import annotations

from PySide6 import QtCore, QtGui, QtWidgets
from PySide6.QtCore import Signal

from .qtio import rgba_to_qimage


class ImageCanvas(QtWidgets.QGraphicsView):
    """左拖框选; Ctrl+滚轮缩放; 中键拖动平移。"""

    rectSelected = Signal(object, bool)  # (x0,y0,x1excl,y1excl), is_click

    def __init__(self, parent: QtWidgets.QWidget | None = None):
        super().__init__(parent)
        self._scene = QtWidgets.QGraphicsScene(self)
        self.setScene(self._scene)
        self._pix_item = self._scene.addPixmap(QtGui.QPixmap())
        self._pix_item.setZValue(0)

        self.setRenderHints(QtGui.QPainter.RenderHint.Antialiasing
                            | QtGui.QPainter.RenderHint.SmoothPixmapTransform)
        self.setAlignment(QtCore.Qt.AlignmentFlag.AlignCenter)
        self.setBackgroundBrush(QtGui.QColor(38, 38, 42))
        self.setMouseTracking(True)
        self.setTransformationAnchor(
            QtWidgets.QGraphicsView.ViewportAnchor.AnchorUnderMouse)
        self.setResizeAnchor(
            QtWidgets.QGraphicsView.ViewportAnchor.AnchorViewCenter)

        # 框选矩形
        self._rubber = QtWidgets.QGraphicsRectItem()
        pen = QtGui.QPen(QtGui.QColor(255, 214, 0), 2.0)
        pen.setCosmetic(True)
        pen.setStyle(QtCore.Qt.PenStyle.DashLine)
        self._rubber.setPen(pen)
        self._rubber.setBrush(QtGui.QColor(255, 214, 0, 28))
        self._rubber.setZValue(20)
        self._rubber.hide()
        self._scene.addItem(self._rubber)

        # 选中镜条的倾斜平行四边形
        self._highlight = QtWidgets.QGraphicsPolygonItem()
        pen2 = QtGui.QPen(QtGui.QColor(0, 220, 255), 2.2)
        pen2.setCosmetic(True)
        self._highlight.setPen(pen2)
        self._highlight.setBrush(QtGui.QColor(0, 200, 255, 46))
        self._highlight.setZValue(19)
        self._highlight.hide()
        self._scene.addItem(self._highlight)

        self._lens_items: list[QtWidgets.QGraphicsLineItem] = []
        self._origin = QtCore.QPointF()
        self._dragging = False
        self._panning = False
        self._pan_last = QtCore.QPoint()
        self._image_size = QtCore.QSize(0, 0)
        self._has_fit_once = False
        self._fitted_after_show = False

    def showEvent(self, event) -> None:
        super().showEvent(event)
        if not self._fitted_after_show and not self._image_size.isEmpty():
            self._fitted_after_show = True
            # 等布局/分隔条把视口尺寸定下来再 fit
            QtCore.QTimer.singleShot(0, self.fit)

    # ------------------------------------------------------------------
    def set_image_array(self, arr) -> None:
        qimg = rgba_to_qimage(arr)
        self.set_image_qimage(qimg)

    def set_image_qimage(self, qimg: QtGui.QImage) -> None:
        pix = QtGui.QPixmap.fromImage(qimg)
        self._pix_item.setPixmap(pix)
        self._image_size = qimg.size()
        self._scene.setSceneRect(0, 0, qimg.width(), qimg.height())
        # 注意: 不清空/隐藏 _rubber, 否则拖观察滑块刷新预览时选区会消失
        if not self._has_fit_once:
            self.fit()
            self._has_fit_once = True

    def reset_view(self) -> None:
        self._has_fit_once = True
        self.fit()

    def fit(self) -> None:
        if self._image_size.isEmpty():
            return
        self.fitInView(self._pix_item, QtCore.Qt.AspectRatioMode.KeepAspectRatio)

    def zoom_by(self, factor: float) -> None:
        self.scale(factor, factor)

    # ------------------------------------------------------------------
    def clear_lens_overlay(self) -> None:
        for item in self._lens_items:
            self._scene.removeItem(item)
        self._lens_items.clear()

    def set_lens_lines(self, segments: list[tuple[float, float, float, float]]) -> None:
        """segments: 原生像素坐标线段 (x1,y1,x2,y2)。"""
        self.clear_lens_overlay()
        pen = QtGui.QPen(QtGui.QColor(255, 255, 255, 150), 1.0)
        pen.setCosmetic(True)
        for x1, y1, x2, y2 in segments:
            line = QtWidgets.QGraphicsLineItem(x1, y1, x2, y2)
            line.setPen(pen)
            line.setZValue(10)
            self._scene.addItem(line)
            self._lens_items.append(line)

    def set_highlight_polygon(self, points: list[tuple[float, float]] | None) -> None:
        if not points:
            self._highlight.hide()
            return
        poly = QtGui.QPolygonF([QtCore.QPointF(x, y) for x, y in points])
        self._highlight.setPolygon(poly)
        self._highlight.show()

    def set_selection_rect(self, rect: tuple[int, int, int, int] | None) -> None:
        """外部(单击扩展为整根镜条后)回填选区, 不发信号。"""
        if rect is None:
            self._rubber.hide()
            return
        x0, y0, x1, y1 = rect
        self._rubber.setRect(QtCore.QRectF(x0, y0, x1 - x0, y1 - y0))
        self._rubber.show()

    # ------------------------------------------------------------------
    def wheelEvent(self, event: QtGui.QWheelEvent) -> None:
        if event.modifiers() & QtCore.Qt.KeyboardModifier.ControlModifier:
            dy = event.angleDelta().y()
            factor = 1.2 ** (dy / 120.0)
            self.zoom_by(factor)
            event.accept()
        else:
            super().wheelEvent(event)

    def mousePressEvent(self, event: QtGui.QMouseEvent) -> None:
        if event.button() == QtCore.Qt.MouseButton.MiddleButton:
            self._panning = True
            self._pan_last = event.position().toPoint()
            self.setCursor(QtCore.Qt.CursorShape.ClosedHandCursor)
            event.accept()
            return
        if event.button() == QtCore.Qt.MouseButton.LeftButton:
            sp = self.mapToScene(event.position().toPoint())
            sp = self._clamp_scene(sp)
            self._origin = sp
            self._dragging = True
            self._rubber.setRect(QtCore.QRectF(sp, sp))
            self._rubber.show()
            event.accept()
            return
        super().mousePressEvent(event)

    def mouseMoveEvent(self, event: QtGui.QMouseEvent) -> None:
        if self._panning:
            cur = event.position().toPoint()
            delta = cur - self._pan_last
            self._pan_last = cur
            self.horizontalScrollBar().setValue(
                self.horizontalScrollBar().value() - delta.x())
            self.verticalScrollBar().setValue(
                self.verticalScrollBar().value() - delta.y())
            event.accept()
            return
        if self._dragging:
            sp = self._clamp_scene(self.mapToScene(event.position().toPoint()))
            r = QtCore.QRectF(self._origin, sp).normalized()
            self._rubber.setRect(r)
            event.accept()
            return
        super().mouseMoveEvent(event)

    def mouseReleaseEvent(self, event: QtGui.QMouseEvent) -> None:
        if event.button() == QtCore.Qt.MouseButton.MiddleButton and self._panning:
            self._panning = False
            self.unsetCursor()
            event.accept()
            return
        if event.button() == QtCore.Qt.MouseButton.LeftButton and self._dragging:
            self._dragging = False
            r = self._rubber.rect()
            is_click = r.width() < 3 and r.height() < 3
            w = self._image_size.width()
            h = self._image_size.height()
            x0 = int(max(0, min(w, math_floor(r.left()))))
            y0 = int(max(0, min(h, math_floor(r.top()))))
            x1 = int(max(0, min(w, math_ceil(r.right()))))
            y1 = int(max(0, min(h, math_ceil(r.bottom()))))
            if x1 <= x0:
                x1 = min(w, x0 + 1)
            if y1 <= y0:
                y1 = min(h, y0 + 1)
            self._rubber.setRect(QtCore.QRectF(x0, y0, x1 - x0, y1 - y0))
            self.rectSelected.emit((x0, y0, x1, y1), is_click)
            event.accept()
            return
        super().mouseReleaseEvent(event)

    def _clamp_scene(self, p: QtCore.QPointF) -> QtCore.QPointF:
        r = self._scene.sceneRect()
        return QtCore.QPointF(min(max(p.x(), r.left()), r.right()),
                              min(max(p.y(), r.top()), r.bottom()))


def math_floor(x: float) -> int:
    import math
    return math.floor(x)


def math_ceil(x: float) -> int:
    import math
    return math.ceil(x)
