"""极简 ISO BMFF / fragmented MP4 box 解析器.

只解析诊断需要的 box: ftyp/styp/moov(含 trak/mdia/stsd/trex)/moof(含 traf/tfhd/tfdt/trun)/mdat.
不依赖第三方库; 文件整体读入内存(分片文件通常很小).
"""
from __future__ import annotations

import struct
from dataclasses import dataclass, field
from typing import Dict, List, Optional

CONTAINER_TYPES = {
    b"moov", b"trak", b"mdia", b"minf", b"stbl", b"moof", b"traf",
    b"mvex", b"edts", b"dinf", b"udta",
}

# tfhd flags
TFHD_BASE_DATA_OFFSET = 0x000001
TFHD_SAMPLE_DESC = 0x000002
TFHD_DEFAULT_DURATION = 0x000008
TFHD_DEFAULT_SIZE = 0x000010
TFHD_DEFAULT_FLAGS = 0x000020
TFHD_DURATION_IS_EMPTY = 0x010000
TFHD_DEFAULT_BASE_IS_MOOF = 0x020000

# trun flags
TRUN_DATA_OFFSET = 0x000001
TRUN_FIRST_SAMPLE_FLAGS = 0x000004
TRUN_SAMPLE_DURATION = 0x000100
TRUN_SAMPLE_SIZE = 0x000200
TRUN_SAMPLE_FLAGS = 0x000400
TRUN_SAMPLE_CTS = 0x000800


@dataclass
class Box:
    type: str
    offset: int          # box 起始(含 header)在文件中的偏移
    size: int            # 声明的总大小(含 header)
    header_size: int
    children: List["Box"] = field(default_factory=list)
    data: dict = field(default_factory=dict)
    truncated: bool = False  # 声明大小超出文件剩余

    @property
    def payload_offset(self) -> int:
        return self.offset + self.header_size

    @property
    def payload_size(self) -> int:
        return max(0, self.size - self.header_size)

    def find(self, type_: str) -> List["Box"]:
        return [c for c in self.children if c.type == type_]

    def first(self, type_: str) -> Optional["Box"]:
        for c in self.children:
            if c.type == type_:
                return c
        return None


@dataclass
class FileStructure:
    path: str
    boxes: List[Box]
    trailing_bytes: int = 0       # 末尾不足以构成 box 的残余字节
    truncated_box: bool = False   # 存在声明大小超出文件的 box

    def top(self, type_: str) -> List[Box]:
        return [b for b in self.boxes if b.type == type_]

    @property
    def has_moov(self) -> bool:
        return any(b.type == "moov" for b in self.boxes)

    @property
    def has_moof(self) -> bool:
        return any(b.type == "moof" for b in self.boxes)


def _u32(buf: bytes, off: int) -> int:
    return struct.unpack_from(">I", buf, off)[0]


def _u64(buf: bytes, off: int) -> int:
    return struct.unpack_from(">Q", buf, off)[0]


def _i32(buf: bytes, off: int) -> int:
    return struct.unpack_from(">i", buf, off)[0]


def parse_file(path: str) -> FileStructure:
    with open(path, "rb") as f:
        buf = f.read()
    boxes, trailing, truncated = _parse_boxes(buf, 0, len(buf))
    return FileStructure(path=path, boxes=boxes,
                         trailing_bytes=trailing, truncated_box=truncated)


def _parse_boxes(buf: bytes, start: int, end: int):
    boxes: List[Box] = []
    pos = start
    truncated = False
    while pos + 8 <= end:
        size = _u32(buf, pos)
        typ = buf[pos + 4:pos + 8]
        header = 8
        if size == 1:
            if pos + 16 > end:
                truncated = True
                break
            size = _u64(buf, pos + 8)
            header = 16
        elif size == 0:
            size = end - pos  # 延伸到最后一个字节
        try:
            type_str = typ.decode("latin-1")
        except Exception:
            type_str = repr(typ)
        if size < header or pos + size > end:
            # 截断: size 记为实际可用字节, payload 反映真实剩余
            boxes.append(Box(type_str, pos, max(header, end - pos), header,
                             truncated=True))
            truncated = True
            break
        box = Box(type_str, pos, size, header)
        if typ in CONTAINER_TYPES:
            children, child_trailing, child_trunc = _parse_boxes(
                buf, pos + header, pos + size)
            box.children = children
            if child_trailing:
                box.data["_trailing"] = child_trailing
            if child_trunc:
                truncated = True
        else:
            box.data = _parse_leaf(typ, buf, pos + header, pos + size)
        boxes.append(box)
        pos += size
    trailing = end - pos if pos < end else 0
    return boxes, trailing, truncated


