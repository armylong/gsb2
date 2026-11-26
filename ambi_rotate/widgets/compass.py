"""方位罗盘: 输入方位(蓝)、旋转后结果(橙)、朝向箭头与双虚拟扬声器。

屏幕映射: 0° 在正上方(前), 逆时针为正, +90° 在左侧。
"""

from __future__ import annotations

import math

from PySide6.QtCore import Qt
from PySide6.QtGui import QColor, QFont, QPainter, QPen
from PySide6.QtWidgets import QWidget


def _xy(deg: float, r: float):
    a = math.radians(deg)
    return -r * math.sin(a), -r * math.cos(a)


class CompassWidget(QWidget):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setMinimumSize(260, 260)
        self._input_az: float | None = None
        self._yaw = 0.0
        self._angle = 90.0
        self._marker_degs: list[float] = []

    def set_input_azimuth(self, deg: float | None) -> None:
        self._input_az = None if deg is None else deg % 360.0
        self.update()

    def set_yaw(self, deg: float) -> None:
        self._yaw = deg % 360.0
        self.update()

    def set_speaker_angle(self, deg: float) -> None:
        self._angle = float(deg)
        self.update()

    def set_markers(self, degs: list[float]) -> None:
        self._marker_degs = [d % 360.0 for d in degs]
        self.update()

    def paintEvent(self, _ev):
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        p.fillRect(self.rect(), QColor("#1B1D23"))
        side = min(self.width(), self.height()) - 16
        cx, cy, r = self.width() / 2, self.height() / 2, side / 2
        p.translate(cx, cy)

        p.setPen(QPen(QColor("#555B66"), 1.5))
        p.drawEllipse(int(-r), int(-r), int(2 * r), int(2 * r))
        p.drawEllipse(int(-r * 0.62), int(-r * 0.62), int(2 * r * 0.62), int(2 * r * 0.62))

        # 刻度与方位字
        p.setPen(QColor("#8A9099"))
        f = QFont()
        f.setPointSize(9)
        p.setFont(f)
        for d in range(0, 360, 30):
            x1, y1 = _xy(d, r * 0.94)
            x2, y2 = _xy(d, r)
            p.setPen(QPen(QColor("#777"), 1))
            p.drawLine(int(x1), int(y1), int(x2), int(y2))
        for d, label in ((0, "前 0°"), (90, "左 90°"), (180, "后 180°"), (270, "右 270°")):
            x, y = _xy(d, r * 1.12)
            p.setPen(QColor("#AAA"))
            p.drawText(int(x) - 34, int(y) - 8, 68, 16,
                       Qt.AlignmentFlag.AlignCenter, label)

        # 朝向标记刻度
        p.setPen(QPen(QColor("#9CDCFE"), 2))
        for d in self._marker_degs:
            x1, y1 = _xy(d, r * 0.86)
            x2, y2 = _xy(d, r)
            p.drawLine(int(x1), int(y1), int(x2), int(y2))

        # 朝向箭头(世界坐标)
        x, y = _xy(self._yaw, r * 0.82)
        p.setPen(QPen(QColor("#FFD166"), 2))
        p.drawLine(0, 0, int(x), int(y))
        p.setBrush(QColor("#FFD166"))
        p.drawEllipse(int(x) - 4, int(y) - 4, 8, 8)

        # 虚拟扬声器(跟随头部, 世界坐标 yaw±φ)
        for deg, name, col in (
            (self._yaw + self._angle, "L", QColor("#7EE787")),
            (self._yaw - self._angle, "R", QColor("#FF9E64")),
        ):
            x, y = _xy(deg, r * 0.62)
            p.setBrush(col)
            p.setPen(Qt.PenStyle.NoPen)
            p.drawRect(int(x) - 7, int(y) - 7, 14, 14)
            p.setPen(QColor("#111"))
            p.drawText(int(x) - 7, int(y) - 7, 14, 14,
                       Qt.AlignmentFlag.AlignCenter, name)

        # 输入方位(外圈蓝点)
        if self._input_az is not None:
            x, y = _xy(self._input_az, r * 0.9)
            p.setBrush(QColor("#4C9BE8"))
            p.setPen(QPen(QColor("#BCD9FF"), 1.5))
            p.drawEllipse(int(x) - 6, int(y) - 6, 12, 12)
            # 旋转后结果(内圈橙点, 头坐标 az-yaw)
            res = (self._input_az - self._yaw) % 360.0
            x2, y2 = _xy(res, r * 0.42)
            p.setBrush(QColor("#FF9E40"))
            p.setPen(QPen(QColor("#FFD2B0"), 1.5))
            p.drawEllipse(int(x2) - 6, int(y2) - 6, 12, 12)
            p.setPen(QColor("#CCC"))
            p.drawText(int(x2) + 8, int(y2) - 4, 60, 14,
                       Qt.AlignmentFlag.AlignLeft, f"结果 {res:.0f}°")

        # 图例
        p.setPen(QColor("#CCC"))
        p.drawText(int(-r), int(r + 6), int(2 * r), 14,
                   Qt.AlignmentFlag.AlignHCenter,
                   "蓝=输入方位  橙=旋转后  黄=朝向  绿/橙方块=左/右虚拟扬声器")
        p.end()
