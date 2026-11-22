"""numpy RGBA 与 QImage/QPixmap 之间的转换。"""
from __future__ import annotations

import numpy as np
from PySide6.QtGui import QImage, QPixmap


def numpy_to_qimage(rgba) -> QImage:
    arr = np.ascontiguousarray(np.asarray(rgba, dtype=np.uint8))
    if arr.ndim != 3 or arr.shape[2] not in (3, 4):
        raise ValueError("需要 (H,W,3) 或 (H,W,4) uint8 数组")
    if arr.shape[2] == 3:
        alpha = np.full(arr.shape[:2] + (1,), 255, dtype=np.uint8)
        arr = np.concatenate([arr, alpha], axis=2)
    h, w = arr.shape[:2]
    # copy() 确保 numpy 缓冲区被 QImage 独立持有
    return QImage(arr.data, w, h, 4 * w,
                  QImage.Format.Format_RGBA8888).copy()


def numpy_to_pixmap(rgba) -> QPixmap:
    return QPixmap.fromImage(numpy_to_qimage(rgba))


def qimage_to_numpy(img: QImage):
    """支持 RGBA/RGB/带索引的 QImage, 返回 (H,W,4) uint8。"""
    img = img.convertToFormat(QImage.Format.Format_RGBA8888)
    w, h = img.width(), img.height()
    ptr = img.bits()
    ptr = bytes(ptr)
    arr = np.frombuffer(ptr, dtype=np.uint8).reshape(h, w, 4).copy()
    return arr
