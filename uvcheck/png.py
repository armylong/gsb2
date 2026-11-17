"""最小 PNG 编码器（RGBA，8bit，非隔行），只依赖标准库 zlib/struct。

仅用于程序化生成检查工具自带的贴图样例，不追求压缩率。
"""

from __future__ import annotations

import struct
import zlib


def _chunk(tag: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data))
        + tag
        + data
        + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    )


def write_png(path: str, width: int, height: int, pixels: list[tuple[int, int, int, int]]) -> None:
    """把逐行 RGBA 像素写入 PNG 文件。pixels 长度必须等于 width*height。"""
    if len(pixels) != width * height:
        raise ValueError(f"像素数 {len(pixels)} 与尺寸 {width}x{height} 不匹配")
    raw = bytearray()
    i = 0
    for _ in range(height):
        raw.append(0)  # filter type 0: None
        for r, g, b, a in pixels[i:i + width]:
            raw.extend((r & 255, g & 255, b & 255, a & 255))
        i += width
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)  # 8bit RGBA
    with open(path, "wb") as fh:
        fh.write(b"\x89PNG\r\n\x1a\n")
        fh.write(_chunk(b"IHDR", ihdr))
        fh.write(_chunk(b"IDAT", zlib.compress(bytes(raw), 9)))
        fh.write(_chunk(b"IEND", b""))


def checker_texture(width: int = 256, height: int = 256, cells: int = 8) -> list[tuple[int, int, int, int]]:
    """生成带编号的棋盘格像素，便于肉眼观察拉伸与错位。"""
    palette = [
        (235, 238, 245, 255),
        (64, 82, 121, 255),
        (224, 122, 95, 255),
        (94, 168, 134, 255),
        (228, 193, 111, 255),
        (130, 105, 178, 255),
        (99, 166, 196, 255),
        (205, 108, 150, 255),
    ]
    cw = width / cells
    ch = height / cells
    px: list[tuple[int, int, int, int]] = []
    for y in range(height):
        row = cy = int(y // ch)
        for x in range(width):
            cx = int(x // cw)
            base = palette[(cx * 7 + cy * 3) % len(palette)]
            # 每格内部再做 4x4 小棋盘，方便观察轻微拉伸
            sub = ((x * cells * 4 // width) + (y * cells * 4 // height)) % 2
            factor = 1.0 if sub == 0 else 0.78
            r, g, b, a = base
            px.append((int(r * factor), int(g * factor), int(b * factor), a))
    return px
