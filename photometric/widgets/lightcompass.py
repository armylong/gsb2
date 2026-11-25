"""Wheel-style control for setting a light's azimuth/elevation graphically."""
from __future__ import annotations

import math

from PySide6.QtCore import QPointF, QRectF, Qt, Signal
from PySide6.QtGui import QBrush, QColor, QFont, QPainter, QPen, QRadialGradient
from PySide6.QtWidgets import QSizePolicy, QWidget

from .. import theme


class LightCompass(QWidget):
    """Drag the dot to set azimuth (angle) and elevation (distance).

    The disc is a top-down view of the light hemisphere: the centre is a light
    straight in front of the camera (90° elevation), the rim is grazing.
    """

    changed = Signal(float, float)          # azimuth, elevation

    def __init__(self, azimuth: float = 45.0, elevation: float = 45.0, parent=None):
        super().__init__(parent)
        self._az = float(azimuth) % 360.0
        self._el = float(max(0.0, min(90.0, elevation)))
        self._dragging = False
        self.setMinimumSize(64, 64)
        self.setMaximumSize(140, 140)
        self.setSizePolicy(QSizePolicy.Policy.Fixed, QSizePolicy.Policy.Fixed)
        self.setCursor(Qt.CursorShape.CrossCursor)
        self.setToolTip("拖动圆点设置光照方向：角度 = 方位角，离圆心距离 = 仰角（圆心为正对镜头）")

    def azimuth(self) -> float:
        return self._az

    def elevation(self) -> float:
        return self._el

    def set_direction(self, azimuth: float, elevation: float, emit: bool = False) -> None:
        az = float(azimuth) % 360.0
        el = float(max(0.0, min(90.0, elevation)))
        if abs(az - self._az) < 1e-6 and abs(el - self._el) < 1e-6:
            return
        self._az, self._el = az, el
        self.update()
        if emit:
            self.changed.emit(self._az, self._el)

    # ------------------------------------------------------------------ mouse
    def _centre_radius(self) -> tuple[QPointF, float]:
        side = min(self.width(), self.height())
        radius = side * 0.44
        return QPointF(self.width() / 2.0, self.height() / 2.0), radius

    def _point_for(self, az: float, el: float) -> QPointF:
        centre, radius = self._centre_radius()
        r = radius * (1.0 - el / 90.0)
        a = math.radians(az)
        return QPointF(centre.x() + r * math.cos(a), centre.y() - r * math.sin(a))

    def _update_from(self, pos: QPointF) -> None:
        centre, radius = self._centre_radius()
        dx = pos.x() - centre.x()
        dy = centre.y() - pos.y()
        r = math.hypot(dx, dy)
        az = math.degrees(math.atan2(dy, dx)) % 360.0
        el = max(0.0, min(90.0, 90.0 * (1.0 - min(1.0, r / max(1e-6, radius)))))
        self._az, self._el = az, el
        self.update()
        self.changed.emit(self._az, self._el)

    def mousePressEvent(self, event):
        if event.button() == Qt.MouseButton.LeftButton:
            self._dragging = True
            self._update_from(event.position())
            event.accept()
            return
        super().mousePressEvent(event)

    def mouseMoveEvent(self, event):
        if self._dragging:
            self._update_from(event.position())
            event.accept()
            return
        super().mouseMoveEvent(event)

    def mouseReleaseEvent(self, event):
        if event.button() == Qt.MouseButton.LeftButton and self._dragging:
            self._dragging = False
            event.accept()
            return
        super().mouseReleaseEvent(event)

    def mouseDoubleClickEvent(self, event):
        self.set_direction(0.0, 90.0, emit=True)

    # ------------------------------------------------------------------ paint
    def paintEvent(self, event):
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        centre, radius = self._centre_radius()
        disc = QRectF(centre.x() - radius, centre.y() - radius, 2 * radius, 2 * radius)

        gradient = QRadialGradient(centre, radius)
        gradient.setColorAt(0.0, QColor("#26304a"))
        gradient.setColorAt(1.0, QColor("#141a26"))
        painter.setBrush(QBrush(gradient))
        painter.setPen(QPen(QColor(theme.BORDER), 1.2))
        painter.drawEllipse(disc)

        # cross axes with compass letters
        painter.setPen(QPen(QColor("#2f3a50"), 1, Qt.PenStyle.DashLine))
        painter.drawLine(QPointF(centre.x() - radius, centre.y()),
                         QPointF(centre.x() + radius, centre.y()))
        painter.drawLine(QPointF(centre.x(), centre.y() - radius),
                         QPointF(centre.x(), centre.y() + radius))
        if self.width() >= 100:
            painter.setPen(QColor(theme.MUTED))
            font = QFont(self.font())
            font.setPointSize(8)
            painter.setFont(font)
            painter.drawText(QRectF(centre.x() + radius - 14, centre.y() - 14, 14, 14),
                             Qt.AlignmentFlag.AlignCenter, "右")
            painter.drawText(QRectF(centre.x() + 2, centre.y() - radius, 14, 14),
                             Qt.AlignmentFlag.AlignCenter, "上")

        painter.setPen(QPen(QColor(theme.ACCENT), 1.2))
        painter.setBrush(Qt.BrushStyle.NoBrush)
        inner = radius * 0.33
        painter.drawEllipse(centre, inner, inner)

        dot = self._point_for(self._az, self._el)
        glow = QRadialGradient(dot, 12)
        glow.setColorAt(0.0, QColor(255, 232, 150, 220))
        glow.setColorAt(1.0, QColor(255, 232, 150, 0))
        painter.setPen(Qt.PenStyle.NoPen)
        painter.setBrush(QBrush(glow))
        painter.drawEllipse(dot, 12, 12)
        painter.setPen(QPen(QColor("#0d1017"), 1))
        painter.setBrush(QColor("#ffe28a"))
        painter.drawEllipse(dot, 5.0, 5.0)

        if self.width() >= 100:
            painter.setPen(QColor(theme.TEXT))
            font = QFont(self.font())
            font.setPointSize(9)
            painter.setFont(font)
            painter.drawText(QRectF(4, self.height() - 20, self.width() - 8, 16),
                             Qt.AlignmentFlag.AlignCenter,
                             f"方位 {self._az:.0f}°  仰角 {self._el:.0f}°")
