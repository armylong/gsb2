from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from .errors import MkvToolError, ffmpeg_path
from .runner import run_capture

_TIME_RE = re.compile(
    r"(?P<h>\d+):(?P<m>\d{1,2}):(?P<s>\d{1,2})(?:[.,](?P<ms>\d{1,3}))?\s*-->\s*"
    r"(?P<h2>\d+):(?P<m2>\d{1,2}):(?P<s2>\d{1,2})(?:[.,](?P<ms2>\d{1,3}))?"
)


@dataclass(frozen=True)
class SubtitleCue:
    start: float
    end: float
    text: str
    index: int | str = ""

    def contains(self, seconds: float, *, inclusive_end: bool = True) -> bool:
        return self.start <= seconds and (seconds < self.end or inclusive_end and seconds == self.end)


def _ts_to_seconds(h: str, m: str, s: str, ms: str | None) -> float:
    frac = 0.0
    if ms:
        frac = int(ms.ljust(3, "0")) / 1000.0
    return int(h) * 3600 + int(m) * 60 + int(s) + frac


def parse_srt(content: str) -> list[SubtitleCue]:
    """Parse SRT content produced by FFmpeg.

    The parser is deliberately tolerant: malformed trailing blocks are ignored
    rather than preventing the rest of the cues from being inspected.
    """
    cues: list[SubtitleCue] = []
    content = content.replace("\r\n", "\n").replace("\r", "\n").lstrip("﻿")
    for block in re.split(r"\n\s*\n", content):
        lines = [line for line in block.split("\n") if line.strip() != ""]
        if not lines:
            continue
        time_line_no = next((i for i, line in enumerate(lines) if "-->" in line), None)
        if time_line_no is None:
            continue
        match = _TIME_RE.search(lines[time_line_no])
        if not match:
            continue
        start = _ts_to_seconds(
            match.group("h"), match.group("m"), match.group("s"), match.group("ms")
        )
        end = _ts_to_seconds(
            match.group("h2"), match.group("m2"), match.group("s2"), match.group("ms2")
        )
        before = lines[:time_line_no]
        index = before[0].strip() if before else len(cues) + 1
        text = "\n".join(lines[time_line_no + 1 :]).strip()
        if text:
            cues.append(SubtitleCue(start=start, end=end, text=text, index=index))
    return cues


def extract_subtitle_srt(
    path: str | Path, stream_index: int, *, ffmpeg: str | Path | None = None
) -> str:
    exe = ffmpeg_path(ffmpeg)
    result = run_capture(
        [
            exe,
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(path),
            "-map",
            f"0:{stream_index}",
            "-f",
            "srt",
            "-",
        ]
    )
    if result.returncode != 0:
        raise MkvToolError(
            f"字幕流 #{stream_index} 无法转换为文本预览：\n{result.stderr_tail()}"
        )
    return result.stdout.decode("utf-8-sig", errors="replace")


def cues_at(cues: list[SubtitleCue], seconds: float) -> list[SubtitleCue]:
    return [cue for cue in cues if cue.contains(seconds)]


def format_seconds(seconds: float) -> str:
    if seconds < 0:
        seconds = 0
    ms = int(round((seconds - int(seconds)) * 1000))
    total = int(seconds)
    h, rem = divmod(total, 3600)
    m, s = divmod(rem, 60)
    if ms == 1000:
        h += 0
        m += 0
        s += 1
        ms = 0
    return f"{h:02d}:{m:02d}:{s:02d}.{ms:03d}"
