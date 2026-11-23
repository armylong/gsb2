"""SRT parsing / serialisation and cue text helpers.

Times are stored as integer milliseconds throughout the tool so that all
arithmetic (snapping, offsets, comparisons) is exact.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Iterable, List, Optional, Sequence

# ---------------------------------------------------------------------------
# Time helpers
# ---------------------------------------------------------------------------

_TS = re.compile(r"^\s*(?:(\d+):)?(\d{1,3}):(\d{1,2})(?:[,.](\d{1,3}))?\s*$")
_DOT_TS = re.compile(r"^\s*(?:(\d+):)?(\d{1,2}):(\d{1,2})[.](\d{1,3})\s*$")


def parse_timestamp(text: str) -> int:
    """Parse ``HH:MM:SS,mmm`` (or ``H:MM:SS.mmm`` etc.) into milliseconds.

    Raises :class:`ValueError` when the text is not a timestamp.
    """
    text = text.strip()
    m = _TS.match(text)
    if m:
        hours = int(m.group(1) or 0)
        minutes = int(m.group(2))
        seconds = int(m.group(3))
        frac = m.group(4) or "0"
    else:
        m = _DOT_TS.match(text)
        if not m:
            raise ValueError(f"not a timestamp: {text!r}")
        hours = int(m.group(1) or 0)
        minutes = int(m.group(2))
        seconds = int(m.group(3))
        frac = m.group(4)
    # "1" -> 100 ms, "12" -> 120 ms, "123" -> 123 ms
    millis = int(frac.ljust(3, "0")[:3])
    if seconds > 59:
        raise ValueError(f"seconds out of range: {text!r}")
    return ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis


def ms_to_timestamp(ms: int) -> str:
    """Format milliseconds as ``HH:MM:SS,mmm``."""
    ms = max(0, int(round(ms)))
    hours, rem = divmod(ms, 3_600_000)
    minutes, rem = divmod(rem, 60_000)
    seconds, millis = divmod(rem, 1000)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d},{millis:03d}"


def ms_to_short(ms: int) -> str:
    """Compact human format ``[MM:]SS.mmm`` for dense UI columns."""
    ms = max(0, int(round(ms)))
    minutes, rem = divmod(ms, 60_000)
    seconds, millis = divmod(rem, 1000)
    return f"{minutes:02d}:{seconds:02d}.{millis:03d}"


def parse_short(text: str) -> int:
    """Parse ``SS.mmm``, ``MM:SS.mmm``, ``HH:MM:SS,mmm`` or plain seconds."""
    text = text.strip()
    if not text:
        raise ValueError("empty time")
    m = re.match(r"^(?:(\d+):)?(\d+):(\d+(?:[.,]\d{1,3})?)$", text)
    if m:
        return parse_timestamp(text.replace(".", ","))
    m = re.match(r"^(\d+):(\d+(?:[.,]\d{1,3})?)$", text)
    if m:
        minutes = int(m.group(1))
        sec = float(m.group(2).replace(",", "."))
        return int(round(minutes * 60_000 + sec * 1000))
    sec = float(text.replace(",", "."))
    return int(round(sec * 1000))


# ---------------------------------------------------------------------------
# SRT data model
# ---------------------------------------------------------------------------


class SrtParseError(ValueError):
    pass


@dataclass
class SrtCue:
    start_ms: int
    end_ms: int
    text: str
    index: Optional[int] = None

    @property
    def lines(self) -> List[str]:
        return self.text.splitlines() or [""]

    @property
    def duration_ms(self) -> int:
        return self.end_ms - self.start_ms


_TIMING_LINE = re.compile(
    r"^\s*(?P<a>[\d:,.]+)\s*-->\s*(?P<b>[\d:,.]+)(?:\s+.*)?$"
)


def parse_srt(content: str) -> List[SrtCue]:
    """Parse SRT text into cues, tolerating BOM, CRLF and missing indices."""
    if content.startswith("﻿"):
        content = content[1:]
    content = content.replace("\r\n", "\n").replace("\r", "\n")
    cues: List[SrtCue] = []
    blocks = re.split(r"\n\s*\n", content.strip("\n")) if content.strip() else []
    for bi, block in enumerate(blocks):
        lines = block.split("\n")
        # trim leading blank lines inside a block
        while lines and not lines[0].strip():
            lines.pop(0)
        if not lines:
            continue
        idx: Optional[int] = None
        timing_at = 0
        if not _TIMING_LINE.match(lines[0]):
            try:
                idx = int(lines[0].strip())
            except ValueError:
                raise SrtParseError(
                    f"block {bi + 1}: expected index or timing line, got {lines[0]!r}"
                )
            timing_at = 1
        if timing_at >= len(lines):
            raise SrtParseError(f"block {bi + 1}: missing timing line")
        m = _TIMING_LINE.match(lines[timing_at])
        if not m:
            raise SrtParseError(
                f"block {bi + 1}: malformed timing line {lines[timing_at]!r}"
            )
        try:
            start = parse_timestamp(m.group("a"))
            end = parse_timestamp(m.group("b"))
        except ValueError as exc:
            raise SrtParseError(f"block {bi + 1}: {exc}") from exc
        if end < start:
            raise SrtParseError(
                f"block {bi + 1}: end {ms_to_timestamp(end)} before start "
                f"{ms_to_timestamp(start)}"
            )
        text = "\n".join(lines[timing_at + 1 :]).strip("\n")
        cues.append(SrtCue(start, end, text, idx))
    return cues


def build_srt(cues: Iterable[SrtCue]) -> str:
    """Serialise cues to SRT text with sequential indices."""
    out = []
    ordered = sorted(cues, key=lambda c: (c.start_ms, c.end_ms))
    for n, cue in enumerate(ordered, start=1):
        out.append(str(n))
        out.append(f"{ms_to_timestamp(cue.start_ms)} --> {ms_to_timestamp(cue.end_ms)}")
        out.append(cue.text)
        out.append("")
    return "\n".join(out)


# ---------------------------------------------------------------------------
# Scene / cut points
# ---------------------------------------------------------------------------

_CUT_SINGLE = re.compile(
    r"^\s*(?:\d+:)?\d{1,2}:\d{1,2}(?:[.,]\d{1,3})?\s*$"
    r"|^\s*\d+(?:[.,]\d{1,3})?\s*$"
)
_CUT_RANGE = re.compile(r"^\s*(?P<a>\S+)\s*(?:-->|\.\.\.|~|\s)\s*(?P<b>\S+)\s*$")


def parse_cut_list(content: str) -> List[int]:
    """Parse a column of scene cut points.

    Accepts a file that also contains an optional header line and cut times as
    seconds (``12.5``), ``MM:SS.mmm`` or ``HH:MM:SS,mmm``, one per line.
    ``a --> b`` shot ranges are accepted too (the start of the shot is the
    cut).  Blank lines and ``#`` comments are ignored.
    """
    cuts: List[int] = []
    for raw in content.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        # take the first token if there's a tab-separated preview column
        first = line.split("\t")[0].strip()
        if not first:
            continue
        # A timestamp contains a comma as the ms separator, so try the single
        # form before treating anything as an "a, b" pair.
        if _CUT_SINGLE.match(first):
            try:
                cuts.append(parse_short(first))
            except ValueError:
                continue
            continue
        m = _CUT_RANGE.match(first)
        if not m:
            continue
        a_text = m.group("a")
        # ``a --> b`` describes a scene range; its start is the cut point.
        # A bare ``a b`` is far more likely two columns than a range.
        if not re.search(r"-->|\.\.\.|~", first):
            try:
                cuts.append(parse_short(a_text))
            except ValueError:
                pass
            continue
        try:
            cuts.append(parse_short(a_text))
        except ValueError:
            continue
    return sorted(set(cuts))


def format_cut_column(cuts: Sequence[int]) -> str:
    header = "# scene cuts — one per line (seconds, or MM:SS.mmm); editable\n"
    return header + "\n".join(f"{ms_to_timestamp(c)}" for c in cuts) + "\n"


# ---------------------------------------------------------------------------
# Pairing helpers
# ---------------------------------------------------------------------------


def normalize_for_match(text: str) -> str:
    """Strip markup and punctuation, lowercase — used for loose similarity."""
    text = re.sub(r"<[^>]+>", "", text)
    text = re.sub(r"\{\\[^}]*\}", "", text)
    text = re.sub(r"[^\w一-鿿]+", " ", text.lower())
    return " ".join(text.split())


def char_bigrams(text: str) -> set:
    text = normalize_for_match(text).replace(" ", "")
    return {text[i : i + 2] for i in range(len(text) - 1)} if len(text) > 1 else set()


def bigram_similarity(a: str, b: str) -> float:
    ta = normalize_for_match(a).replace(" ", " ")
    if not ta or not b:
        return 0.0
    # token overlap + character overlap; useful for CJK where words are short
    ta_chars = set(normalize_for_match(a).replace(" ", ""))
    tb_chars = set(normalize_for_match(b).replace(" ", ""))
    char_j = len(ta_chars & tb_chars) / max(1, len(ta_chars | tb_chars))
    ba, bb = char_bigrams(a), char_bigrams(b)
    big_j = len(ba & bb) / max(1, len(ba | bb)) if (ba or bb) else 0.0
    return 0.55 * char_j + 0.45 * big_j


def time_overlap(a_start: int, a_end: int, b_start: int, b_end: int) -> float:
    """Overlap in ms (0 if none)."""
    return max(0, min(a_end, b_end) - max(a_start, b_start))


def overlap_ratio(a_start: int, a_end: int, b_start: int, b_end: int) -> float:
    """Intersection over the shorter cue duration (0..1)."""
    inter = time_overlap(a_start, a_end, b_start, b_end)
    shorter = max(1, min(a_end - a_start, b_end - b_start))
    return inter / shorter


def merge_intervals(intervals: Iterable[tuple]) -> List[tuple]:
    out: List[tuple] = []
    for start, end in sorted(intervals):
        if end <= start:
            continue
        if out and start <= out[-1][1]:
            out[-1] = (out[-1][0], max(out[-1][1], end))
        else:
            out.append((start, end))
    return out


def covers_point(intervals: Iterable[tuple], t: int) -> bool:
    return any(s <= t < e for s, e in intervals)
