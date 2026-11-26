"""图像读写。

支持两类输入:
  1. .npy / .npz —— 任意 numpy 二维数组 (uint8/uint16/uint32/float...), 完整保留高位深
  2. Qt 能读的图片 (png/tif/bmp/...) —— 支持 Grayscale8 / Grayscale16 / Indexed8 /
     RGB / RGBA; 彩色图按指定通道 (r/g/b/亮度) 提取为单通道

注意: 本机 Qt 6.12 从 QBuffer(内存字节流) 读取图片会段错误, 因此这里一律走文件路径。
"""

from __future__ import annotations

import json
import os
from typing import Optional

import numpy as np
from PySide6.QtGui import QImage

from .model import BandData

_GRAY_FORMATS = {
    QImage.Format.Format_Grayscale8: (np.uint8, 1),
    QImage.Format.Format_Grayscale16: (np.uint16, 2),
}
_RGB_FORMATS = {
    QImage.Format.Format_RGB888: (3, 3),
    QImage.Format.Format_RGBA8888: (4, 4),
    QImage.Format.Format_BGR888: (3, 3),
}


def _qimage_to_2d(image: QImage, channel: str = "luminance") -> np.ndarray:
    """把 QImage 转成二维 numpy 数组, 处理行填充 (bytesPerLine)。"""
    fmt = image.format()

    if fmt in _GRAY_FORMATS:
        dtype, elemsize = _GRAY_FORMATS[fmt]
        h, w = image.height(), image.width()
        bpl = image.bytesPerLine()
        raw = np.frombuffer(image.constBits(), dtype=np.uint8)
        raw = raw[: bpl * h].reshape(h, bpl)
        raw = np.ascontiguousarray(raw[:, : w * elemsize])
        return raw.view(dtype).reshape(h, w).copy()

    if fmt == QImage.Format.Format_Indexed8:
        # 用调色板索引本身作为像素值 (索引图即单通道语义)
        h, w = image.height(), image.width()
        bpl = image.bytesPerLine()
        raw = np.frombuffer(image.constBits(), dtype=np.uint8)
        raw = raw[: bpl * h].reshape(h, bpl)
        return np.ascontiguousarray(raw[:, :w]).copy()

    if fmt in _RGB_FORMATS:
        channels, elemsize = _RGB_FORMATS[fmt]
        h, w = image.height(), image.width()
        bpl = image.bytesPerLine()
        raw = np.frombuffer(image.constBits(), dtype=np.uint8)
        raw = raw[: bpl * h].reshape(h, bpl)
        packed = np.ascontiguousarray(raw[:, : w * channels]).reshape(h, w, channels)
        if fmt == QImage.Format.Format_BGR888:
            packed = packed[:, :, ::-1]
        if channel in ("r", "g", "b"):
            idx = {"r": 0, "g": 1, "b": 2}[channel]
            return packed[:, :, idx].copy()
        # ITU-R 601-2 亮度
        lum = (
            packed[:, :, 0].astype(np.float32) * 0.299
            + packed[:, :, 1].astype(np.float32) * 0.587
            + packed[:, :, 2].astype(np.float32) * 0.114
        )
        return lum.round().astype(np.uint8)

    # 其它格式 (Mono 等) 统一转 RGBA8888 再提亮度
    return _qimage_to_2d(image.convertToFormat(QImage.Format.Format_RGBA8888), channel)


def build_valid_mask(data: np.ndarray, nodata: Optional[float]) -> np.ndarray:
    """根据无值配置生成有效像素掩码。

    nodata=None: 浮点数组自动把 NaN/Inf 当无值; 整数数组默认全部有效。
    nodata 给定: 等于该值的像素为无值 (浮点仍额外排除 NaN/Inf)。
    """
    if np.issubdtype(data.dtype, np.floating):
        valid = np.isfinite(data)
        if nodata is not None and np.isfinite(nodata):
            valid &= data != nodata
        return valid
    if nodata is None:
        return np.ones(data.shape, dtype=bool)
    return data != nodata


def load_band(
    path: str,
    name: Optional[str] = None,
    nodata: Optional[float] = None,
    channel: str = "luminance",
) -> BandData:
    """从文件加载一个单通道波段。"""
    if name is None:
        name = os.path.splitext(os.path.basename(path))[0]
    ext = os.path.splitext(path)[1].lower()

    if ext == ".npy":
        data = np.load(path, allow_pickle=False)
        if data.ndim != 2:
            raise ValueError(f"{path}: .npy 必须是二维数组, 实际 shape={data.shape}")
    elif ext == ".npz":
        with np.load(path, allow_pickle=False) as z:
            keys = list(z.keys())
            if len(keys) != 1:
                raise ValueError(f"{path}: .npz 需只含一个数组, 实际包含 {keys}")
            data = z[keys[0]]
        if data.ndim != 2:
            raise ValueError(f"{path}: .npz 数组必须是二维")
    else:
        image = QImage(path)  # 必须走文件路径, 见模块说明
        if image.isNull():
            raise ValueError(f"{path}: Qt 无法读取该图片")
        data = _qimage_to_2d(image, channel)

    valid = build_valid_mask(data, nodata)
    return BandData(name=name, data=data, valid=valid, source_path=path, nodata_value=nodata)


def save_rgba_png(path: str, rgba: np.ndarray) -> None:
    """把 RGBA uint8 渲染结果存成 PNG (全分辨率, 所见即所得)。"""
    if rgba.dtype != np.uint8 or rgba.ndim != 3 or rgba.shape[2] != 4:
        raise ValueError("save_rgba_png 需要 HxWx4 uint8 数组")
    h, w = rgba.shape[:2]
    image = QImage(rgba.tobytes(), w, h, 4 * w, QImage.Format.Format_RGBA8888).copy()
    if not image.save(path, "PNG"):
        raise OSError(f"写入 {path} 失败")


def save_gray_png(path: str, gray: np.ndarray) -> None:
    """把单通道 uint8 存成 8 位灰度 PNG。"""
    if gray.dtype != np.uint8 or gray.ndim != 2:
        raise ValueError("save_gray_png 需要二维 uint8 数组")
    h, w = gray.shape
    image = QImage(gray.tobytes(), w, h, w, QImage.Format.Format_Grayscale8).copy()
    if not image.save(path, "PNG"):
        raise OSError(f"写入 {path} 失败")


def save_band_npy(path: str, data: np.ndarray) -> None:
    np.save(path, data)


def save_settings_json(path: str, settings: dict) -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(settings, f, ensure_ascii=False, indent=2)


def load_settings_json(path: str) -> dict:
    with open(path, encoding="utf-8") as f:
        return json.load(f)
