"""GIF89a binary writer.

A small, self-contained writer used instead of Pillow's generic saver so that
per-frame tile offsets, per-frame local color tables, explicit transparency
indices and per-frame disposal methods are fully under this tool's control.
LZW compression comes from :mod:`giftool.lzw`.

The writer emits *no* global color table: every frame carries its own local
table, which keeps frames independent (each may use a different palette) and
makes the logical-screen background index irrelevant for decoders.
"""

from __future__ import annotations

from collections.abc import Sequence

from . import lzw
from .optimizer import StorageFrame


def _u16(value: int) -> bytes:
    return bytes((value & 0xFF, (value >> 8) & 0xFF))


def _padded_palette(palette: Sequence[Sequence[int]]) -> bytes:
    """Pad an RGB palette to a power-of-two number of entries."""
    n = len(palette)
    size = 2
    while size < n:
        size <<= 1
    if size > 256:
        msg = "palette exceeds 256 entries"
        raise ValueError(msg)
    raw = bytearray(size * 3)
    for i, color in enumerate(palette):
        raw[i * 3 : i * 3 + 3] = bytes(color[:3])
    return bytes(raw)


def _palette_flag(n_entries: int) -> int:
    """GIF packed-flag color-table-size field (log2(size) - 1)."""
    size = 2
    flag = 0
    while size < n_entries:
        size <<= 1
        flag += 1
    return flag


def _netscape_extension(loop_count: int) -> bytes:
    # NETSCAPE2.0 application extension: app id block (11 bytes) followed by
    # the loop sub-block (id 1, little-endian loop count), then terminator.
    app_id = b"NETSCAPE2.0"
    loop_sub_block = bytes((1, loop_count & 0xFF, (loop_count >> 8) & 0xFF))
    return (
        b"\x21\xff\x0b"
        + app_id
        + bytes((len(loop_sub_block),))
        + loop_sub_block
        + b"\x00"
    )


def _graphic_control_extension(
    duration_ms: int, disposal: int, transparent_index: int | None
) -> bytes:
    flags = (disposal & 0x07) << 2
    if transparent_index is not None:
        flags |= 0x01
    centiseconds = max(0, min(0xFFFF, round(duration_ms / 10.0)))
    return (
        b"\x21\xf9\x04"
        + bytes((flags,))
        + _u16(centiseconds)
        + bytes((transparent_index if transparent_index is not None else 0, 0))
    )


def _image_descriptor(
    frame: StorageFrame, palette_bytes: bytes, table_flag: int
) -> bytes:
    packed = 0x80 | (table_flag & 0x07)  # local color table present, no interlace
    return (
        b"\x2c"
        + _u16(frame.left)
        + _u16(frame.top)
        + _u16(frame.width)
        + _u16(frame.height)
        + bytes((packed,))
        + palette_bytes
    )


def encode_gif(
    canvas_size: tuple[int, int],
    frames: list[StorageFrame],
    loop_count: int,
    background_rgb: tuple[int, int, int] = (0, 0, 0),
) -> bytes:
    """Encode ``frames`` as an animated GIF89a byte string.

    ``loop_count`` follows the Netscape convention: 0 = infinite.
    Durations are rounded to centiseconds (GIF's only time resolution).
    """
    if not frames:
        msg = "cannot write a GIF with no frames"
        raise ValueError(msg)

    width, height = canvas_size
    parts: list[bytes] = [b"GIF89a", _u16(width), _u16(height)]
    # Logical screen descriptor: no global color table, 8-bit color, bg 0.
    parts.append(b"\x00\x00\x00")
    parts.append(_netscape_extension(loop_count))

    for frame in frames:
        palette_bytes = _padded_palette(frame.palette)
        table_flag = _palette_flag(len(frame.palette))
        parts.append(
            _graphic_control_extension(
                frame.duration_ms, frame.disposal, frame.transparent_index
            )
        )
        parts.append(_image_descriptor(frame, palette_bytes, table_flag))
        # Minimum LZW code size is always 8 for palette-index images.
        parts.append(lzw.encode(frame.indices.reshape(-1).tolist(), 8))

    parts.append(b"\x3b")  # trailer
    return b"".join(parts)


def write_gif(
    path: str,
    canvas_size: tuple[int, int],
    frames: list[StorageFrame],
    loop_count: int,
    background_rgb: tuple[int, int, int] = (0, 0, 0),
) -> None:
    """Write an animated GIF89a to ``path``."""
    data = encode_gif(canvas_size, frames, loop_count, background_rgb)
    with open(path, "wb") as handle:
        handle.write(data)


def write_gif_to_bytes(
    canvas_size: tuple[int, int],
    frames: list[StorageFrame],
    loop_count: int,
    background_rgb: tuple[int, int, int] = (0, 0, 0),
) -> bytes:
    """In-memory variant of :func:`write_gif` (handy for tests)."""
    return encode_gif(canvas_size, frames, loop_count, background_rgb)
