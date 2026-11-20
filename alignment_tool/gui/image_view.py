"""numpy 图像 <-> QPixmap 的转换与带缩放的显示控件。"""

from __future__ import annotations

import cv2
import numpy as np
from PySide6.QtCore import Qt
from PySide6.QtGui import QImage, QPixmap
from PySide6.QtWidgets import QLabel, QSizePolicy


def gray_to_qimage(img: np.ndarray) -> QImage:
    """uint8 灰度图 -> QImage（拷贝一份，避免 numpy 内存被回收）。"""
    if img.dtype != np.uint8:
        img = np.clip(img, 0, 255).astype(np.uint8)
    h, w = img.shape[:2]
    qimg = QImage(img.tobytes(), w, h, w, QImage.Format.Format_Grayscale8)
    return qimg.copy()


def color_to_qimage(img: np.ndarray) -> QImage:
    """uint8 BGR 或 RGB 彩色图 -> QImage。默认按 BGR（OpenCV 习惯）处理。"""
    if img.ndim == 2:
        return gray_to_qimage(img)
    rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    h, w, _ = rgb.shape
    qimg = QImage(rgb.tobytes(), w, h, 3 * w, QImage.Format.Format_RGB888)
    return qimg.copy()


def to_qpixmap(img: np.ndarray) -> QPixmap:
    if img.ndim == 2:
        return QPixmap.fromImage(gray_to_qimage(img))
    return QPixmap.fromImage(color_to_qimage(img))


class ImageView(QLabel):
    """保持宽高比缩放显示一张 QPixmap 的控件。"""

    def __init__(self, title: str = "", parent=None):
        super().__init__(parent)
        self.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.setMinimumSize(200, 160)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding)
        self.setStyleSheet("background-color:#1e1f22; color:#9aa0a6; font-size:12px;")
        self._title = title
        self._pixmap: QPixmap | None = None
        self.setText(f"{title}\n(暂无图像)")

    def set_image(self, img: np.ndarray | None) -> None:
        if img is None:
            self._pixmap = None
            self.setText(f"{self._title}\n(暂无图像)")
            return
        self._pixmap = to_qpixmap(img)
        self._update_scaled()

    def resizeEvent(self, event):  # noqa: N802 (Qt 命名)
        super().resizeEvent(event)
        self._update_scaled()

    def _update_scaled(self) -> None:
        if self._pixmap is None:
            return
        scaled = self._pixmap.scaled(
            self.size(),
            Qt.AspectRatioMode.KeepAspectRatio,
            Qt.TransformationMode.SmoothTransformation,
        )
        self.setPixmap(scaled)
