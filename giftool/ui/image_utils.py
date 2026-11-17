"""numpy RGBA <-> Qt image conversions and small display helpers."""

from __future__ import annotations

import numpy as np
from PySide6.QtCore import QPoint
from PySide6.QtGui import QColor, QImage, QPainter, QPixmap


def numpy_to_qimage(rgba: np.ndarray) -> QImage:
    """Convert a contiguous HxWx4 uint8 RGBA array into a QImage (copied)."""
    rgba = np.ascontiguousarray(rgba, dtype=np.uint8)
    height, width = rgba.shape[:2]
    image = QImage(rgba.data, width, height, width * 4, QImage.Format.Format_RGBA8888)
    # copy() detaches from the numpy buffer whose lifetime is not guaranteed.
    return image.copy()


def numpy_to_pixmap(rgba: np.ndarray) -> QPixmap:
    return QPixmap.fromImage(numpy_to_qimage(rgba))


def checkerboard_pixmap(size: tuple[int, int], cell: int = 8) -> QPixmap:
    """Transparency-indicating checkerboard background."""
    width, height = size
    pixmap = QPixmap(width, height)
    pixmap.fill(QColor(255, 255, 255))
    painter = QPainter(pixmap)
    light = QColor(238, 238, 238)
    dark = QColor(200, 200, 200)
    for y in range(0, height, cell):
        for x in range(0, width, cell):
            color = dark if ((x // cell + y // cell) % 2) else light
            painter.fillRect(x, y, cell, cell, color)
    painter.end()
    return pixmap


def overlay_with_checker(rgba: np.ndarray, cell: int = 8) -> QPixmap:
    """Composite an RGBA frame over a checkerboard so transparency is visible."""
    height, width = rgba.shape[:2]
    base = checkerboard_pixmap((width, height), cell)
    painter = QPainter(base)
    painter.drawImage(QPoint(0, 0), numpy_to_qimage(rgba))
    painter.end()
    return base
