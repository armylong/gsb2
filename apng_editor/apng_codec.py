"""Minimal, independent APNG reader used to verify exported files.

The writer lives in :mod:`apng_editor.exporter` and uses the third-party
``apng`` package.  This reader shares no encoding code with it: it parses the
PNG chunks, inflates and unfilters the frame data itself, replays the APNG
blend/dispose operations, and returns the exact pixels shown during each
frame.  That makes the export check a genuine read-back rather than a second
call of the compositor.
"""

from __future__ import annotations

import struct
import zlib
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"

DISPOSAL_NONE = 0
DISPOSAL_BACKGROUND = 1
DISPOSAL_PREVIOUS = 2
BLEND_SOURCE = 0
BLEND_OVER = 1


class APNGReadError(ValueError):
    """Raised when a file is not a readable 8-bit RGBA APNG."""


@dataclass
class APNGChunk:
    type: str
    data: bytes


@dataclass
class DecodedFrame:
    pixels: np.ndarray  # full canvas as displayed while this frame runs
    duration_ms: float
    duration_fraction: tuple[int, int]
    rect: tuple[int, int, int, int]
    disposal: int
    blend: int


@dataclass
class DecodedAPNG:
    width: int
    height: int
    loop_count: int
    declared_frames: int
    frames: list[DecodedFrame] = field(default_factory=list)


def _read_chunks(raw: bytes) -> list[APNGChunk]:
    if not raw.startswith(PNG_SIGNATURE):
        raise APNGReadError("文件不是 PNG（签名不匹配）")
    chunks: list[APNGChunk] = []
    pos = len(PNG_SIGNATURE)
    while pos < len(raw):
        if pos + 8 > len(raw):
            raise APNGReadError("PNG 数据被截断（缺少块头）")
        length = struct.unpack(">I", raw[pos : pos + 4])[0]
        ctype = raw[pos + 4 : pos + 8].decode("latin-1")
        end = pos + 12 + length
        if end > len(raw):
            raise APNGReadError(f"{ctype} 块被截断")
        payload = raw[pos + 8 : pos + 8 + length]
        crc = struct.unpack(">I", raw[pos + 8 + length : end])[0]
        if zlib.crc32(raw[pos + 4 : pos + 8 + length]) & 0xFFFFFFFF != crc:
            raise APNGReadError(f"{ctype} 块 CRC 校验失败")
        chunks.append(APNGChunk(ctype, payload))
        pos = end
        if ctype == "IEND":
            break
    return chunks


def _paeth(a: int, b: int, c: int) -> int:
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    if pb <= pc:
        return b
    return c


def _unfilter(data: bytes, width: int, height: int, bpp: int = 4) -> np.ndarray:
    stride = width * bpp
    expected = (stride + 1) * height
    if len(data) < expected:
        raise APNGReadError(
            f"帧数据不足：需要 {expected} 字节，实际 {len(data)} 字节"
        )
    out = np.zeros((height, stride), dtype=np.uint8)
    previous = bytearray(stride)
    offset = 0
    for y in range(height):
        filter_type = data[offset]
        offset += 1
        row = bytearray(data[offset : offset + stride])
        offset += stride
        if filter_type == 0:
            pass
        elif filter_type == 1:  # Sub
            for i in range(bpp, stride):
                row[i] = (row[i] + row[i - bpp]) & 0xFF
        elif filter_type == 2:  # Up
            for i in range(stride):
                row[i] = (row[i] + previous[i]) & 0xFF
        elif filter_type == 3:  # Average
            for i in range(stride):
                left = row[i - bpp] if i >= bpp else 0
                row[i] = (row[i] + ((left + previous[i]) >> 1)) & 0xFF
        elif filter_type == 4:  # Paeth
            for i in range(stride):
                left = row[i - bpp] if i >= bpp else 0
                up_left = previous[i - bpp] if i >= bpp else 0
                row[i] = (row[i] + _paeth(left, previous[i], up_left)) & 0xFF
        else:
            raise APNGReadError(f"未知 PNG 行过滤类型：{filter_type}")
        out[y] = np.frombuffer(bytes(row), dtype=np.uint8)
        previous = row
    return out.reshape(height, width, bpp)


