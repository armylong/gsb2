"""PNG 导出, 仅依赖标准库 zlib/struct。

输入一律为 sRGB uint8 HxWx3 (显示链的最终产物);
线性浮点数据不做隐式截断导出, 必须先经过 display_image。
"""

from __future__ import annotations

import struct
import zlib

import numpy as np


def _chunk(tag: bytes, data: bytes) -> bytes:
    return (struct.pack(">I", len(data)) + tag + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))


def write_png_rgb8(path: str, rgb8: np.ndarray) -> None:
    """把 HxWx3 uint8 数组写成 8-bit RGB PNG。"""
    if rgb8.ndim != 3 or rgb8.shape[2] != 3:
        raise ValueError(f"期望 HxWx3 数组, 实际 {rgb8.shape}")
    if rgb8.dtype != np.uint8:
        raise ValueError("PNG 导出只接受 sRGB uint8 数据")
    h, w, _ = rgb8.shape
    # 每行前加 filter type 0 (None)
    flat = rgb8.reshape(h, w * 3)
    raw = np.empty((h, w * 3 + 1), np.uint8)
    raw[:, 0] = 0
    raw[:, 1:] = flat
    compressed = zlib.compress(raw.tobytes(), level=6)

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)  # 8bit, color type 2
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n")
        f.write(_chunk(b"IHDR", ihdr))
        f.write(_chunk(b"IDAT", compressed))
        f.write(_chunk(b"IEND", b""))
