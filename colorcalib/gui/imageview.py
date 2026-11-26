"""交互式图像视图：显示图片、圈选色格取样区域并做状态配色。

状态配色约定：
- 绿色实线：参与对色拟合（fit）
- 蓝色实线：仅留作检查（check）
- 灰色虚线：已停用（disabled）
- 橙红色描边：取样存在过曝或取到边框的警告
- 加粗高亮：当前选中

支持滚轮缩放、拖拽新建取样框、移动/缩放/删除已有框。
"""

from __future__ import annotations

from PySide6.QtCore import QPointF, QRectF, Qt, Signal
from PySide6.QtGui import QBrush, QColor, QPen, QPixmap
from PySide6.QtWidgets import (
    QGraphicsRectItem,
    QGraphicsScene,
    QGraphicsSimpleTextItem,
    QGraphicsView,
    QMenu,
)

from ..sampling import ROIRect

_COLOR_FIT = QColor(46, 204, 113)
_COLOR_CHECK = QColor(52, 152, 219)
_COLOR_DISABLED = QColor(140, 140, 140)
_COLOR_WARNING = QColor(231, 76, 60)
_COLOR_SELECTED = QColor(255, 220, 0)
_HANDLE = 10.0  # 右下角缩放手柄尺寸（场景像素）


class RoiItem(QGraphicsRectItem):
    """单个取样框，可整体移动、用右下角手柄缩放。"""

    def __init__(self, roi: ROIRect, state: dict, on_changed, on_context):
        super().__init__(QRectF(roi.x0, roi.y0, roi.x1 - roi.x0, roi.y1 - roi.y0))
        self.roi = roi
        self._state = state  # {"warning": bool, "selected": bool}
        self._on_changed = on_changed
        self._on_context = on_context
        self._resizing = False
        self._label = QGraphicsSimpleTextItem(roi.patch_id, self)
        self._label.setBrush(QBrush(QColor(255, 255, 255)))
        self.setFlag(QGraphicsRectItem.GraphicsItemFlag.ItemIsSelectable, True)
        self.setFlag(QGraphicsRectItem.GraphicsItemFlag.ItemIsMovable, True)
        self.setFlag(QGraphicsRectItem.GraphicsItemFlag.ItemSendsGeometryChanges, True)
        self.setAcceptHoverEvents(True)
        self.refresh_style()

    # --- 样式 ---
    def refresh_style(self) -> None:
        if not self.roi.enabled:
            color = _COLOR_DISABLED
            pen = QPen(color, 2.0, Qt.PenStyle.DashLine)
        elif self.roi.role == "check":
            color = _COLOR_CHECK
            pen = QPen(color, 2.0)
        else:
            color = _COLOR_FIT
            pen = QPen(color, 2.0)
        if self._state.get("warning"):
            pen = QPen(_COLOR_WARNING, 2.5, Qt.PenStyle.DashLine)
        if self._state.get("selected"):
            pen = QPen(_COLOR_SELECTED, 3.0)
        self.setPen(pen)
        fill = QColor(color)
        fill.setAlpha(45)
        self.setBrush(QBrush(fill))

        # 标签放在框上方
        self._label.setText(self._label_text())
        br = self._label.boundingRect()
        self._label.setPos(self.rect().left(), self.rect().top() - br.height() - 2)
        self._label.setBrush(QBrush(QColor(255, 255, 255)))

    def _label_text(self) -> str:
        tags = [self.roi.patch_id]
        tags.append("检查" if self.roi.role == "check" else "拟合")
        if not self.roi.enabled:
            tags.append("停用")
        if self._state.get("warning"):
            tags.append("!")
        return " ".join(tags)

    def set_state(self, state: dict) -> None:
        self._state = state
        self.refresh_style()

    def current_roi(self) -> ROIRect:
        r = self.mapRectToScene(self.rect())
        return ROIRect(
            patch_id=self.roi.patch_id,
            x0=round(r.left()),
            y0=round(r.top()),
            x1=round(r.right()),
            y1=round(r.bottom()),
            role=self.roi.role,
            enabled=self.roi.enabled,
        )

    def apply_role(self, role: str) -> None:
        self.roi.role = role
        self.refresh_style()
        self._on_changed()

    def apply_enabled(self, enabled: bool) -> None:
        self.roi.enabled = enabled
        self.refresh_style()
        self._on_changed()

    # --- 鼠标交互：移动 / 右下角缩放 ---
    def _on_handle(self, pos: QPointF) -> bool:
        r = self.rect()
        return pos.x() >= r.right() - _HANDLE and pos.y() >= r.bottom() - _HANDLE

    def hoverMoveEvent(self, event):
        self.setCursor(
            Qt.CursorShape.SizeFDiagCursor if self._on_handle(event.pos())
            else Qt.CursorShape.SizeAllCursor
        )
        super().hoverMoveEvent(event)

    def mousePressEvent(self, event):
        if event.button() == Qt.MouseButton.LeftButton and self._on_handle(event.pos()):
            self._resizing = True
            self.setFlag(QGraphicsRectItem.GraphicsItemFlag.ItemIsMovable, False)
            event.accept()
            return
        super().mousePressEvent(event)

    def mouseMoveEvent(self, event):
        if self._resizing:
            r = self.rect()
            r.setBottomRight(event.pos())
            min_size = 8.0
            if r.width() < min_size:
                r.setWidth(min_size)
            if r.height() < min_size:
                r.setHeight(min_size)
            self.setRect(r)
            event.accept()
            return
        super().mouseMoveEvent(event)

    def mouseReleaseEvent(self, event):
        if self._resizing:
            self._resizing = False
            self.setFlag(QGraphicsRectItem.GraphicsItemFlag.ItemIsMovable, True)
        self.roi = self.current_roi()
        self.refresh_style()
        self._on_changed()
        super().mouseReleaseEvent(event)

    def contextMenuEvent(self, event):
        self._on_context(event.screenPos(), self)


