"""BGR numpy 图像与 Qt 图像之间的转换。"""

from __future__ import annotations

import cv2
import numpy as np
from PySide6.QtGui import QImage, QPixmap


def bgr_to_qpixmap(frame_bgr: np.ndarray) -> QPixmap:
    if frame_bgr is None or frame_bgr.size == 0:
        return QPixmap()
    rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
    h, w, ch = rgb.shape
    # bytesPerLine 显式给出，避免连续内存假设出问题
    img = QImage(rgb.data, w, h, ch * w, QImage.Format.Format_RGB888).copy()
    return QPixmap.fromImage(img)
