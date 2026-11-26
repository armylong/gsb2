"""Small dependency-free RGB image helpers.

The packer only needs raw RGB composition and PNG output. JPEG pages are
encoded through FFmpeg when the user explicitly asks for JPEG.
"""

from __future__ import annotations

import struct
import subprocess
import zlib
from dataclasses import dataclass
from typing import Iterable


@dataclass
class RGBImage:
    width: int
    height: int
    pixels: bytearray

    @classmethod
    def new(cls, width: int, height: int, color: tuple[int, int, int] = (0, 0, 0)) -> "RGBImage":
        if width <= 0 or height <= 0:
            raise ValueError(f"image dimensions must be positive, got {width}x{height}")
        row = bytes(color) * width
        pixels = bytearray(row * height)
        return cls(width, height, pixels)

    def copy(self) -> "RGBImage":
        return RGBImage(self.width, self.height, bytearray(self.pixels))

    def fill_rect(
        self,
        x: int,
        y: int,
        width: int,
        height: int,
        color: tuple[int, int, int],
    ) -> None:
        x0 = max(0, x)
        y0 = max(0, y)
        x1 = min(self.width, x + width)
        y1 = min(self.height, y + height)
        if x0 >= x1 or y0 >= y1:
            return
        row = bytes(color) * (x1 - x0)
        for yy in range(y0, y1):
            start = (yy * self.width + x0) * 3
            self.pixels[start : start + len(row)] = row

    def draw_rect(
        self,
        x: int,
        y: int,
        width: int,
        height: int,
        color: tuple[int, int, int],
        thickness: int = 1,
    ) -> None:
        if thickness <= 0 or width <= 0 or height <= 0:
            return
        t = min(thickness, width, height)
        self.fill_rect(x, y, width, t, color)
        self.fill_rect(x, y + height - t, width, t, color)
        self.fill_rect(x, y, t, height, color)
        self.fill_rect(x + width - t, y, t, height, color)

    def draw_dashed_rect(
        self,
        x: int,
        y: int,
        width: int,
        height: int,
        color: tuple[int, int, int],
        dash: int = 5,
        thickness: int = 1,
    ) -> None:
        dash = max(1, dash)
        t = max(1, thickness)
        for xx in range(x, x + width, dash * 2):
            self.fill_rect(xx, y, min(dash, x + width - xx), t, color)
            self.fill_rect(xx, y + height - t, min(dash, x + width - xx), t, color)
        for yy in range(y, y + height, dash * 2):
            self.fill_rect(x, yy, t, min(dash, y + height - yy), color)
            self.fill_rect(x + width - t, yy, t, min(dash, y + height - yy), color)

    def blit(self, src: "RGBImage | bytes", x: int, y: int, width: int, height: int) -> None:
        if isinstance(src, RGBImage):
            if src.width != width or src.height != height:
                raise ValueError("blit source dimensions do not match requested dimensions")
            data = src.pixels
        else:
            expected = width * height * 3
            if len(src) != expected:
                raise ValueError(f"raw frame has {len(src)} bytes, expected {expected}")
            data = src if isinstance(src, bytearray) else bytearray(src)
        if x < 0 or y < 0 or x + width > self.width or y + height > self.height:
            raise ValueError(
                f"blit rectangle {(x, y, width, height)} exceeds "
                f"{self.width}x{self.height}"
            )
        stride = width * 3
        dst_stride = self.width * 3
        for row in range(height):
            src_start = row * stride
            dst_start = ((y + row) * self.width + x) * 3
            self.pixels[dst_start : dst_start + stride] = data[src_start : src_start + stride]

    def draw_text(
        self,
        text: str,
        x: int,
        y: int,
        scale: int = 1,
        color: tuple[int, int, int] = (235, 238, 245),
        shadow: tuple[int, int, int] | None = (0, 0, 0),
    ) -> tuple[int, int]:
        return draw_text(self, text, x, y, scale=scale, color=color, shadow=shadow)

    def png_bytes(self) -> bytes:
        return encode_png(self)

    def save(self, path: str, ffmpeg_bin: str = "ffmpeg", quality: int = 3) -> None:
        if path.lower().endswith((".jpg", ".jpeg")):
            encode_jpeg_ffmpeg(self, path, ffmpeg_bin=ffmpeg_bin, quality=quality)
        else:
            with open(path, "wb") as fh:
                fh.write(self.png_bytes())


