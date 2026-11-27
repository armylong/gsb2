"""共用的“查一个像素”与“缺失/多余字节”描述，CLI 与 GUI 都调用这里。

保证界面、命令行、导出复核三处对同一个像素给出完全一致的读数。
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .decode import Decoded
from .layout import BitPart, Layout, PixelSource


@dataclass
class PixelReport:
    row: int
    col: int
    valid: bool
    value: int | None
    value_hex: str
    bpp: int
    needed_bytes: tuple[int, ...]
    present_bytes: tuple[int, ...]
    missing_bytes: tuple[int, ...]
    parts: tuple[BitPart, ...]
    row_start: int
    row_tail: int
    source: PixelSource

    def byte_hex(self, data: bytes, b: int) -> str | None:
        if 0 <= b < len(data):
            return f"{data[b]:02X}"
        return None

    def parts_text(self, data: bytes) -> list[str]:
        out = []
        for p in self.parts:
            b = data[p.file_byte] if 0 <= p.file_byte < len(data) else None
            present = b is not None
            byte_txt = f"0x{p.file_byte:08X}" + (f"={b:02X}" if present else "（缺）")
            out.append(
                f"字节 {byte_txt} 的 bit{p.file_bit_start}..bit{p.file_bit_end}"
                f" → 灰度 bit{p.value_bit_start}..bit{p.value_bit_end}"
            )
        return out

    def needed_bytes_text(self) -> str:
        if len(self.needed_bytes) == 1:
            return f"0x{self.needed_bytes[0]:08X}"
        return (
            f"0x{self.needed_bytes[0]:08X}..0x{self.needed_bytes[-1]:08X}"
            f"（{len(self.needed_bytes)} 字节）"
        )


def describe_pixel(dec: Decoded, data: bytes, row: int, col: int) -> PixelReport:
    src = dec.source_at(row, col)
    valid = bool(dec.valid[row, col])
    value = int(dec.values[row, col]) if valid else None
    present = dec.layout.present_byte_offsets(src)
    missing = dec.layout.missing_byte_offsets(src)
    layout_row = dec.layout.rows[row]
    return PixelReport(
        row=row,
        col=col,
        valid=valid,
        value=value,
        value_hex=f"0x{value:04X}" if value is not None else "—",
        bpp=dec.interp.bpp,
        needed_bytes=src.needed_bytes,
        present_bytes=present,
        missing_bytes=missing,
        parts=src.parts,
        row_start=layout_row.start,
        row_tail=layout_row.tail,
        source=src,
    )


@dataclass
class Coverage:
    last_complete_pixel: tuple[int, int] | None
    last_complete_pixel_offset: int | None
    first_missing_offset: int | None
    missing_span: tuple[int, int] | None
    extra_span: tuple[int, int] | None
    partial_rows: list[int]
    absent_rows: list[int]
    first_partial_row: int | None
    note_lines: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {
            "last_complete_pixel": self.last_complete_pixel,
            "last_complete_pixel_offset": self.last_complete_pixel_offset,
            "first_missing_offset": self.first_missing_offset,
            "missing_span": self.missing_span,
            "extra_span": self.extra_span,
            "partial_rows": self.partial_rows,
            "absent_rows": self.absent_rows,
            "first_partial_row": self.first_partial_row,
            "note_lines": self.note_lines,
        }


def coverage(dec: Decoded) -> Coverage:
    """最后一个完整像素、缺失起点、多余字节、部分/空缺行，各自区分说明。"""
    lay = dec.layout
    last: tuple[int, int] | None = None
    last_off: int | None = None
    if dec.valid.any():
        flat = int(dec.valid.size - 1 - dec.valid.ravel()[::-1].argmax())
        r, c = divmod(flat, dec.width)
        last = (r, c)
        src = dec.source_at(r, c)
        last_off = src.last_byte
        # 同一像素内可能跨字节，取最后一个实际存在的字节
        present = lay.present_byte_offsets(src)
        last_off = present[-1] if present else None

    first_missing = dec.file_size if lay.shortfall > 0 else None
    missing_span = (
        (dec.file_size, lay.required_bytes - 1) if lay.shortfall > 0 else None
    )
    extra_span = lay.extra_range

    notes: list[str] = []
    if first_missing is not None:
        notes.append(
            f"文件 {dec.file_size} B 短于所需 {lay.required_bytes} B，"
            f"缺 {lay.shortfall} B；缺失从文件尾 0x{first_missing:08X} 开始，"
            f"到 0x{lay.required_bytes - 1:08X} 为止"
        )
    if lay.extra_bytes:
        assert lay.extra_range is not None
        notes.append(
            f"文件比所需多 {lay.extra_bytes} B，位于 "
            f"0x{lay.extra_range[0]:08X}..0x{lay.extra_range[1]:08X}，"
            "这些字节不属于任何像素（可能是尾随数据或参数偏小）"
        )
    if lay.partial_rows:
        notes.append(f"部分行 {lay.partial_rows}：只读到该行一部分字节，行内后段像素未知")
    if lay.absent_rows:
        notes.append(f"空缺行 {lay.absent_rows}：该行一个字节都没读到，整行未知")
    if last is not None:
        notes.append(
            f"最后一个完整像素 ({last[0]}, {last[1]})，"
            f"其最后一个字节 0x{last_off:08X}" if last_off is not None else ""
        )
    else:
        notes.append("没有任何完整像素")
    notes = [n for n in notes if n]
    return Coverage(
        last_complete_pixel=last,
        last_complete_pixel_offset=last_off,
        first_missing_offset=first_missing,
        missing_span=missing_span,
        extra_span=extra_span,
        partial_rows=list(lay.partial_rows),
        absent_rows=list(lay.absent_rows),
        first_partial_row=lay.partial_rows[0] if lay.partial_rows else None,
        note_lines=notes,
    )
