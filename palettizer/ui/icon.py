"""Tiny built-in application icon, drawn with Qt (no external assets)."""

from __future__ import annotations

import numpy as np
from PySide6.QtGui import QColor, QIcon, QImage, QPainter, QPen, QPixmap


def make_icon(size: int = 64) -> QIcon:
    image = QImage(size, size, QImage.Format_ARGB32_Premultiplied)
    image.fill(QColor(0, 0, 0, 0))
    p = QPainter(image)
    p.setRenderHint(QPainter.Antialiasing, False)
    # 8x8 pixel mosaic with a lighter lattice, deterministically generated.
    cell = size // 8
    rng = np.random.default_rng(13759)
    palette = [
        QColor(84, 160, 255),
        QColor(255, 196, 62),
        QColor(226, 46, 84),
        QColor(36, 44, 62),
        QColor(64, 208, 156),
    ]
    for y in range(8):
        for x in range(8):
            c = palette[int(rng.integers(len(palette)))]
            p.fillRect(x * cell, y * cell, cell, cell, c)
    p.setPen(QPen(QColor(12, 14, 20, 180), 1))
    for i in range(9):
        p.drawLine(i * cell, 0, i * cell, size)
        p.drawLine(0, i * cell, size, i * cell)
    p.end()
    return QIcon(QPixmap.fromImage(image))
