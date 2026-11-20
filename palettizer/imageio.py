"""Image loading with the size limit enforced, and alpha-only helpers."""

from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image, UnidentifiedImageError

MAX_SIDE = 256


class ImageLoadError(RuntimeError):
    pass


def load_image(path: str | Path) -> np.ndarray:
    """Load a PNG into (H, W, 4) uint8 without resampling.

    The original pixel dimensions are kept exactly: no resize happens here.
    Refuses non-PNG input and anything larger than 256 px on either side, so
    the renderer's assumptions hold.
    """
    path = Path(path)
    try:
        with Image.open(path) as im:
            if im.format != "PNG":
                raise ImageLoadError(f"仅支持 PNG，当前文件格式为 {im.format or '未知'}")
            w, h = im.size
            if w <= 0 or h <= 0:
                raise ImageLoadError("图像尺寸无效")
            if w > MAX_SIDE or h > MAX_SIDE:
                raise ImageLoadError(f"图像尺寸 {w}x{h} 超过 {MAX_SIDE}px 上限")
            im.load()
            rgba = im.convert("RGBA")
            arr = np.array(rgba, dtype=np.uint8)
    except FileNotFoundError:
        raise ImageLoadError(f"找不到文件：{path}") from None
    except UnidentifiedImageError:
        raise ImageLoadError("无法识别的图片文件") from None
    except OSError as exc:
        raise ImageLoadError(f"读取图片失败：{exc}") from None
    return np.ascontiguousarray(arr)
