"""最小 PNG 读写实现，仅依赖标准库（zlib/struct）与 numpy。

支持 8-bit、非隔行的灰度/灰度+Alpha/RGB/RGBA。写图用于导出灰阶图与误差图，
读图用于“也支持灰度图”的外部 PNG 加载。
"""
from __future__ import annotations

import struct
import zlib

import numpy as np

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def _chunk(tag: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data))
        + tag
        + data
        + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    )


def write_png(path: str, image: np.ndarray, alpha: np.ndarray | None = None) -> None:
    """把数组写为 8-bit PNG。

    Parameters
    ----------
    image: 二维 [0,1] 灰度数组 或 三维 (H,W,3) RGB 数组。
    alpha: 可选二维 [0,1] 透明度；为 None 且 image 为 RGBA 时取第 4 通道。
    """
    image = np.asarray(image, dtype=np.float64)
    if image.ndim == 3 and image.shape[2] == 4 and alpha is None:
        alpha = image[:, :, 3]
        image = image[:, :, :3]

    if image.ndim == 2:
        if alpha is None:
            color_type, channels = 0, 1
            raw8 = (np.clip(image, 0, 1) * 255.0 + 0.5).astype(np.uint8)[:, :, None]
        else:
            color_type, channels = 4, 2
            g = (np.clip(image, 0, 1) * 255.0 + 0.5).astype(np.uint8)[:, :, None]
            a = (np.clip(alpha, 0, 1) * 255.0 + 0.5).astype(np.uint8)[:, :, None]
            raw8 = np.concatenate([g, a], axis=2)
    elif image.ndim == 3 and image.shape[2] == 3:
        if alpha is None:
            color_type, channels = 2, 3
            raw8 = (np.clip(image, 0, 1) * 255.0 + 0.5).astype(np.uint8)
        else:
            color_type, channels = 6, 4
            rgb = (np.clip(image, 0, 1) * 255.0 + 0.5).astype(np.uint8)
            a = (np.clip(alpha, 0, 1) * 255.0 + 0.5).astype(np.uint8)[:, :, None]
            raw8 = np.concatenate([rgb, a], axis=2)
    else:
        raise ValueError("write_png 仅接受 HxW 灰度或 HxWx3/4 彩色数组")

    h, w = raw8.shape[:2]
    # 每行前置 filter byte 0（None 过滤）
    scanlines = np.concatenate(
        [np.zeros((h, 1), dtype=np.uint8), raw8.reshape(h, w * channels)], axis=1
    )
    compressed = zlib.compress(scanlines.tobytes(), level=6)
    ihdr = struct.pack(">IIBBBBB", w, h, 8, color_type, 0, 0, 0)
    data = PNG_SIGNATURE + _chunk(b"IHDR", ihdr) + _chunk(b"IDAT", compressed) + _chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(data)


def _paeth(a: int, b: int, c: int) -> int:
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    if pb <= pc:
        return b
    return c


def read_png(path: str) -> tuple[np.ndarray, np.ndarray]:
    """读取 8-bit 非隔行 PNG，返回 (gray[0,1] float64, alpha[0,1] float64)。

    彩色图按 ITU-R BT.601 系数转灰度；无 alpha 通道时 alpha 全 1。
    """
    with open(path, "rb") as f:
        blob = f.read()
    if not blob.startswith(PNG_SIGNATURE):
        raise ValueError(f"{path} 不是合法 PNG")
    pos = len(PNG_SIGNATURE)
    width = height = bit_depth = color_type = None
    idat = bytearray()
    while pos < len(blob):
        (length,) = struct.unpack(">I", blob[pos:pos + 4])
        tag = blob[pos + 4:pos + 8]
        body = blob[pos + 8:pos + 8 + length]
        pos += 12 + length
        if tag == b"IHDR":
            width, height, bit_depth, color_type, compression, filt, interlace = struct.unpack(
                ">IIBBBBB", body
            )
            if bit_depth != 8:
                raise ValueError("仅支持 8-bit PNG")
            if interlace != 0:
                raise ValueError("不支持隔行(Adam7) PNG")
        elif tag == b"IDAT":
            idat.extend(body)
        elif tag == b"IEND":
            break

    channels = {0: 1, 2: 3, 4: 2, 6: 4}.get(color_type)
    if channels is None:
        raise ValueError(f"不支持的 PNG color type={color_type}")
    raw = np.frombuffer(zlib.decompress(bytes(idat)), dtype=np.uint8)
    stride = width * channels
    expected = height * (stride + 1)
    if raw.size != expected:
        raise ValueError(f"PNG 数据长度异常: {raw.size} != {expected}")
    rows = raw.reshape(height, stride + 1)
    filters = rows[:, 0]
    filtered = rows[:, 1:].reshape(height, width, channels).astype(np.int32)
    recon = np.zeros_like(filtered)

    for y in range(height):
        f = int(filters[y])
        cur = filtered[y]
        prev_row = recon[y - 1] if y > 0 else np.zeros_like(cur)
        left = np.zeros_like(cur)
        if f == 0:
            recon[y] = cur
        elif f == 1:  # Sub
            for x in range(width):
                a = recon[y, x - 1] if x > 0 else np.zeros(channels, dtype=np.int32)
                left[x] = (cur[x] + a) & 0xFF
            recon[y] = left
        elif f == 2:  # Up
            recon[y] = (cur + prev_row) & 0xFF
        elif f == 3:  # Average
            for x in range(width):
                a = recon[y, x - 1] if x > 0 else np.zeros(channels, dtype=np.int32)
                recon[y, x] = (cur[x] + ((a + prev_row[x]) >> 1)) & 0xFF
        elif f == 4:  # Paeth
            for x in range(width):
                a = recon[y, x - 1] if x > 0 else np.zeros(channels, dtype=np.int32)
                c = recon[y - 1, x - 1] if (y > 0 and x > 0) else np.zeros(channels, dtype=np.int32)
                pred = np.array([_paeth(int(a[k]), int(prev_row[x, k]), int(c[k]))
                                 for k in range(channels)], dtype=np.int32)
                recon[y, x] = (cur[x] + pred) & 0xFF
        else:
            raise ValueError(f"未知 PNG filter: {f}")

    arr = recon.astype(np.float64) / 255.0
    if color_type == 0:
        gray, alpha = arr[:, :, 0], np.ones((height, width), dtype=np.float64)
    elif color_type == 4:
        gray, alpha = arr[:, :, 0], arr[:, :, 1]
    elif color_type == 2:
        gray = 0.299 * arr[:, :, 0] + 0.587 * arr[:, :, 1] + 0.114 * arr[:, :, 2]
        alpha = np.ones((height, width), dtype=np.float64)
    else:  # 6
        gray = 0.299 * arr[:, :, 0] + 0.587 * arr[:, :, 1] + 0.114 * arr[:, :, 2]
        alpha = arr[:, :, 3]
    return gray, alpha
