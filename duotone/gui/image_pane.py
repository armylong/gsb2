"""图像显示面板：线性 RGB 或覆盖率灰度 -> QPixmap，点击发探针信号。"""

from __future__ import annotations

import numpy as np
from PySide6.QtCore import Qt, Signal
from PySide6.QtGui import QImage, QPixmap
from PySide6.QtWidgets import QLabel, QSizePolicy, QVBoxLayout, QWidget

from .. import color as C


def linrgb_to_qimage(rgb01: np.ndarray) -> QImage:
    srgb = (np.clip(C.rgb_to_srgb(rgb01), 0, 1) * 255 + 0.5).astype(np.uint8)
    h, w, _ = srgb.shape
    img = QImage(srgb.tobytes(), w, h, 3 * w, QImage.Format_RGB888).copy()
    return img


def coverage_to_qimage(cov01: np.ndarray) -> QImage:
    u8 = (np.clip(cov01, 0, 1) * 255 + 0.5).astype(np.uint8)
    h, w = u8.shape
    rgb = np.repeat(u8[:, :, None], 3, axis=2)
    return QImage(rgb.tobytes(), w, h, 3 * w, QImage.Format_RGB888).copy()


class ImagePane(QWidget):
    clickedAt = Signal(int, int)  # 图像坐标 (row, col)

    def __init__(self, title: str, parent=None):
        super().__init__(parent)
        self.title = title
        self._shape = (0, 0)
        self._qimg: QImage | None = None
        self.label_title = QLabel(title)
        self.label_img = QLabel("（无图像）")
        self.label_img.setAlignment(Qt.AlignCenter)
        self.label_img.setMinimumSize(220, 160)
        self.label_img.setStyleSheet("background:#f0f0f0; border:1px solid #ccc;")
        self.label_img.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)
        lay = QVBoxLayout(self)
        lay.setContentsMargins(2, 2, 2, 2)
        lay.addWidget(self.label_title)
        lay.addWidget(self.label_img, 1)

    def set_rgb(self, rgb01: np.ndarray) -> None:
        self._set(linrgb_to_qimage(rgb01), rgb01.shape[:2])

    def set_coverage(self, cov01: np.ndarray) -> None:
        self._set(coverage_to_qimage(cov01), cov01.shape)

    def _set(self, img: QImage, shape) -> None:
        self._shape = shape
        self._qimg = img
        self._rescale()

    def _rescale(self) -> None:
        if self._qimg is None:
            return
        self.label_img.setPixmap(QPixmap.fromImage(self._qimg).scaled(
            self.label_img.size(), Qt.KeepAspectRatio, Qt.SmoothTransformation))

    def resizeEvent(self, e):
        super().resizeEvent(e)
        self._rescale()

    def mousePressEvent(self, e):
        pm = self.label_img.pixmap()
        if pm is None or pm.isNull() or self._shape[0] == 0:
            return
        lp = self.label_img.mapFrom(self, e.position().toPoint())
        pw, ph = pm.width(), pm.height()
        if not (0 <= lp.x() < pw and 0 <= lp.y() < ph):
            return
        h, w = self._shape
        col = int(lp.x() / pw * w)
        row = int(lp.y() / ph * h)
        self.clickedAt.emit(row, col)
