"""A small 3-D gizmo showing the estimated normal and the light directions."""
from __future__ import annotations

import math

import numpy as np
from PySide6.QtCore import QPointF, QRectF, Qt
from PySide6.QtGui import QBrush, QColor, QFont, QPainter, QPen, QPolygonF
from PySide6.QtWidgets import QSizePolicy, QWidget

from .. import theme


class NormalGizmo(QWidget):
    """Camera-space view: x right, y up, z towards the viewer."""

    def __init__(self, parent=None):
        super().__init__(parent)
        self._normal = np.array([0.0, 0.0, 1.0])
        self._lights: list[np.ndarray] = []
        self._highlight: int | None = None
        self._enabled = True
        self.setMinimumSize(150, 150)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding)

    def set_normal(self, normal: np.ndarray | None) -> None:
        self._enabled = normal is not None
        if normal is not None:
            v = np.asarray(normal, dtype=np.float64).reshape(3)
            length = np.linalg.norm(v)
            if length > 1e-6:
                self._normal = v / length
        self.update()

    def set_lights(self, directions: np.ndarray | None,
                   highlight: int | None = None) -> None:
        self._lights = [] if directions is None else [np.asarray(d, dtype=np.float64) for d in directions]
        self._highlight = highlight
        self.update()

    # ------------------------------------------------------------------ paint
    def paintEvent(self, event):
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        painter.fillRect(self.rect(), QColor(theme.PANEL))

        centre = QPointF(self.width() / 2.0, self.height() / 2.0 + 6)
        radius = min(self.width(), self.height()) * 0.36

        # ground ring in the image plane
        painter.setPen(QPen(QColor(theme.BORDER), 1, Qt.PenStyle.DashLine))
        painter.drawEllipse(centre, radius, radius * 0.42)
        painter.drawEllipse(centre, radius, radius)
        painter.setPen(QPen(QColor("#2f3a50"), 1))
        painter.drawLine(QPointF(centre.x() - radius, centre.y()),
                         QPointF(centre.x() + radius, centre.y()))
        painter.drawLine(QPointF(centre.x(), centre.y() - radius),
                         QPointF(centre.x(), centre.y() + radius))

        font = QFont(self.font())
        font.setPointSize(8)
        painter.setFont(font)
        painter.setPen(QColor(theme.MUTED))
        painter.drawText(QPointF(centre.x() + radius + 2, centre.y() + 4), "+X")
        painter.drawText(QPointF(centre.x() - 6, centre.y() - radius - 4), "+Y")
        painter.drawText(QPointF(centre.x() + 6, centre.y() + radius * 0.42 + 12), "+Z 近")

        # lights
        for i, light in enumerate(self._lights):
            px = centre.x() + light[0] * radius
            py = centre.y() - light[1] * radius * 0.9 - light[2] * radius * 0.12
            colour = QColor(theme.WARN) if self._highlight == i else QColor("#8a94a8")
            painter.setPen(QPen(colour, 1))
            painter.setBrush(QBrush(colour))
            painter.drawEllipse(QPointF(px, py), 3.4, 3.4)

        if not self._enabled:
            painter.setPen(QColor(theme.MUTED))
            painter.drawText(self.rect(), Qt.AlignmentFlag.AlignBottom | Qt.AlignmentFlag.AlignHCenter,
                             "此像素没有有效法线")
            return

        n = self._normal
        tip = QPointF(centre.x() + n[0] * radius,
                      centre.y() - n[1] * radius - n[2] * radius * 0.12)
        tail = QPointF(centre.x(), centre.y())
        painter.setPen(QPen(QColor(theme.ACCENT), 2.4))
        painter.setBrush(QBrush(QColor(theme.ACCENT)))
        painter.drawLine(tail, tip)
        d = QPointF(tip.x() - tail.x(), tip.y() - tail.y())
        length = max(1e-6, math.hypot(d.x(), d.y()))
        ux, uy = d.x() / length, d.y() / length
        head = 7.0
        p1 = QPointF(tip.x() - ux * head + uy * head * 0.55,
                     tip.y() - uy * head - ux * head * 0.55)
        p2 = QPointF(tip.x() - ux * head - uy * head * 0.55,
                     tip.y() - uy * head + ux * head * 0.55)
        painter.drawPolygon(QPolygonF([tip, p1, p2]))

        az = math.degrees(math.atan2(n[1], n[0])) % 360.0
        tilt = math.degrees(math.acos(max(-1.0, min(1.0, n[2]))))
        painter.setPen(QColor(theme.TEXT))
        font.setPointSize(9)
        painter.setFont(font)
        painter.drawText(QRectF(0, self.height() - 34, self.width(), 16),
                         Qt.AlignmentFlag.AlignCenter,
                         f"n = ({n[0]:+.2f}, {n[1]:+.2f}, {n[2]:+.2f})")
        painter.setPen(QColor(theme.MUTED))
        painter.drawText(QRectF(0, self.height() - 18, self.width(), 16),
                         Qt.AlignmentFlag.AlignCenter,
                         f"方位 {az:.0f}° · 倾角 {tilt:.0f}°")
