"""Split planning: which source samples go into which output file.

Two modes for a lead-in (INDEX 00) region at a boundary:

* ``TAIL`` – the lead-in belongs to the **previous** track's file, the current
  track's file starts at its INDEX 01.
* ``HEAD`` – the lead-in belongs to the **current** track's file, the previous
  track's file ends just before the INDEX 00 point.

The very first lead-in (everything before the first sheet point) may be saved
as its own file; otherwise it is prepended to track 1.  Track 1's own lead-in
(if it has INDEX 00) always ends up in track 1's file in both modes because
there is no previous track to own it.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field, replace
from enum import Enum
from typing import List, Optional, Tuple

from .model import AudioInfo, CueSheet, Segment
from .timeutil import sample_at


class SplitMode(str, Enum):
    TAIL = "tail"
    HEAD = "head"

    @property
    def label(self) -> str:
        return {
            SplitMode.TAIL: "前导归上一轨末尾",
            SplitMode.HEAD: "前导归本轨开头",
        }[self]

    @property
    def short_label(self) -> str:
        return {SplitMode.TAIL: "归前轨", SplitMode.HEAD: "归本轨"}[self]


@dataclass
class Plan:
    mode: SplitMode
    head_lead_separate: bool
    segments: List[Segment] = field(default_factory=list)
    info: Optional[AudioInfo] = None
    sheet: Optional[CueSheet] = None
    # Non-fatal notes produced while planning (e.g. dropped zero-length file)
    notes: List[str] = field(default_factory=list)

    @property
    def total_samples(self) -> int:
        return self.info.total_samples if self.info else 0

    def tiles_whole_file(self) -> bool:
        """True when segments cover [0, total) exactly once."""
        if not self.segments:
            return False
        expected = 0
        for seg in self.segments:
            if seg.first_sample != expected:
                return False
            if seg.last_sample < seg.first_sample:
                return False
            expected = seg.last_sample + 1
        return expected == self.total_samples

    def ownership_problems(self) -> List[str]:
        """Concrete, human-readable description of any tiling defect."""
        problems: List[str] = []
        if not self.segments:
            return ["没有任何输出段"]
        expected = 0
        for seg in self.segments:
            if seg.first_sample > expected:
                problems.append(
                    f"采样 {expected}..{seg.first_sample - 1} 没有任何输出文件接收"
                    f"（{seg.sample_count} 个采样漏读）"
                )
            elif seg.first_sample < expected:
                problems.append(
                    f"采样 {seg.first_sample}..{expected - 1} 被重复写入"
                    f"（{expected - seg.first_sample} 个采样重读）"
                )
            if seg.last_sample < seg.first_sample:
                problems.append(f"{seg.label} 是空段（{seg.first_sample}..{seg.last_sample}）")
            expected = max(expected, seg.last_sample + 1)
        if expected < self.total_samples:
            problems.append(
                f"采样 {expected}..{self.total_samples - 1} 没有任何输出文件接收"
                f"（{self.total_samples - expected} 个采样漏读）"
            )
        return problems

    def owner_of_sample(self, sample: int) -> Optional[Segment]:
        if not self.segments or sample < 0 or sample >= self.total_samples:
            return None
        # Segments are sorted and contiguous.
        lo, hi = 0, len(self.segments) - 1
        while lo <= hi:
            mid = (lo + hi) // 2
            seg = self.segments[mid]
            if sample < seg.first_sample:
                hi = mid - 1
            elif sample > seg.last_sample:
                lo = mid + 1
            else:
                return seg
        return None

    def segment_for_sheet_index(self, index: int) -> Optional[Segment]:
        for seg in self.segments:
            if seg.sheet_index == index:
                return seg
        return None


_BAD_FS_CHARS = re.compile(r'[\\/:*?"<>|\x00-\x1f]')


def safe_filename(text: str) -> str:
    cleaned = _BAD_FS_CHARS.sub("_", text).strip().strip(".")
    cleaned = re.sub(r"\s+", " ", cleaned)
    return cleaned or "未命名"


def track_file_name(number: int, title: str) -> str:
    base = f"{number:02d}"
    if title.strip():
        base += f" - {safe_filename(title)}"
    return base + ".wav"


HEAD_LEAD_FILE = "00 - 整卷前导.wav"


def boundary_points(sheet: CueSheet, info: AudioInfo) -> List[Tuple[int, int, str]]:
    """Every INDEX point as ``(sample, sheet_index, kind)``.

    ``kind`` is ``"index00"`` or ``"index01"``.  Used to populate the
    "audition a boundary" selector and ruler markers.
    """
    pts: List[Tuple[int, int, str]] = []
    for i, tr in enumerate(sheet.tracks):
        if tr.lead is not None:
            pts.append((sample_at(tr.lead, info.samplerate), i, "index00"))
        pts.append((sample_at(tr.start, info.samplerate), i, "index01"))
    pts.sort(key=lambda p: (p[0], p[1], 0 if p[2] == "index00" else 1))
    return pts


@dataclass(frozen=True)
class Junction:
    """A boundary that can be auditioned across both split modes.

    ``sample`` is the source position the "junction" is centred on and never
    changes with the split mode.  ``true_split`` is the absolute sample where
    the previous file ends / next file begins under a given mode.
    """

    sheet_index: int
    label: str
    sample: int
    lead_start: Optional[int]  # sample of this track's INDEX 00
    start: int  # this track's INDEX 01

    def true_split(self, mode: SplitMode, info: AudioInfo) -> int:
        if mode == SplitMode.TAIL or self.lead_start is None:
            return self.start
        return self.lead_start

    def owner_text(self, mode: SplitMode) -> str:
        if self.lead_start is None:
            return f"无前导：从采样 {self.start} 起归 T{self.sheet_index + 1:02d}"
        if mode == SplitMode.TAIL:
            return (
                f"{self.lead_start}..{self.start - 1} 写入上一轨文件末尾；"
                f"T{self.sheet_index + 1:02d} 从 {self.start} 起"
            )
        return (
            f"{self.lead_start}..{self.start - 1} 写入 T{self.sheet_index + 1:02d} 文件开头；"
            f"上一轨在 {self.lead_start - 1} 结束"
        )


def junctions(sheet: CueSheet, info: AudioInfo) -> List[Junction]:
    """Boundaries auditionable across modes: every track after the first.

    Track 1 has no previous track, so its lead region is not switchable; it
    is still listed for the "head lead" decision, handled separately.
    """
    out: List[Junction] = []
    for i, tr in enumerate(sheet.tracks):
        if i == 0:
            continue
        lead = sample_at(tr.lead, info.samplerate) if tr.lead is not None else None
        start = sample_at(tr.start, info.samplerate)
        centre = lead if lead is not None else start
        title = f"T{tr.number:02d}"
        if tr.title:
            title += f" {tr.title}"
        out.append(
            Junction(
                sheet_index=i,
                label=title,
                sample=centre,
                lead_start=lead,
                start=start,
            )
        )
    return out


def build_plan(
    sheet: CueSheet,
    info: AudioInfo,
    mode: SplitMode,
    head_lead_separate: bool,
) -> Plan:
    """Produce a plan whose segments tile the whole source exactly.

    Assumes ``validate_against_audio`` has already rejected out-of-order and
    out-of-range sheets; a defensive clamp is still applied so the GUI never
    crashes on a broken sheet.
    """
    plan = Plan(mode=mode, head_lead_separate=head_lead_separate, info=info, sheet=sheet)
    if not sheet.tracks:
        plan.notes.append("cue 中没有 TRACK，无法拆分")
        return plan

    sr = info.samplerate
    total = info.total_samples
    tracks = sheet.tracks
    starts = [sample_at(tr.start, sr) for tr in tracks]
    displays = [sample_at(tr.display_start, sr) for tr in tracks]
    names: List[str] = []
    used = set()
    for tr in tracks:
        base = track_file_name(tr.number, tr.title)
        name = base
        n = 2
        while name in used:
            name = base[:-4] + f" ({n}).wav"
            n += 1
        used.add(name)
        names.append(name)

    head_end = displays[0]
    if head_lead_separate:
        if head_end > 0:
            seg = Segment(
                first_sample=0,
                last_sample=head_end - 1,
                sheet_index=-1,
                kind="head_lead",
                label="整卷前导",
                file_name=HEAD_LEAD_FILE,
            )
            plan.segments.append(seg)
        first_file_start = head_end
    else:
        first_file_start = 0

    def clamp(v: int) -> int:
        return max(0, min(v, total))

    for i, tr in enumerate(tracks):
        if i == 0:
            start = clamp(first_file_start)
        else:
            if mode == SplitMode.TAIL:
                start = starts[i]
            else:
                start = displays[i]
            start = max(clamp(start), plan.segments[-1].last_sample + 1 if plan.segments else 0)
        if i + 1 < len(tracks):
            if mode == SplitMode.TAIL:
                end = starts[i + 1]
            else:
                end = displays[i + 1]
        else:
            end = total
        end = clamp(end)
        if end <= start:
            plan.notes.append(
                f"T{tr.number:02d} 在当前拆法下长度为 0（采样 {start}..{end - 1}），已跳过生成空文件"
            )
            continue
        last = end - 1
        # If the previous segment was skipped, the next one starts where it
        # ended; recompute the end from the following boundary instead.
        # (Both conditions cannot normally occur on a validated sheet.)
        label = f"T{tr.number:02d}"
        if tr.title:
            label += f" {tr.title}"
        plan.segments.append(
            Segment(
                first_sample=start,
                last_sample=last,
                sheet_index=i,
                kind="track",
                label=label,
                file_name=names[i],
            )
        )

    # Keep tiling true even if something above was skipped: extend the
    # previous segment to absorb any hole/overlap introduced by a skip.
    repaired: List[Segment] = []
    for seg in plan.segments:
        if repaired and seg.first_sample > repaired[-1].last_sample + 1:
            repaired[-1] = replace(repaired[-1], last_sample=seg.first_sample - 1)
        elif repaired and seg.first_sample <= repaired[-1].last_sample:
            seg = replace(seg, first_sample=repaired[-1].last_sample + 1)
        repaired.append(seg)
    if repaired and repaired[-1].last_sample < total - 1:
        repaired[-1] = replace(repaired[-1], last_sample=total - 1)
    plan.segments = repaired
    return plan


def intrinsic_regions(
    sheet: CueSheet, info: AudioInfo
) -> List[Tuple[int, int, str, int]]:
    """Mode-independent regions: (first, last, kind, sheet_index).

    ``kind`` is ``"head_lead"`` (before track 1's first sheet point),
    ``"lead"`` (a track's INDEX 00..INDEX 01 gap) or ``"track"``.
    """
    out: List[Tuple[int, int, str, int]] = []
    if not sheet.tracks:
        return out
    first_start = sample_at(sheet.tracks[0].display_start, info.samplerate)
    if first_start > 0:
        out.append((0, first_start - 1, "head_lead", -1))
    for i, tr in enumerate(sheet.tracks):
        lead = sample_at(tr.lead, info.samplerate) if tr.lead is not None else None
        start = sample_at(tr.start, info.samplerate)
        track_end = (
            sample_at(sheet.tracks[i + 1].display_start, info.samplerate)
            if i + 1 < len(sheet.tracks)
            else info.total_samples
        )
        if lead is not None and start > lead:
            out.append((lead, start - 1, "lead", i))
            if track_end > start:
                out.append((start, track_end - 1, "track", i))
        elif start < track_end:
            out.append((start, track_end - 1, "track", i))
    return out


def member_track_index(sheet: CueSheet, info: AudioInfo, sample: int) -> int:
    """Sheet entry a sample belongs to (by lead-in boundary), -1 before first.

    This is independent of the split mode: a lead region belongs to the
    upcoming track in cue terms.  The split mode only decides which *file*
    receives it.
    """
    if not sheet.tracks:
        return -1
    idx = -1
    for i, tr in enumerate(sheet.tracks):
        if sample >= sample_at(tr.display_start, info.samplerate):
            idx = i
        else:
            break
    return idx


def in_track_offset(sheet: CueSheet, info: AudioInfo, sample: int, index: Optional[int] = None) -> int:
    """Samples relative to the entry's INDEX 01 (negative while in its lead)."""
    if index is None:
        index = member_track_index(sheet, info, sample)
    if index < 0:
        # Head lead: count down to the first track's INDEX 01.
        if not sheet.tracks:
            return sample
        return sample - sample_at(sheet.tracks[0].start, info.samplerate)
    return sample - sample_at(sheet.tracks[index].start, info.samplerate)


def is_in_lead(sheet: CueSheet, info: AudioInfo, sample: int) -> bool:
    idx = member_track_index(sheet, info, sample)
    if idx < 0:
        return True if sheet.tracks else False
    tr = sheet.tracks[idx]
    return sample < sample_at(tr.start, info.samplerate)
