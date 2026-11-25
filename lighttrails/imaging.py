from __future__ import annotations

from pathlib import Path

import numpy as np
from PySide6.QtGui import QImage, QImageReader, QImageWriter


def qimage_to_rgb(image: QImage) -> np.ndarray:
    image = image.convertToFormat(QImage.Format.Format_RGB888)
    width = image.width()
    height = image.height()
    bytes_per_line = image.bytesPerLine()
    pointer = image.constBits()
    if pointer is None:
        raise RuntimeError("无法读取 QImage 像素内存")
    arr = np.frombuffer(pointer, dtype=np.uint8)
    if arr.size < bytes_per_line * height:
        raise RuntimeError("QImage 像素缓冲区大小异常")
    arr = arr[: bytes_per_line * height].reshape(height, bytes_per_line)
    rgb = arr[:, : width * 3].reshape(height, width, 3)
    return np.ascontiguousarray(rgb).copy()


def load_rgb(path: str | Path) -> np.ndarray:
    reader = QImageReader(str(path))
    reader.setAutoTransform(True)
    image = reader.read()
    if image.isNull():
        raise RuntimeError(f"无法读取图片: {path} ({reader.errorString()})")
    return qimage_to_rgb(image)


def rgb_to_qimage(rgb: np.ndarray) -> QImage:
    arr = np.ascontiguousarray(rgb, dtype=np.uint8)
    if arr.ndim != 3 or arr.shape[2] != 3:
        raise ValueError("rgb 必须是 H×W×3 数组")
    height, width = arr.shape[:2]
    image = QImage(arr.data, width, height, int(arr.strides[0]), QImage.Format.Format_RGB888)
    # The numpy array owns the buffer; copy so the QImage can outlive it.
    return image.copy()


def save_rgb(path: str | Path, rgb: np.ndarray, quality: int = 96) -> Path:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    image = rgb_to_qimage(rgb)
    writer = QImageWriter(str(target))
    suffix = target.suffix.lower().lstrip(".")
    if suffix:
        writer.setFormat(suffix.encode("ascii", errors="ignore"))
    writer.setQuality(quality)
    if not writer.write(image):
        raise RuntimeError(f"导出失败: {target} ({writer.errorString()})")
    return target
