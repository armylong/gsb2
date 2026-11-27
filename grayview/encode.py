"""按解释参数把灰度数组写回原始字节（用于生成样本和往返测试）。

只实现工具支持的三种表达：
    8 位      每像素 1 字节
    16 位小端 低字节在前
    12 位     每行从该行首字节的最低位开始连续打包，行尾不足一字节的高位补 0
"""

from __future__ import annotations

import numpy as np

from .layout import Interpretation, ParamError

_MAX = {8: 0xFF, 16: 0xFFFF, 12: 0xFFF}


def check_values(values: np.ndarray, interp: Interpretation) -> np.ndarray:
    arr = np.asarray(values, dtype=np.int64)
    if arr.shape != (interp.height, interp.width):
        raise ParamError(
            f"数组形状应为 {(interp.height, interp.width)}，收到 {arr.shape}"
        )
    if arr.size and (arr.min() < 0 or arr.max() > _MAX[interp.bpp]):
        raise ParamError(
            f"灰度值超出 {interp.bpp} 位范围 0..{_MAX[interp.bpp]}"
        )
    return arr


def _pack_row_12(vals: np.ndarray) -> bytes:
    """把一行值从 LSB 连续打包成 ceil(12*n/8) 字节。"""
    n = vals.size
    word = 0
    for c in range(n):
        word |= int(vals[c]) << (12 * c)
    nbytes = (12 * n + 7) // 8
    return word.to_bytes(nbytes, "little")


def pack_rows(
    values: np.ndarray,
    interp: Interpretation,
    *,
    skip_fill: int = 0xA5,
    gap_fill: int = 0x5A,
    trailing_gap: bool = False,
) -> bytes:
    """按 interp 生成完整字节流（含前置区与行间空白）。

    skip_fill/gap_fill 用来让“跳过的字节”和“空白字节”在原始字节视图里一眼可见。
    trailing_gap=True 时最后一行后也写 gap（部分旧程序这样写，文件会比
    required_bytes 多 gap 字节）。
    """
    vals = check_values(values, interp)
    out = bytearray([skip_fill & 0xFF]) * interp.skip
    for r in range(interp.height):
        row = vals[r]
        if interp.bpp == 8:
            out += row.astype(np.uint8).tobytes()
        elif interp.bpp == 16:
            out += np.stack([row.astype(np.uint8), (row >> 8).astype(np.uint8)], 1).tobytes()
        else:
            out += _pack_row_12(row)
        if interp.row_gap and (trailing_gap or r != interp.height - 1):
            out += bytes([gap_fill & 0xFF]) * interp.row_gap
    return bytes(out)
