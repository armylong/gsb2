"""剖面曲线视图 (纯 QPainter, 不引入 matplotlib 依赖)。

同一坐标系上叠加三路的 Y / Cb / Cr 或色度误差曲线, 图例区分采样模式。
所有值都是 8-bit 平面原始量纲 (Y 16-235, Cb/Cr 16-240)。
"""

from __future__ import annotations

import numpy as np
from PySide6.QtCore import Qt
from PySide6.QtGui import QColor, QPainter, QPen
from PySide6.QtWidgets import QWidget

from ..analysis import Profile
from ..color import MODES

MODE_COLORS = {
    "444": QColor(255, 255, 255),
    "422": QColor(255, 180, 40),
    "420": QColor(90, 170, 255),
}
CHANNELS = ("Y", "Cb", "Cr", "Cb_err", "Cr_err")


class ProfilePlot(QWidget):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.profile: Profile | None = None
        self.channel = "Y"
        self.setMinimumHeight(220)

    def set_profile(self, profile: Profile | None):
        self.profile = profile
        self.update()

    def set_channel(self, channel: str):
        if channel in CHANNELS:
            self.channel = channel
            self.update()

    def paintEvent(self, event):
        p = QPainter(self)
        p.fillRect(self.rect(), QColor(24, 26, 30))
        if self.profile is None:
            p.setPen(QColor(180, 180, 180))
            p.drawText(self.rect(), Qt.AlignmentFlag.AlignCenter,
                       "在画面上点击「设为水平/竖直剖面」后在此显示曲线")
            return

        prof = self.profile
        left, top, right, bottom = 64, 14, 16, 34
        plot_w = max(10, self.width() - left - right)
        plot_h = max(10, self.height() - top - bottom)
        n = len(prof.axis)

        is_err = self.channel.endswith("_err")
        y_max = 120 if is_err else 255

        # 网格 + 纵轴刻度
        p.setPen(QPen(QColor(70, 74, 82)))
        for v in range(0, y_max + 1, 16 if not is_err else 20):
            yy = bottom + plot_h - int(v / y_max * plot_h)
            p.drawLine(left, yy, left + plot_w, yy)
            p.setPen(QColor(150, 154, 160))
            p.drawText(4, yy - 6, 46, 14, Qt.AlignmentFlag.AlignRight, str(v))
            p.setPen(QPen(QColor(70, 74, 82)))

        # 横轴刻度 (像素坐标)
        p.setPen(QColor(150, 154, 160))
        ticks = min(12, n - 1)
        for i in range(ticks + 1):
            idx = round(i * (n - 1) / max(1, ticks))
            xx = left + int(idx / max(1, n - 1) * plot_w)
            p.drawLine(xx, bottom + plot_h, xx, bottom + plot_h + 5)
            p.drawText(xx - 20, bottom + plot_h + 8, 40, 20,
                       Qt.AlignmentFlag.AlignCenter, str(idx))

        orient_text = "水平" if prof.orientation == "h" else "竖直"
        p.drawText(left, 2, 300, 14, Qt.AlignmentFlag.AlignLeft,
                   f"{orient_text}剖面  位置={prof.position}  通道={self.channel}")

        # 曲线
        for mode in MODES:
            vals = prof.data[mode][self.channel]
            pen = QPen(MODE_COLORS[mode])
            pen.setWidth(2 if mode == "444" else 1)
            if mode == "444":
                pen.setStyle(Qt.PenStyle.SolidLine)
            elif mode == "422":
                pen.setStyle(Qt.PenStyle.DashLine)
            else:
                pen.setStyle(Qt.PenStyle.DotLine)
            p.setPen(pen)
            prev = None
            for i, v in enumerate(vals):
                xx = left + int(i / max(1, n - 1) * plot_w)
                yy = bottom + plot_h - int(min(v, y_max) / y_max * plot_h)
                if prev is not None:
                    p.drawLine(prev[0], prev[1], xx, yy)
                prev = (xx, yy)

        # 图例
        lx = left + plot_w - 150
        for i, mode in enumerate(MODES):
            yy = top + 2 + i * 16
            pen = QPen(MODE_COLORS[mode])
            pen.setWidth(2)
            p.setPen(pen)
            p.drawLine(lx, yy + 6, lx + 26, yy + 6)
            p.setPen(QColor(220, 220, 220))
            p.drawText(lx + 30, yy, 110, 14, Qt.AlignmentFlag.AlignLeft,
                       {"444": "4:4:4 基准", "422": "4:2:2", "420": "4:2:0"}[mode])
