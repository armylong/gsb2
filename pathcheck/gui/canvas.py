"""Qt canvas: nearest-neighbour image view with boundary overlays."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from PySide6.QtCore import QPointF, QRectF, Qt, Signal
from PySide6.QtGui import QColor, QFont, QImage, QPainter, QPen, QPolygonF
from PySide6.QtWidgets import QSizePolicy, QWidget

from ..palette import component_colour, hole_colour


@dataclass
class OverlayRing:
    label: str
    comp_id: int
    kind: str
    index: int
    points: list[tuple[float, float]]
    border_spans: list[tuple[str, int, int]]
    selected: bool = False
    dropped: bool = False


class Canvas(QWidget):
    """Displays a mask plus optional ring overlays.

    Modes:
      * ``mask``  -- the imported/generated binary image
      * ``paths`` -- mask + ring polylines (default)
      * ``diff``  -- reference in grey, rebuilt-only in blue, missing in red
    """

    hovered = Signal(str)
    clicked = Signal(str)

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setMinimumSize(420, 360)
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)
        self.setMouseTracking(True)
        self.setFocusPolicy(Qt.StrongFocus)

        self._image = QImage()
        self._image_size = (1, 1)
        self._zoom = 1.0
        self._offset = QPointF(0, 0)
        self._panning = False
        self._last_pos = None

        self.mode = "paths"
        self.show_vertices = True
        self.show_labels = True
        self.show_border = True
        self.show_deviation = True
        self.rings: list[OverlayRing] = []
        self.deviation: dict | None = None
        self._pick_radius = 6.0

    # ---------------------------------------------------------------- data
    def set_image(self, rgb: np.ndarray) -> None:
        h, w = rgb.shape[:2]
        data = np.ascontiguousarray(rgb)
        new_size = (w, h)
        self._image = QImage(
            data.data, w, h, 3 * w, QImage.Format_RGB888
        ).copy()
        changed = new_size != self._image_size
        self._image_size = new_size
        if changed:
            self.fit()
        self.update()

    def set_rings(self, rings: list[OverlayRing], deviation: dict | None) -> None:
        self.rings = rings
        self.deviation = deviation
        self.update()

    def fit(self) -> None:
        w, h = self._image_size
        if w <= 0 or h <= 0:
            return
        zx = (self.width() - 24) / w
        zy = (self.height() - 24) / h
        self._zoom = max(0.5, min(zx, zy))
        self._center()
        self.update()

    def resizeEvent(self, event):
        super().resizeEvent(event)

    def one_to_one(self) -> None:
        self._zoom = 1.0
        self._center()
        self.update()

    def zoom_to(self, zoom: float) -> None:
        self._zoom = max(0.25, min(40.0, zoom))
        self.update()

    def _center(self) -> None:
        w, h = self._image_size
        self._offset = QPointF(
            (self.width() - w * self._zoom) / 2.0,
            (self.height() - h * self._zoom) / 2.0,
        )

    def set_deviation(self, dev: dict | None) -> None:
        self.deviation = dev
        self.update()

    def center_on(self, x: float, y: float) -> None:
        """Place image point (x, y) in the middle of the viewport."""
        self._offset = QPointF(
            self.width() / 2.0 - x * self._zoom,
            self.height() / 2.0 - y * self._zoom,
        )
        self.update()

    # -------------------------------------------------------------- mapping
    def _to_screen(self, x: float, y: float) -> QPointF:
        return QPointF(self._offset.x() + x * self._zoom,
                       self._offset.y() + y * self._zoom)

    def _to_image(self, p: QPointF) -> tuple[float, float]:
        return ((p.x() - self._offset.x()) / self._zoom,
                (p.y() - self._offset.y()) / self._zoom)

    # -------------------------------------------------------------- events
    def wheelEvent(self, event):
        before = self._to_image(event.position())
        factor = 1.25 if event.angleDelta().y() > 0 else 0.8
        self._zoom = max(0.25, min(40.0, self._zoom * factor))
        after = self._to_image(event.position())
        self._offset += QPointF(
            (after[0] - before[0]) * self._zoom,
            (after[1] - before[1]) * self._zoom,
        )
        self.update()

    def mousePressEvent(self, event):
        if event.button() in (Qt.MiddleButton, Qt.RightButton):
            self._panning = True
            self._last_pos = event.position()
        elif event.button() == Qt.LeftButton:
            label = self._ring_at(self._to_image(event.position()))
            if label:
                self.clicked.emit(label)

    def mouseMoveEvent(self, event):
        if self._panning and self._last_pos is not None:
            delta = event.position() - self._last_pos
            self._offset += delta
            self._last_pos = event.position()
            self.update()
            return
        label = self._ring_at(self._to_image(event.position()))
        if label:
            self.hovered.emit(label)

    def mouseReleaseEvent(self, event):
        if event.button() in (Qt.MiddleButton, Qt.RightButton):
            self._panning = False
            self._last_pos = None

    def _ring_at(self, p) -> str | None:
        best = None
        best_d = self._pick_radius / self._zoom
        for ring in self.rings:
            n = len(ring.points)
            for i in range(n):
                ax, ay = ring.points[i]
                bx, by = ring.points[(i + 1) % n]
                d = _segment_distance(p[0], p[1], ax, ay, bx, by)
                if d < best_d:
                    best_d = d
                    best = ring.label
        return best

    # --------------------------------------------------------------- paint
    def paintEvent(self, event):
        p = QPainter(self)
        p.fillRect(self.rect(), QColor(16, 17, 19))
        if self._image.isNull():
            p.setPen(QColor(200, 200, 200))
            p.drawText(self.rect(), Qt.AlignCenter, "载入图片或生成样例")
            return
        p.setRenderHint(QPainter.SmoothPixmapTransform, False)
        w, h = self._image_size
        target = QRectF(self._offset.x(), self._offset.y(),
                        w * self._zoom, h * self._zoom)
        p.drawImage(target, self._image)

        p.setRenderHint(QPainter.Antialiasing, True)
        self._draw_rings(p)
        self._draw_deviation(p)

    def _draw_rings(self, p: QPainter):
        if not self.rings:
            return
        font = QFont()
        font.setPointSizeF(max(7.0, min(11.0, self._zoom * 2.6)))
        p.setFont(font)
        for ring in self.rings:
            if ring.dropped:
                continue
            base = component_colour(ring.comp_id)
            col = QColor(*base)
            if ring.kind == "hole":
                col = QColor(*hole_colour(ring.comp_id, ring.index, base))
            elif ring.kind == "notch":
                col = QColor(*base).lighter(140)
            pen = QPen(col, 2.0 if ring.selected else 1.2)
            if ring.selected:
                pen.setStyle(Qt.SolidLine)
            p.setPen(pen)
            p.setBrush(Qt.NoBrush)          # rings are outlines, never fills
            poly = QPolygonF([self._to_screen(x, y) for x, y in ring.points])
            p.drawPolygon(poly)

            if self.show_border and ring.border_spans:
                p.setPen(QPen(QColor(255, 255, 255, 220), 3.0))
                self._draw_border_spans(p, ring)

            if self.show_vertices and len(ring.points) <= 600:
                p.setPen(Qt.NoPen)
                p.setBrush(QColor(0, 0, 0))
                for x, y in ring.points:
                    q = self._to_screen(x, y)
                    p.drawEllipse(q, 1.6, 1.6)
                p.setBrush(Qt.NoBrush)

            if self.show_labels:
                p.setPen(QColor(0, 0, 0))
                p.drawText(self._to_screen(*ring.points[0]) + QPointF(4, -4), ring.label)
                p.setPen(QColor(255, 255, 255))
                p.drawText(self._to_screen(*ring.points[0]) + QPointF(3, -5), ring.label)

    def _draw_border_spans(self, p: QPainter, ring: OverlayRing):
        for side, a, b in ring.border_spans:
            if side == "top":
                p.drawLine(self._to_screen(a, 0), self._to_screen(b, 0))
            elif side == "bottom":
                p.drawLine(self._to_screen(a, self._image_size[1]),
                           self._to_screen(b, self._image_size[1]))
            elif side == "left":
                p.drawLine(self._to_screen(0, a), self._to_screen(0, b))
            else:
                p.drawLine(self._to_screen(self._image_size[0], a),
                           self._to_screen(self._image_size[0], b))

    def _draw_deviation(self, p: QPainter):
        if not self.show_deviation or not self.deviation:
            return
        d = self.deviation
        if d["max_distance"] <= 1e-9:
            return
        x0, y0, x1, y1 = d["bbox"]
        r = QRectF(self._to_screen(x0, y0), self._to_screen(x1, y1))
        p.setPen(QPen(QColor(255, 210, 60), 1.2, Qt.DashLine))
        p.setBrush(Qt.NoBrush)
        p.drawRect(r)
        a = self._to_screen(*d["original_point"])
        b = self._to_screen(*d["simplified_point"])
        p.setPen(QPen(QColor(255, 210, 60), 2.0))
        p.drawLine(a, b)
        p.setBrush(QColor(255, 80, 80))
        p.drawEllipse(a, 4.0, 4.0)
        p.setBrush(QColor(80, 200, 255))
        p.drawEllipse(b, 4.0, 4.0)
        p.setPen(QColor(255, 230, 120))
        p.drawText(
            r.topLeft() + QPointF(3, -4),
            f"最大偏离 {d['max_distance']:.2f}px",
        )


def _segment_distance(px, py, ax, ay, bx, by) -> float:
    vx, vy = bx - ax, by - ay
    den = vx * vx + vy * vy
    if den == 0:
        return ((px - ax) ** 2 + (py - ay) ** 2) ** 0.5
    t = ((px - ax) * vx + (py - ay) * vy) / den
    t = max(0.0, min(1.0, t))
    return ((px - (ax + t * vx)) ** 2 + (py - (ay + t * vy)) ** 2) ** 0.5
