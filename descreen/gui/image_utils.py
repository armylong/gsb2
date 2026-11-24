"""numpy 数组与 QImage 互转、图片读写（只用 Qt，不引入额外依赖）。"""

from __future__ import annotations

import numpy as np
from PySide6.QtCore import Qt
from PySide6.QtGui import QImage, QImageReader


def ndarray_to_qimage(arr: np.ndarray) -> QImage:
    arr = np.ascontiguousarray(arr)
    h, w = arr.shape[:2]
    if arr.ndim == 2:
        img = QImage(arr.data, w, h, w, QImage.Format.Format_Grayscale8)
    elif arr.ndim == 3 and arr.shape[2] == 3:
        img = QImage(arr.data, w, h, 3 * w, QImage.Format.Format_RGB888)
    else:
        raise ValueError(f"不支持的数组形状: {arr.shape}")
    # copy 后就不依赖 numpy 缓冲区的生命周期
    return img.copy()


def qimage_to_ndarray(img: QImage) -> np.ndarray:
    if img.isGrayscale() and img.format() != QImage.Format.Format_Indexed8:
        g = img.convertToFormat(QImage.Format.Format_Grayscale8)
        w, h = g.width(), g.height()
        ptr = g.constBits()
        arr = np.frombuffer(ptr, np.uint8, w * h).reshape(h, w)
        return arr.copy()

    rgb = img.convertToFormat(QImage.Format.Format_RGB888)
    w, h = rgb.width(), rgb.height()
    ptr = rgb.constBits()
    arr = np.frombuffer(ptr, np.uint8, w * h * 3).reshape(h, w, 3)
    return arr.copy()


def load_image(path: str) -> np.ndarray:
    reader = QImageReader(path)
    reader.setAutoTransform(True)
    img = reader.read()
    if img.isNull():
        raise IOError(f"无法读取图片 {path}: {reader.errorString()}")
    return qimage_to_ndarray(img)


def save_image(arr: np.ndarray, path: str) -> None:
    img = ndarray_to_qimage(arr)
    if not img.save(path):
        raise IOError(f"保存失败: {path}")
