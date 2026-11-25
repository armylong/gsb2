"""格子马赛克的可缩放预览视图：点击位置映射到行列格子。"""
from __future__ import annotations

from PySide6.QtCore import Qt, Signal, QPoint
from PySide6.QtGui import QPainter, QPixmap, QWheelEvent, QMouseEvent
from PySide6.QtWidgets import QGraphicsView, QGraphicsScene, QGraphicsRectItem


class MosaicGraphicsView(QGraphicsView):
    cell_clicked = Signal(int, int)  # cell_index, button (1=左键,2=右键?)

    def __init__(self, parent=None):
        super().__init__(parent)
        self._scene = QGraphicsScene(self)
        self.setScene(self._scene)
        self.setRenderHints(
            QPainter.RenderHint.Antialiasing
            | QPainter.RenderHint.SmoothPixmapTransform
        )
        self.setDragMode(QGraphicsView.DragMode.ScrollHandDrag)
        self.setTransformationAnchor(
            QGraphicsView.ViewportAnchor.AnchorUnderMouse)
        self.setResizeAnchor(QGraphicsView.ViewportAnchor.AnchorViewCenter)
        self.setBackgroundBrush(Qt.GlobalColor.darkGray)
        self.setMinimumSize(420, 320)

        self._pixmap_item = None
        self._selection_item: QGraphicsRectItem | None = None
        self.cols = 0
        self.rows = 0
        self.cell_px = 1
        self._press_pos: QPoint | None = None
        self._zoom = 1.0

    def set_pixmap(self, pixmap: QPixmap, cols: int, rows: int,
                   cell_px: int) -> None:
        # 网格尺寸没变（例如固定格后重算、切换视图）时保留用户的缩放与视角，
        # 这样放大检查并连续固定时不会每次被拉回全图。
        same_grid = (self._pixmap_item is not None
                     and self.cols == cols and self.rows == rows
                     and self.cell_px == cell_px)
        old_transform = self.transform()
        old_center = (self.mapToScene(self.viewport().rect().center())
                      if same_grid else None)

        self._scene.clear()
        self._selection_item = None
        self.cols, self.rows, self.cell_px = cols, rows, cell_px
        self._pixmap_item = self._scene.addPixmap(pixmap)
        self._scene.setSceneRect(0, 0, pixmap.width(), pixmap.height())

        if same_grid and old_center is not None:
            self.setTransform(old_transform)
            self.centerOn(old_center)
        else:
            self.reset_zoom()

    def reset_zoom(self) -> None:
        self.resetTransform()
        self._zoom = 1.0
        self.fitInView(self._scene.sceneRect(),
                       Qt.AspectRatioMode.KeepAspectRatio)

    def zoom_by(self, factor: float) -> None:
        self._zoom *= factor
        self.scale(factor, factor)

    def set_selected(self, cell_index: int | None) -> None:
        if self._selection_item is not None:
            self._scene.removeItem(self._selection_item)
            self._selection_item = None
        if cell_index is None or not self.cols:
            return
        r, c = divmod(cell_index, self.cols)
        x, y = c * self.cell_px, r * self.cell_px
        rect = self._scene.addRect(
            x + 1.5, y + 1.5,
            self.cell_px - 3, self.cell_px - 3,
        )
        from PySide6.QtGui import QColor, QPen
        pen = QPen(QColor(255, 255, 255, 240))
        pen.setWidth(max(2, self.cell_px // 18))
        pen.setCosmetic(True)
        rect.setPen(pen)
        rect.setZValue(10)
        self._selection_item = rect

    def cell_at_view_pos(self, pos: QPoint) -> int | None:
        if not self.cols or self._pixmap_item is None:
            return None
        scene_pos = self.mapToScene(pos)
        x, y = scene_pos.x(), scene_pos.y()
        if x < 0 or y < 0 or x >= self.cols * self.cell_px \
                or y >= self.rows * self.cell_px:
            return None
        c = int(x // self.cell_px)
        r = int(y // self.cell_px)
        c = max(0, min(self.cols - 1, c))
        r = max(0, min(self.rows - 1, r))
        return r * self.cols + c

    def mousePressEvent(self, event: QMouseEvent) -> None:
        # 先交给 ScrollHandDrag 处理拖拽起点，释放时再按位移判断是不是“点击”。
        self._press_pos = event.pos()
        super().mousePressEvent(event)

    def mouseReleaseEvent(self, event: QMouseEvent) -> None:
        start = self._press_pos
        super().mouseReleaseEvent(event)
        self._press_pos = None
        if start is None or event.button() != Qt.MouseButton.LeftButton:
            return
        if (event.pos() - start).manhattanLength() > 5:
            return  # 是拖拽平移，不是点格子
        idx = self.cell_at_view_pos(event.pos())
        if idx is not None:
            self.cell_clicked.emit(idx, 1)

    def wheelEvent(self, event: QWheelEvent) -> None:
        if event.angleDelta().y() > 0:
            self.zoom_by(1.15)
        else:
            self.zoom_by(1 / 1.15)
