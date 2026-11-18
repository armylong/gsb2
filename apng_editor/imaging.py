"""Image helpers shared by the GUI and tests (Pillow/numpy only)."""

from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image, UnidentifiedImageError


class TileLoadError(ValueError):
    """Raised when an imported tile cannot be used."""


def load_rgba_png(path: str | Path) -> np.ndarray:
    """Load a normal PNG and return an independent 8-bit RGBA array."""

    path = Path(path)
    try:
        with Image.open(path) as image:
            image.load()
            rgba = image.convert("RGBA")
    except FileNotFoundError as exc:
        raise TileLoadError(f"找不到文件：{path}") from exc
    except UnidentifiedImageError as exc:
        raise TileLoadError(f"无法识别该图片：{path.name}") from exc
    except OSError as exc:
        raise TileLoadError(f"读取图片失败：{exc}") from exc
    array = np.array(rgba, dtype=np.uint8, copy=True)
    if array.ndim != 3 or array.shape[2] != 4:
        raise TileLoadError("导入的图片无法转换为 RGBA")
    return array


def checkerboard(
    width: int,
    height: int,
    cell: int = 8,
    light: int = 204,
    dark: int = 153,
) -> np.ndarray:
    """Return an opaque RGB checkerboard used only as a UI backdrop."""

    if width <= 0 or height <= 0:
        raise ValueError("棋盘格尺寸必须为正")
    cell = max(1, int(cell))
    yy = (np.arange(height)[:, None] // cell) % 2
    xx = (np.arange(width)[None, :] // cell) % 2
    mask = (yy ^ xx).astype(bool)
    board = np.empty((height, width, 3), dtype=np.uint8)
    board[...] = light
    board[mask] = dark
    return board


def flatten_on_checker(pixels: np.ndarray, cell: int = 8) -> np.ndarray:
    """Composite an RGBA array over a checkerboard for display only."""

    rgba = np.asarray(pixels, dtype=np.uint8)
    if rgba.ndim != 3 or rgba.shape[2] != 4:
        raise ValueError("需要 RGBA 图像")
    height, width = rgba.shape[:2]
    base = checkerboard(width, height, cell=cell)
    alpha = rgba[..., 3:4].astype(np.float32) / 255.0
    out = rgba[..., :3].astype(np.float32) * alpha + base.astype(np.float32) * (
        1.0 - alpha
    )
    return np.clip(np.rint(out), 0, 255).astype(np.uint8)


def generate_tile(seed: int, size: int = 48) -> tuple[np.ndarray, str]:
    """Create a deterministic, recognisable RGBA tile (program-generated)."""

    rng = np.random.default_rng(seed * 7919 + 13)
    size = max(8, min(int(size), 128))
    yy, xx = np.mgrid[0:size, 0:size]
    palette = [
        (232, 84, 72),
        (66, 133, 244),
        (52, 168, 83),
        (251, 188, 5),
        (171, 71, 188),
        (0, 172, 193),
    ]
    base = palette[seed % len(palette)]
    other = palette[(seed * 3 + 2) % len(palette)]
    mix = (xx + yy) / max(1, 2 * size - 2)
    rgb = np.zeros((size, size, 3), dtype=np.float32)
    for channel in range(3):
        rgb[..., channel] = base[channel] * (1 - mix) + other[channel] * mix
    noise = rng.normal(0, 10, size=(size, size, 1))
    rgb = np.clip(rgb + noise, 0, 255)

    alpha = np.full((size, size), 215.0, dtype=np.float32)
    border = max(2, size // 16)
    alpha[:border, :] = 255
    alpha[-border:, :] = 255
    alpha[:, :border] = 255
    alpha[:, -border:] = 255
    # A transparent notch makes partial transparency obvious in the UI.
    notch = size // 4
    alpha[size - notch :, size - notch :] = 96

    tile = np.empty((size, size, 4), dtype=np.uint8)
    tile[..., :3] = np.rint(rgb).astype(np.uint8)
    tile[..., 3] = np.rint(alpha).astype(np.uint8)
    return tile, f"程序图块 {seed + 1}"
