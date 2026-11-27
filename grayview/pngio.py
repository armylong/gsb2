"""极简 PNG 读写，只覆盖本工具需要的灰度图（8/16 位、无 alpha）。

用纯 Python + zlib + binascii，不依赖 Pillow；写入的文件是 PNG 规范的
大端 16 位灰度（bit depth 16, color type 0）。读写都逐字节可核对。
"""

from __future__ import annotations

import binascii
import struct
import zlib
from dataclasses import dataclass

import numpy as np


PNG_SIG = b"\x89PNG\r\n\x1a\n"


class PngError(ValueError):
    pass


def _chunk(tag: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data))
        + tag
        + data
        + struct.pack(">I", binascii.crc32(tag + data) & 0xFFFFFFFF)
    )


def write_gray(
    path: str,
    array: np.ndarray,
    *,
    bit_depth: int | None = None,
    text: dict[str, str] | None = None,
) -> dict[str, int]:
    """把 (H, W) 数组写成灰度 PNG。

    bit_depth=8 时要求值域 0..255；bit_depth=16 时按原值写成大端 16 位。
    array 的 dtype 是 uint8/uint16，bit depth 默认按 dtype 推断。
    返回写入用的 {bit_depth, width, height}。
    """
    arr = np.asarray(array)
    if arr.ndim != 2:
        raise PngError(f"灰度图必须是二维，收到 shape={arr.shape}")
    h, w = arr.shape
    if h == 0 or w == 0:
        raise PngError("宽高必须大于 0")
    if bit_depth is None:
        bit_depth = 8 if arr.dtype == np.uint8 else 16
    if bit_depth == 8:
        if arr.dtype == np.uint8:
            arr8 = arr
        elif arr.dtype == np.uint16:
            if arr.size and int(arr.max()) > 255:
                raise PngError("8 位导出但灰度超过 255，会丢精度")
            arr8 = arr.astype(np.uint8)
        else:
            raise PngError(f"8 位导出需要 uint8/uint16，收到 {arr.dtype}")
        raw = b"".join(
            b"\x00" + np.ascontiguousarray(arr8[i]).tobytes() for i in range(h)
        )
    elif bit_depth == 16:
        arr16 = arr if arr.dtype == np.uint16 else arr.astype(np.uint16)
        # PNG 里 16 位灰度是大端：每个像素先写高字节
        raw = b"".join(
            b"\x00" + np.ascontiguousarray(arr16[i]).astype(">u2").tobytes()
            for i in range(h)
        )
    else:
        raise PngError("只支持 8 位或 16 位 PNG")

    ihdr = struct.pack(">IIBBBBB", w, h, bit_depth, 0, 0, 0, 0)
    chunks = [_chunk(b"IHDR", ihdr)]
    if text:
        for k, v in text.items():
            chunks.append(_chunk(b"tEXt", f"{k}\x00{v}".encode("latin-1", "replace")))
    chunks.append(_chunk(b"IDAT", zlib.compress(raw, 9)))
    chunks.append(_chunk(b"IEND", b""))
    with open(path, "wb") as fh:
        fh.write(PNG_SIG + b"".join(chunks))
    return {"bit_depth": bit_depth, "width": w, "height": h}


@dataclass
class PngImage:
    array: np.ndarray
    bit_depth: int
    width: int
    height: int
    text: dict[str, str]


def _unfilter_rows(raw: bytes, h: int, row_bytes: int, bpp_bytes: int) -> list[bytes]:
    """按 PNG 规范逐行反滤波。"""
    out: list[bytes] = []
    pos = 0
    prev = bytes(row_bytes)
    for _ in range(h):
        if pos + 1 + row_bytes > len(raw):
            raise PngError("IDAT 数据不足，文件可能被截断")
        ftype = raw[pos]
        pos += 1
        cur = bytearray(raw[pos:pos + row_bytes])
        pos += row_bytes
        if ftype == 0:
            pass
        elif ftype == 1:  # Sub
            for i in range(bpp_bytes, row_bytes):
                cur[i] = (cur[i] + cur[i - bpp_bytes]) & 0xFF
        elif ftype == 2:  # Up
            for i in range(row_bytes):
                cur[i] = (cur[i] + prev[i]) & 0xFF
        elif ftype == 3:  # Average
            for i in range(row_bytes):
                a = cur[i - bpp_bytes] if i >= bpp_bytes else 0
                cur[i] = (cur[i] + ((a + prev[i]) >> 1)) & 0xFF
        elif ftype == 4:  # Paeth
            for i in range(row_bytes):
                a = cur[i - bpp_bytes] if i >= bpp_bytes else 0
                b = prev[i]
                c = prev[i - bpp_bytes] if i >= bpp_bytes else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pred = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                cur[i] = (cur[i] + pred) & 0xFF
        else:
            raise PngError(f"不支持的 PNG filter type {ftype}")
        out.append(bytes(cur))
        prev = bytes(cur)
    return out


def read_gray(path: str) -> PngImage:
    """读取 8/16 位灰度 PNG（color type 0）及 tEXt 元数据。"""
    with open(path, "rb") as fh:
        data = fh.read()
    if not data.startswith(PNG_SIG):
        raise PngError("不是 PNG 文件（签名不符）")
    pos = len(PNG_SIG)
    width = height = bit_depth = color_type = None
    interlace = 0
    idat = bytearray()
    text: dict[str, str] = {}
    while pos + 8 <= len(data):
        (length,) = struct.unpack(">I", data[pos:pos + 4])
        tag = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + length]
        pos += 12 + length
        if tag == b"IHDR":
            width, height, bit_depth, color_type, _comp, _filt, interlace = struct.unpack(
                ">IIBBBBB", body
            )
        elif tag == b"IDAT":
            idat += body
        elif tag == b"tEXt":
            k, _, v = body.partition(b"\x00")
            text[k.decode("latin-1")] = v.decode("latin-1")
        elif tag == b"IEND":
            break
    if width is None or bit_depth is None:
        raise PngError("缺少 IHDR")
    if color_type != 0:
        raise PngError(f"只支持灰度 PNG (color type 0)，收到 {color_type}")
    if bit_depth not in (8, 16):
        raise PngError(f"只支持 8/16 位，收到 {bit_depth}")
    if interlace:
        raise PngError("不支持隔行 PNG")
    bpp_bytes = 1 if bit_depth == 8 else 2
    row_bytes = width * bpp_bytes
    raw = zlib.decompress(bytes(idat))
    rows = _unfilter_rows(raw, height, row_bytes, bpp_bytes)
    if bit_depth == 8:
        arr = np.frombuffer(b"".join(rows), dtype=np.uint8).reshape(height, width)
        arr = arr.copy()
    else:
        arr = np.frombuffer(b"".join(rows), dtype=">u2").reshape(height, width)
        arr = arr.astype(np.uint16)
    return PngImage(array=arr, bit_depth=bit_depth, width=width, height=height, text=text)
