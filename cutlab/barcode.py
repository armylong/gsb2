"""烧录到样例画面顶部的机器可读帧号条码。

布局（以 640x360 为基准，按输出尺寸等比缩放）::

    [安静区][sync 4][data 12][check 6]
     4 位同步 = 1,0,1,0（黑,白,黑,白）
    12 位帧号（MSB 在前，支持 0..4095）
     6 位校验 = ((data * 37 + 11) ^ (data >> 6)) & 0x3F

方块足够大（约 27x36 像素），可承受 H.264 重编码与 4:2:0 色度抽样。
解码只依赖亮度，不依赖字体或 OCR。
"""

from __future__ import annotations

from dataclasses import dataclass

BASE_WIDTH = 640
BASE_HEIGHT = 360
MARGIN_RATIO = 16 / BASE_WIDTH
CELL_H_RATIO = 36 / BASE_HEIGHT
Y_RATIO = 12 / BASE_HEIGHT

N_SYNC = 4
N_DATA = 12
N_CHECK = 6
N_CELLS = N_SYNC + N_DATA + N_CHECK
MAX_FRAME = (1 << N_DATA) - 1
SYNC = (1, 0, 1, 0)


def checksum(data: int) -> int:
    return ((data * 37 + 11) ^ (data >> 6)) & ((1 << N_CHECK) - 1)


def encode_bits(frame_index: int) -> list[int]:
    if not 0 <= frame_index <= MAX_FRAME:
        raise ValueError(f"帧号超出条码容量: {frame_index}")
    data = [(frame_index >> (N_DATA - 1 - i)) & 1 for i in range(N_DATA)]
    chk = [(checksum(frame_index) >> (N_CHECK - 1 - i)) & 1 for i in range(N_CHECK)]
    return list(SYNC) + data + chk


@dataclass(frozen=True, slots=True)
class Geometry:
    width: int
    height: int
    margin: int
    cell: int
    cell_h: int
    y: int

    @property
    def total_width(self) -> int:
        return N_CELLS * self.cell

    @property
    def x0(self) -> int:
        return (self.width - self.total_width) // 2


def geometry(width: int, height: int) -> Geometry:
    margin = max(4, round(width * MARGIN_RATIO))
    cell = max(4, (width - 2 * margin) // N_CELLS)
    cell_h = max(6, round(height * CELL_H_RATIO))
    y = max(2, round(height * Y_RATIO))
    if y + cell_h + 2 > height:
        y = max(2, height - cell_h - 2)
    return Geometry(width, height, margin, cell, cell_h, y)


@dataclass(slots=True)
class BarcodeResult:
    frame_index: int | None
    sync_ok: bool
    checksum_ok: bool
    contrast: float
    bits: list[int]

    @property
    def ok(self) -> bool:
        return self.frame_index is not None


def _luma(r: int, g: int, b: int) -> float:
    return 0.299 * r + 0.587 * g + 0.114 * b


def decode_identity(rgb: bytes, width: int, height: int) -> BarcodeResult:
    """从 RGB24 原始帧中解码帧号。"""
    geo = geometry(width, height)
    stride = width * 3
    means: list[float] = []
    half_w = max(1, geo.cell // 4)
    half_h = max(1, geo.cell_h // 4)
    cx0 = geo.x0 + geo.cell // 2
    cy = geo.y + geo.cell_h // 2
    for k in range(N_CELLS):
        cx = cx0 + k * geo.cell
        total = 0.0
        count = 0
        for py in range(cy - half_h, cy + half_h):
            if not 0 <= py < height:
                continue
            row = py * stride
            for px in range(cx - half_w, cx + half_w):
                if not 0 <= px < width:
                    continue
                off = row + px * 3
                total += _luma(rgb[off], rgb[off + 1], rgb[off + 2])
                count += 1
        means.append(total / count if count else 0.0)

    low, high = min(means), max(means)
    contrast = high - low
    threshold = (low + high) / 2.0
    bits = [1 if m < threshold else 0 for m in means]

    sync_ok = tuple(bits[:N_SYNC]) == SYNC and contrast >= 25
    data = 0
    for bit in bits[N_SYNC:N_SYNC + N_DATA]:
        data = (data << 1) | bit
    got = 0
    for bit in bits[N_SYNC + N_DATA:]:
        got = (got << 1) | bit
    checksum_ok = got == checksum(data)
    frame = data if (sync_ok and checksum_ok) else None
    return BarcodeResult(frame, sync_ok, checksum_ok, contrast, bits)