# A compact 5x7 font.  Every glyph is exactly seven strings of five chars.
FONT: dict[str, tuple[str, ...]] = {
    "0": ("01110", "10001", "10011", "10101", "11001", "10001", "01110"),
    "1": ("00100", "01100", "00100", "00100", "00100", "00100", "01110"),
    "2": ("01110", "10001", "00001", "00010", "00100", "01000", "11111"),
    "3": ("11110", "00001", "00001", "01110", "00001", "00001", "11110"),
    "4": ("00010", "00110", "01010", "10010", "11111", "00010", "00010"),
    "5": ("11111", "10000", "11110", "00001", "00001", "10001", "01110"),
    "6": ("00110", "01000", "10000", "11110", "10001", "10001", "01110"),
    "7": ("11111", "00001", "00010", "00100", "01000", "01000", "01000"),
    "8": ("01110", "10001", "10001", "01110", "10001", "10001", "01110"),
    "9": ("01110", "10001", "10001", "01111", "00001", "00010", "01100"),
    "A": ("01110", "10001", "10001", "11111", "10001", "10001", "10001"),
    "B": ("11110", "10001", "10001", "11110", "10001", "10001", "11110"),
    "C": ("01111", "10000", "10000", "10000", "10000", "10000", "01111"),
    "D": ("11110", "10001", "10001", "10001", "10001", "10001", "11110"),
    "E": ("11111", "10000", "10000", "11110", "10000", "10000", "11111"),
    "F": ("11111", "10000", "10000", "11110", "10000", "10000", "10000"),
    "G": ("01111", "10000", "10000", "10111", "10001", "10001", "01111"),
    "H": ("10001", "10001", "10001", "11111", "10001", "10001", "10001"),
    "I": ("01110", "00100", "00100", "00100", "00100", "00100", "01110"),
    "J": ("00111", "00010", "00010", "00010", "10010", "10010", "01100"),
    "K": ("10001", "10010", "10100", "11000", "10100", "10010", "10001"),
    "L": ("10000", "10000", "10000", "10000", "10000", "10000", "11111"),
    "M": ("10001", "11011", "10101", "10101", "10001", "10001", "10001"),
    "N": ("10001", "11001", "10101", "10011", "10001", "10001", "10001"),
    "O": ("01110", "10001", "10001", "10001", "10001", "10001", "01110"),
    "P": ("11110", "10001", "10001", "11110", "10000", "10000", "10000"),
    "Q": ("01110", "10001", "10001", "10001", "10101", "10010", "01101"),
    "R": ("11110", "10001", "10001", "11110", "10100", "10010", "10001"),
    "S": ("01111", "10000", "10000", "01110", "00001", "00001", "11110"),
    "T": ("11111", "00100", "00100", "00100", "00100", "00100", "00100"),
    "U": ("10001", "10001", "10001", "10001", "10001", "10001", "01110"),
    "V": ("10001", "10001", "10001", "10001", "10001", "01010", "00100"),
    "W": ("10001", "10001", "10001", "10101", "10101", "11011", "10001"),
    "X": ("10001", "10001", "01010", "00100", "01010", "10001", "10001"),
    "Y": ("10001", "10001", "01010", "00100", "00100", "00100", "00100"),
    "Z": ("11111", "00001", "00010", "00100", "01000", "10000", "11111"),
    " ": ("00000",) * 7,
    "#": ("00101", "00101", "11111", "01010", "11111", "10100", "10100"),
    ".": ("00000", "00000", "00000", "00000", "00000", "00110", "00110"),
    ":": ("00000", "00110", "00110", "00000", "00110", "00110", "00000"),
    "/": ("00001", "00010", "00010", "00100", "01000", "01000", "10000"),
    "-": ("00000", "00000", "00000", "11111", "00000", "00000", "00000"),
    "_": ("00000", "00000", "00000", "00000", "00000", "00000", "11111"),
    "(": ("00010", "00100", "01000", "01000", "01000", "00100", "00010"),
    ")": ("01000", "00100", "00010", "00010", "00010", "00100", "01000"),
    "[": ("01110", "01000", "01000", "01000", "01000", "01000", "01110"),
    "]": ("01110", "00010", "00010", "00010", "00010", "00010", "01110"),
    ">": ("01000", "00100", "00010", "00100", "01000", "00000", "00000"),
    "=": ("00000", "00000", "11111", "00000", "11111", "00000", "00000"),
    "+": ("00000", "00100", "00100", "11111", "00100", "00100", "00000"),
    "?": ("01110", "10001", "00001", "00010", "00100", "00000", "00100"),
    "!": ("00100", "00100", "00100", "00100", "00100", "00000", "00100"),
}

