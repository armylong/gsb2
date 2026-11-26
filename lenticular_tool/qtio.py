"""QImage <-> numpy RGBA 转换、PNG 读写、DPI 元数据。"""
from __future__ import annotations

from pathlib import Path

import numpy as np
from PySide6 import QtGui

from .params import LensParams


def qimage_to_rgba(img: QtGui.QImage) -> np.ndarray:
    """转成连续的 uint8 RGBA 数组 (H, W, 4)。"""
    if img.format() != QtGui.QImage.Format.Format_RGBA8888:
        img = img.convertToFormat(QtGui.QImage.Format.Format_RGBA8888)
    w, h = img.width(), img.height()
    bpl = img.bytesPerLine()
    mv = img.bits()
    arr = np.frombuffer(mv, dtype=np.uint8)
    if bpl == w * 4:
        return arr.reshape(h, w, 4).copy()
    # 行跨度可能有对齐填充
    return arr.reshape(h, bpl)[:, : w * 4].reshape(h, w, 4).copy()


def rgba_to_qimage(arr: np.ndarray) -> QtGui.QImage:
    """uint8 RGBA 数组 -> 独立持有的 QImage(拷贝)。"""
    arr = np.ascontiguousarray(arr, dtype=np.uint8)
    h, w = arr.shape[:2]
    if arr.ndim != 3 or arr.shape[2] != 4:
        raise ValueError("需要 (H, W, 4) RGBA 数组")
    img = QtGui.QImage(arr.data, w, h, 4 * w,
                       QtGui.QImage.Format.Format_RGBA8888)
    return img.copy()  # 脱离 arr 内存


def load_png_rgba(path: str | Path) -> np.ndarray:
    p = Path(path)
    img = QtGui.QImage(str(p))
    if img.isNull():
        raise ValueError(f"无法读取 PNG: {p}")
    return qimage_to_rgba(img)


def save_png(arr: np.ndarray, path: str | Path, dpi: float | None = None) -> Path:
    """无损保存原像素 PNG; 可选写入印刷 DPI(phys chunk)。"""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    img = rgba_to_qimage(arr)
    if dpi and dpi > 0:
        ppm = int(round(dpi / 0.0254))  # dots per meter
        img.setDotsPerMeterX(ppm)
        img.setDotsPerMeterY(ppm)
    ok = img.save(str(path), "PNG")
    if not ok:
        raise OSError(f"保存 PNG 失败: {path}")
    return path


def save_qimage_png(img: QtGui.QImage, path: str | Path,
                    dpi: float | None = None) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if dpi and dpi > 0:
        ppm = int(round(dpi / 0.0254))
        img.setDotsPerMeterX(ppm)
        img.setDotsPerMeterY(ppm)
    ok = img.save(str(path), "PNG")
    if not ok:
        raise OSError(f"保存 PNG 失败: {path}")
    return path


def scaled_for_preview(arr: np.ndarray, max_side: int) -> np.ndarray:
    """仅用于屏幕显示的缩小副本(平滑缩放), 绝不参与导出。"""
    h, w = arr.shape[:2]
    longest = max(h, w)
    if longest <= max_side:
        return arr
    img = rgba_to_qimage(arr)
    img2 = img.scaled(max_side, max_side,
                      aspectMode=QtGui.Qt.AspectRatioMode.KeepAspectRatio,
                      mode=QtGui.Qt.TransformationMode.SmoothTransformation)
    return qimage_to_rgba(img2)
