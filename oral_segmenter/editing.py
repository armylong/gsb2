"""人工编辑段的纯函数: 越界与重叠约束都在这里统一处理。

所有函数返回新的列表, 不修改入参; 边界一律为整数帧 (sample frame)。
人工编辑过的段会被标记 ``pinned=True``, 供“重新分析时保留指定段”使用。
"""

from __future__ import annotations

from dataclasses import replace
from typing import Sequence

from .segmentation import Segment


def _clamp(value: int, low: int, high: int) -> int:
    if high < low:
        return low
    return max(low, min(value, high))


def _with_manual(seg: Segment, start: int, end: int) -> Segment:
    return replace(
        seg, start=start, end=end, pinned=True, adjusted=True, origin="manual"
    )


def resize_segment(
    segments: Sequence[Segment],
    index: int,
    start: int,
    end: int,
    total_frames: int,
    min_length: int = 1,
) -> list[Segment]:
    """调整第 index 段的边界, 自动夹在相邻段之间且至少 min_length 帧。"""
    if not 0 <= index < len(segments):
        raise IndexError("段索引越界")
    min_length = max(1, int(min_length))
    left = segments[index - 1].end if index > 0 else 0
    right = segments[index + 1].start if index + 1 < len(segments) else total_frames

    if right - left < min_length:
        # 相邻段之间已没有足够空位, 保持原样而不是制造重叠。
        return list(segments)

    start = _clamp(int(start), left, right - min_length)
    end = _clamp(int(end), start + min_length, right)

    updated = list(segments)
    updated[index] = _with_manual(segments[index], start, end)
    return updated


def move_segment(
    segments: Sequence[Segment],
    index: int,
    new_start: int,
    total_frames: int,
    min_length: int = 1,
) -> list[Segment]:
    """整体平移第 index 段, 保持长度不变, 不越过相邻段和文件边界。"""
    if not 0 <= index < len(segments):
        raise IndexError("段索引越界")
    seg = segments[index]
    length = seg.length
    left = segments[index - 1].end if index > 0 else 0
    right = (
        segments[index + 1].start if index + 1 < len(segments) else total_frames
    )
    if right - left < length:
        # 邻段空间不足时退化为原地不动, 而不是产生重叠。
        return list(segments)
    start = _clamp(int(new_start), left, right - length)
    updated = list(segments)
    updated[index] = _with_manual(seg, start, start + length)
    return updated


def insert_segment(
    segments: Sequence[Segment],
    start: int,
    end: int,
    total_frames: int,
    min_length: int = 1,
) -> tuple[list[Segment], int | None]:
    """在空白区插入新段, 返回 (新列表, 新段索引)。

    请求区间若与已有段相交, 只保留最长的空闲片段; 不足 min_length 则放弃。
    """
    min_length = max(1, int(min_length))
    start = _clamp(int(start), 0, total_frames)
    end = _clamp(int(end), 0, total_frames)
    if end < start:
        start, end = end, start
    if end <= start:
        return list(segments), None

    pieces = [(start, end)]
    for seg in segments:
        next_pieces: list[tuple[int, int]] = []
        for a, b in pieces:
            if seg.end <= a or seg.start >= b:
                next_pieces.append((a, b))
                continue
            if a < seg.start:
                next_pieces.append((a, seg.start))
            if seg.end < b:
                next_pieces.append((seg.end, b))
        pieces = next_pieces
        if not pieces:
            break

    pieces = [(a, b) for a, b in pieces if b - a >= min_length]
    if not pieces:
        return list(segments), None
    a, b = max(pieces, key=lambda piece: piece[1] - piece[0])
    updated = sorted(
        [*segments, Segment(start=a, end=b, pinned=True, adjusted=True,
                            origin="manual")],
        key=lambda s: (s.start, s.end),
    )
    index = next(
        i for i, seg in enumerate(updated)
        if seg.start == a and seg.end == b and seg.origin == "manual"
    )
    return updated, index


def delete_segment(segments: Sequence[Segment], index: int) -> list[Segment]:
    if not 0 <= index < len(segments):
        raise IndexError("段索引越界")
    return [seg for i, seg in enumerate(segments) if i != index]


def clear_pins(segments: Sequence[Segment]) -> list[Segment]:
    """取消所有人工锁定; 下次分析将完全重算。"""
    return [
        replace(seg, pinned=False, adjusted=False,
                origin="auto" if seg.origin in ("manual", "pinned") else seg.origin)
        for seg in segments
    ]