def _over(dst: np.ndarray, src: np.ndarray) -> np.ndarray:
    """Straight-alpha source-over written independently of the editor code."""

    s = src.astype(np.int64)
    d = dst.astype(np.int64)
    sa = s[..., 3]
    da = d[..., 3]
    # Work in units where 0..255 is 0..1, but keep integer rounding.
    out_a = sa * 255 + da * (255 - sa)
    out = np.zeros_like(src)
    nz = out_a > 0
    for channel in range(3):
        numerator = s[..., channel] * sa * 255 + d[..., channel] * da * (255 - sa)
        out[..., channel] = np.where(
            nz, np.clip((2 * numerator + out_a) // (2 * np.maximum(out_a, 1)), 0, 255), 0
        )
    out[..., 3] = np.where(nz, np.clip((out_a + 127) // 255, 0, 255), 0)
    return out.astype(np.uint8)


def decode_apng(path: str | Path) -> DecodedAPNG:
    """Decode an APNG into the full-canvas RGBA image of every display slot."""

    raw = Path(path).read_bytes()
    chunks = _read_chunks(raw)

    ihdr = next((c for c in chunks if c.type == "IHDR"), None)
    if ihdr is None or len(ihdr.data) != 13:
        raise APNGReadError("缺少有效的 IHDR 块")
    width, height = struct.unpack(">II", ihdr.data[:8])
    bit_depth, color_type = ihdr.data[8], ihdr.data[9]
    interlace = ihdr.data[12]
    if bit_depth != 8 or color_type != 6:
        raise APNGReadError(
            f"只支持 8 位 RGBA APNG，当前位深 {bit_depth}、颜色类型 {color_type}"
        )
    if interlace != 0:
        raise APNGReadError("暂不支持隔行扫描 APNG")

    actl = next((c for c in chunks if c.type == "acTL"), None)
    if actl is None or len(actl.data) < 8:
        raise APNGReadError("缺少 acTL 块，不是 APNG 动画")
    declared_frames, loop_count = struct.unpack(">II", actl.data[:8])

    # Collect each frame's control data and compressed pixel payload.
    frame_controls: list[dict] = []
    frame_payloads: list[bytearray] = []
    pending_payload: bytearray | None = None
    # IDAT before the first fcTL is the non-animated default image.
    default_idat = bytearray()
    next_seq = 0
    for chunk in chunks:
        if chunk.type == "fcTL":
            if len(chunk.data) != 26:
                raise APNGReadError("fcTL 块长度无效")
            (
                seq,
                fw,
                fh,
                fx,
                fy,
                delay_num,
                delay_den,
                disposal,
                blend,
            ) = struct.unpack(">IIIIIHHBB", chunk.data)
            if seq != next_seq:
                raise APNGReadError(
                    f"fcTL 序列号不连续：期望 {next_seq}，实际 {seq}"
                )
            next_seq += 1
            frame_controls.append(
                {
                    "width": fw,
                    "height": fh,
                    "x": fx,
                    "y": fy,
                    "delay_num": delay_num,
                    "delay_den": delay_den,
                    "disposal": disposal,
                    "blend": blend,
                }
            )
            frame_payloads.append(bytearray())
            pending_payload = frame_payloads[-1]
        elif chunk.type == "IDAT":
            if pending_payload is not None:
                pending_payload.extend(chunk.data)
            else:
                default_idat.extend(chunk.data)
        elif chunk.type == "fdAT":
            if len(chunk.data) < 4 or pending_payload is None:
                raise APNGReadError("fdAT 块无效或没有对应的 fcTL")
            seq = struct.unpack(">I", chunk.data[:4])[0]
            if seq != next_seq:
                raise APNGReadError(
                    f"fdAT 序列号不连续：期望 {next_seq}，实际 {seq}"
                )
            next_seq += 1
            pending_payload.extend(chunk.data[4:])

    if not frame_controls:
        raise APNGReadError("没有找到任何 fcTL 帧")
    if len(frame_payloads) != len(frame_controls):
        raise APNGReadError("帧控制块与帧数据数量不一致")
    if declared_frames != len(frame_controls):
        raise APNGReadError(
            f"acTL 声明 {declared_frames} 帧，实际找到 {len(frame_controls)} 帧"
        )
    if default_idat:
        # The default image is not part of the animation in this layout.
        raise APNGReadError("默认图像位于动画序列之外，不是本工具导出的 APNG 布局")

    decoded = DecodedAPNG(width, height, loop_count, declared_frames)
    canvas = np.zeros((height, width, 4), dtype=np.uint8)

    for index, control in enumerate(frame_controls):
        fw, fh = control["width"], control["height"]
        fx, fy = control["x"], control["y"]
        if fw <= 0 or fh <= 0 or fx + fw > width or fy + fh > height:
            raise APNGReadError(
                f"第 {index + 1} 帧矩形 ({fx}, {fy}, {fw}, {fh}) 超出画布"
            )
        try:
            decompressed = zlib.decompress(bytes(frame_payloads[index]))
        except zlib.error as exc:
            raise APNGReadError(f"第 {index + 1} 帧解压失败：{exc}") from exc
        raw_frame = _unfilter(decompressed, fw, fh)
        before = canvas[fy : fy + fh, fx : fx + fw].copy()
        region = canvas[fy : fy + fh, fx : fx + fw]
        if control["blend"] == BLEND_SOURCE:
            region[...] = raw_frame
        elif control["blend"] == BLEND_OVER:
            region[...] = _over(region, raw_frame)
        else:
            raise APNGReadError(f"未知混合模式：{control['blend']}")

        delay_num = control["delay_num"]
        delay_den = control["delay_den"] or 100
        duration_ms = delay_num / delay_den * 1000.0
        decoded.frames.append(
            DecodedFrame(
                pixels=canvas.copy(),
                duration_ms=duration_ms,
                duration_fraction=(delay_num, delay_den),
                rect=(fx, fy, fx + fw, fy + fh),
                disposal=control["disposal"],
                blend=control["blend"],
            )
        )

        if control["disposal"] == DISPOSAL_BACKGROUND:
            canvas[fy : fy + fh, fx : fx + fw] = 0
        elif control["disposal"] == DISPOSAL_PREVIOUS:
            canvas[fy : fy + fh, fx : fx + fw] = before
        elif control["disposal"] != DISPOSAL_NONE:
            raise APNGReadError(f"未知处置方式：{control['disposal']}")

    return decoded
