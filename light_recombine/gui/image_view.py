"""numpy 数组 <-> QImage/QPixmap 转换与缩放显示控件。"""

from __future__ import annotations

import numpy as np
from PySide6.QtCore import Qt, QPoint, Signal
from PySide6.QtGui import QImage, QPixmap, QPainter, QColor
from PySide6.QtWidgets import QWidget


def rgb8_to_qimage(arr: np.ndarray) -> QImage:
    """HxWx3 uint8 (sRGB) -> QImage, 拷贝一份避免引用被回收。"""
    if arr.dtype != np.uint8 or arr.ndim != 3 or arr.shape[2] != 3:
        raise ValueError("只接受 HxWx3 uint8 数组")
    h, w, _ = arr.shape
    cont = np.ascontiguousarray(arr)
    img = QImage(cont.data, w, h, 3 * w, QImage.Format.Format_RGB888)
    return img.copy()


def make_checker_pixmap(w: int, h: int, cell: int = 12) -> QPixmap:
    """缺失区域用棋盘格底纹提示, 区别于真实的黑色像素。"""
    pm = QPixmap(w, h)
    pm.fill(QColor(45, 45, 48))
    painter = QPainter(pm)
    light = QColor(72, 72, 76)
    for y in range(0, h, cell):
        for x in range(0, w, cell):
            if ((x // cell) + (y // cell)) % 2 == 0:
                painter.fillRect(x, y, cell, cell, light)
    painter.end()
    return pm


class ImageView(QWidget):
    """等比缩放显示一张 QPixmap, 并把鼠标位置换算回原图坐标。"""

    pixelHovered = Signal(int, int)   # 原图坐标 (x, y)
    pixelLeft = Signal()

    def __init__(self, parent=None):
        super().__init__(parent)
        self._pixmap: QPixmap | None = None
        self._overlay = ""
        self.setMinimumSize(320, 240)
        self.setMouseTracking(True)
        self.setStyleSheet("background: #1e1e20;")
        self._draw_rect = None

    def set_pixmap(self, pm: QPixmap | None):
        self._pixmap = pm
        self.update()

    def set_overlay_text(self, text: str):
        """在预览图上叠加提示 (例如缺失通道说明)。"""
        self._overlay = text
        self.update()

    def _layout(self):
        if self._pixmap is None or self._pixmap.isNull():
            return None
        pw, ph = self._pixmap.width(), self._pixmap.height()
        cw, ch = max(self.width(), 1), max(self.height(), 1)
        scale = min(cw / pw, ch / ph)
        dw, dh = max(int(pw * scale), 1), max(int(ph * scale), 1)
        ox = (cw - dw) // 2
        oy = (ch - dh) // 2
        return scale, ox, oy, dw, dh

    def paintEvent(self, event):
        painter = QPainter(self)
        painter.fillRect(self.rect(), QColor(30, 30, 32))
        if self._pixmap is None or self._pixmap.isNull():
            painter.setPen(QColor(150, 150, 150))
            painter.drawText(self.rect(), Qt.AlignmentFlag.AlignCenter,
                             "无可用通道\n请载入 npy 或打开内置示例")
            return
        layout = self._layout()
        if layout is None:
            return
        _, ox, oy, dw, dh = layout
        target = self._pixmap.scaled(
            dw, dh, Qt.AspectRatioMode.IgnoreAspectRatio,
            Qt.TransformationMode.SmoothTransformation)
        painter.drawPixmap(ox, oy, target)
        self._draw_rect = (ox, oy, dw, dh)
        if self._overlay:
            painter.setPen(QColor(255, 210, 150))
            font = painter.font()
            font.setPointSize(13)
            painter.setFont(font)
            painter.drawText(self.rect(),
                             Qt.AlignmentFlag.AlignCenter, self._overlay)

    def _to_image_coords(self, pos: QPoint) -> tuple[int, int] | None:
        layout = self._layout()
        if layout is None or self._pixmap is None:
            return None
        scale, ox, oy, dw, dh = layout
        if not (ox <= pos.x() < ox + dw and oy <= pos.y() < oy + dh):
            return None
        ix = int((pos.x() - ox) / scale)
        iy = int((pos.y() - oy) / scale)
        ix = min(max(ix, 0), self._pixmap.width() - 1)
        iy = min(max(iy, 0), self._pixmap.height() - 1)
        return ix, iy

    def mouseMoveEvent(self, event):
        coords = self._to_image_coords(event.position().toPoint())
        if coords is None:
            self.pixelLeft.emit()
        else:
            self.pixelHovered.emit(*coords)

    def leaveEvent(self, event):
        self.pixelLeft.emit()
