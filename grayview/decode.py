"""把原始字节按 Interpretation 解码成灰度图。

缺失的像素不会填 0，而是由 ``valid`` 掩膜标成未知；0 只在像素确实有效时出现。
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .layout import Interpretation, Layout, ParamError, PixelSource, pixel_source

# 12 位模式下，numpy 一次取位时多读一个字节也无妨（用 0 补齐），
# 真正是否有效由“需要字节是否在文件内”判定。
_MAX_VALUE = {8: 0xFF, 16: 0xFFFF, 12: 0xFFF}


@dataclass
class Decoded:
    interp: Interpretation
    layout: Layout
    values: np.ndarray      # (height, width) uint16，无效像素处无意义（不要读）
    valid: np.ndarray       # (height, width) bool
    file_size: int

    @property
    def width(self) -> int:
        return self.interp.width

    @property
    def height(self) -> int:
        return self.interp.height

    @property
    def max_value(self) -> int:
        return _MAX_VALUE[self.interp.bpp]

    @property
    def missing_count(self) -> int:
        return int((~self.valid).sum())

    @property
    def missing(self) -> bool:
        return bool((~self.valid).any())

    def value_at(self, row: int, col: int) -> int | None:
        if not (0 <= row < self.height and 0 <= col < self.width):
            raise ParamError(f"像素 ({row}, {col}) 超出图像范围")
        if not self.valid[row, col]:
            return None
        return int(self.values[row, col])

    def source_at(self, row: int, col: int) -> PixelSource:
        return pixel_source(self.interp, row, col)

    def present_bits(self, src: PixelSource) -> int:
        """像素需要的位中，文件里实际存在的位数（0..bpp）。"""
        avail = self.layout.rows[src.row].available
        stop = src.row_start + avail
        return sum(
            p.count
            for p in src.parts
            if src.row_start <= p.file_byte < stop
        )


def decode(data: bytes | bytearray | memoryview, interp: Interpretation) -> Decoded:
    """解码整个文件；越界/缺失按掩膜处理，不抛像素级异常。"""
    size = len(data)
    layout = Layout.compute(interp, size)
    h, w = interp.height, interp.width
    values = np.zeros((h, w), dtype=np.uint16)
    valid = np.zeros((h, w), dtype=bool)
    if size:
        buf = np.frombuffer(data, dtype=np.uint8)
    else:
        buf = np.empty(0, dtype=np.uint8)

    bpp = interp.bpp
    rb = interp.row_bytes
    for r in range(h):
        row_layout = layout.rows[r]
        start = row_layout.start
        avail = row_layout.available
        if avail <= 0:
            continue
        seg_end = start + avail
        if bpp == 8:
            n = min(avail, w)
            if n:
                values[r, :n] = buf[start:seg_end]
                valid[r, :n] = True
            continue

        if bpp == 16:
            n = min(avail // 2, w)
            if n:
                pair = buf[start:start + 2 * n].reshape(n, 2)
                values[r, :n] = pair[:, 0].astype(np.uint16) | (
                    pair[:, 1].astype(np.uint16) << 8
                )
                valid[r, :n] = True
            continue

        # 12 位：每行从最低位开始连续打包
        n = min(avail * 8 // 12, w)
        if n:
            padded = np.zeros(avail + 2, dtype=np.uint8)
            padded[:avail] = buf[start:seg_end]
            bit0 = 12 * np.arange(n, dtype=np.int64)
            idx = bit0 // 8
            shift = (bit0 % 8).astype(np.uint8)
            word = (
                padded[idx].astype(np.uint32)
                | (padded[idx + 1].astype(np.uint32) << 8)
                | (padded[idx + 2].astype(np.uint32) << 16)
            )
            values[r, :n] = ((word >> shift) & 0xFFF).astype(np.uint16)
            valid[r, :n] = True

    return Decoded(interp=interp, layout=layout, values=values, valid=valid, file_size=size)


def asset_scale(decoded: Decoded) -> np.ndarray:
    """给界面/缩略图用的 8 位显示数组；无效像素填 0（绘制时另有掩膜覆盖）。"""
    maxv = decoded.max_value
    if decoded.interp.bpp == 8:
        out = decoded.values.astype(np.uint8)
    elif decoded.interp.bpp == 16:
        out = (decoded.values >> 8).astype(np.uint8)
    else:
        out = (decoded.values.astype(np.uint32) * 255 // maxv).astype(np.uint8)
    out = np.where(decoded.valid, out, 0).astype(np.uint8)
    return np.ascontiguousarray(out)
