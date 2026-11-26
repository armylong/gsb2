"""Interactive image canvas.

One canvas class serves four read-only/editable views:

* ``mode="display"`` — the upright image, editable (rects + markers).
* ``mode="stored"`` — the encoded original, with the selection drawn in
  stored coordinates; read-only.
* ``mode="crop"``   — one exported crop, read-only, for point lookup.

Overlay geometry is expressed in *image* coordinates and drawn through the
view transform, so a selection that touches the image border is painted on
the border pixel no matter the zoom.
"""

from __future__ import annotations

import math
from typing import List, Optional, Sequence, Tuple

from PIL import Image
from PySide6.QtCore import QPointF, QRectF, Qt, Signal
from PySide6.QtGui import QBrush, QColor, QFont, QPainter, QPen
from PySide6.QtWidgets import QGraphicsItem, QGraphicsScene, QGraphicsView

from cropkit.rectmath import Rect
from cropkit.ui.qtutil import pil_to_pixmap

PREVIEW_PIXEL_BUDGET = 24_000_000  # decode/keep at most ~24 MP per view


class RectItem(QGraphicsItem):
    def __init__(self, index: int):
        super().__init__()
        self.index = index
        self.rect = Rect(0, 0, 1, 1)
        self.active = False
        self.enabled = True
        self.label = ""
        self.ui_scale = 1.0
        self.setZValue(10)

    def boundingRect(self) -> QRectF:
        m = 60 / max(self.ui_scale, 1e-6)
        return QRectF(self.rect.x0 - m, self.rect.y0 - m,
                      self.rect.width + 2 * m, self.rect.height + 2 * m)

    def paint(self, painter: QPainter, option, widget=None) -> None:
        color = QColor("#1fc77b") if self.enabled else QColor("#8a8a8a")
        if self.active:
            color = QColor("#ffb020")
        pen = QPen(color, 1.6)
        pen.setCosmetic(True)
        painter.setPen(pen)
        painter.setBrush(Qt.BrushStyle.NoBrush)
        r = QRectF(self.rect.x0, self.rect.y0,
                   self.rect.width, self.rect.height)
        painter.drawRect(r)
        if self.active:
            hs = 4.0 / max(self.ui_scale, 1e-6)
            painter.setBrush(QBrush(color))
            for cx, cy in self.handle_points():
                painter.drawRect(QRectF(cx - hs, cy - hs, hs * 2, hs * 2))
        if self.label:
            font = QFont()
            font.setPixelSize(max(9, int(11 / max(self.ui_scale, 1e-6))))
            painter.setFont(font)
            painter.setPen(QPen(color))
            painter.drawText(QPointF(self.rect.x0, self.rect.y0 - 3),
                             self.label)

    def handle_points(self) -> List[Tuple[float, float]]:
        r = self.rect
        mx, my = r.x0 + r.width / 2, r.y0 + r.height / 2
        return [
            (r.x0, r.y0), (mx, r.y0), (r.x1, r.y0),
            (r.x0, my), (r.x1, my),
            (r.x0, r.y1), (mx, r.y1), (r.x1, r.y1),
        ]


class MarkerItem(QGraphicsItem):
    def __init__(self, index: int):
        super().__init__()
        self.index = index
        self.x = 0
        self.y = 0
        self.active = False
        self.label = ""
        self.ui_scale = 1.0
        self.setZValue(20)

    def boundingRect(self) -> QRectF:
        m = 60 / max(self.ui_scale, 1e-6)
        return QRectF(self.x - m, self.y - m, 2 * m, 2 * m)

    def paint(self, painter: QPainter, option, widget=None) -> None:
        color = QColor("#ff5d5d") if self.active else QColor("#4aa3ff")
        s = 6.0 / max(self.ui_scale, 1e-6)
        pen = QPen(color, 1.4)
        pen.setCosmetic(True)
        painter.setPen(pen)
        painter.setBrush(Qt.BrushStyle.NoBrush)
        painter.drawEllipse(QPointF(self.x, self.y), s, s)
        painter.drawLine(QPointF(self.x - 1.6 * s, self.y),
                         QPointF(self.x + 1.6 * s, self.y))
        painter.drawLine(QPointF(self.x, self.y - 1.6 * s),
                         QPointF(self.x, self.y + 1.6 * s))
        if self.label:
            font = QFont()
            font.setPixelSize(max(8, int(10 / max(self.ui_scale, 1e-6))))
            painter.setFont(font)
            painter.drawText(QPointF(self.x + s + 1, self.y - s), self.label)


