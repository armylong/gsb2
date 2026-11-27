"""文件布局与每像素的取位几何。

术语全部按文件字节线性排列来定义：

    行 r 的起头      head(r) = skip + r * (row_bytes + gap)
    行的像素字节数   row_bytes = 8 位: width
                               16 位小端: 2 * width
                               12 位连续打包: ceil(width * 12 / 8)
    行尾(含)         head(r) + row_bytes - 1
    下一行之前空白   gap 字节, 位于 head(r) + row_bytes .. head(r+1)-1

12 位模式是一行一行独立的位流，每行都从该行第一个字节的 **最低位** 开始向上填：
像素 c 占该行位流的 [12*c, 12*c+12) 位；文件字节的 bit0 是 LSB。等价于
把该行字节当成一个小端整数，每像素取值 ``(row_int >> (12*c)) & 0xFFF``。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterable

SUPPORTED_BPP = (8, 12, 16)
MAX_PIXELS = 120_000_000


class ParamError(ValueError):
    """解释参数或文件布局不合法。"""


def _as_int(name: str, value: Any, minimum: int = 0) -> int:
    try:
        out = int(value)
    except (TypeError, ValueError):
        raise ParamError(f"{name} 必须是整数，收到 {value!r}") from None
    if out < minimum:
        raise ParamError(f"{name} 不能小于 {minimum}，收到 {out}")
    return out


@dataclass(frozen=True)
class Interpretation:
    """一份“解释参数”，即怎样把原始文件解释成灰度图。"""

    width: int
    height: int
    skip: int = 0
    row_gap: int = 0
    bpp: int = 8

    def __post_init__(self) -> None:
        w = _as_int("width", self.width, 1)
        h = _as_int("height", self.height, 1)
        skip = _as_int("skip", self.skip, 0)
        gap = _as_int("row_gap", self.row_gap, 0)
        bpp = _as_int("bpp", self.bpp, 0)
        if bpp not in SUPPORTED_BPP:
            raise ParamError(f"每像素位数只支持 {SUPPORTED_BPP}，收到 {bpp}")
        if w * h > MAX_PIXELS:
            raise ParamError(
                f"宽×高 = {w * h} 超过上限 {MAX_PIXELS}，请先缩小检查范围"
            )
        object.__setattr__(self, "width", w)
        object.__setattr__(self, "height", h)
        object.__setattr__(self, "skip", skip)
        object.__setattr__(self, "row_gap", gap)
        object.__setattr__(self, "bpp", bpp)

    # -- 派生布局 -------------------------------------------------------
    @property
    def row_bytes(self) -> int:
        if self.bpp == 8:
            return self.width
        if self.bpp == 16:
            return self.width * 2
        return (self.width * 12 + 7) // 8

    @property
    def stride(self) -> int:
        return self.row_bytes + self.row_gap

    @property
    def required_bytes(self) -> int:
        return self.skip + self.height * self.row_bytes + (self.height - 1) * self.row_gap

    def row_start(self, row: int) -> int:
        return self.skip + row * self.stride

    def row_tail(self, row: int) -> int:
        """行像素区最后一个字节的文件偏移（含）；计划值，不一定存在。"""
        return self.row_start(row) + self.row_bytes - 1

    def row_gap_span(self, row: int) -> tuple[int, int, int]:
        """(gap 起始, gap 结束含, gap 字节数)；gap 为空时返回长度 0。"""
        if self.row_gap == 0:
            start = self.row_start(row) + self.row_bytes
            return start, start - 1, 0
        start = self.row_start(row) + self.row_bytes
        return start, start + self.row_gap - 1, self.row_gap

    def row_pixels_per_byte(self) -> float | None:
        if self.bpp == 12:
            return 2 / 3
        return None

    def as_dict(self) -> dict[str, int]:
        return {
            "width": self.width,
            "height": self.height,
            "skip": self.skip,
            "row_gap": self.row_gap,
            "bpp": self.bpp,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Interpretation":
        return cls(
            width=data.get("width"),
            height=data.get("height"),
            skip=data.get("skip", 0),
            row_gap=data.get("row_gap", data.get("gap", 0)),
            bpp=data.get("bpp", data.get("bit_depth", 8)),
        )

    def summary_lines(self) -> list[str]:
        rb = self.row_bytes
        if self.bpp == 8:
            mode = "8 位：每像素 1 字节"
            formula = f"每行字节 = 宽 = {rb}"
        elif self.bpp == 16:
            mode = "16 位小端：每像素 2 字节，低字节在前"
            formula = f"每行字节 = 2×宽 = {rb}"
        else:
            mode = "12 位：每行独立从最低位连续打包"
            formula = f"每行字节 = ceil(12×宽/8) = {rb}"
        return [
            mode,
            formula,
            f"行步长 = 每行字节 + 行间空白 = {rb} + {self.row_gap} = {self.stride} B",
            f"行 r 头字节 = {self.skip} + r×{self.stride}；行尾字节 = 头 + {rb} - 1",
            f"整图需要 = skip + H×每行字节 + (H-1)×gap = {self.required_bytes} B",
        ]


@dataclass(frozen=True)
class BitPart:
    """像素的一个字节片段，以及它在文件与灰度值中的位位置。"""

    file_byte: int          # 绝对文件字节偏移
    file_bit_start: int     # 该字节内起始位（含，0 = LSB）
    file_bit_end: int       # 该字节内结束位（含）
    value_bit_start: int    # 该片段写入灰度值的起始位（含）
    value_bit_end: int      # 至结束位（含）

    @property
    def count(self) -> int:
        return self.file_bit_end - self.file_bit_start + 1


@dataclass(frozen=True)
class PixelSource:
    """一个像素需要从文件哪些字节取哪些位。"""

    row: int
    col: int
    row_start: int
    row_bytes: int
    bpp: int
    needed_bytes: tuple[int, ...]       # 绝对字节偏移, 由低到高
    parts: tuple[BitPart, ...]
    value_mask: int
    lacks_low_byte: bool = False        # 预留：非小端时用

    @property
    def first_byte(self) -> int:
        return self.needed_bytes[0]

    @property
    def last_byte(self) -> int:
        return self.needed_bytes[-1]

    @property
    def byte_span(self) -> int:
        return self.last_byte - self.first_byte + 1


def pixel_source(interp: Interpretation, row: int, col: int) -> PixelSource:
    """给出像素 (row, col) 的取位几何，不读取文件。"""
    if not (0 <= row < interp.height):
        raise ParamError(f"行 {row} 超出 0..{interp.height - 1}")
    if not (0 <= col < interp.width):
        raise ParamError(f"列 {col} 超出 0..{interp.width - 1}")

    rs = interp.row_start(row)
    rb = interp.row_bytes
    if interp.bpp == 8:
        parts = (BitPart(rs + col, 0, 7, 0, 7),)
        return PixelSource(row, col, rs, rb, 8, (rs + col,), parts, 0xFF)

    if interp.bpp == 16:
        b = rs + 2 * col
        parts = (
            BitPart(b, 0, 7, 0, 7),
            BitPart(b + 1, 0, 7, 8, 15),
        )
        return PixelSource(row, col, rs, rb, 16, (b, b + 1), parts, 0xFFFF)

    # 12 位低地址 -> 高地址；每行从最低位开始连续填。
    bit0 = 12 * col
    sh = bit0 % 8
    b0 = rs + bit0 // 8
    nbytes = (sh + 12 + 7) // 8
    need = tuple(b0 + i for i in range(nbytes))
    parts_list: list[BitPart] = []
    for i in range(nbytes):
        v_lo = max(0, 8 * i - sh)
        v_hi_ex = min(12, 8 * (i + 1) - sh)
        if v_lo >= v_hi_ex:
            continue
        f_lo = v_lo + sh - 8 * i
        f_hi = v_hi_ex + sh - 8 * i - 1
        parts_list.append(BitPart(b0 + i, f_lo, f_hi, v_lo, v_hi_ex - 1))
    total_bits = sum(p.count for p in parts_list)
    if total_bits != 12:  # pragma: no cover - 防御性
        raise ParamError(f"12 位取位几何异常：{total_bits} 位")
    return PixelSource(row, col, rs, rb, 12, need, tuple(parts_list), 0xFFF)


@dataclass
class RowLayout:
    row: int
    start: int
    row_bytes: int
    gap_start: int
    gap_end: int
    gap: int
    available: int
    complete_pixels: int
    status: str  # complete | partial | absent

    @property
    def end_required(self) -> int:
        return self.start + self.row_bytes

    @property
    def tail(self) -> int:
        """计划的行尾字节（含）；行不存在也有计划值。"""
        return self.end_required - 1

    status_text = {
        "complete": "完整",
        "partial": "仅部分字节",
        "absent": "此行为空/未到达",
    }

    def status_label(self) -> str:
        return self.status_text[self.status]


@dataclass
class Layout:
    """参数 + 实际文件大小得到的行布局。"""

    interp: Interpretation
    file_size: int
    rows: list[RowLayout]
    required_bytes: int
    shortfall: int
    extra_start: int | None
    extra_bytes: int
    extra_range: tuple[int, int] | None
    partial_rows: list[int] = field(default_factory=list)
    absent_rows: list[int] = field(default_factory=list)

    @classmethod
    def compute(cls, interp: Interpretation, file_size: int) -> "Layout":
        if file_size < 0:
            raise ParamError("文件大小不能为负")
        rb = interp.row_bytes
        rows: list[RowLayout] = []
        partial: list[int] = []
        absent: list[int] = []
        for r in range(interp.height):
            start = interp.row_start(r)
            avail = min(max(file_size - start, 0), rb)
            if interp.bpp == 8:
                complete_px = avail
            elif interp.bpp == 16:
                complete_px = avail // 2
            else:
                complete_px = min(avail * 8 // 12, interp.width)
            status = "complete" if avail >= rb else ("partial" if avail > 0 else "absent")
            if status == "partial":
                partial.append(r)
            elif status == "absent":
                absent.append(r)
            gs, ge, g = interp.row_gap_span(r)
            rows.append(
                RowLayout(
                    row=r,
                    start=start,
                    row_bytes=rb,
                    gap_start=gs,
                    gap_end=ge,
                    gap=g,
                    available=avail,
                    complete_pixels=complete_px,
                    status=status,
                )
            )
        required = interp.required_bytes
        shortfall = max(required - file_size, 0)
        if file_size > required:
            extra_start = required
            extra_bytes = file_size - required
            extra_range = (required, file_size - 1)
        else:
            extra_start = None
            extra_bytes = 0
            extra_range = None
        return cls(
            interp=interp,
            file_size=file_size,
            rows=rows,
            required_bytes=required,
            shortfall=shortfall,
            extra_start=extra_start,
            extra_bytes=extra_bytes,
            extra_range=extra_range,
            partial_rows=partial,
            absent_rows=absent,
        )

    # -- 便捷查询 -------------------------------------------------------
    def row_available(self, row: int) -> int:
        return self.rows[row].available

    def row_status(self, row: int) -> str:
        return self.rows[row].status

    def present_bytes_in_row(self, row: int) -> int:
        return min(self.rows[row].available, self.rows[row].row_bytes)

    def missing_byte_offsets(self, src: PixelSource) -> tuple[int, ...]:
        avail = self.rows[src.row].available
        stop = src.row_start + avail
        return tuple(b for b in src.needed_bytes if not (src.row_start <= b < stop))

    def present_byte_offsets(self, src: PixelSource) -> tuple[int, ...]:
        avail = self.rows[src.row].available
        stop = src.row_start + avail
        return tuple(b for b in src.needed_bytes if src.row_start <= b < stop)

    def source_complete(self, src: PixelSource) -> bool:
        return not self.missing_byte_offsets(src)


def format_range(first: int, last: int) -> str:
    return f"0x{first:08X}..0x{last:08X}"


def iter_row_indices(count: int, limit: int | None = None) -> Iterable[int]:
    return range(count if limit is None else min(count, limit))
