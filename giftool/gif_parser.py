"""Minimal GIF87a/GIF89a binary parser.

Only what the tool needs is parsed: logical screen descriptor, global/local
color tables, the Netscape looping extension, graphic control extensions
(duration, disposal, transparency) and the image descriptors.  LZW image
data is decoded with :mod:`giftool.lzw` and de-interlaced into raw palette
index grids.

The parser deliberately returns *stored* tiles: each frame keeps its own
sub-rectangle (``left/top/width/height``) plus palette indices.  Turning those
tiles into full-canvas pictures is the compositor's job
(:mod:`giftool.compositor`), so a partial frame is never mistaken for a
complete picture.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from . import lzw

# Disposal method codes as stored in the graphic control extension.
DISPOSAL_UNSPECIFIED = 0
DISPOSAL_KEEP = 1  # do not dispose; leave the canvas in place
DISPOSAL_BACKGROUND = 2  # restore to background color
DISPOSAL_PREVIOUS = 3  # restore to the state before this frame

DISPOSAL_NAMES = {
    0: "未指定 (按保留处理)",
    1: "保留上一画面",
    2: "恢复背景",
    3: "恢复前一画面",
}


class GifParseError(ValueError):
    """Raised when a file is not a parseable GIF (or exceeds sanity limits)."""


@dataclass
class RawFrame:
    """One stored frame: a palette-index tile plus its control parameters."""

    left: int
    top: int
    width: int
    height: int
    interlaced: bool
    indices: np.ndarray  # uint8, shape (height, width), palette indices
    palette: np.ndarray  # uint8, shape (n, 3), RGB triplets
    transparent_index: int | None
    disposal: int
    duration_ms: int

    @property
    def bbox(self) -> tuple[int, int, int, int]:
        """Canvas-space bounding box ``(left, top, right, bottom)``."""
        return (self.left, self.top, self.left + self.width, self.top + self.height)

    def tile_rgba(self) -> np.ndarray:
        """Render *just this stored tile* to RGBA (transparent index -> alpha 0).

        Pixels outside the tile are not represented here on purpose; callers
        that need the full canvas must use the compositor.
        """
        h, w = self.indices.shape
        rgba = np.zeros((h, w, 4), dtype=np.uint8)
        rgb = self.palette[self.indices]
        rgba[..., :3] = rgb
        rgba[..., 3] = 255
        if self.transparent_index is not None:
            rgba[self.indices == self.transparent_index, 3] = 0
        return rgba


@dataclass
class GifDocument:
    """Result of parsing a GIF file."""

    width: int
    height: int
    background_index: int
    has_global_palette: bool
    global_palette: np.ndarray | None  # (n, 3) uint8 or None
    loop_count: int  # Netscape loop count; 0 == infinite, None means "play once"
    frames: list[RawFrame] = field(default_factory=list)
    # True when at least one frame actually uses a transparent palette entry.
    uses_transparency: bool = False

    @property
    def background_rgb(self) -> tuple[int, int, int]:
        if self.global_palette is not None and self.background_index < len(
            self.global_palette
        ):
            return tuple(int(v) for v in self.global_palette[self.background_index])  # type: ignore[return-value]
        return (0, 0, 0)


# Sanity limits: the scope is short, small animations.
MAX_DIMENSION = 4096
MAX_FRAMES = 500
MAX_BLOCK_BYTES = 64 * 1024 * 1024


class _Reader:
    def __init__(self, data: bytes) -> None:
        self.data = data
        self.pos = 0

    def read(self, n: int) -> bytes:
        if self.pos + n > len(self.data):
            msg = "unexpected end of GIF data"
            raise GifParseError(msg)
        chunk = self.data[self.pos : self.pos + n]
        self.pos += n
        return chunk

    def byte(self) -> int:
        return self.read(1)[0]

    def u16(self) -> int:
        lo, hi = self.read(2)
        return lo | (hi << 8)

    def skip_sub_blocks(self) -> None:
        while True:
            size = self.byte()
            if size == 0:
                return
            self.read(size)

    def read_sub_blocks(self) -> list[bytes]:
        blocks: list[bytes] = []
        total = 0
        while True:
            size = self.byte()
            if size == 0:
                # Block terminator: not itself a data block.
                return blocks
            total += size
            if total > MAX_BLOCK_BYTES:
                msg = "GIF sub-block data exceeds sanity limit"
                raise GifParseError(msg)
            blocks.append(self.read(size))


def _deinterlace(indices: np.ndarray, height: int, width: int) -> np.ndarray:
    """Undo GIF interlacing (passes: rows 0,8,16... then 4,12... then 2,6... then 1,3...)."""
    rows: list[int] = []
    for start, step in ((0, 8), (4, 8), (2, 4), (1, 2)):
        rows.extend(range(start, height, step))
    out = np.empty_like(indices)
    out[rows, :] = indices
    return out


def parse_gif(data: bytes) -> GifDocument:
    """Parse GIF bytes into a :class:`GifDocument`."""
    if len(data) < 13 or data[:6] not in (b"GIF87a", b"GIF89a"):
        msg = "not a GIF87a/GIF89a file"
        raise GifParseError(msg)

    reader = _Reader(data)
    reader.read(6)
    width = reader.u16()
    height = reader.u16()
    if not (0 < width <= MAX_DIMENSION and 0 < height <= MAX_DIMENSION):
        msg = f"unsupported canvas size {width}x{height}"
        raise GifParseError(msg)

    packed = reader.byte()
    background_index = reader.byte()
    reader.byte()  # pixel aspect ratio, unused

    global_palette: np.ndarray | None = None
    if packed & 0x80:
        size = 2 ** ((packed & 0x07) + 1)
        global_palette = np.frombuffer(reader.read(size * 3), dtype=np.uint8).reshape(
            size, 3
        )

    doc = GifDocument(
        width=width,
        height=height,
        background_index=background_index,
        has_global_palette=global_palette is not None,
        global_palette=global_palette,
        loop_count=1,  # default when no Netscape extension is present
    )

    # Pending values carried by a graphic control extension.
    gc_duration = 0
    gc_transparent: int | None = None
    gc_disposal = DISPOSAL_UNSPECIFIED

    while True:
        introducer = reader.byte()
        if introducer == 0x3B:  # trailer
            break
        if introducer == 0x21:  # extension
            label = reader.byte()
            if label == 0xF9:  # graphic control extension
                block_size = reader.byte()
                if block_size != 4:
                    msg = "malformed graphic control extension"
                    raise GifParseError(msg)
                flags = reader.byte()
                gc_duration = reader.u16() * 10  # centiseconds -> milliseconds
                # The transparent-index byte is always present in the GCE;
                # only its *meaning* depends on the transparency flag.
                transparent_byte = reader.byte()
                gc_transparent = transparent_byte if flags & 0x01 else None
                gc_disposal = (flags & 0x1C) >> 2
                terminator = reader.byte()
                if terminator != 0:
                    msg = "malformed graphic control extension terminator"
                    raise GifParseError(msg)
            elif label == 0xFF:  # application extension (loop count etc.)
                blocks = reader.read_sub_blocks()
                if blocks and blocks[0].startswith(b"NETSCAPE2.0"):
                    payload = b"".join(blocks[1:])
                    if len(payload) >= 3 and payload[0] == 1:
                        doc.loop_count = payload[1] | (payload[2] << 8)
            else:
                reader.skip_sub_blocks()
            continue

        if introducer != 0x2C:  # image descriptor expected
            msg = f"unexpected GIF block introducer 0x{introducer:02X}"
            raise GifParseError(msg)

        left = reader.u16()
        top = reader.u16()
        tile_w = reader.u16()
        tile_h = reader.u16()
        image_packed = reader.byte()
        interlaced = bool(image_packed & 0x40)

        local_palette: np.ndarray | None = None
        if image_packed & 0x80:
            size = 2 ** ((image_packed & 0x07) + 1)
            local_palette = np.frombuffer(
                reader.read(size * 3), dtype=np.uint8
            ).reshape(size, 3)

        palette = local_palette if local_palette is not None else global_palette
        if palette is None:
            msg = "image frame has neither a local nor a global color table"
            raise GifParseError(msg)

        min_code_size = reader.byte()
        sub_blocks = reader.read_sub_blocks()
        flat = lzw.decode(sub_blocks, min_code_size)

        expected = tile_w * tile_h
        if len(flat) < expected:
            msg = f"LZW decoded {len(flat)} indices, expected at least {expected}"
            raise GifParseError(msg)
        indices = np.asarray(flat[:expected], dtype=np.uint8).reshape(tile_h, tile_w)
        if interlaced:
            indices = _deinterlace(indices, tile_h, tile_w)

        if (
            left + tile_w > width
            or top + tile_h > height
            or tile_w == 0
            or tile_h == 0
        ):
            msg = f"frame tile {left},{top} {tile_w}x{tile_h} outside canvas"
            raise GifParseError(msg)

        frame = RawFrame(
            left=left,
            top=top,
            width=tile_w,
            height=tile_h,
            interlaced=interlaced,
            indices=indices,
            palette=palette,
            transparent_index=gc_transparent,
            disposal=gc_disposal,
            duration_ms=max(gc_duration, 0),
        )
        if gc_transparent is not None:
            doc.uses_transparency = True
        doc.frames.append(frame)
        if len(doc.frames) > MAX_FRAMES:
            msg = f"GIF has more than {MAX_FRAMES} frames (outside supported scope)"
            raise GifParseError(msg)

        # GCE applies to the single following image only.
        gc_duration = 0
        gc_transparent = None
        gc_disposal = DISPOSAL_UNSPECIFIED

    if not doc.frames:
        msg = "GIF contains no image frames"
        raise GifParseError(msg)
    return doc