class ImageView(QGraphicsView):
    """图片显示与 ROI 管理视图。"""

    rois_changed = Signal()
    selection_changed = Signal(str)  # patch_id 或 ""

    def __init__(self, parent=None):
        super().__init__(parent)
        self._scene = QGraphicsScene(self)
        self.setScene(self._scene)
        self.setRenderHints(self.renderHints())
        self.setDragMode(QGraphicsView.DragMode.NoDrag)
        self.setTransformationAnchor(QGraphicsView.ViewportAnchor.AnchorUnderMouse)
        self.setResizeAnchor(QGraphicsView.ViewportAnchor.AnchorUnderMouse)
        self._pixmap_item = None
        self._roi_items: dict[str, RoiItem] = {}
        self._draw_target: str | None = None
        self._band: QGraphicsRectItem | None = None
        self._band_start: QPointF | None = None
        self._image_size = (0, 0)

    def set_image(self, pixmap: QPixmap) -> None:
        """载入全新图片：清空场景与所有 ROI。"""
        self._scene.clear()
        self._roi_items.clear()
        self._pixmap_item = self._scene.addPixmap(pixmap)
        self._image_size = (pixmap.width(), pixmap.height())
        self.setSceneRect(QRectF(0, 0, pixmap.width(), pixmap.height()))
        self.fitInView(self._pixmap_item, Qt.AspectRatioMode.KeepAspectRatio)

    def set_pixmap(self, pixmap: QPixmap) -> None:
        """只替换显示的像素（预览切换），保留所有 ROI 与视图变换。"""
        old = self._pixmap_item
        self._pixmap_item = self._scene.addPixmap(pixmap)
        if old is not None:
            self._scene.removeItem(old)
        # ROI 保持在像素层之上
        for item in self._roi_items.values():
            item.setZValue(1.0)
        self._image_size = (pixmap.width(), pixmap.height())

    def fit_to_window(self) -> None:
        if self._pixmap_item is not None:
            self.fitInView(self._pixmap_item, Qt.AspectRatioMode.KeepAspectRatio)

    # --- 绘制模式 ---
    def set_draw_target(self, patch_id: str | None) -> None:
        self._draw_target = patch_id
        self.setCursor(
            Qt.CursorShape.CrossCursor if patch_id else Qt.CursorShape.ArrowCursor
        )

    def wheelEvent(self, event):
        # 滚轮以鼠标位置为锚点缩放
        factor = 1.2 if event.angleDelta().y() > 0 else 1 / 1.2
        self.scale(factor, factor)

    def mousePressEvent(self, event):
        if self._draw_target and event.button() == Qt.MouseButton.LeftButton:
            scene_pos = self.mapToScene(event.position().toPoint())
            if self.sceneRect().contains(scene_pos):
                self._band_start = scene_pos
                pen = QPen(QColor(255, 255, 0), 2.0, Qt.PenStyle.DashLine)
                self._band = self._scene.addRect(QRectF(scene_pos, scene_pos), pen)
                event.accept()
                return
        super().mousePressEvent(event)

    def mouseMoveEvent(self, event):
        if self._band is not None and self._band_start is not None:
            pos = self.mapToScene(event.position().toPoint())
            self._band.setRect(QRectF(self._band_start, pos).normalized())
            event.accept()
            return
        super().mouseMoveEvent(event)

    def mouseReleaseEvent(self, event):
        if self._band is not None and self._band_start is not None:
            rect = self._band.rect().normalized()
            self._scene.removeItem(self._band)
            self._band = None
            start, self._band_start = self._band_start, None
            if rect.width() >= 8 and rect.height() >= 8 and self._draw_target:
                target = self._draw_target
                self._emit_drawn(target, rect)
            self.set_draw_target(None)
            event.accept()
            return
        super().mouseReleaseEvent(event)
        selected = self._selected_id()
        self.selection_changed.emit(selected)
        self._refresh_selection_styles()

    def _emit_drawn(self, patch_id: str, rect: QRectF) -> None:
        w, h = self._image_size
        roi = ROIRect(
            patch_id=patch_id,
            x0=int(max(0, round(rect.left()))),
            y0=int(max(0, round(rect.top()))),
            x1=int(min(w, round(rect.right()))),
            y1=int(min(h, round(rect.bottom()))),
        )
        self.add_or_replace_roi(roi)

    # --- ROI 增删改 ---
    def add_or_replace_roi(self, roi: ROIRect, state: dict | None = None) -> None:
        if roi.patch_id in self._roi_items:
            old = self._roi_items.pop(roi.patch_id)
            self._scene.removeItem(old)
        item = RoiItem(
            roi,
            state or {},
            on_changed=self._notify_changed,
            on_context=self._show_context_menu,
        )
        self._scene.addItem(item)
        self._roi_items[roi.patch_id] = item
        self._notify_changed()

    def remove_roi(self, patch_id: str) -> None:
        item = self._roi_items.pop(patch_id, None)
        if item is not None:
            self._scene.removeItem(item)
            self._notify_changed()

    def clear_rois(self) -> None:
        for item in list(self._roi_items.values()):
            self._scene.removeItem(item)
        self._roi_items.clear()
        self._notify_changed()

    def get_rois(self) -> list[ROIRect]:
        return [item.current_roi() for item in self._roi_items.values()]

    def update_states(self, states: dict[str, dict]) -> None:
        """states: patch_id -> {"warning": bool, "selected": bool}。"""
        for pid, item in self._roi_items.items():
            item.set_state(states.get(pid, {}))

    def update_roi_meta(self, roi: ROIRect) -> None:
        """从外部（面板/项目文件）同步角色与启用状态。"""
        item = self._roi_items.get(roi.patch_id)
        if item is not None:
            item.roi = roi
            item.refresh_style()

    def _selected_id(self) -> str:
        for pid, item in self._roi_items.items():
            if item.isSelected():
                return pid
        return ""

    def _refresh_selection_styles(self) -> None:
        selected = self._selected_id()
        for pid, item in self._roi_items.items():
            state = dict(item._state)
            state["selected"] = pid == selected
            item.set_state(state)

    def _notify_changed(self) -> None:
        self.rois_changed.emit()

    def _show_context_menu(self, screen_pos, item: RoiItem) -> None:
        menu = QMenu(self)
        act_fit = menu.addAction("设为参与拟合")
        act_check = menu.addAction("设为仅留作检查")
        act_toggle = menu.addAction("停用" if item.roi.enabled else "启用")
        menu.addSeparator()
        act_delete = menu.addAction("删除取样框")
        chosen = menu.exec(screen_pos)
        if chosen == act_fit:
            item.apply_role("fit")
        elif chosen == act_check:
            item.apply_role("check")
        elif chosen == act_toggle:
            item.apply_enabled(not item.roi.enabled)
        elif chosen == act_delete:
            self.remove_roi(item.roi.patch_id)
