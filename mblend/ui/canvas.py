"""A zoomable, pannable image canvas with mask painting.

The widget shows one ``H×W×3`` uint8 RGB array (already converted to sRGB for
display) plus an optional overlay.  Painting happens in *image* coordinates,
so the brush has the same physical size relative to the image at every zoom
level.  The overlay is a pre-rendered RGBA image at image resolution; it is
composited in numpy at the zoom level that is actually visible, so brush
feedback is immediate even at 100 %.
"""

from __future__ import annotations

from dataclasses import dataclass
import numpy as np
from PySide6.QtCore import QPointF, QRectF, Qt, Signal
from PySide6.QtGui import (
    QColor,
    QImage,
    QMouseEvent,
    QPainter,
    QPen,
    QPixmap,
    QWheelEvent,
)
from PySide6.QtWidgets import QWidget

MIN_ZOOM = 0.05
MAX_ZOOM = 16.0
ZOOM_STEP = 1.25

TOOL_PAINT_A = "paint_a"
TOOL_PAINT_B = "paint_b"
TOOL_ERASE = "erase"
TOOL_PICK = "pick"


@dataclass
class ViewTransform:
    zoom: float = 1.0
    offset_x: float = 0.0
    offset_y: float = 0.0

    def image_to_widget(self, x: float, y: float) -> tuple[float, float]:
        return x * self.zoom + self.offset_x, y * self.zoom + self.offset_y

    def widget_to_image(self, x: float, y: float) -> tuple[float, float]:
        return (x - self.offset_x) / self.zoom, (y - self.offset_y) / self.zoom


def numpy_rgb_to_qimage(rgb: np.ndarray) -> QImage:
    if rgb.dtype != np.uint8 or rgb.ndim != 3 or rgb.shape[2] != 3:
        raise ValueError("expected H×W×3 uint8 RGB")
    data = np.ascontiguousarray(rgb)
    height, width = data.shape[:2]
    image = QImage(
        data.data, width, height, 3 * width, QImage.Format.Format_RGB888
    )
    # QImage does not own the buffer; hand back a deep copy.
    return image.copy()


def numpy_rgba_to_qimage(rgba: np.ndarray) -> QImage:
    if rgba.dtype != np.uint8 or rgba.ndim != 3 or rgba.shape[2] != 4:
        raise ValueError("expected H×W×4 uint8 RGBA")
    data = np.ascontiguousarray(rgba)
    height, width = data.shape[:2]
    image = QImage(
        data.data, width, height, 4 * width, QImage.Format.Format_RGBA8888
    )
    return image.copy()


def overlay_rgba(mask: np.ndarray, alpha: float = 0.35) -> np.ndarray:
    """Paint A-side of the mask in warm orange, B-side in cool blue."""
    m = np.clip(mask, 0.0, 1.0)
    strength = np.abs(m - 0.5) * 2.0
    rgba = np.zeros((*m.shape, 4), dtype=np.float32)
    warm = np.array([1.0, 0.55, 0.15], dtype=np.float32)
    cool = np.array([0.15, 0.45, 1.0], dtype=np.float32)
    side = (m >= 0.5)[..., None]
    rgb = np.where(side, warm, cool)
    rgba[..., :3] = rgb
    rgba[..., 3] = np.clip(strength * alpha, 0.0, 1.0)
    return np.clip(np.rint(rgba * 255.0), 0, 255).astype(np.uint8)


