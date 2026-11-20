"""Canvas widget: zoomable / pannable view of the deformed image and mesh."""

from __future__ import annotations

import math

import numpy as np
from PySide6.QtCore import QPointF, QRectF, Qt, Signal
from PySide6.QtGui import (
    QColor,
    QFont,
    QImage,
    QPainter,
    QPen,
    QPolygonF,
)
from PySide6.QtWidgets import QWidget

from ..editor import Editor

def _ui_font(point_size: int = 11) -> QFont:
    """Platform UI font at a given size (resolved lazily, after QApplication)."""
    font = QFont()
    font.setPointSize(point_size)
    return font


def _qimage(rgba: np.ndarray) -> QImage:
    arr = np.ascontiguousarray(rgba)
    h, w = arr.shape[:2]
    img = QImage(arr.data, w, h, w * 4, QImage.Format_RGBA8888)
    return img.copy()


class CanvasWidget(QWidget):
    """Image + control-mesh view.

    All editing coordinates are image pixels.  Zoom and pan only change the
    view transform; hit testing divides by the zoom factor, so a point is
    clickable where it is drawn regardless of magnification.
    """

    pointSelected = Signal(int)
    pointDragStarted = Signal(int)
    pointDragged = Signal(float, float)
    pointDragFinished = Signal(bool)
    dragRejected = Signal(str)
    sampled = Signal(float, float)
    zoomChanged = Signal(float)
    statusMessage = Signal(str)

    def __init__(self, editor: Editor, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.editor = editor
        self.setMouseTracking(True)
        self.setFocusPolicy(Qt.StrongFocus)
        self.setMinimumSize(320, 240)
        self.setAutoFillBackground(True)

        self.zoom = 1.0
        self.pan = QPointF(0.0, 0.0)
        self._fit_pending = True
        self.selected: int | None = None
        self.hover: int | None = None
        self.dragging = False
        self.drag_offset = QPointF(0.0, 0.0)
        self._panning = False
        self._pan_anchor = QPointF()
        self._pan_start = QPointF()
        self._space_down = False
        self.sample_point: tuple[float, float] | None = None
        self.sample_covered: bool | None = None
        self.show_ghost = True
        self.show_last_rejection = True
        self._pending_labels: list[tuple[float, float, str, QColor]] = []
        self.show_mesh = True
        self.show_points = True
        self.show_labels = True
        self.show_rest = True
        self._image_cache: QImage | None = None
        self._preview_cache: QImage | None = None
        self._preview_scale = 1.0
        self._preview_array_id: int | None = None
        self._ghost_image: QImage | None = None
        self._demo_index: int | None = None
        self._demo_candidate: tuple[float, float] | None = None
        self._demo_report = None

    # -- view helpers ---------------------------------------------------------
    def image_size(self) -> tuple[int, int]:
        if not self.editor.has_document:
            return (0, 0)
        return self.editor.image.width, self.editor.image.height

    def fit_to_view(self) -> None:
        w, h = self.image_size()
        if w <= 0 or h <= 0:
            return
        if self.width() < 32 or self.height() < 32:
            # Layout has not happened yet; retry once the widget has a size.
            self._fit_pending = True
            return
        self._fit_pending = False
        margin = 28
        self.zoom = max(
            0.02,
            min((self.width() - margin) / w, (self.height() - margin) / h),
        )
        self.pan = QPointF(
            (self.width() - w * self.zoom) / 2.0,
            (self.height() - h * self.zoom) / 2.0,
        )
        self.zoomChanged.emit(self.zoom)
        self.update()

    def screen_to_image(self, pos: QPointF) -> QPointF:
        if self.zoom <= 0:
            return QPointF(0, 0)
        return QPointF(
            (pos.x() - self.pan.x()) / self.zoom,
            (pos.y() - self.pan.y()) / self.zoom,
        )

    def image_to_screen(self, x: float, y: float) -> QPointF:
        return QPointF(x * self.zoom + self.pan.x(), y * self.zoom + self.pan.y())

    def set_zoom(self, zoom: float, anchor: QPointF | None = None) -> None:
        zoom = float(max(0.03, min(32.0, zoom)))
        if anchor is None:
            anchor = QPointF(self.width() / 2.0, self.height() / 2.0)
        before = self.screen_to_image(anchor)
        self.zoom = zoom
        after = self.screen_to_image(anchor)
        self.pan += QPointF(
            (after.x() - before.x()) * self.zoom,
            (after.y() - before.y()) * self.zoom,
        )
        self.zoomChanged.emit(self.zoom)
        self.update()

    # -- caches ---------------------------------------------------------------
    def invalidate_image(self) -> None:
        self._image_cache = None
        self._preview_cache = None
        self._preview_array_id = None
        self._ghost_image = None
        self.update()

    def _full_image(self) -> QImage | None:
        if not self.editor.has_document:
            return None
        if self._image_cache is None:
            self._image_cache = _qimage(self.editor.render_full())
        return self._image_cache

    def _drag_image(self) -> tuple[QImage, float] | tuple[None, float]:
        if not self.editor.has_document:
            return None, 1.0
        preview, scale = self.editor.render_drag_preview()
        # The editor returns a fresh array per accepted drag position; rebuild
        # the QImage whenever the underlying buffer changes, otherwise the
        # canvas would freeze on the first preview frame.
        key = (id(preview), preview.shape, float(scale))
        if self._preview_cache is None or self._preview_array_id != key:
            self._preview_cache = _qimage(preview)
            self._preview_scale = scale
            self._preview_array_id = key
        return self._preview_cache, scale

    def _draw_source_sample(self, painter: QPainter) -> None:
        """Mark where the last sampled result position came from."""
        if self.sample_point is None or not self.editor.has_document:
            return
        sample = self.editor.sample(self.sample_point)
        if not sample.covered or sample.source is None:
            return
        inv = 1.0 / self.zoom
        sx, sy = sample.source
        painter.setBrush(Qt.NoBrush)
        painter.setPen(QPen(QColor(80, 255, 140), 1.4 * inv, Qt.DotLine))
        painter.drawEllipse(QPointF(sx, sy), 6 * inv, 6 * inv)
        self._pending_labels.append(
            (sx + 8 * inv, sy + 16 * inv, f"源 ({sx:.1f},{sy:.1f})", QColor(80, 255, 140, 235))
        )

    # -- painting -------------------------------------------------------------
    def paintEvent(self, event) -> None:  # noqa: N802 (Qt API)
        painter = QPainter(self)
        painter.setRenderHint(QPainter.Antialiasing, True)
        painter.setRenderHint(QPainter.SmoothPixmapTransform, True)
        self._draw_checkerboard(painter)

        if not self.editor.has_document:
            painter.setPen(QColor(150, 150, 150))
            painter.setFont(_ui_font(14))
            painter.drawText(self.rect(), Qt.AlignCenter, "载入 PNG 或生成测试图开始")
            return

        img_w, img_h = self.image_size()
        image_rect = QRectF(
            self.pan.x(), self.pan.y(), img_w * self.zoom, img_h * self.zoom
        )
        painter.setOpacity(1.0)
        if self.dragging:
            qimg, pscale = self._drag_image()
            if qimg is not None:
                painter.drawImage(
                    image_rect, qimg, QRectF(0, 0, qimg.width(), qimg.height())
                )
        else:
            qimg = self._full_image()
            if qimg is not None:
                painter.drawImage(image_rect, qimg, QRectF(0, 0, qimg.width(), qimg.height()))

        # Canvas boundary
        painter.setPen(QPen(QColor(70, 70, 70), 1, Qt.DashLine))
        painter.setBrush(Qt.NoBrush)
        painter.drawRect(image_rect)

        mesh = self.editor.mesh
        if mesh is None:
            return
        self._pending_labels.clear()
        painter.save()
        painter.translate(self.pan)
        painter.scale(self.zoom, self.zoom)
        self._draw_rest_image(painter, img_w, img_h)
        if self.show_mesh:
            self._draw_mesh(painter, mesh)
        self._draw_invalid_candidate(painter, mesh)
        self._draw_candidate_vertex(painter, mesh)
        if self.show_points:
            self._draw_points(painter, mesh)
        self._draw_source_sample(painter)
        self._draw_sample_marker(painter)
        painter.restore()
        if self.show_labels:
            self._draw_labels(painter, mesh)
        self._draw_floating_labels(painter)
        self._pending_labels.clear()

    def _draw_checkerboard(self, painter: QPainter) -> None:
        painter.fillRect(self.rect(), QColor(38, 38, 42))
        size = 16
        light = QColor(52, 52, 58)
        dark = QColor(43, 43, 48)
        for y in range(0, self.height(), size):
            for x in range(0, self.width(), size):
                painter.fillRect(
                    x, y, size, size, light if ((x // size + y // size) % 2 == 0) else dark
                )

    def _draw_rest_image(self, painter: QPainter, w: float, h: float) -> None:
        """Faint ghost of the source raster while a drag is in flight."""
        if not self.show_ghost or not self.dragging or self.editor.is_identity():
            return
        if not self.editor.has_document:
            return
        if self._ghost_image is None:
            self._ghost_image = _qimage(self.editor.image.rgba)
        painter.setOpacity(0.14)
        painter.drawImage(QRectF(0, 0, w, h), self._ghost_image)
        painter.setOpacity(1.0)

    def _draw_mesh(self, painter: QPainter, mesh) -> None:
        inv = 1.0 / self.zoom
        painter.setBrush(Qt.NoBrush)
        if not mesh.is_identity:
            pen = QPen(QColor(70, 210, 255, 190), 1.0 * inv)
            painter.setPen(pen)
            for tri in mesh.tris:
                poly = QPolygonF([QPointF(*mesh.dst[p]) for p in tri])
                painter.drawPolygon(poly)
        else:
            pen = QPen(QColor(120, 190, 220, 120), 1.0 * inv, Qt.DashLine)
            painter.setPen(pen)
            for tri in mesh.tris:
                poly = QPolygonF([QPointF(*mesh.src[p]) for p in tri])
                painter.drawPolygon(poly)

    def show_demo_rejection(self, index: int, candidate, report) -> None:
        """Draw a rejected candidate pose without modifying mesh or history."""
        self._demo_index = int(index)
        self._demo_candidate = (float(candidate[0]), float(candidate[1]))
        self._demo_report = report
        self._image_cache = None
        self.update()

    def clear_demo(self) -> None:
        if self._demo_index is None:
            return
        self._demo_index = None
        self._demo_candidate = None
        self._demo_report = None
        self.update()

    def _candidate_pose(self, mesh) -> np.ndarray | None:
        if self.dragging and self.editor.drag_index is not None:
            index = self.editor.drag_index
            candidate = self.editor.drag_candidate
            report = self.editor.drag_report
            if candidate is None or report is None:
                return None
        elif self._demo_index is not None:
            index = self._demo_index
            candidate = self._demo_candidate
            if candidate is None or self._demo_report is None:
                return None
        elif (
            self.editor.last_rejected_index is not None
            and self.editor.last_rejected_candidate is not None
            and self.editor.last_report is not None
            and self.show_last_rejection
        ):
            # After release, keep showing the refused geometry until the next
            # successful edit; the mesh itself was never modified.
            index = self.editor.last_rejected_index
            candidate = self.editor.last_rejected_candidate
        else:
            return None
        pose = mesh.dst.copy()
        pose[index] = candidate
        return pose

    def _draw_invalid_candidate(self, painter: QPainter, mesh) -> None:
        if self.dragging:
            report = self.editor.drag_report
        elif self._demo_index is not None:
            report = self._demo_report
        else:
            report = self.editor.last_report
        pose = self._candidate_pose(mesh)
        inv = 1.0 / self.zoom
        if report is None or pose is None or report.ok:
            return
        bad = report.bad_triangles
        for k in bad:
            poly = QPolygonF([QPointF(*pose[p]) for p in mesh.tris[int(k)]])
            painter.setPen(QPen(QColor(255, 70, 70, 230), 1.2 * inv))
            painter.setBrush(QColor(255, 50, 50, 70))
            painter.drawPolygon(poly)
        painter.setBrush(Qt.NoBrush)
        for a, b in report.crossings:
            for edge in (mesh.edges[int(a)], mesh.edges[int(b)]):
                painter.setPen(QPen(QColor(255, 60, 60, 240), 2.0 * inv))
                painter.drawLine(
                    QPointF(*pose[edge[0]]), QPointF(*pose[edge[1]])
                )
        if self.dragging:
            drag_candidate = self.editor.drag_candidate
        elif self._demo_index is not None:
            drag_candidate = self._demo_candidate
        else:
            drag_candidate = self.editor.last_rejected_candidate
        if drag_candidate is not None:
            cx, cy = drag_candidate
            r = 8 * inv
            painter.setPen(QPen(QColor(255, 80, 80), 2 * inv))
            painter.drawLine(QPointF(cx - r, cy - r), QPointF(cx + r, cy + r))
            painter.drawLine(QPointF(cx - r, cy + r), QPointF(cx + r, cy - r))
            # The label is drawn later in view space so it stays readable at
            # every zoom level.
            self._pending_labels.append(
                (cx + 12 * inv, cy - 10 * inv, "无效位置", QColor(255, 120, 120))
            )

    def _draw_candidate_vertex(self, painter: QPainter, mesh) -> None:
        """Always draw the in-flight drag handle, valid or rejected."""
        if self.dragging:
            candidate = self.editor.drag_candidate
            bad = self.editor.drag_report is not None
        elif self._demo_index is not None:
            candidate = self._demo_candidate
            bad = self._demo_report is not None
        else:
            candidate = self.editor.last_rejected_candidate
            bad = self.editor.last_report is not None
        if candidate is None:
            return
        inv = 1.0 / self.zoom
        x, y = candidate
        color = QColor(255, 80, 80) if bad else QColor(120, 255, 170)
        painter.setBrush(QColor(color.red(), color.green(), color.blue(), 60))
        painter.setPen(QPen(color, 1.8 * inv))
        painter.drawEllipse(QPointF(x, y), 6.0 * inv, 6.0 * inv)

    def _draw_points(self, painter: QPainter, mesh) -> None:
        inv = 1.0 / self.zoom
        radius = 4.5 * inv
        for idx in range(mesh.n_points):
            x, y = mesh.dst[idx]
            locked = bool(mesh.locked[idx])
            if locked:
                painter.setBrush(QColor(255, 170, 60))
                painter.setPen(QPen(QColor(70, 40, 0), 1.2 * inv))
            elif idx == self.selected:
                painter.setBrush(QColor(80, 255, 140))
                painter.setPen(QPen(QColor(10, 70, 35), 1.5 * inv))
            else:
                painter.setBrush(QColor(250, 250, 250))
                painter.setPen(QPen(QColor(20, 20, 20), 1.2 * inv))
            painter.drawEllipse(QPointF(x, y), radius, radius)
            if idx == self.selected:
                painter.setBrush(Qt.NoBrush)
                painter.setPen(QPen(QColor(80, 255, 140), 1.5 * inv))
                painter.drawEllipse(QPointF(x, y), radius * 2.1, radius * 2.1)

        # Original vs current position of the point being manipulated.
        active = self.editor.drag_index if self.dragging else self.selected
        if active is not None and self.show_rest:
            sx, sy = mesh.src[active]
            cx, cy = mesh.dst[active]
            if self.dragging and self.editor.drag_candidate is not None:
                cx, cy = self.editor.drag_candidate
            painter.setBrush(Qt.NoBrush)
            painter.setPen(QPen(QColor(255, 255, 255, 220), 1.4 * inv, Qt.DashLine))
            painter.drawEllipse(QPointF(sx, sy), radius * 1.6, radius * 1.6)
            painter.drawLine(QPointF(sx, sy), QPointF(cx, cy))
            self._pending_labels.append(
                (sx + 8 * inv, sy - 8 * inv, f"原 ({sx:.0f},{sy:.0f})", QColor(255, 255, 255, 230))
            )
            self._pending_labels.append(
                (cx + 8 * inv, cy + 14 * inv, f"现 ({cx:.0f},{cy:.0f})", QColor(120, 255, 170, 240))
            )


    def _draw_sample_marker(self, painter: QPainter) -> None:
        if self.sample_point is None:
            return
        inv = 1.0 / self.zoom
        x, y = self.sample_point
        color = QColor(80, 255, 140) if self.sample_covered else QColor(255, 90, 90)
        painter.setBrush(Qt.NoBrush)
        painter.setPen(QPen(color, 1.6 * inv))
        painter.drawEllipse(QPointF(x, y), 7 * inv, 7 * inv)
        painter.drawLine(QPointF(x - 10 * inv, y), QPointF(x + 10 * inv, y))
        painter.drawLine(QPointF(x, y - 10 * inv), QPointF(x, y + 10 * inv))

    def _draw_floating_labels(self, painter: QPainter) -> None:
        """Draw accumulated text labels at a fixed screen font size."""
        if not self._pending_labels:
            return
        painter.setFont(_ui_font(10))
        for x, y, text, color in self._pending_labels:
            painter.setPen(color)
            painter.drawText(self.image_to_screen(x, y), text)

    def _draw_labels(self, painter: QPainter, mesh) -> None:
        if not self.show_mesh:
            return
        painter.setFont(_ui_font(9))
        painter.setPen(QColor(240, 240, 240, 220))
        for idx in range(mesh.n_points):
            x, y = mesh.dst[idx]
            sp = self.image_to_screen(x, y)
            painter.drawText(QPointF(sp.x() + 6, sp.y() - 6), str(idx + 1))

    # -- hit testing ----------------------------------------------------------
    def _hit_point(self, image_pos: QPointF) -> int | None:
        if self.editor.mesh is None:
            return None
        mesh = self.editor.mesh
        best: tuple[float, int] | None = None
        # 10 screen pixels, converted to image units: zoom never changes what
        # is clickable on screen.
        tol = 10.0 / max(self.zoom, 1e-9)
        for idx in range(mesh.n_points):
            d = math.hypot(image_pos.x() - mesh.dst[idx][0], image_pos.y() - mesh.dst[idx][1])
            if d <= tol and (best is None or d < best[0]):
                best = (d, idx)
        return best[1] if best else None

    # -- interaction ----------------------------------------------------------
    def mousePressEvent(self, event) -> None:  # noqa: N802
        if not self.editor.has_document:
            return
        self.clear_demo()
        pos = event.position()
        image_pos = self.screen_to_image(pos)
        if (
            event.button() == Qt.MiddleButton
            or (event.button() == Qt.LeftButton and self._space_down)
        ):
            self._panning = True
            self._pan_anchor = pos
            self._pan_start = QPointF(self.pan)
            self.setCursor(Qt.ClosedHandCursor)
            return
        if event.button() != Qt.LeftButton:
            return
        # Alt+click always samples, even on top of a control point.
        force_sample = bool(event.modifiers() & Qt.AltModifier)
        hit = None if force_sample else self._hit_point(image_pos)
        if hit is None:
            img_w, img_h = self.image_size()
            if not (0.0 <= image_pos.x() <= img_w - 1 and 0.0 <= image_pos.y() <= img_h - 1):
                self.statusMessage.emit("点击位置在画布之外")
                return
            self.sample_point = (image_pos.x(), image_pos.y())
            self.sampled.emit(image_pos.x(), image_pos.y())
            self.update()
            return
        self.selected = hit
        self.pointSelected.emit(hit)
        mesh = self.editor.mesh
        assert mesh is not None
        if mesh.locked[hit]:
            self.statusMessage.emit(f"点 {hit + 1} 已锁定，不能拖动")
            self.update()
            return
        ok, msg = self.editor.begin_drag(hit)
        if not ok:
            self.statusMessage.emit(msg)
            return
        self.dragging = True
        self.drag_offset = QPointF(
            mesh.dst[hit][0] - image_pos.x(), mesh.dst[hit][1] - image_pos.y()
        )
        self.pointDragStarted.emit(hit)
        self.update()

    def mouseMoveEvent(self, event) -> None:  # noqa: N802
        if not self.editor.has_document:
            return
        pos = event.position()
        if self._panning:
            self.pan = self._pan_start + (pos - self._pan_anchor)
            self.update()
            return
        image_pos = self.screen_to_image(pos)
        if self.dragging and self.editor.drag_index is not None:
            x = round(image_pos.x() + self.drag_offset.x())
            y = round(image_pos.y() + self.drag_offset.y())
            feedback = self.editor.drag_to(float(x), float(y))
            self.pointDragged.emit(float(x), float(y))
            if not feedback.accepted and feedback.message:
                self.dragRejected.emit(feedback.message)
            self.update()
            return
        hit = self._hit_point(image_pos)
        if hit != self.hover:
            self.hover = hit
            self.setCursor(Qt.OpenHandCursor if hit is not None else Qt.CrossCursor)
            self.update()

    def mouseReleaseEvent(self, event) -> None:  # noqa: N802
        if self._panning and event.button() in (Qt.MiddleButton, Qt.LeftButton):
            self._panning = False
            self.setCursor(Qt.CrossCursor)
            return
        if event.button() != Qt.LeftButton or not self.dragging:
            return
        self.dragging = False
        committed = self.editor.end_drag()
        self.pointDragFinished.emit(committed)
        self.update()

    def mouseDoubleClickEvent(self, event) -> None:  # noqa: N802
        if event.button() != Qt.LeftButton or not self.editor.has_document:
            return
        image_pos = self.screen_to_image(event.position())
        hit = self._hit_point(image_pos)
        if hit is None:
            return
        self.selected = hit
        self.pointSelected.emit(hit)
        if not self.editor.mesh.locked[hit]:
            self.editor.set_point_locked(hit, True)
            self.statusMessage.emit(f"点 {hit + 1} 已锁定（双击解锁）")
        else:
            self.editor.set_point_locked(hit, False)
            self.statusMessage.emit(f"点 {hit + 1} 已解锁")
        self.pointDragFinished.emit(False)
        self.update()

    def wheelEvent(self, event) -> None:  # noqa: N802
        if not self.editor.has_document:
            return
        delta = event.angleDelta().y()
        if delta == 0:
            return
        factor = math.pow(1.0015, delta)
        self.set_zoom(self.zoom * factor, event.position())
        event.accept()

    def keyPressEvent(self, event) -> None:  # noqa: N802
        if event.key() == Qt.Key_Space:
            self._space_down = True
            self.setCursor(Qt.OpenHandCursor)
            return
        if event.key() == Qt.Key_Escape and self.dragging:
            self.dragging = False
            self.editor.cancel_drag()
            self.pointDragFinished.emit(False)
            self.update()
            return
        super().keyPressEvent(event)

    def keyReleaseEvent(self, event) -> None:  # noqa: N802
        if event.key() == Qt.Key_Space:
            self._space_down = False
            self.setCursor(Qt.CrossCursor)
            return
        super().keyReleaseEvent(event)

    def resizeEvent(self, event) -> None:  # noqa: N802
        super().resizeEvent(event)
        if self._fit_pending and self.editor.has_document:
            self.fit_to_view()
