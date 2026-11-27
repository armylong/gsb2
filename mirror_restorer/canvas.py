"""Interactive canvas: symmetry line, damage painting, ROIs and previews."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

import cv2
import numpy as np
from PySide6.QtCore import QPointF, Qt, Signal
from PySide6.QtGui import (
    QColor,
    QCursor,
    QImage,
    QPen,
    QPixmap,
)
from PySide6.QtGui import QBrush
from PySide6.QtWidgets import (
    QGraphicsEllipseItem,
    QGraphicsItem,
    QGraphicsLineItem,
    QGraphicsPixmapItem,
    QGraphicsRectItem,
    QGraphicsScene,
    QGraphicsView,
)

from .geometry import SymLine, mirror_image

DAMAGE_COLOR = (200, 40, 40)      # BGR-ish tuple used on numpy arrays
CC_COLOR = (40, 120, 255)


class Tool(str, Enum):
    LINE = "line"
    BRUSH = "brush"
    ERASER = "eraser"
    RECT_DAMAGE = "rect_damage"
    SUGGEST_ROI = "suggest_roi"
    CC_REGION = "cc_region"


class ViewMode(str, Enum):
    ORIGINAL = "original"
    MIRROR = "mirror"
    OVERLAY = "overlay"
    RESTORED = "restored"
    GAP = "gap"


def qimage_from_bgr(img: np.ndarray) -> QImage:
    if img.ndim == 2:
        img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    h, w = rgb.shape[:2]
    return QImage(rgb.data, w, h, 3 * w, QImage.Format.Format_RGB888).copy()


def mask_overlay(mask: np.ndarray, color_bgr: tuple[int, int, int], alpha: float) -> np.ndarray:
    h, w = mask.shape
    layer = np.zeros((h, w, 4), dtype=np.uint8)
    layer[mask > 0, 0] = color_bgr[0]
    layer[mask > 0, 1] = color_bgr[1]
    layer[mask > 0, 2] = color_bgr[2]
    layer[mask > 0, 3] = int(255 * alpha)
    return layer


@dataclass
class Document:
    image: np.ndarray
    damage: np.ndarray                      # uint8 0/255
    cc_region: np.ndarray                   # uint8 0/255
    line: SymLine | None = None
    suggest_roi: tuple[int, int, int, int] | None = None  # x0,y0,x1,y1
    brush_size: int = 18

    @property
    def h(self) -> int:
        return self.image.shape[0]

    @property
    def w(self) -> int:
        return self.image.shape[1]

    def paint_circle(self, x: float, y: float, erase: bool) -> None:
        r = self.brush_size
        xi, yi = int(round(x)), int(round(y))
        val = 0 if erase else 255
        cv2.circle(self.damage, (xi, yi), r, val, thickness=-1)


class HandleItem(QGraphicsEllipseItem):
    def __init__(self, kind: str):
        super().__init__(-7, -7, 14, 14)
        self.kind = kind
        self.setBrush(QBrush(QColor(255, 220, 0)))
        self.setPen(QPen(QColor(20, 20, 20), 1.5))
        self.setZValue(6)
        self.setFlag(QGraphicsItem.GraphicsItemFlag.ItemIsSelectable, False)
        self.setCursor(QCursor(Qt.CursorShape.PointingHandCursor))


class EditorCanvas(QGraphicsView):
    """Scene-based editor. All coordinates map 1:1 to image pixels."""

    lineEdited = Signal(object)            # emits SymLine
    maskEdited = Signal()
    roiEdited = Signal(object)
    hoverMoved = Signal(float, float)

    HIT_PX = 12.0

    def __init__(self, document: Document, parent=None):
        super().__init__(parent)
        self.doc = document
        self._mode = ViewMode.ORIGINAL
        self._overlay_alpha = 0.45
        self._restored_pix: QPixmap | None = None
        self._gap_pix: QPixmap | None = None
        self._mirror_pix: QPixmap | None = None

        self.setRenderHints(self.renderHints())
        self.setDragMode(QGraphicsView.DragMode.NoDrag)
        self.setTransformationAnchor(QGraphicsView.ViewportAnchor.AnchorUnderMouse)
        self.setResizeAnchor(QGraphicsView.ViewportAnchor.AnchorUnderMouse)

        self.scene_ = QGraphicsScene(self)
        self.setScene(self.scene_)
        self.base_item = QGraphicsPixmapItem()
        self.scene_.addItem(self.base_item)
        self.mask_item = QGraphicsPixmapItem()
        self.mask_item.setZValue(2)
        self.scene_.addItem(self.mask_item)
        self.cc_item = QGraphicsPixmapItem()
        self.cc_item.setZValue(1)
        self.scene_.addItem(self.cc_item)
        self.roi_item = QGraphicsRectItem()
        pen = QPen(QColor(0, 255, 180), 2, Qt.PenStyle.DashLine)
        self.roi_item.setPen(pen)
        self.roi_item.setZValue(4)
        self.scene_.addItem(self.roi_item)
        self.line_item = QGraphicsLineItem()
        self.line_item.setPen(QPen(QColor(0, 255, 255), 2))
        self.line_item.setZValue(5)
        self.scene_.addItem(self.line_item)
        self.h1 = HandleItem("p1")
        self.h2 = HandleItem("p2")
        self.scene_.addItem(self.h1)
        self.scene_.addItem(self.h2)

        self.tool = Tool.LINE
        self.pick_callback = None  # when set, clicks are forwarded as magnifier points
        self._line_drag: str | None = None          # 'p1' | 'p2' | 'body'
        self._drag_start: QPointF | None = None
        self._line_start: SymLine | None = None
        self._painting = False
        self._rect_start: QPointF | None = None
        self._line_clicks: list[QPointF] = []

        self.setMouseTracking(True)
        self.viewport().setMouseTracking(True)
        self._load_base()

    # ------------------------------------------------------------------ data
    def _load_base(self) -> None:
        self.base_item.setPixmap(QPixmap.fromImage(qimage_from_bgr(self.doc.image)))
        self.scene_.setSceneRect(0, 0, self.doc.w, self.doc.h)
        self.refresh_overlays()
        self.refresh_line()

    def set_document(self, doc: Document) -> None:
        self.doc = doc
        self._line_clicks.clear()
        self._restored_pix = None
        self._load_base()

    def set_view_mode(self, mode: ViewMode) -> None:
        self._mode = mode
        self.refresh_overlays()

    def set_overlay_alpha(self, a: float) -> None:
        self._overlay_alpha = a
        if self._mode in (ViewMode.OVERLAY, ViewMode.ORIGINAL):
            self.refresh_overlays()

    def set_restored(self, bgr: np.ndarray) -> None:
        self._restored_pix = QPixmap.fromImage(qimage_from_bgr(bgr))

    def set_gap_preview(self, bgr: np.ndarray) -> None:
        self._gap_pix = QPixmap.fromImage(qimage_from_bgr(bgr))

    def refresh_overlays(self) -> None:
        mode = self._mode
        if mode == ViewMode.MIRROR and self.doc.line is not None:
            mir = mirror_image(self.doc.image, self.doc.line)
            self._mirror_pix = QPixmap.fromImage(qimage_from_bgr(mir))
            self.base_item.setPixmap(self._mirror_pix)
        elif mode == ViewMode.OVERLAY and self.doc.line is not None:
            if self._mirror_pix is None:
                mir = mirror_image(self.doc.image, self.doc.line)
                self._mirror_pix = QPixmap.fromImage(qimage_from_bgr(mir))
            self.base_item.setPixmap(self._blend(self._mirror_pix))
        elif mode == ViewMode.RESTORED and self._restored_pix is not None:
            self.base_item.setPixmap(self._restored_pix)
        elif mode == ViewMode.GAP and self._gap_pix is not None:
            self.base_item.setPixmap(self._gap_pix)
        else:
            self.base_item.setPixmap(QPixmap.fromImage(qimage_from_bgr(self.doc.image)))

        # damage mask overlay stays visible on every view
        layer = mask_overlay(self.doc.damage, DAMAGE_COLOR, 0.42)
        rgba = cv2.cvtColor(layer, cv2.COLOR_BGRA2RGBA)
        qi = QImage(rgba.data, self.doc.w, self.doc.h, 4 * self.doc.w,
                    QImage.Format.Format_RGBA8888).copy()
        self.mask_item.setPixmap(QPixmap.fromImage(qi))

        layer_cc = mask_overlay(self.doc.cc_region, CC_COLOR, 0.30)
        rgba_cc = cv2.cvtColor(layer_cc, cv2.COLOR_BGRA2RGBA)
        qic = QImage(rgba_cc.data, self.doc.w, self.doc.h, 4 * self.doc.w,
                     QImage.Format.Format_RGBA8888).copy()
        self.cc_item.setPixmap(QPixmap.fromImage(qic))
        self.cc_item.setVisible(bool(self.doc.cc_region.any()))

        if self.doc.suggest_roi is not None:
            x0, y0, x1, y1 = self.doc.suggest_roi
            self.roi_item.setRect(min(x0, x1), min(y0, y1), abs(x1 - x0), abs(y1 - y0))
            self.roi_item.setVisible(True)
        else:
            self.roi_item.setVisible(False)

    def _blend(self, mirror_pix: QPixmap) -> QPixmap:
        a = self._overlay_alpha
        base = qimage_from_bgr(self.doc.image)
        m = mirror_pix.toImage()
        out = QImage(base.size(), QImage.Format.Format_RGB888)
        from PySide6.QtGui import QPainter
        p = QPainter(out)
        p.drawImage(0, 0, base)
        p.setOpacity(a)
        p.drawImage(0, 0, m)
        p.end()
        return QPixmap.fromImage(out)

    def refresh_mirror(self) -> None:
        if self.doc.line is None:
            return
        mir = mirror_image(self.doc.image, self.doc.line)
        self._mirror_pix = QPixmap.fromImage(qimage_from_bgr(mir))
        self.refresh_overlays()

    def refresh_line(self) -> None:
        line = self.doc.line
        if line is None:
            self.line_item.setVisible(False)
            self.h1.setVisible(False)
            self.h2.setVisible(False)
            return
        self.line_item.setLine(line.x1, line.y1, line.x2, line.y2)
        self.line_item.setVisible(True)
        self.h1.setPos(line.x1, line.y1)
        self.h2.setPos(line.x2, line.y2)
        self.h1.setVisible(True)
        self.h2.setVisible(True)
        self.refresh_mirror()

    def set_line(self, line: SymLine, notify: bool = True) -> None:
        self.doc.line = line
        self.refresh_line()
        if notify:
            self.lineEdited.emit(line)

    # ------------------------------------------------------------- zoom/pan
    def wheelEvent(self, event):
        factor = 1.25 if event.angleDelta().y() > 0 else 0.8
        self.scale(factor, factor)

    # ------------------------------------------------------------- mouse API
    def _scene_pos(self, event) -> QPointF:
        p = self.mapToScene(event.position().toPoint())
        return QPointF(
            float(np.clip(p.x(), 0, self.doc.w - 1)),
            float(np.clip(p.y(), 0, self.doc.h - 1)),
        )

    def _hit_handle(self, p: QPointF) -> str | None:
        if self.doc.line is None:
            return None
        if np.hypot(p.x() - self.doc.line.x1, p.y() - self.doc.line.y1) <= self.HIT_PX:
            return "p1"
        if np.hypot(p.x() - self.doc.line.x2, p.y() - self.doc.line.y2) <= self.HIT_PX:
            return "p2"
        return None

    def _hit_line_body(self, p: QPointF) -> bool:
        if self.doc.line is None:
            return False
        ln = self.doc.line
        ax, ay = ln.x2 - ln.x1, ln.y2 - ln.y1
        denom = max(ax * ax + ay * ay, 1e-9)
        t = ((p.x() - ln.x1) * ax + (p.y() - ln.y1) * ay) / denom
        t = float(np.clip(t, 0, 1))
        cx, cy = ln.x1 + t * ax, ln.y1 + t * ay
        return np.hypot(p.x() - cx, p.y() - cy) <= self.HIT_PX

    def mousePressEvent(self, event):
        if event.button() != Qt.MouseButton.LeftButton:
            super().mousePressEvent(event)
            return
        p = self._scene_pos(event)

        if self.pick_callback is not None:
            self.pick_callback(p.x(), p.y())
            return

        if self.tool == Tool.LINE:
            hit = self._hit_handle(p)
            if hit:
                self._line_drag = hit
                self._drag_start = p
                self._line_start = self.doc.line
                return
            if self._hit_line_body(p) and self.doc.line is not None:
                self._line_drag = "body"
                self._drag_start = p
                self._line_start = self.doc.line
                return
            self._line_clicks.append(p)
            if len(self._line_clicks) == 2:
                line = SymLine.from_points(
                    (self._line_clicks[0].x(), self._line_clicks[0].y()),
                    (self._line_clicks[1].x(), self._line_clicks[1].y()),
                )
                self._line_clicks.clear()
                self.set_line(line)
            return

        if self.tool in (Tool.BRUSH, Tool.ERASER):
            self._painting = True
            self.doc.paint_circle(p.x(), p.y(), erase=self.tool == Tool.ERASER)
            self.refresh_overlays()
            self.maskEdited.emit()
            return

        if self.tool in (Tool.RECT_DAMAGE, Tool.SUGGEST_ROI, Tool.CC_REGION):
            self._rect_start = p
            return

    def mouseMoveEvent(self, event):
        p = self._scene_pos(event)
        self.hoverMoved.emit(p.x(), p.y())

        if self._line_drag and self._line_start is not None and self._drag_start is not None:
            ln = self._line_start
            if self._line_drag == "p1":
                self.set_line(ln.with_endpoints((p.x(), p.y()), (ln.x2, ln.y2)))
            elif self._line_drag == "p2":
                self.set_line(ln.with_endpoints((ln.x1, ln.y1), (p.x(), p.y())))
            else:
                dx, dy = p.x() - self._drag_start.x(), p.y() - self._drag_start.y()
                self.set_line(
                    SymLine.from_points(
                        (ln.x1 + dx, ln.y1 + dy), (ln.x2 + dx, ln.y2 + dy)
                    )
                )
            return

        if self._painting:
            # interpolate between last and current point so fast strokes stay solid
            last = getattr(self, "_last_paint", p)
            steps = max(1, int(np.hypot(p.x() - last.x(), p.y() - last.y())))
            for i in range(steps + 1):
                t = i / max(steps, 1)
                self.doc.paint_circle(
                    last.x() + (p.x() - last.x()) * t,
                    last.y() + (p.y() - last.y()) * t,
                    erase=self.tool == Tool.ERASER,
                )
            self._last_paint = p
            self.refresh_overlays()
            self.maskEdited.emit()
            return
        self._last_paint = p

        if self._rect_start is not None:
            s = self._rect_start
            self.roi_item.setRect(
                min(s.x(), p.x()), min(s.y(), p.y()),
                abs(p.x() - s.x()), abs(p.y() - s.y()),
            )
            self.roi_item.setVisible(True)

    def mouseReleaseEvent(self, event):
        if event.button() != Qt.MouseButton.LeftButton:
            super().mouseReleaseEvent(event)
            return
        p = self._scene_pos(event)

        if self._line_drag:
            self._line_drag = None
            self._drag_start = None
            self._line_start = None
            return
        self._painting = False

        if self._rect_start is not None and self.tool in (
            Tool.RECT_DAMAGE, Tool.SUGGEST_ROI, Tool.CC_REGION
        ):
            s = self._rect_start
            x0, y0 = int(round(min(s.x(), p.x()))), int(round(min(s.y(), p.y())))
            x1, y1 = int(round(max(s.x(), p.x()))), int(round(max(s.y(), p.y())))
            if x1 > x0 and y1 > y0:
                if self.tool == Tool.RECT_DAMAGE:
                    self.doc.damage[y0:y1, x0:x1] = 255
                    self.refresh_overlays()
                    self.maskEdited.emit()
                elif self.tool == Tool.SUGGEST_ROI:
                    self.doc.suggest_roi = (x0, y0, x1, y1)
                    self.refresh_overlays()
                    self.roiEdited.emit(self.doc.suggest_roi)
                else:
                    self.doc.cc_region[:] = 0
                    self.doc.cc_region[y0:y1, x0:x1] = 255
                    self.refresh_overlays()
            self._rect_start = None

    def clear_damage(self) -> None:
        self.doc.damage[:] = 0
        self.refresh_overlays()
        self.maskEdited.emit()

    def clear_cc_region(self) -> None:
        self.doc.cc_region[:] = 0
        self.refresh_overlays()