GLYPH_W = 5
GLYPH_H = 7
CHAR_ADVANCE = 6


def text_size(text: str, scale: int = 1) -> tuple[int, int]:
    if not text:
        return 0, GLYPH_H * scale
    return (len(text) * CHAR_ADVANCE - 1) * scale, GLYPH_H * scale


def draw_text(
    img: RGBImage,
    text: str,
    x: int,
    y: int,
    scale: int = 1,
    color: tuple[int, int, int] = (235, 238, 245),
    shadow: tuple[int, int, int] | None = (0, 0, 0),
) -> tuple[int, int]:
    scale = max(1, scale)
    cursor = x
    for ch in text.upper():
        glyph = FONT.get(ch, FONT["?"])
        if shadow is not None:
            _draw_glyph(img, glyph, cursor + scale, y + scale, scale, shadow)
        _draw_glyph(img, glyph, cursor, y, scale, color)
        cursor += CHAR_ADVANCE * scale
    return text_size(text, scale)


def _draw_glyph(
    img: RGBImage,
    glyph: Iterable[str],
    x: int,
    y: int,
    scale: int,
    color: tuple[int, int, int],
) -> None:
    for row, bits in enumerate(glyph):
        for col, bit in enumerate(bits):
            if bit == "1":
                img.fill_rect(x + col * scale, y + row * scale, scale, scale, color)


def parse_color(value: str | None, default: tuple[int, int, int] = (0, 0, 0)) -> tuple[int, int, int]:
    if value is None:
        return default
    v = value.strip()
    named = {
        "black": (0, 0, 0),
        "white": (255, 255, 255),
        "red": (220, 38, 38),
        "green": (34, 197, 94),
        "blue": (37, 99, 235),
        "yellow": (250, 204, 21),
        "gray": (107, 114, 128),
        "grey": (107, 114, 128),
        "dark": (17, 24, 39),
        "cell": (43, 50, 66),
        "page": (24, 28, 38),
    }
    if v.lower() in named:
        return named[v.lower()]
    if v.startswith("#"):
        h = v[1:]
        if len(h) == 3:
            h = "".join(c * 2 for c in h)
        if len(h) == 6:
            try:
                return tuple(int(h[i : i + 2], 16) for i in (0, 2, 4))  # type: ignore[return-value]
            except ValueError:
                pass
    raise ValueError(f"unsupported color {value!r}; use #RRGGBB or a basic name")


def ffmpeg_color(value: str) -> str:
    r, g, b = parse_color(value)
    return f"0x{r:02X}{g:02X}{b:02X}"


def encode_png(img: RGBImage) -> bytes:
    raw = bytearray()
    stride = img.width * 3
    for y in range(img.height):
        raw.append(0)  # filter type 0
        raw.extend(img.pixels[y * stride : (y + 1) * stride])

    def chunk(kind: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + kind
            + data
            + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", img.width, img.height, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(bytes(raw), 6))
        + chunk(b"IEND", b"")
    )


def encode_jpeg_ffmpeg(
    img: RGBImage,
    path: str,
    ffmpeg_bin: str = "ffmpeg",
    quality: int = 3,
) -> None:
    cmd = [
        ffmpeg_bin,
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "rawvideo",
        "-pixel_format",
        "rgb24",
        "-video_size",
        f"{img.width}x{img.height}",
        "-i",
        "pipe:0",
        "-frames:v",
        "1",
        "-q:v",
        str(max(2, min(31, quality))),
        path,
    ]
    proc = subprocess.run(cmd, input=bytes(img.pixels), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.decode("utf-8", "replace"))


def read_image_size(path: str) -> tuple[int, int]:
    """Read PNG/JPEG dimensions without a third-party library."""
    with open(path, "rb") as fh:
        head = fh.read(64 * 1024)
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        if len(head) < 24:
            raise ValueError("truncated PNG header")
        width, height = struct.unpack(">II", head[16:24])
        return width, height
    if head.startswith(b"\xff\xd8"):
        idx = 2
        data = head
        while idx + 9 < len(data):
            if data[idx] != 0xFF:
                idx += 1
                continue
            marker = data[idx + 1]
            if marker in (0xC0, 0xC1, 0xC2, 0xC3):
                height, width = struct.unpack(">HH", data[idx + 5 : idx + 9])
                return width, height
            length = struct.unpack(">H", data[idx + 2 : idx + 4])[0]
            idx += 2 + length
        raise ValueError("could not find JPEG frame dimensions")
    raise ValueError("unsupported image format")
