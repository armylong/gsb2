"""最小 PNG 读写, 只依赖标准库 (zlib/struct), 供离线脚本与测试使用。

支持: 8-bit, 非隔行, 灰度/真彩/RGBA/索引色。
应用界面读取用户 PNG 时走 QImage, 这里主要保证样例与测试可在无 Qt
环境下生成和验证。
"""
from __future__ import annotations

import struct
import zlib

PNG_SIG = b"\x89PNG\r\n\x1a\n"


def _chunk(tag: bytes, data: bytes) -> bytes:
    return (struct.pack(">I", len(data)) + tag + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))


def write_png(path, rgba):
    """把 (H,W,3|4) uint8 数组写成 PNG。"""
    import numpy as np

    arr = np.ascontiguousarray(rgba)
    if arr.dtype != np.uint8 or arr.ndim != 3 or arr.shape[2] not in (3, 4):
        raise ValueError("需要 (H,W,3) 或 (H,W,4) 的 uint8 数组")
    h, w = arr.shape[:2]
    color_type = 6 if arr.shape[2] == 4 else 2
    ihdr = struct.pack(">IIBBBBB", w, h, 8, color_type, 0, 0, 0)
    raw = np.zeros((h, 1 + w * arr.shape[2]), dtype=np.uint8)
    raw[:, 0] = 0  # filter type 0
    raw[:, 1:] = arr.reshape(h, -1)
    idat = zlib.compress(raw.tobytes(), 9)
    with open(path, "wb") as f:
        f.write(PNG_SIG)
        f.write(_chunk(b"IHDR", ihdr))
        f.write(_chunk(b"IDAT", idat))
        f.write(_chunk(b"IEND", b""))


def read_png(path):
    """读取 PNG, 返回 (H,W,C) uint8, C 为 3 或 4。"""
    import numpy as np

    with open(path, "rb") as f:
        blob = f.read()
    if blob[:8] != PNG_SIG:
        raise ValueError("不是 PNG 文件")

    pos = 8
    width = height = bit_depth = color_type = None
    idat = bytearray()
    palette = trns = None
    while pos < len(blob):
        (length,) = struct.unpack(">I", blob[pos:pos + 4])
        tag = blob[pos + 4:pos + 8]
        data = blob[pos + 8:pos + 8 + length]
        pos += 12 + length
        if tag == b"IHDR":
            width, height, bit_depth, color_type, _, _, interlace = \
                struct.unpack(">IIBBBBB", data)
            if interlace != 0:
                raise ValueError("暂不支持隔行 PNG")
        elif tag == b"IDAT":
            idat.extend(data)
        elif tag == b"PLTE":
            palette = np.frombuffer(data, dtype=np.uint8).reshape(-1, 3)
        elif tag == b"tRNS":
            trns = np.frombuffer(data, dtype=np.uint8)
        elif tag == b"IEND":
            break

    if bit_depth != 8:
        raise ValueError(f"暂只支持 8-bit PNG, 实际 bit depth={bit_depth}")
    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}.get(color_type)
    if channels is None:
        raise ValueError(f"未知 color type {color_type}")

    raw = zlib.decompress(bytes(idat))
    stride = width * channels
    expected = height * (stride + 1)
    if len(raw) != expected:
        raise ValueError("PNG 数据长度异常")

    # 逐行 unfilter
    out = np.zeros((height, stride), dtype=np.uint8)
    prev = np.zeros(stride, dtype=np.uint8)
    bpp = channels
    for y in range(height):
        ftype = raw[y * (stride + 1)]
        line = np.frombuffer(
            raw[y * (stride + 1) + 1:(y + 1) * (stride + 1)],
            dtype=np.uint8).copy()
        if ftype == 0:
            pass
        elif ftype == 1:  # Sub
            for i in range(bpp, stride):
                line[i] = (int(line[i]) + int(line[i - bpp])) & 0xFF
        elif ftype == 2:  # Up
            line = (line.astype(np.uint16) + prev.astype(np.uint16)
                    ).astype(np.uint8)
        elif ftype == 3:  # Average
            for i in range(stride):
                left = int(line[i - bpp]) if i >= bpp else 0
                line[i] = (int(line[i])
                           + ((left + int(prev[i])) >> 1)) & 0xFF
        elif ftype == 4:  # Paeth
            for i in range(stride):
                a = int(line[i - bpp]) if i >= bpp else 0
                b_ = int(prev[i])
                c = int(prev[i - bpp]) if i >= bpp else 0
                p = a + b_ - c
                pa, pb, pc = abs(p - a), abs(p - b_), abs(p - c)
                pr = a if pa <= pb and pa <= pc else (b_ if pb <= pc else c)
                line[i] = (int(line[i]) + pr) & 0xFF
        else:
            raise ValueError(f"未知 filter type {ftype}")
        out[y] = line
        prev = line

    if color_type == 2:
        return out.reshape(height, width, 3)
    if color_type == 6:
        return out.reshape(height, width, 4)
    if color_type == 3:
        rows = out.reshape(height, width)
        img = np.zeros((height, width, 4), dtype=np.uint8)
        img[..., :3] = palette[rows]
        img[..., 3] = 255
        if trns is not None:
            for idx, a in enumerate(trns):
                img[rows == idx, 3] = a
        return img
    if color_type == 0:  # 灰度 -> RGBA
        g = out.reshape(height, width)
        img = np.repeat(g[:, :, None], 4, axis=2)
        img[..., 3] = 255
        return img
    # 灰度+alpha
    ga = out.reshape(height, width, 2)
    img = np.zeros((height, width, 4), dtype=np.uint8)
    img[..., 0] = img[..., 1] = img[..., 2] = ga[..., 0]
    img[..., 3] = ga[..., 1]
    return img
