"""样本叠图: 展示同一位置的若干样本之间的磨损与颜色差别。"""

from __future__ import annotations

from typing import List

from PySide6.QtCore import QRectF, Qt
from PySide6.QtGui import QColor, QPainter
from PySide6.QtWidgets import QSizePolicy, QWidget

from ..sampler import CellSample, overlay_samples
from .imageview import rgb_to_qimage


class SampleOverlay(QWidget):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setMinimumSize(240, 200)
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)
        self._image = None
        self._caption = ""
        self._stats_text = ""

    def set_samples(self, samples: List[CellSample], mode: str = "difference") -> None:
        if not samples:
            self._image = None
            self._caption = "没有可用的同位置样本"
            self.update()
            return
        try:
            rgb = overlay_samples(samples, mode=mode, gain=5.0)
        except ValueError as exc:
            self._image = None
            self._caption = f"无法叠图: {exc}"
            self.update()
            return
        self._image = rgb_to_qimage(rgb)
        self._caption = {
            "difference": "红=偏亮于中位样本, 蓝=偏暗 (磨损/色差)",
            "mean": "所有样本的直接平均",
            "checker": "样本棋盘拼图",
        }.get(mode, mode)
        self.update()

    def set_stats(self, stats: dict) -> None:
        if not stats or not stats.get("count"):
            self._stats_text = ""
        else:
            parts = [f"样本 {stats['count']} 个"]
            if "mean_pair_rms" in stats:
                parts.append(f"两两 RMS 差 均值 {stats['mean_pair_rms']:.3f}"
                             f" / 最大 {stats['max_pair_rms']:.3f}")
            self._stats_text = "   ".join(parts)
        self.update()

    def paintEvent(self, event) -> None:
        p = QPainter(self)
        p.fillRect(self.rect(), QColor(24, 26, 30))
        area = QRectF(6, 6, self.width() - 12, self.height() - 44)
        if self._image is None:
            p.setPen(QColor(160, 165, 175))
            p.drawText(self.rect(), Qt.AlignCenter, self._caption or "暂无叠图")
            return
        side = min(area.width(), area.height())
        rect = QRectF(area.left() + (area.width() - side) / 2,
                      area.top(), side, side)
        p.drawImage(rect, self._image)
        p.setPen(QColor(200, 205, 215))
        p.drawText(QRectF(6, rect.bottom() + 4, self.width() - 12, 20),
                   Qt.AlignHCenter, self._caption)
        p.setPen(QColor(150, 160, 175))
        p.drawText(QRectF(6, rect.bottom() + 22, self.width() - 12, 20),
                   Qt.AlignHCenter, self._stats_text)
        p.end()
