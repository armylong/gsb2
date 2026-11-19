"""sRGB / linear-light colour helpers.

The whole application uses one colour convention:

* 8-bit files are interpreted as sRGB encoded values (no ICC handling).
* All blending and pyramid decomposition happens on linear-light floats.
* Every visible colour and every exported PNG is converted back to sRGB.

Keeping these conversions in one place is what makes the preview, the probe
readout, the level inspector and the export use exactly the same numbers.
"""

from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np

# sRGB <-> linear-light transfer functions (IEC 61966-2-1).
_SRGB_LINEAR_CUT = 0.04045
_LINEAR_SRGB_CUT = 0.0031308


def srgb_to_linear(values: np.ndarray) -> np.ndarray:
    """Convert sRGB encoded [0, 1] values to linear light [0, 1]."""
    x = np.asarray(values, dtype=np.float32)
    out = np.empty_like(x, dtype=np.float32)
    low = x <= _SRGB_LINEAR_CUT
    out[low] = x[low] / 12.92
    high = ~low
    out[high] = np.power((x[high] + 0.055) / 1.055, 2.4)
    return out


def linear_to_srgb(values: np.ndarray) -> np.ndarray:
    """Convert linear-light [0, 1] values to sRGB encoded [0, 1]."""
    x = np.asarray(values, dtype=np.float32)
    out = np.empty_like(x, dtype=np.float32)
    low = x <= _LINEAR_SRGB_CUT
    out[low] = x[low] * 12.92
    high = ~low
    out[high] = 1.055 * np.power(x[high], 1.0 / 2.4) - 0.055
    return out


def rgb8_to_linear(rgb: np.ndarray) -> np.ndarray:
    """uint8 sRGB RGB image -> float32 linear-light RGB image."""
    if rgb.dtype != np.uint8:
        raise ValueError("rgb8_to_linear expects a uint8 array")
    return srgb_to_linear(rgb.astype(np.float32) / 255.0)


def linear_to_rgb8(linear: np.ndarray) -> np.ndarray:
    """float32 linear-light RGB -> uint8 sRGB RGB, rounded and clipped."""
    return np.clip(
        np.rint(linear_to_srgb(np.clip(linear, 0.0, 1.0)) * 255.0), 0, 255
    ).astype(np.uint8)


def linear_to_rgb8_float(linear: np.ndarray) -> np.ndarray:
    """Same as :func:`linear_to_rgb8` but returns float sRGB in [0, 1]."""
    return np.clip(linear_to_srgb(np.clip(linear, 0.0, 1.0)), 0.0, 1.0)


def luminance(linear_rgb: np.ndarray) -> np.ndarray:
    """Rec.709 luminance of linear-light RGB data (channels last)."""
    return (
        0.2126 * linear_rgb[..., 0]
        + 0.7152 * linear_rgb[..., 1]
        + 0.0722 * linear_rgb[..., 2]
    )


class ImageError(ValueError):
    """Raised when an image cannot be used as an input pair member."""


def _to_rgb8(data: np.ndarray) -> np.ndarray:
    if data.dtype == np.uint16:
        data = np.rint(data.astype(np.float32) / 257.0).astype(np.uint8)
    elif data.dtype != np.uint8:
        raise ImageError(f"不支持的像素类型: {data.dtype}")

    if data.ndim == 2:
        return np.repeat(data[..., None], 3, axis=2)
    if data.ndim != 3:
        raise ImageError("图像维度异常")

    channels = data.shape[2]
    if channels == 1:
        return np.repeat(data, 3, axis=2)
    if channels == 2:
        alpha = data[..., 1]
        if int(alpha.min()) < 255:
            raise ImageError("图像包含透明像素；本工具只接受不透明图像")
        return np.repeat(data[..., :1], 3, axis=2)
    if channels == 3:
        return data
    if channels == 4:
        alpha = data[..., 3]
        if int(alpha.min()) < 255:
            raise ImageError("图像包含透明像素；本工具只接受不透明图像")
        return np.ascontiguousarray(data[..., :3])
    raise ImageError(f"不支持的通道数: {channels}")


def load_rgb_image(path: str | Path, *, max_size: int = 1200) -> np.ndarray:
    """Load an opaque PNG/JPEG as an RGB uint8 array in sRGB.

    The file is decoded with ``IMREAD_UNCHANGED`` so that an alpha channel can
    be inspected instead of silently discarded.  Transparency is rejected;
    fully opaque alpha is fine.
    """
    path = Path(path)
    if not path.is_file():
        raise ImageError(f"文件不存在: {path}")
    raw = np.fromfile(str(path), dtype=np.uint8)
    if raw.size == 0:
        raise ImageError(f"无法读取空文件: {path.name}")
    decoded = cv2.imdecode(raw, cv2.IMREAD_UNCHANGED)
    if decoded is None:
        raise ImageError(f"不支持或已损坏的图片: {path.name}")

    rgb = _to_rgb8(decoded)
    height, width = rgb.shape[:2]
    if width < 1 or height < 1:
        raise ImageError("图像尺寸为空")
    if width > max_size or height > max_size:
        raise ImageError(
            f"图像尺寸 {width}×{height} 超出上限 {max_size}×{max_size}"
        )
    return np.ascontiguousarray(rgb)
