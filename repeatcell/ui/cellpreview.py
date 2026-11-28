"""单元预览: 把选定的平行四边形拉成规则单元格, 标出缺口与可换用的完整单元。"""

from __future__ import annotations

from typing import List

import numpy as np
from PySide6.QtCore import QRectF, Qt, Signal
from PySide6.QtGui import QColor, QImage, QPainter, QPen
from PySide6.QtWidgets import QSizePolicy, QWidget

from ..sampler import CellSample
from .imageview import rgb_to_qimage


class CellPreview(QWidget):
    """显示 1~4 个单元预览 (当前单元 + 图内完整单元备选)。"""

    cellClicked = Signal(int)

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setMinimumSize(260, 260)
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)
        self.tiles: List[CellSample] = []
        self.labels: List[str] = []
        self.active = 0
        self._qimages: List[QImage] = []
        self.setMouseTracking(True)

    def set_cells(self, tiles: List[CellSample], labels: List[str],
                  active: int = 0) -> None:
        self.tiles = tiles
        self.labels = labels
        self.active = active
        self._qimages = []
        for s in tiles:
            self._qimages.append(self._make_image(s))
        self.setMouseTracking(True)
        self.update()

    def _make_image(self, s: CellSample) -> QImage:
        rgb = np.clip(s.rgb, 0.0, 1.0).copy()
        if not s.valid.all():
            # 缺口画成洋红斜纹, 一眼能看出哪里没有真实像素
            yy, xx = np.mgrid[0:rgb.shape[0], 0:rgb.shape[1]]
            stripes = ((yy + xx) // 4) % 2 == 0
            gap = s.valid == 0
            rgb[gap & stripes] = np.array([0.95, 0.15, 0.65])
            rgb[gap & ~stripes] = np.array([0.55, 0.05, 0.38])
        return rgb_to_qimage(rgb)

    def _tile_rects(self) -> List[QRectF]:
        n = max(1, len(self.tiles))
        cols = 2 if n > 1 else 1
        rows = int(np.ceil(n / cols))
        pad = 8.0
        cw = (self.width() - pad * (cols + 1)) / cols
        ch = (self.height() - pad * (rows + 1)) / rows
        side = max(24.0, min(cw, ch))
        rects = []
        for idx in range(n):
            r, c = divmod(idx, cols)
            x = pad + c * (side + pad)
            y = pad + r * (side + pad)
            rects.append(QRectF(x, y, side, side))
        return rects

    def paintEvent(self, event) -> None:
        p = QPainter(self)
        p.fillRect(self.rect(), QColor(24, 26, 30))
        if not self.tiles:
            p.setPen(QColor(160, 165, 175))
            p.drawText(self.rect(), Qt.AlignCenter, "选定单元后在这里预览")
            return
        rects = self._tile_rects()
        for idx, rect in enumerate(rects):
            if idx >= len(self._qimages):
                break
            is_active = idx == self.active
            border = QPen(QColor(255, 210, 90) if is_active
                          else QColor(120, 130, 145), 2.0 if is_active else 1.0)
            p.setPen(border)
            p.drawRect(rect.adjusted(-1, -1, 1, 1))
            p.drawImage(rect, self._qimages[idx])
            label = self.labels[idx] if idx < len(self.labels) else ""
            if label:
                p.setPen(QColor(220, 225, 235))
                fm = p.fontMetrics()
                text_rect = QRectF(rect.left(), rect.bottom() + 2,
                                   rect.width(), fm.height() + 2)
                p.drawText(text_rect, Qt.AlignHCenter | Qt.AlignTop, label)
        p.end()

    def mousePressEvent(self, event) -> None:
        rects = self._tile_rects()
        pos = event.position()
        for idx, rect in enumerate(rects):
            if idx < len(self.tiles) and rect.contains(pos):
                self.active = idx
                self.update()
                self.cellClicked.emit(idx)
                return
