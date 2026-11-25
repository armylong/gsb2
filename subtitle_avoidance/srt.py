"""SRT 读写。"""

from __future__ import annotations

import re
from pathlib import Path

from .model import Cue

_TIME_RE = re.compile(
    r"(?P<h>\d+):(?P<m>\d{1,2}):(?P<s>\d{1,2})[,.](?P<ms>\d{1,3})"
)
_TAG_RE = re.compile(r"<[^>]+>|\{[^}]+\}")


def parse_timestamp(value: str) -> float:
    m = _TIME_RE.search(value.strip())
    if not m:
        raise ValueError(f"无法解析 SRT 时间: {value!r}")
    h = int(m.group("h"))
    minute = int(m.group("m"))
    sec = int(m.group("s"))
    ms_text = m.group("ms").ljust(3, "0")
    ms = int(ms_text)
    return h * 3600 + minute * 60 + sec + ms / 1000.0


def format_timestamp(seconds: float, comma: bool = True) -> str:
    if seconds < 0:
        seconds = 0.0
    total_ms = int(round(seconds * 1000))
    h, rem = divmod(total_ms, 3_600_000)
    m, rem = divmod(rem, 60_000)
    s, ms = divmod(rem, 1000)
    sep = "," if comma else "."
    return f"{h:02d}:{m:02d}:{s:02d}{sep}{ms:03d}"


def clean_text(text: str) -> str:
    # SRT/ASS 内联标签不参与实际字形占位。
    text = _TAG_RE.sub("", text)
    return text.replace("\r", "").strip("\n")


def parse_srt(content: str) -> list[Cue]:
    if content.startswith("﻿"):
        content = content[1:]
    content = content.replace("\r\n", "\n").replace("\r", "\n")
    blocks = re.split(r"\n\s*\n", content.strip())
    cues: list[Cue] = []
    auto = 0
    for block in blocks:
        lines = [ln for ln in block.split("\n") if ln.strip() != ""]
        if not lines:
            continue
        time_line_idx = next(
            (i for i, ln in enumerate(lines) if "-->" in ln), None
        )
        if time_line_idx is None:
            continue
        start_s, end_s = lines[time_line_idx].split("-->", 1)
        start = parse_timestamp(start_s)
        end = parse_timestamp(end_s.split()[0])
        text = clean_text("\n".join(lines[time_line_idx + 1 :]))
        if end <= start or not text:
            continue
        auto += 1
        index = auto
        before = lines[:time_line_idx]
        if before and before[0].strip().isdigit():
            index = int(before[0].strip())
        cues.append(
            Cue(id=f"cue_{auto}", index=index, start=start, end=end, text=text)
        )
    return cues


def read_srt(path: str | Path) -> list[Cue]:
    return parse_srt(Path(path).read_text(encoding="utf-8-sig"))


def write_srt(path: str | Path, cues: list[Cue]) -> None:
    chunks: list[str] = []
    for n, cue in enumerate(cues, 1):
        chunks.append(
            f"{n}\n"
            f"{format_timestamp(cue.start)} --> {format_timestamp(cue.end)}\n"
            f"{cue.text.strip()}\n"
        )
    Path(path).write_text("\n".join(chunks), encoding="utf-8")
