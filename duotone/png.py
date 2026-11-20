"""零依赖 PNG 读写：只用到标准库 zlib/struct。

支持本工具需要的两种格式：
  * write_png_rgb     —— 8 位 RGB（预览、误差图、检查条）
  * write_png_gray    —— 8 位灰度（墨版：覆盖率 0..1 映射到 0..255，
                         255=满覆墨；这是印刷制版常用的"黑位=有墨"约定）
  * read_png_rgb_u8   —— 读取 8/16 位 PNG（RGB/RGBA/灰度），返回 uint8 RGB
"""

from __future__ import annotations

import struct
import zlib

import numpy as np


def _chunk(tag: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data))
        + tag
        + data
        + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    )


def _write(width: int, height: int, color_type: int, bit_depth: int,
           raw: bytes, path: str) -> None:
    ihdr = struct.pack(">IIBBBBB", width, height, bit_depth, color_type, 0, 0, 0)
    # 逐行加 filter byte 0
    stride = {2: 3, 0: 1, 6: 4}[color_type] * (bit_depth // 8)
    scan = width * stride
    buf = bytearray()
    for y in range(height):
        buf.append(0)
        buf.extend(raw[y * scan:(y + 1) * scan])
    png = b"\x89PNG\r\n\x1a\n"
    png += _chunk(b"IHDR", ihdr)
    png += _chunk(b"IDAT", zlib.compress(bytes(buf), 9))
    png += _chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)


def write_png_rgb(path: str, rgb01: np.ndarray) -> None:
    """sRGB/显示用 RGB 浮点 0..1 (H,W,3) -> 8 位 PNG。"""
    a = np.clip(rgb01, 0.0, 1.0)
    u8 = (a * 255.0 + 0.5).astype(np.uint8)
    h, w, _ = u8.shape
    _write(w, h, 2, 8, u8.tobytes(), path)


def write_png_gray(path: str, coverage01: np.ndarray) -> None:
    """覆盖率 0..1 -> 8 位灰度 PNG（255 = 100% 墨）。"""
    u8 = (np.clip(coverage01, 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8)
    h, w = u8.shape
    _write(w, h, 0, 8, u8.tobytes(), path)


def read_png_rgb_u8(path: str) -> np.ndarray:
    """读取 PNG 为 uint8 (H,W,3)。覆盖 RGB/RGBA/灰度，8/16 位。"""
    with open(path, "rb") as f:
        data = f.read()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("不是 PNG 文件")
    pos = 8
    width = height = bit_depth = color_type = None
    idat = bytearray()
    while pos < len(data):
        (length,) = struct.unpack(">I", data[pos:pos + 4])
        tag = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + length]
        pos += 12 + length
        if tag == b"IHDR":
            width, height, bit_depth, color_type, *_ = struct.unpack(">IIBBBBB", body)
        elif tag == b"IDAT":
            idat.extend(body)
        elif tag == b"IEND":
            break
    raw = zlib.decompress(bytes(idat))
    channels = {0: 1, 2: 3, 6: 4, 4: 2}[color_type]
    if color_type == 4:
        raise ValueError("暂不支持灰度+Alpha PNG")
    bps = bit_depth // 8
    stride = width * channels * bps
    rows = []
    rpos = 0
    prev = np.zeros(stride, dtype=np.uint8)
    for _ in range(height):
        ftype = raw[rpos]
        rpos += 1
        line = np.frombuffer(raw[rpos:rpos + stride], dtype=np.uint8).copy()
        rpos += stride
        if ftype == 1:  # Sub
            for i in range(bps, stride):
                line[i] = (line[i] + line[i - bps]) & 0xFF
        elif ftype == 2:  # Up
            line = (line + prev) & 0xFF
        elif ftype == 3:  # Average
            left = np.concatenate([np.zeros(bps, dtype=np.uint8), line[:-bps]])
            line = (line + ((left.astype(np.uint16) + prev.astype(np.uint16)) // 2)).astype(np.uint8)
        elif ftype == 4:  # Paeth
            left = np.concatenate([np.zeros(bps, dtype=np.uint8), line[:-bps]])
            up = prev
            ul = np.concatenate([np.zeros(bps, dtype=np.uint8), prev[:-bps]])
            p = left.astype(np.int16) + up.astype(np.int16) - ul.astype(np.int16)
            pa, pb, pc = np.abs(p - left), np.abs(p - up), np.abs(p - ul)
            pred = np.where((pa <= pb) & (pa <= pc), left, np.where(pb <= pc, up, ul))
            line = (line.astype(np.int16) + pred.astype(np.int16)).astype(np.uint8)
        elif ftype != 0:
            raise ValueError(f"未知 PNG filter: {ftype}")
        rows.append(line)
        prev = line
    img = np.stack(rows).reshape(height, width, channels)
    if bit_depth == 16:
        # 取每通道高字节作为 8 位值（标准 16->8 降采样）
        img = img.reshape(height, width, channels, 2)[..., 0]
    if channels == 1:
        img = np.repeat(img, 3, axis=2)
    elif channels == 4:
        img = img[..., :3]
    return img