class ImageCanvas(QWidget):
    """Displays one image with optional mask overlay, zoom and painting."""

    picked = Signal(int, int)
    stroke_started = Signal()
    stroke_finished = Signal()
    paint_requested = Signal(float, float, float, float, float)  # x0,y0,x1,y1,target
    view_changed = Signal()
    zoom_changed = Signal(float)

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setMouseTracking(True)
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
        self.setMinimumSize(320, 240)
        self.setAttribute(Qt.WidgetAttribute.WA_OpaquePaintEvent, True)

        self._image: np.ndarray | None = None
        self._pixmap: QPixmap | None = None
        self._overlay: QImage | None = None  # image-resolution RGBA overlay
        self._overlay_rgba: np.ndarray | None = None
        self.transform = ViewTransform()
        self.fit_when_possible = True

        self.tool = TOOL_PAINT_A
        self.read_only = False
        self.brush_radius = 24.0
        self.softness = 0.5
        self.show_overlay = True

        self._painting = False
        self._last_point: tuple[float, float] | None = None
        self._cursor: tuple[float, float] | None = None
        self._drag_panning = False
        self._pan_start = QPointF()
        self._pan_origin = (0.0, 0.0)
        self._links: list["ImageCanvas"] = []
        self._syncing = False

    # -- linked views ----------------------------------------------------
    def link_view(self, other: "ImageCanvas") -> None:
        """Keep pan/zoom identical between two canvases of the same size."""
        if other is self or other in self._links:
            return
        self._links.append(other)
        other._links.append(self)

    def _sync_links(self) -> None:
        if self._syncing:
            return
        self._syncing = True
        try:
            for other in self._links:
                if other.image is None or self.image is None:
                    continue
                other.transform = ViewTransform(
                    self.transform.zoom,
                    self.transform.offset_x,
                    self.transform.offset_y,
                )
                other.fit_when_possible = self.fit_when_possible
                other.update()
        finally:
            self._syncing = False

    # -- content ---------------------------------------------------------
    def set_image(self, rgb: np.ndarray | None, *, keep_view: bool = False) -> None:
        if rgb is None:
            self._image = None
            self._pixmap = None
            self.update()
            return
        if (
            self._image is not None
            and keep_view
            and self._image.shape == rgb.shape
        ):
            self._image = np.ascontiguousarray(rgb)
            self._pixmap = QPixmap.fromImage(numpy_rgb_to_qimage(self._image))
            self.update()
            return
        self._image = np.ascontiguousarray(rgb)
        self._pixmap = QPixmap.fromImage(numpy_rgb_to_qimage(self._image))
        if not keep_view and self.fit_when_possible:
            self.fit_to_view()
        self.update()

    def set_overlay_mask(self, mask: np.ndarray | None) -> None:
        if mask is None:
            self._overlay_rgba = None
            self._overlay = None
        else:
            m = mask if mask.ndim == 2 else mask[..., 0]
            self._overlay_rgba = overlay_rgba(m)
            self._overlay = numpy_rgba_to_qimage(self._overlay_rgba)
        self.update()

    def overlay_mask_pixels(self) -> np.ndarray | None:
        return self._overlay_rgba

    @property
    def image(self) -> np.ndarray | None:
        return self._image

    def _rebuild_overlay_cache(self) -> None:
        # The overlay is kept at image resolution and scaled at paint time by
        # the painter, so there is no per-zoom pre-render to invalidate.
        return None

    # -- view ------------------------------------------------------------
    def _viewport(self) -> tuple[int, int]:
        return self.width(), self.height()

    def fit_to_view(self) -> None:
        if self._image is None:
            return
        height, width = self._image.shape[:2]
        avail_w = max(1, self.width() - 8)
        avail_h = max(1, self.height() - 8)
        zoom = min(avail_w / width, avail_h / height)
        zoom = max(MIN_ZOOM, min(MAX_ZOOM, zoom))
        self.transform.zoom = zoom
        self.transform.offset_x = (self.width() - width * zoom) / 2.0
        self.transform.offset_y = (self.height() - height * zoom) / 2.0
        self._rebuild_overlay_cache()
        self._emit_zoom()
        self.update()

    def set_zoom(self, zoom: float, anchor: tuple[float, float] | None = None) -> None:
        if self._image is None:
            return
        zoom = float(np.clip(zoom, MIN_ZOOM, MAX_ZOOM))
        if anchor is None:
            ax, ay = self.width() / 2.0, self.height() / 2.0
        else:
            ax, ay = anchor
        ix, iy = self.transform.widget_to_image(ax, ay)
        self.transform.zoom = zoom
        self.transform.offset_x = ax - ix * zoom
        self.transform.offset_y = ay - iy * zoom
        self.fit_when_possible = False
        self._rebuild_overlay_cache()
        self._emit_zoom()
        self.update()

    def zoom_by(self, factor: float, anchor: tuple[float, float] | None = None) -> None:
        self.set_zoom(self.transform.zoom * factor, anchor)

    def _emit_zoom(self) -> None:
        self.zoom_changed.emit(self.transform.zoom)
        self.view_changed.emit()
        self._sync_links()

    def center_on_image(self) -> None:
        if self._image is None:
            return
        height, width = self._image.shape[:2]
        zoom = self.transform.zoom
        self.transform.offset_x = (self.width() - width * zoom) / 2.0
        self.transform.offset_y = (self.height() - height * zoom) / 2.0
        self.update()

    # -- painting --------------------------------------------------------
    def paintEvent(self, event) -> None:  # noqa: N802 - Qt API
        painter = QPainter(self)
        painter.fillRect(self.rect(), QColor(24, 24, 28))
        if self._image is None or self._pixmap is None:
            painter.setPen(QColor(150, 150, 160))
            painter.drawText(
                self.rect(),
                Qt.AlignmentFlag.AlignCenter,
                "载入图 A 与图 B，或点击「示例图对」",
            )
            return

        height, width = self._image.shape[:2]
        zoom = self.transform.zoom
        target_w = max(1, int(round(width * zoom)))
        target_h = max(1, int(round(height * zoom)))
        painter.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform, False)
        painter.drawPixmap(
            int(round(self.transform.offset_x)),
            int(round(self.transform.offset_y)),
            target_w,
            target_h,
            self._pixmap,
        )

        if self._overlay is not None and self.show_overlay:
            painter.drawImage(
                QRectF(
                    self.transform.offset_x,
                    self.transform.offset_y,
                    float(target_w),
                    float(target_h),
                ),
                self._overlay,
            )

        self._draw_cursor(painter)

    def _draw_cursor(self, painter: QPainter) -> None:
        if self._cursor is None:
            return
        if self.read_only and self.tool != TOOL_PICK:
            return
        radius_px = self.brush_radius * self.transform.zoom
        cx, cy = self.transform.image_to_widget(*self._cursor)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        if self.tool == TOOL_PICK:
            pen = QPen(QColor(255, 255, 255, 230), 1, Qt.PenStyle.DashLine)
            painter.setPen(pen)
            painter.drawLine(QPointF(cx - 9, cy), QPointF(cx + 9, cy))
            painter.drawLine(QPointF(cx, cy - 9), QPointF(cx, cy + 9))
            return
        if self.tool == TOOL_PAINT_A:
            color = QColor(255, 160, 60, 230)
        elif self.tool == TOOL_PAINT_B:
            color = QColor(90, 160, 255, 230)
        else:
            color = QColor(220, 220, 220, 230)
        painter.setPen(QPen(QColor(0, 0, 0, 160), 3))
        painter.drawEllipse(QPointF(cx, cy), radius_px, radius_px)
        painter.setPen(QPen(color, 1.5))
        painter.drawEllipse(QPointF(cx, cy), radius_px, radius_px)
        if self.softness > 0.01:
            inner = radius_px * (1.0 - self.softness)
            painter.setPen(QPen(QColor(color.red(), color.green(), color.blue(), 90), 1))
            painter.drawEllipse(QPointF(cx, cy), inner, inner)

    # -- mouse -----------------------------------------------------------
    def _image_point(self, pos: QPointF) -> tuple[float, float]:
        return self.transform.widget_to_image(pos.x(), pos.y())

    def mousePressEvent(self, event: QMouseEvent) -> None:  # noqa: N802
        if self._image is None:
            return
        pos = event.position()
        if event.button() == Qt.MouseButton.MiddleButton or (
            event.button() == Qt.MouseButton.LeftButton
            and event.modifiers() & Qt.KeyboardModifier.ShiftModifier
        ):
            self._drag_panning = True
            self._pan_start = pos
            self._pan_origin = (self.transform.offset_x, self.transform.offset_y)
            self.setCursor(Qt.CursorShape.ClosedHandCursor)
            return
        if event.button() != Qt.MouseButton.LeftButton:
            return
        if self.tool == TOOL_PICK or self.read_only:
            ix, iy = self._image_point(pos)
            self.picked.emit(int(np.floor(ix)), int(np.floor(iy)))
            return
        target = _tool_target(self.tool)
        self._painting = True
        self.stroke_started.emit()
        ix, iy = self._image_point(pos)
        self._last_point = (ix, iy)
        self.paint_requested.emit(ix, iy, ix, iy, target)

    def mouseMoveEvent(self, event: QMouseEvent) -> None:  # noqa: N802
        if self._image is None:
            return
        pos = event.position()
        if self._drag_panning:
            delta = pos - self._pan_start
            self.transform.offset_x = self._pan_origin[0] + delta.x()
            self.transform.offset_y = self._pan_origin[1] + delta.y()
            self._sync_links()
            self.update()
            return
        ix, iy = self._image_point(pos)
        self._cursor = (ix, iy)
        if self._painting and self._last_point is not None:
            target = _tool_target(self.tool)
            x0, y0 = self._last_point
            self.paint_requested.emit(x0, y0, ix, iy, target)
            self._last_point = (ix, iy)
        else:
            self.update()

    def mouseReleaseEvent(self, event: QMouseEvent) -> None:  # noqa: N802
        if self._drag_panning:
            self._drag_panning = False
            self.setCursor(Qt.CursorShape.ArrowCursor)
            return
        if self._painting:
            self._painting = False
            self._last_point = None
            self.stroke_finished.emit()

    def leaveEvent(self, event) -> None:  # noqa: N802
        self._cursor = None
        self.update()

    def wheelEvent(self, event: QWheelEvent) -> None:  # noqa: N802
        if self._image is None:
            return
        delta = event.angleDelta().y()
        if delta == 0:
            return
        factor = ZOOM_STEP if delta > 0 else 1.0 / ZOOM_STEP
        pos = event.position()
        self.zoom_by(factor, (pos.x(), pos.y()))
        event.accept()


def _tool_target(tool: str) -> float:
    if tool == TOOL_PAINT_A:
        return 1.0
    if tool == TOOL_PAINT_B:
        return 0.0
    return 0.5