class ImageCanvas(QGraphicsView):
    pointClicked = Signal(float, float, object)   # image x, image y, button
    pointDragged = Signal(float, float, object)   # image x, image y, buttons
    dragStarted = Signal()
    dragFinished = Signal()
    mouseMoved = Signal(float, float)
    mouseLeft = Signal()
    zoomChanged = Signal(float)

    def __init__(self, mode: str = "display", parent=None):
        super().__init__(parent)
        self.mode = mode
        self.setScene(QGraphicsScene(self))
        self.setRenderHints(QPainter.RenderHint.Antialiasing |
                            QPainter.RenderHint.SmoothPixmapTransform)
        self.setDragMode(QGraphicsView.DragMode.NoDrag)
        self.setTransformationAnchor(
            QGraphicsView.ViewportAnchor.AnchorUnderMouse)
        self.setResizeAnchor(QGraphicsView.ViewportAnchor.AnchorViewCenter)
        self.setBackgroundBrush(QBrush(QColor("#191a1f")))
        self._pixmap_item = None
        self._image_size = (1, 1)
        self._zoom = 1.0
        self._fit = True
        self._corner_labels = None
        self._edge_visible = True
        self._crosshair = None
        self._rect_items: List[RectItem] = []
        self._marker_items: List[MarkerItem] = []
        self._extra_items: List[QGraphicsItem] = []
        self._press_button = None
        self._pan_origin = None
        self.setMouseTracking(True)
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)

    # ------------------------------------------------------------------
    def set_image(self, img: Image.Image) -> None:
        scene = self.scene()
        if self._pixmap_item is not None:
            scene.removeItem(self._pixmap_item)
            self._pixmap_item = None
        for item in list(self._rect_items) + list(self._marker_items):
            scene.removeItem(item)
        self._rect_items = []
        self._marker_items = []
        self._clear_extra()

        self._image_size = img.size
        scale = 1.0
        if img.width * img.height > PREVIEW_PIXEL_BUDGET:
            scale = math.sqrt(PREVIEW_PIXEL_BUDGET / (img.width * img.height))
        preview = img if scale >= 1.0 else img.resize(
            (max(1, int(img.width * scale)), max(1, int(img.height * scale))),
            Image.Resampling.LANCZOS)
        pix = pil_to_pixmap(preview)
        item = scene.addPixmap(pix)
        item.setScale(1.0 / scale)
        item.setZValue(0)
        self._pixmap_item = item
        scene.setSceneRect(0, 0, img.width, img.height)
        if self._fit:
            self.fit_image()
        self._update_ui_scale()
        self.viewport().update()

    def image_size(self) -> Tuple[int, int]:
        return self._image_size

    # ------------------------------------------------------------------
    # zoom
    # ------------------------------------------------------------------
    def fit_image(self) -> None:
        if self._pixmap_item is None:
            return
        self._fit = True
        self.fitInView(self.sceneRect(), Qt.AspectRatioMode.KeepAspectRatio)
        self._sync_zoom()

    def zoom_to(self, factor: float) -> None:
        self._fit = False
        self._zoom = max(0.01, min(64.0, factor))
        self.resetTransform()
        self.scale(self._zoom, self._zoom)
        self._update_ui_scale()

    def zoom_by(self, factor: float) -> None:
        self.zoom_to(self.zoom() * factor)

    def zoom(self) -> float:
        return self.transform().m11()

    def focus_on_rect(self, rect: Rect, margin: float = 0.06) -> None:
        """Fit the view to ``rect`` plus a relative margin."""
        if self._pixmap_item is None:
            return
        pad_x = max(rect.width * margin, 4)
        pad_y = max(rect.height * margin, 4)
        box = QRectF(rect.x0 - pad_x, rect.y0 - pad_y,
                     rect.width + 2 * pad_x, rect.height + 2 * pad_y)
        self._fit = False
        self.fitInView(box, Qt.AspectRatioMode.KeepAspectRatio)
        self._sync_zoom()

    def center_on(self, x: float, y: float) -> None:
        self.centerOn(QPointF(x, y))
        self._fit = False

    def _sync_zoom(self) -> None:
        self._zoom = self.transform().m11()
        self._update_ui_scale()

    def _update_ui_scale(self) -> None:
        z = max(self.zoom(), 1e-6)
        for item in self._rect_items + self._marker_items:
            item.ui_scale = z
            item.prepareGeometryChange()
        self.zoomChanged.emit(z)

    def leaveEvent(self, event) -> None:
        self.mouseLeft.emit()
        super().leaveEvent(event)

    def wheelEvent(self, event) -> None:
        if event.modifiers() & (Qt.KeyboardModifier.ControlModifier |
                                Qt.KeyboardModifier.MetaModifier):
            factor = 1.15 if event.angleDelta().y() > 0 else 1 / 1.15
            self.zoom_by(factor)
            event.accept()
            return
        super().wheelEvent(event)
        self._sync_zoom()

    def resizeEvent(self, event) -> None:
        super().resizeEvent(event)
        if self._fit:
            self.fit_image()
        else:
            self._sync_zoom()

    # ------------------------------------------------------------------
    # overlays
    # ------------------------------------------------------------------
    def _clear_extra(self) -> None:
        for item in self._extra_items:
            self.scene().removeItem(item)
        self._extra_items = []

    def _add_extra(self, item, z: float):
        item.setZValue(z)
        self._extra_items.append(item)
        return item

    def set_rects(self, entries: Sequence[dict]) -> None:
        scene = self.scene()
        for item in self._rect_items:
            scene.removeItem(item)
        self._rect_items = []
        for e in entries:
            item = RectItem(e["index"])
            item.rect = e["rect"]
            item.active = e.get("active", False)
            item.enabled = e.get("enabled", True)
            item.label = e.get("label", "")
            item.ui_scale = max(self.zoom(), 1e-6)
            scene.addItem(item)
            self._rect_items.append(item)
        self.viewport().update()

    def set_markers(self, entries: Sequence[dict]) -> None:
        scene = self.scene()
        for item in self._marker_items:
            scene.removeItem(item)
        self._marker_items = []
        for e in entries:
            item = MarkerItem(e["index"])
            item.x, item.y = e["x"], e["y"]
            item.active = e.get("active", False)
            item.label = e.get("label", "")
            item.ui_scale = max(self.zoom(), 1e-6)
            scene.addItem(item)
            self._marker_items.append(item)
        self.viewport().update()

    def show_edges(self, visible: bool) -> None:
        self._edge_visible = visible
        self._redraw_edges()

    def set_corner_labels(self, labels: Optional[Sequence[str]]) -> None:
        self._corner_labels = list(labels) if labels else None
        self._redraw_edges()

    def _redraw_edges(self) -> None:
        # edge + label items live in _extra_items together with the crosshair;
        # rebuild both groups.
        crosshair = self._crosshair
        self._clear_extra()
        if self._edge_visible and self._pixmap_item is not None:
            w, h = self._image_size
            pen = QPen(QColor("#ffffff66"), 1.0)
            pen.setCosmetic(True)
            for x0, y0, x1, y1 in ((0, 0, w, 0), (0, h, w, h),
                                   (0, 0, 0, h), (w, 0, w, h)):
                self._add_extra(self.scene().addLine(x0, y0, x1, y1, pen), 5)
            if self._corner_labels:
                font = QFont()
                font.setPixelSize(11)
                positions = ((2, 16), (w - 46, 16), (2, h - 6), (w - 46, h - 6))
                for text, (lx, ly) in zip(self._corner_labels, positions):
                    item = self.scene().addText(text, font)
                    item.setDefaultTextColor(QColor("#ffe58aff"))
                    item.setPos(lx, ly - 12)
                    self._add_extra(item, 6)
        if crosshair is not None:
            self._draw_crosshair(crosshair)
        self.viewport().update()

    def set_crosshair(self, point: Optional[Tuple[float, float]]) -> None:
        self._crosshair = tuple(point) if point else None
        self._redraw_edges()

    def _draw_crosshair(self, point) -> None:
        x, y = point
        w, h = self._image_size
        pen = QPen(QColor("#ffd400"), 1.2)
        pen.setCosmetic(True)
        self._add_extra(self.scene().addLine(0, y, w, y, pen), 25)
        self._add_extra(self.scene().addLine(x, 0, x, h, pen), 25)
        font = QFont()
        font.setPixelSize(11)
        label = self.scene().addText(f"({int(round(x))}, {int(round(y))})", font)
        label.setDefaultTextColor(QColor("#ffd400"))
        label.setPos(x + 6, y + 4)
        self._add_extra(label, 26)

    # ------------------------------------------------------------------
    # coordinate conversion
    # ------------------------------------------------------------------
    def to_image(self, view_pos):
        if self._pixmap_item is None:
            return None
        scene_pt = self.mapToScene(view_pos.toPoint())
        if not (0 <= scene_pt.x() <= self._image_size[0] and
                0 <= scene_pt.y() <= self._image_size[1]):
            # still useful for dragging slightly outside: clamp
            x = min(max(scene_pt.x(), 0.0), float(self._image_size[0]))
            y = min(max(scene_pt.y(), 0.0), float(self._image_size[1]))
            return x, y
        return scene_pt.x(), scene_pt.y()

    def to_view(self, x: float, y: float) -> QPointF:
        return self.mapFromScene(QPointF(x, y))

    def ensure_item_visible(self, x: float, y: float,
                           margin: float = 40.0) -> None:
        """Scroll so that an image point (plus margin) is inside the view."""
        if self._pixmap_item is None:
            return
        target = QRectF(x - margin, y - margin, margin * 2, margin * 2)
        visible = self.mapToScene(self.viewport().rect()).boundingRect()
        if not visible.contains(target):
            self.centerOn(QPointF(x, y))

    def px_tolerance(self, screen_px: float = 6.0) -> float:
        return screen_px / max(self.zoom(), 1e-6)

    # ------------------------------------------------------------------
    # mouse
    # ------------------------------------------------------------------
    def mousePressEvent(self, event) -> None:
        pos = self.to_image(event.position())
        if pos is None:
            super().mousePressEvent(event)
            return
        pan = (event.button() == Qt.MouseButton.MiddleButton or
               (event.button() == Qt.MouseButton.LeftButton and
                event.modifiers() & Qt.KeyboardModifier.AltModifier))
        if pan:
            self._pan_origin = (event.position(),
                                self.horizontalScrollBar(),
                                self.verticalScrollBar())
            event.accept()
            return
        self._press_button = event.button()
        self.dragStarted.emit()
        self.pointClicked.emit(pos[0], pos[1], event.button())
        event.accept()

    def mouseMoveEvent(self, event) -> None:
        pos = self.to_image(event.position())
        if pos is None:
            super().mouseMoveEvent(event)
            return
        self.mouseMoved.emit(pos[0], pos[1])
        if self._pan_origin is not None:
            start, hbar, vbar = self._pan_origin
            delta = event.position() - start
            hbar.setValue(int(hbar.value() - delta.x()))
            vbar.setValue(int(vbar.value() - delta.y()))
            event.accept()
            return
        if event.buttons() & (Qt.MouseButton.LeftButton |
                              Qt.MouseButton.RightButton |
                              Qt.MouseButton.MiddleButton):
            self.pointDragged.emit(pos[0], pos[1], event.buttons())
            event.accept()
            return
        super().mouseMoveEvent(event)

    def mouseReleaseEvent(self, event) -> None:
        if self._pan_origin is not None:
            self._pan_origin = None
            event.accept()
            return
        if self._press_button is not None:
            self._press_button = None
            self.dragFinished.emit()
            event.accept()
            return
        super().mouseReleaseEvent(event)

    def keyPressEvent(self, event) -> None:
        if event.key() == Qt.Key.Key_Space:
            self.setDragMode(QGraphicsView.DragMode.ScrollHandDrag)
            event.accept()
            return
        super().keyPressEvent(event)

    def keyReleaseEvent(self, event) -> None:
        if event.key() == Qt.Key.Key_Space:
            self.setDragMode(QGraphicsView.DragMode.NoDrag)
            event.accept()
            return
        super().keyReleaseEvent(event)