def _parse_leaf(typ: bytes, buf: bytes, start: int, end: int) -> dict:
    data: dict = {}
    n = end - start
    try:
        if typ == b"mfhd" and n >= 8:
            data["sequence_number"] = _u32(buf, start + 4)
        elif typ == b"tfhd" and n >= 8:
            flags = _u32(buf, start) & 0xFFFFFF
            data["flags"] = flags
            off = start + 4
            data["track_id"] = _u32(buf, off); off += 4
            if flags & TFHD_BASE_DATA_OFFSET:
                data["base_data_offset"] = _u64(buf, off); off += 8
            if flags & TFHD_SAMPLE_DESC:
                data["sample_description_index"] = _u32(buf, off); off += 4
            if flags & TFHD_DEFAULT_DURATION:
                data["default_sample_duration"] = _u32(buf, off); off += 4
            if flags & TFHD_DEFAULT_SIZE:
                data["default_sample_size"] = _u32(buf, off); off += 4
            if flags & TFHD_DEFAULT_FLAGS:
                data["default_sample_flags"] = _u32(buf, off); off += 4
            data["default_base_is_moof"] = bool(flags & TFHD_DEFAULT_BASE_IS_MOOF)
        elif typ == b"tfdt" and n >= 8:
            version = buf[start]
            if version == 1 and n >= 12:
                data["base_media_decode_time"] = _u64(buf, start + 4)
            else:
                data["base_media_decode_time"] = _u32(buf, start + 4)
        elif typ == b"trun" and n >= 8:
            _parse_trun(buf, start, end, data)
        elif typ == b"mdhd" and n >= 24:
            version = buf[start]
            if version == 1 and n >= 36:
                data["timescale"] = _u32(buf, start + 20)
                data["duration"] = _u64(buf, start + 24)
            else:
                data["timescale"] = _u32(buf, start + 12)
                data["duration"] = _u32(buf, start + 16)
        elif typ == b"hdlr" and n >= 12:
            data["handler_type"] = buf[start + 8:start + 12].decode("latin-1")
        elif typ == b"tkhd" and n >= 24:
            version = buf[start]
            data["track_id"] = _u32(buf, start + (20 if version == 1 else 12))
        elif typ == b"mvhd" and n >= 20:
            version = buf[start]
            if version == 1 and n >= 32:
                data["timescale"] = _u32(buf, start + 20)
                data["duration"] = _u64(buf, start + 24)
            else:
                data["timescale"] = _u32(buf, start + 12)
                data["duration"] = _u32(buf, start + 16)
        elif typ == b"trex" and n >= 24:
            data["track_id"] = _u32(buf, start + 4)
            data["default_sample_duration"] = _u32(buf, start + 12)
            data["default_sample_size"] = _u32(buf, start + 16)
            data["default_sample_flags"] = _u32(buf, start + 20)
        elif typ == b"stsd" and n >= 16:
            _parse_stsd(buf, start, end, data)
        elif typ == b"ftyp" or typ == b"styp":
            if n >= 8:
                data["major_brand"] = buf[start:start + 4].decode("latin-1")
    except (struct.error, IndexError):
        data["_parse_error"] = True
    return data


def _parse_trun(buf: bytes, start: int, end: int, data: dict) -> None:
    word = _u32(buf, start)
    version = (word >> 24) & 0xFF
    flags = word & 0xFFFFFF
    sample_count = _u32(buf, start + 4)
    data["flags"] = flags
    data["sample_count"] = sample_count
    off = start + 8
    if flags & TRUN_DATA_OFFSET:
        data["data_offset"] = _i32(buf, off); off += 4
    if flags & TRUN_FIRST_SAMPLE_FLAGS:
        data["first_sample_flags"] = _u32(buf, off); off += 4
    samples = []
    for _ in range(sample_count):
        s = {}
        if flags & TRUN_SAMPLE_DURATION:
            s["duration"] = _u32(buf, off); off += 4
        if flags & TRUN_SAMPLE_SIZE:
            s["size"] = _u32(buf, off); off += 4
        if flags & TRUN_SAMPLE_FLAGS:
            s["flags"] = _u32(buf, off); off += 4
        if flags & TRUN_SAMPLE_CTS:
            if version == 1:
                s["cts_offset"] = _i32(buf, off)
            else:
                s["cts_offset"] = _u32(buf, off)
            off += 4
        samples.append(s)
        if off > end:
            data["_parse_error"] = True
            break
    data["samples"] = samples


def _parse_stsd(buf: bytes, start: int, end: int, data: dict) -> None:
    entry_count = _u32(buf, start + 4)
    data["entry_count"] = entry_count
    if entry_count < 1:
        return
    eoff = start + 8
    esize = _u32(buf, eoff)
    fmt = buf[eoff + 4:eoff + 8].decode("latin-1")
    data["codec"] = fmt
    eend = min(eoff + esize, end)
    if fmt in ("avc1", "avc3", "hev1", "hvc1", "mp4v", "vp09", "av01"):
        if eoff + 36 <= eend:
            data["width"] = struct.unpack_from(">H", buf, eoff + 32)[0]
            data["height"] = struct.unpack_from(">H", buf, eoff + 34)[0]
    elif fmt in ("mp4a", "ac-3", "ec-3", "Opus", "alac"):
        if eoff + 36 <= eend:
            data["channels"] = struct.unpack_from(">H", buf, eoff + 24)[0]
            data["sample_rate"] = _u32(buf, eoff + 32) >> 16
