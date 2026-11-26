"""numpy 数组与 QImage 之间的转换、图像文件读写（GUI 层专用）。

预览与导出共用 to_qimage / to_uint8 这一套颜色约定：
所有浮点 sRGB 图先按同一规则裁剪到 0-255 再转 8bit，
保证屏幕上看到的和导出的 PNG 完全一致。
"""

from __future__ import annotations

import numpy as np
from PySide6.QtGui import QImage

from ..srgb import clip_srgb


def qimage_to_array(image: QImage) -> np.ndarray:
    """QImage → HxWx3 uint8（RGB，去掉 alpha 与行填充字节）。"""
    img = image.convertToFormat(QImage.Format.Format_RGB888)
    w, h = img.width(), img.height()
    ptr = img.constBits()
    raw = np.frombuffer(bytes(ptr), dtype=np.uint8).reshape(h, img.bytesPerLine())
    return np.ascontiguousarray(raw[:, : 3 * w].reshape(h, w, 3))


def to_qimage(image: np.ndarray) -> tuple[QImage, np.ndarray]:
    """浮点/uint8 sRGB 数组 → (QImage, 越界裁剪掩码)。

    掩码 True 表示该像素原本超出 sRGB 可显示范围，已被压到 0 或 255。
    """
    arr = np.asarray(image, dtype=np.float64)
    if arr.ndim != 3 or arr.shape[2] != 3:
        raise ValueError("图像数组形状必须是 HxWx3")
    clipped, mask = clip_srgb(arr)
    uint8 = np.round(clipped).astype(np.uint8)
    h, w = uint8.shape[:2]
    qimg = QImage(uint8.data, w, h, 3 * w, QImage.Format.Format_RGB888).copy()
    return qimg, mask


def to_uint8(image: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """与 to_qimage 相同的裁剪规则，但直接返回 uint8 数组（导出用）。"""
    clipped, mask = clip_srgb(np.asarray(image, dtype=np.float64))
    return np.round(clipped).astype(np.uint8), mask


def load_image(path: str) -> np.ndarray:
    """读取常见图片格式为 HxWx3 uint8。"""
    img = QImage(path)
    if img.isNull():
        raise IOError(f"无法读取图片: {path}")
    return qimage_to_array(img)
