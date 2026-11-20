"""Interactive zoom / pan canvas with brush, box-select and overlay rendering.

Coordinates
-----------
The canvas shows ``image`` (an original-resolution BGR array) scaled by ``zoom``
and translated by ``pan``.  Every mouse position is converted to *original image
coordinates* with :meth:`CanvasWidget.widget_to_image`, and every brush point is
stored in that space.  Rendering converts back with
:meth:`CanvasWidget.image_to_widget`.  Nothing is stored in widget pixels, so
painting while zoomed in lands on exactly the same original pixels as painting
at 100 % (requirement 1).  The tests exercise this round trip directly.

The view keeps a *display buffer*: the image with alpha preview, labels, box and
the live stroke composited into it.  That buffer is rendered 1:1 when zoom is a
power of two and all overlay drawing is done in image space, but since Qt scales
the whole pixmap uniformly, anti-aliasing offsets can never make the brush drift.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

import cv2
import numpy as np
from PySide6 import QtCore, QtGui, QtWidgets

from matting.constraints import BG, ERASE, FG, Stroke, Tool, draw_stroke_preview
from matting.engine import MattingResult
from matting.imageio import composite_on_backdrop

# Display buffers are BGR, so (B, G, R).  Foreground is warm, background is cool.
LABEL_COLORS = {
    FG: (64, 72, 255),    # red
    BG: (255, 170, 60),   # blue
    ERASE: (210, 210, 210),
}

MIN_ZOOM = 0.05
MAX_ZOOM = 32.0
ZOOM_STEPS = (0.125, 0.25, 0.333, 0.5, 0.667, 1.0, 1.5, 2.0, 3.0, 4.0, 6.0, 8.0, 12.0, 16.0, 24.0, 32.0)


@dataclass
class ViewState:
    zoom: float = 1.0
    # Widget offset of the image origin.
    pan: QtCore.QPointF = field(default_factory=lambda: QtCore.QPointF(0.0, 0.0))


class CanvasWidget(QtWidgets.QWidget):
    """Image canvas.  Emits signals for stroke/box gestures; owns no app state."""

    stroke_started = QtCore.Signal()
    stroke_finished = QtCore.Signal(object)  # Stroke (image coords)
    box_changed = QtCore.Signal(object)  # (x0, y0, x1, y1) or None
    zoom_changed = QtCore.Signal(float)
    cursor_moved = QtCore.Signal(int, int)  # image coords or -1, -1

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setMouseTracking(True)
        self.setFocusPolicy(QtCore.Qt.StrongFocus)
        self.setMinimumSize(320, 240)
        self.setSizePolicy(QtWidgets.QSizePolicy.Expanding, QtWidgets.QSizePolicy.Expanding)

        self._image: Optional[np.ndarray] = None
        self._result: Optional[MattingResult] = None
        self._labels: Optional[np.ndarray] = None
        self._box: Optional[tuple[int, int, int, int]] = None
        self._show_labels = True
        self._backdrop = "checker"
        self._view_mode = "original"  # original | alpha | composite
        self._interactive = True
        self._linked: list["CanvasWidget"] = []
        self._syncing = False
        self._zoom = 1.0
        self._pan = QtCore.QPointF(0.0, 0.0)
        self._fitted = False
        self._auto_fit = True
        self._pending_center: Optional[QtCore.QPointF] = None
        self._syncing_from: Optional["CanvasWidget"] = None

        # Interaction state.
        self._mode = "idle"  # idle | brush | box | pan
        self._tool = FG
        self._brush_radius = 12.0
        self._active_stroke: Optional[Stroke] = None
        self._box_anchor: Optional[QtCore.QPointF] = None
        self._box_preview: Optional[QtCore.QRectF] = None
        self._pan_anchor = QtCore.QPointF()
        self._pan_origin = QtCore.QPointF()
        self._space_down = False
        self._display_cache: Optional[np.ndarray] = None
        self._display_dirty = True
        self._cached_zoom = 1.0

    # ------------------------------------------------------------------ model
    def set_model(
        self,
        image: Optional[np.ndarray],
        labels: Optional[np.ndarray] = None,
        result: Optional[MattingResult] = None,
        box: Optional[tuple[int, int, int, int]] = None,
    ) -> None:
        new_image = image is not None
        self._image = image
        self._labels = labels
        self._result = result
        self._box = box
        self._display_dirty = True
        if new_image:
            self._active_stroke = None
            self._box_preview = None
            self._fitted = False
            self._auto_fit = True
            self.fit_to_window()
        else:
            self.update()

    def set_labels(self, labels: Optional[np.ndarray]) -> None:
        self._labels = labels
        self._invalidate()

    def set_result(self, result: Optional[MattingResult], box=None) -> None:
        self._result = result
        if box is not None:
            self._box = box
        self._invalidate()

    def set_box(self, box: Optional[tuple[int, int, int, int]]) -> None:
        self._box = box
        self._invalidate()

    def get_box(self) -> Optional[tuple[int, int, int, int]]:
        return self._box

    def set_tool(self, tool: int) -> None:
        self._tool = int(tool)
        self.update()

    def set_brush_radius(self, radius: float) -> None:
        self._brush_radius = max(1.0, float(radius))

    def set_show_labels(self, show: bool) -> None:
        self._show_labels = bool(show)
        self._invalidate()

    def set_backdrop(self, mode: str) -> None:
        self._backdrop = mode
        self._invalidate()

    def set_view_mode(self, mode: str) -> None:
        """'original' | 'alpha' | 'composite'."""
        self._view_mode = mode
        self._invalidate()

    def set_interactive(self, enabled: bool) -> None:
        self._interactive = bool(enabled)
        self.setCursor(QtCore.Qt.ArrowCursor if not enabled else QtCore.Qt.CrossCursor)

    def link_view(self, other: "CanvasWidget") -> None:
        """Synchronise zoom/pan with ``other`` (for side-by-side comparison)."""
        if other is self or other in self._linked:
            return
        self._linked.append(other)

    def center_image_point(self) -> QtCore.QPointF:
        """Image coordinate currently displayed at the widget centre."""
        return self.widget_to_image(QtCore.QPointF(self.width() / 2.0, self.height() / 2.0))

    def set_center_image_point(self, pt: QtCore.QPointF) -> None:
        if self.width() <= 1 or self.height() <= 1:
            self._pending_center = QtCore.QPointF(pt)
            return
        self._pan = QtCore.QPointF(
            self.width() / 2.0 - pt.x() * self._zoom,
            self.height() / 2.0 - pt.y() * self._zoom,
        )

    def _sync_zoom_pan(self) -> None:
        """Mirror zoom + the image point under the centre onto linked views.

        Copying the centre point (rather than the raw pan) keeps the three panes
        aligned even though they are different widths, which is what makes the
        side-by-side comparison trustworthy.
        """
        if self._syncing or not self._linked:
            return
        if self.width() <= 1 or self.height() <= 1:
            return
        self._syncing = True
        try:
            centre = self.center_image_point()
            for view in self._linked:
                view._zoom = self._zoom
                view.set_center_image_point(centre)
                view._invalidate()
                view.zoom_changed.emit(self._zoom)
        finally:
            self._syncing = False

    def has_image(self) -> bool:
        return self._image is not None

    @property
    def zoom(self) -> float:
        return self._zoom

    def _invalidate(self) -> None:
        self._display_dirty = True
        self.update()

    # -------------------------------------------------------------- transforms
    def widget_to_image(self, pt: QtCore.QPointF) -> QtCore.QPointF:
        return QtCore.QPointF((pt.x() - self._pan.x()) / self._zoom,
                              (pt.y() - self._pan.y()) / self._zoom)

    def image_to_widget(self, pt: QtCore.QPointF) -> QtCore.QPointF:
        return QtCore.QPointF(pt.x() * self._zoom + self._pan.x(),
                              pt.y() * self._zoom + self._pan.y())

    def _clamp_image_point(self, pt: QtCore.QPointF) -> QtCore.QPointF:
        assert self._image is not None
        h, w = self._image.shape[:2]
        return QtCore.QPointF(min(max(pt.x(), 0.0), w - 1e-6),
                              min(max(pt.y(), 0.0), h - 1e-6))

    # -------------------------------------------------------------------- zoom
    def fit_to_window(self) -> None:
        if self._image is None:
            return
        h, w = self._image.shape[:2]
        vw, vh = max(1, self.width()), max(1, self.height())
        margin = 16
        zoom = min((vw - margin * 2) / w, (vh - margin * 2) / h)
        self._zoom = max(MIN_ZOOM, min(MAX_ZOOM, zoom))
        self._pan = QtCore.QPointF((vw - w * self._zoom) / 2.0, (vh - h * self._zoom) / 2.0)
        self._fitted = True
        self.zoom_changed.emit(self._zoom)
        self._sync_zoom_pan()
        self._invalidate()

    def zoom_at(self, factor: float, anchor: Optional[QtCore.QPointF] = None) -> None:
        if self._image is None:
            return
        if anchor is None:
            anchor = QtCore.QPointF(self.width() / 2.0, self.height() / 2.0)
        old = self._zoom
        new = max(MIN_ZOOM, min(MAX_ZOOM, old * factor))
        if abs(new - old) < 1e-9:
            return
        self._auto_fit = False
        img_pt = self.widget_to_image(anchor)
        self._zoom = new
        self._pan = QtCore.QPointF(anchor.x() - img_pt.x() * new, anchor.y() - img_pt.y() * new)
        self.zoom_changed.emit(self._zoom)
        self._sync_zoom_pan()
        self._invalidate()

    def set_zoom_steps(self, direction: int) -> None:
        if self._image is None:
            return
        current = self._zoom
        if direction > 0:
            for z in ZOOM_STEPS:
                if z > current * 1.001:
                    self.zoom_at(z / current)
                    return
            self.zoom_at(MAX_ZOOM / current)
        else:
            for z in reversed(ZOOM_STEPS):
                if z < current * 0.999:
                    self.zoom_at(z / current)
                    return
            self.zoom_at(MIN_ZOOM / current)

    def actual_size(self) -> None:
        if self._image is not None:
            self._auto_fit = False
            self.zoom_at(1.0 / self._zoom)

    def pan_by(self, dx: float, dy: float) -> None:
        self._pan += QtCore.QPointF(dx, dy)
        self._sync_zoom_pan()
        self.update()

    # ---------------------------------------------------------------- rendering
    def _build_display(self) -> np.ndarray:
        """Compose the RGB display buffer in *image* resolution."""
        assert self._image is not None
        h, w = self._image.shape[:2]
        if self._view_mode == "original" or self._result is None:
            display = self._image.copy()
        elif self._view_mode == "alpha":
            # Same grayscale mapping the exported alpha PNG uses.
            display = cv2.cvtColor(
                np.clip(self._result.alpha * 255.0 + 0.5, 0, 255).astype(np.uint8),
                cv2.COLOR_GRAY2BGR,
            )
        else:
            # Keep the checker squares roughly constant on screen at any zoom.
            cell = int(round(16.0 / max(0.125, min(32.0, self._zoom))))
            display = composite_on_backdrop(
                self._result.foreground, self._result.alpha, self._backdrop,
                cell=max(4, min(64, cell)),
            )

        if self._show_labels and self._labels is not None and self._interactive:
            # Labels as a semi-transparent tint.
            overlay = display.copy()
            for label, color in LABEL_COLORS.items():
                if label == ERASE:
                    continue
                mask = self._labels == label
                if mask.any():
                    overlay[mask] = color
            cv2.addWeighted(overlay, 0.42, display, 0.58, 0, display)

        if self._active_stroke is not None:
            color = LABEL_COLORS.get(self._active_stroke.kind, (255, 255, 255))
            draw_stroke_preview(display, self._active_stroke, color_bgr=color, alpha=0.65)

        # Brush circle ghost is drawn in widget space (see paintEvent) because
        # it needs to follow the cursor without rebuilding the buffer.
        if self._box is not None and self._interactive:
            x0, y0, x1, y1 = self._box
            cv2.rectangle(display, (x0, y0), (x1 - 1, y1 - 1), (60, 220, 255), 2, cv2.LINE_AA)
            # Dim outside the box to make the crop obvious.
            border = np.zeros((h, w), np.uint8)
            border[y0:y1, x0:x1] = 1
            border_u8 = border.astype(bool)
            display[~border_u8] = (display[~border_u8] * 0.55).astype(np.uint8)

        if self._box_preview is not None:
            r = self._box_preview
            p0 = (int(round(r.left())), int(round(r.top())))
            p1 = (int(round(r.right())), int(round(r.bottom())))
            cv2.rectangle(display, p0, p1, (0, 255, 255), 2, cv2.LINE_AA)
        return np.ascontiguousarray(display)

    def _to_pixmap(self) -> QtGui.QPixmap:
        if self._display_dirty or self._display_cache is None:
            buf = self._build_display()
            rgb = cv2.cvtColor(buf, cv2.COLOR_BGR2RGB)
            h, w = rgb.shape[:2]
            qimg = QtGui.QImage(rgb.data, w, h, 3 * w, QtGui.QImage.Format_RGB888).copy()
            self._display_cache = qimg
            self._display_dirty = False
        qimg = self._display_cache
        assert isinstance(qimg, QtGui.QImage)
        return QtGui.QPixmap.fromImage(qimg)

    def paintEvent(self, event: QtGui.QPaintEvent) -> None:
        painter = QtGui.QPainter(self)
        try:
            self._paint(painter)
        finally:
            painter.end()

    def _paint(self, painter: QtGui.QPainter) -> None:
        painter.fillRect(self.rect(), QtGui.QColor(38, 40, 44))
        if self._image is None:
            painter.setPen(QtGui.QColor(150, 154, 160))
            hint = {
                "original": "打开一张 PNG / JPEG，或点击“生成样例”",
                "alpha": "计算后在这里查看透明度",
                "composite": "计算后在这里查看换底效果",
            }.get(self._view_mode, "")
            painter.drawText(self.rect(), QtCore.Qt.AlignCenter, hint)
            return

        pixmap = self._to_pixmap()
        painter.setRenderHint(QtGui.QPainter.SmoothPixmapTransform, self._zoom < 8.0)
        target = QtCore.QRectF(self._pan.x(), self._pan.y(),
                               pixmap.width() * self._zoom, pixmap.height() * self._zoom)
        painter.drawPixmap(target, pixmap, QtCore.QRectF(pixmap.rect()))

        # Brush cursor ring: radius is in image pixels, drawn in widget space.
        if self._mode == "brush" and self._active_stroke is None and self._interactive:
            pos = self.mapFromGlobal(QtGui.QCursor.pos())
            if self.rect().contains(pos):
                img_pt = self.widget_to_image(QtCore.QPointF(pos))
                c = self.image_to_widget(img_pt)
                r = self._brush_radius * self._zoom
                color = QtGui.QColor(255, 255, 255, 220)
                pen = QtGui.QPen(color, 1.2)
                painter.setPen(pen)
                painter.setBrush(QtCore.Qt.NoBrush)
                painter.drawEllipse(c, r, r)

    def resizeEvent(self, event: QtGui.QResizeEvent) -> None:
        super().resizeEvent(event)
        if self._image is not None and (not self._fitted or self._auto_fit):
            self.fit_to_window()
        else:
            self._sync_zoom_pan()

    # ------------------------------------------------------------------ input
    def _is_pan_modifier(self, event: QtGui.QMouseEvent) -> bool:
        return (
            event.button() == QtCore.Qt.MiddleButton
            or (event.buttons() & QtCore.Qt.MiddleButton)
            or self._space_down
            or (
                event.button() == QtCore.Qt.LeftButton
                and bool(event.modifiers() & QtCore.Qt.AltModifier)
            )
        )

    def mousePressEvent(self, event: QtGui.QMouseEvent) -> None:
        if self._image is None:
            return
        pos = event.position()
        if not self._interactive:
            if event.button() in (QtCore.Qt.LeftButton, QtCore.Qt.RightButton, QtCore.Qt.MiddleButton):
                self._mode = "pan"
                self._pan_anchor = pos
                self._pan_origin = QtCore.QPointF(self._pan)
                self.setCursor(QtCore.Qt.ClosedHandCursor)
                event.accept()
            return
        if self._is_pan_modifier(event):
            self._mode = "pan"
            self._pan_anchor = pos
            self._pan_origin = QtCore.QPointF(self._pan)
            self.setCursor(QtCore.Qt.ClosedHandCursor)
            event.accept()
            return
        if event.button() == QtCore.Qt.LeftButton:
            if self._tool == Tool.BOX:
                self._mode = "box"
                self._box_anchor = self._clamp_image_point(self.widget_to_image(pos))
                self._box_preview = QtCore.QRectF(self._box_anchor, self._box_anchor)
                self._invalidate()
            else:
                kind = {Tool.FG: FG, Tool.BG: BG, Tool.ERASE: ERASE}.get(self._tool, FG)
                self._mode = "brush"
                self._active_stroke = Stroke(kind=kind, radius=self._brush_radius)
                img_pt = self._clamp_image_point(self.widget_to_image(pos))
                self._active_stroke.append(img_pt.x(), img_pt.y())
                self.stroke_started.emit()
                self._invalidate()
            event.accept()
        elif event.button() == QtCore.Qt.RightButton:
            # Right-drag always pans.
            self._mode = "pan"
            self._pan_anchor = pos
            self._pan_origin = QtCore.QPointF(self._pan)
            self.setCursor(QtCore.Qt.ClosedHandCursor)
            event.accept()

    def mouseMoveEvent(self, event: QtGui.QMouseEvent) -> None:
        if self._image is None:
            return
        pos = event.position()
        img_pt = self.widget_to_image(pos)
        self.cursor_moved.emit(int(img_pt.x()), int(img_pt.y()))
        if self._mode == "pan":
            delta = pos - self._pan_anchor
            self._pan = self._pan_origin + delta
            self._sync_zoom_pan()
            self.update()
            return
        if self._mode == "brush" and self._active_stroke is not None:
            clamped = self._clamp_image_point(img_pt)
            if self._active_stroke.append(clamped.x(), clamped.y()):
                self._invalidate()
            return
        if self._mode == "box" and self._box_anchor is not None:
            img_pt = self._clamp_image_point(img_pt)
            self._box_preview = QtCore.QRectF(self._box_anchor, img_pt).normalized()
            self._invalidate()
            return
        if self._tool in (Tool.FG, Tool.BG, Tool.ERASE) and self._interactive:
            self.update()  # refresh brush cursor ring

    def mouseReleaseEvent(self, event: QtGui.QMouseEvent) -> None:
        if self._image is None:
            return
        if self._mode == "pan":
            self._mode = "idle"
            self.unsetCursor()
            event.accept()
            return
        if self._mode == "brush" and self._active_stroke is not None:
            stroke = self._active_stroke
            self._active_stroke = None
            self._mode = "idle"
            if stroke.points:
                self.stroke_finished.emit(stroke)
            self._invalidate()
            event.accept()
            return
        if self._mode == "box":
            self._mode = "idle"
            rect = self._box_preview
            self._box_preview = None
            anchor = self._box_anchor
            self._box_anchor = None
            if rect is not None and anchor is not None:
                x0 = int(round(min(rect.left(), rect.right())))
                y0 = int(round(min(rect.top(), rect.bottom())))
                x1 = int(round(max(rect.left(), rect.right())))
                y1 = int(round(max(rect.top(), rect.bottom())))
                if x1 > x0 + 2 and y1 > y0 + 2:
                    self.box_changed.emit((x0, y0, x1, y1))
                else:
                    self.box_changed.emit(None)
            self._invalidate()
            event.accept()

    def keyPressEvent(self, event: QtGui.QKeyEvent) -> None:
        if event.key() == QtCore.Qt.Key_Space:
            self._space_down = True
            self.setCursor(QtCore.Qt.OpenHandCursor)
            event.accept()
            return
        super().keyPressEvent(event)

    def keyReleaseEvent(self, event: QtGui.QKeyEvent) -> None:
        if event.key() == QtCore.Qt.Key_Space:
            self._space_down = False
            self.unsetCursor()
            event.accept()
            return
        super().keyReleaseEvent(event)

    def wheelEvent(self, event: QtGui.QWheelEvent) -> None:
        if self._image is None:
            return
        delta = event.angleDelta().y()
        if delta == 0:
            return
        factor = 1.15 if delta > 0 else 1 / 1.15
        self.zoom_at(factor, event.position())
        event.accept()

    def leaveEvent(self, event: QtCore.QEvent) -> None:
        self.cursor_moved.emit(-1, -1)
        super().leaveEvent(event)


__all__ = ["CanvasWidget", "LABEL_COLORS", "Tool", "MIN_ZOOM", "MAX_ZOOM"]
