"""Loading binary PNGs without a Qt dependency."""
from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image


class MaskLoadError(RuntimeError):
    pass


def load_mask_png(path: str | Path) -> np.ndarray:
    """Read a PNG as a boolean foreground mask (non-zero / non-transparent)."""
    path = Path(path)
    try:
        with Image.open(path) as im:
            im.load()
            if im.mode in ("I", "I;16", "I;16B", "I;16L", "F"):
                arr = np.asarray(im, dtype=np.float64)
                return arr > 0
            if im.mode == "1":
                return np.asarray(im, dtype=bool)
            if im.mode == "P":
                im = im.convert("RGBA")
            arr = np.asarray(im)
    except FileNotFoundError as exc:
        raise MaskLoadError(f"文件不存在: {path}") from exc
    except Exception as exc:  # PIL raises a wide range of errors
        raise MaskLoadError(f"无法读取图片 {path.name}: {exc}") from exc

    if arr.ndim == 3 and arr.shape[2] in (2, 4):
        alpha = arr[..., -1]
        rgb = arr[..., :3].astype(np.int32)
        return ((rgb.max(axis=2) > 0) & (alpha > 0))
    if arr.ndim == 3:
        return arr.any(axis=2)
    if arr.ndim == 2:
        return arr > 0
    raise MaskLoadError(f"{path.name} 不是可识别的二值图像")


def save_mask_png(mask: np.ndarray, path: str | Path) -> Path:
    """Write a boolean mask as an 8-bit grayscale PNG (255 = foreground)."""
    path = Path(path)
    arr = (np.asarray(mask, dtype=bool) * 255).astype(np.uint8)
    Image.fromarray(arr, mode="L").save(path)
    return path
