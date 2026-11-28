"""CUE sheet parsing and validation.

Only the single-file form is supported (one ``FILE`` line, audio split by
INDEX points).  Every reported problem carries the 1-based source line so the
UI can point at the exact place in the sheet that needs fixing.
"""

from __future__ import annotations

import os
import re
from fractions import Fraction
from typing import List, Optional, Tuple

from .model import AudioInfo, CueSheet, Track, TrackError, Warning
from .timeutil import format_clock as format_mmss
from .timeutil import format_mmssff as format_time
from .timeutil import sample_at as time_to_sample

FRAMES_PER_SECOND = 75  # CD cue sheets count 1/75 s frames.

_TIME_RE = re.compile(r"^([0-9]{1,3}):([0-9]{1,2}):([0-9]{1,2})(?:\.([0-9]+))?$")
_NUM_RE = re.compile(r"^[0-9]+$")


def parse_time(text: str) -> Fraction:
    """``MM:SS:FF`` (75 fps) -> Fraction seconds.

    Raises ValueError with a human-readable reason.
    """
    m = _TIME_RE.match(text.strip())
    if not m:
        raise ValueError(
            f"时间格式无效 “{text}”，应为 分:秒:帧 (MM:SS:FF, 帧率 75)"
        )
    mm, ss, ff = int(m.group(1)), int(m.group(2)), int(m.group(3))
    if ss >= 60:
        raise ValueError(f"秒数 {ss} 超出 0–59（{text}）")
    if ff >= FRAMES_PER_SECOND:
        raise ValueError(f"帧数 {ff} 超出 0–74（{text}）")
    base = Fraction(mm * 60 + ss) + Fraction(ff, FRAMES_PER_SECOND)
    if m.group(4):
        # Tolerate a fractional frame written as MM:SS:FF.fraction.
        base += Fraction(int(m.group(4)), 10 ** len(m.group(4))) / FRAMES_PER_SECOND
    return base


def sample_to_time(s: int, samplerate: int) -> Fraction:
    return Fraction(s, samplerate)


def _read_text(path: str) -> str:
    data = open(path, "rb").read()
    for enc in ("utf-8-sig", "utf-8", "gb18030", "big5"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace")


def parse_cue(path: str) -> CueSheet:
    """Parse a cue file.  Syntax problems become errors; no audio needed."""
    text = _read_text(path)
    sheet = CueSheet(filename=path, title="", performer="")

    current: Optional[dict] = None
    file_lines: List[Tuple[int, str]] = []
    seen_album_title = False

    def flush() -> None:
        nonlocal current
        if current is None:
            return
        if current["index01"] is None:
            sheet.errors.append(
                TrackError(
                    current["track_line"],
                    f"TRACK {current['number']:02d} 缺少 INDEX 01（正式起点）",
                    current["number"],
                    code="missing_index01",
                )
            )
            current = None
            return
        if current["index00"] is not None and current["index00"] > current["index01"]:
            sheet.errors.append(
                TrackError(
                    current["index00_line"],
                    f"TRACK {current['number']:02d} 的 INDEX 00 ({format_time(current['index00'])}) "
                    f"晚于 INDEX 01 ({format_time(current['index01'])})：前导起点应在正式起点之前",
                    current["number"],
                    code="lead_after_start",
                )
            )
        sheet.tracks.append(
            Track(
                number=current["number"],
                title=current["title"],
                artist=current["artist"],
                start=current["index01"],
                lead=current["index00"],
                source_line=current["track_line"],
                start_line=current["index01_line"],
                lead_line=current["index00_line"],
            )
        )
        current = None

    for lineno, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("REM"):
            continue
        parts = line.split()
        key = parts[0].upper()

        if key == "FILE":
            name = line[5:].strip()
            # Strip the trailing type (WAVE/MP3/...) and any quotes.
            m = re.match(r'"([^"]*)"(?:\s+[A-Za-z0-9]+)?$', name)
            if m:
                name = m.group(1)
            elif name.upper().endswith(" WAVE"):
                name = name[: -len(" WAVE")].strip()
            file_lines.append((lineno, name))
            continue

        if key == "TRACK":
            flush()
            if len(parts) < 3:
                sheet.errors.append(
                    TrackError(lineno, f"TRACK 行不完整：“{line}”", code="bad_track")
                )
                continue
            if not _NUM_RE.match(parts[1]):
                sheet.errors.append(
                    TrackError(
                        lineno,
                        f"TRACK 编号无效 “{parts[1]}”，应为十进制数字",
                        code="bad_track_number",
                    )
                )
                continue
            kind = parts[2].upper()
            if kind not in ("AUDIO", "MODE1/2352", "MODE2/2352", "CDG"):
                sheet.errors.append(
                    TrackError(
                        lineno,
                        f"不支持的轨道类型 “{parts[2]}”（本工具只处理 AUDIO 单文件）",
                        int(parts[1]),
                        code="bad_track_type",
                    )
                )
                continue
            current = {
                "number": int(parts[1]),
                "track_line": lineno,
                "title": "",
                "artist": "",
                "index00": None,
                "index01": None,
                "index00_line": 0,
                "index01_line": 0,
            }
            continue

        if key == "INDEX":
            if len(parts) < 3:
                sheet.errors.append(
                    TrackError(lineno, f"INDEX 行不完整：“{line}”", code="bad_index")
                )
                continue
            if current is None:
                sheet.errors.append(
                    TrackError(lineno, "INDEX 出现在任何 TRACK 之前", code="orphan_index")
                )
                continue
            if not _NUM_RE.match(parts[1]):
                sheet.errors.append(
                    TrackError(
                        lineno,
                        f"INDEX 编号无效 “{parts[1]}”",
                        current["number"],
                        code="bad_index_number",
                    )
                )
                continue
            idx = int(parts[1])
            try:
                t = parse_time(parts[2])
            except ValueError as exc:
                sheet.errors.append(
                    TrackError(lineno, str(exc), current["number"], code="bad_time")
                )
                continue
            if idx == 0:
                if current["index00"] is not None:
                    sheet.errors.append(
                        TrackError(
                            lineno,
                            f"TRACK {current['number']:02d} 重复的 INDEX 00"
                            f"（先前在第 {current['index00_line']} 行）",
                            current["number"],
                            code="duplicate_index00",
                        )
                    )
                else:
                    current["index00"] = t
                    current["index00_line"] = lineno
            elif idx == 1:
                if current["index01"] is not None:
                    sheet.errors.append(
                        TrackError(
                            lineno,
                            f"TRACK {current['number']:02d} 重复的 INDEX 01"
                            f"（先前在第 {current['index01_line']} 行）",
                            current["number"],
                            code="duplicate_index01",
                        )
                    )
                else:
                    current["index01"] = t
                    current["index01_line"] = lineno
            else:
                sheet.warnings.append(
                    Warning(
                        lineno,
                        f"INDEX {idx:02d}（TRACK {current['number']:02d}）不参与单文件拆分，已忽略",
                    )
                )
            continue

        if key == "TITLE":
            value = line[5:].strip().strip('"')
            if current is not None:
                current["title"] = value
            elif not seen_album_title:
                sheet.title = value
                seen_album_title = True
            else:
                sheet.errors.append(
                    TrackError(lineno, "TRACK 之外的第二个 TITLE 无法归属", code="orphan_title")
                )
            continue

        if key == "PERFORMER":
            value = line[len("PERFORMER"):].strip().strip('"')
            if current is not None:
                current["artist"] = value
            else:
                sheet.performer = value
            continue

        if key in ("CATALOG", "CDTEXTFILE", "ISRC", "FLAGS", "PREGAP", "POSTGAP", "SONGWRITER", "COMPOSER"):
            if key in ("PREGAP", "POSTGAP"):
                sheet.warnings.append(
                    Warning(lineno, f"{key} 在单文件拆分中不产生独立音频，已忽略")
                )
            continue

        sheet.errors.append(
            TrackError(lineno, f"无法识别的指令 “{parts[0]}”", code="unknown_directive")
        )

    flush()

    sheet.file_name = file_lines[0][1] if file_lines else ""
    sheet.file_line = file_lines[0][0] if file_lines else 0
    if not file_lines:
        sheet.errors.insert(
            0, TrackError(0, "缺少 FILE 行：单文件 cue 必须声明一个音频文件", code="missing_file")
        )
    elif len(file_lines) > 1:
        sheet.errors.insert(
            0,
            TrackError(
                file_lines[1][0],
                f"cue 含 {len(file_lines)} 个 FILE（第 {file_lines[0][0]}、{file_lines[1][0]} 行…），"
                "本工具只支持单文件 cue",
                code="multiple_files",
            ),
        )
    sheet.parse_errors = list(sheet.errors)
    sheet.parse_warnings = list(sheet.warnings)
    sheet.file_name = file_lines[0][1] if file_lines else ""
    sheet.file_line = file_lines[0][0] if file_lines else 0
    return sheet


def validate_against_audio(sheet: CueSheet, info: AudioInfo) -> None:
    """Rebuild ``sheet.errors``/``warnings`` for this WAV.

    Parse problems are preserved; audio-dependent problems (order, points off
    the file) are recomputed, so swapping WAVs never accumulates stale errors.
    """
    sheet.errors = list(sheet.parse_errors)
    sheet.warnings = list(sheet.parse_warnings)
    if not sheet.tracks:
        if not sheet.errors:
            sheet.errors.append(TrackError(0, "cue 中没有任何可拆分的 TRACK", code="no_tracks"))
        return

    if sheet.file_name and os.path.basename(info.path) != os.path.basename(
        sheet.file_name
    ):
        sheet.warnings.append(
            Warning(
                sheet.file_line,
                f"cue 的 FILE 行写的是 “{sheet.file_name}”，"
                f"当前载入的是 “{os.path.basename(info.path)}”（按后者拆分）",
            )
        )

    if info.samplerate != 44100:
        sheet.warnings.append(
            Warning(0, f"音源采样率为 {info.samplerate} Hz（本工具按 44.1 kHz 设计，已按实际采样率换算）")
        )

    prev_start_sample: Optional[int] = None
    prev_start_line = 0
    prev_track_no = None

    for i, tr in enumerate(sheet.tracks):
        start_sample = time_to_sample(tr.start, info.samplerate)
        if tr.start < 0:  # defensive, parse_time cannot go negative
            sheet.errors.append(
                TrackError(
                    tr.start_line,
                    f"TRACK {tr.number:02d} 的 INDEX 01 为负时间",
                    tr.number,
                    code="negative_point",
                )
            )
        if start_sample >= info.total_samples:
            sheet.errors.append(
                TrackError(
                    tr.start_line,
                    f"TRACK {tr.number:02d} 的 INDEX 01 {format_time(tr.start)}"
                    f"（采样 {start_sample}）超出音频范围（共 {info.total_samples} 采样 / "
                    f"{format_mmss(info.duration)}）",
                    tr.number,
                    code="point_outside_file",
                )
            )
        if prev_start_sample is not None and start_sample < prev_start_sample:
            sheet.errors.append(
                TrackError(
                    tr.start_line,
                    f"TRACK {tr.number:02d} 的 INDEX 01 {format_time(tr.start)}"
                    f"早于上一轨（第 {prev_start_line} 行）的 {format_time(sheet.tracks[i-1].start)}："
                    "轨道顺序与时间顺序不一致",
                    tr.number,
                    code="time_out_of_order",
                )
            )
        elif prev_start_sample is not None and start_sample == prev_start_sample:
            sheet.errors.append(
                TrackError(
                    tr.start_line,
                    f"TRACK {tr.number:02d} 与上一轨的 INDEX 01 相同"
                    f"（{format_time(tr.start)}），该轨时长为 0",
                    tr.number,
                    code="duplicate_start",
                )
            )
        if tr.lead is not None:
            lead_sample = time_to_sample(tr.lead, info.samplerate)
            if lead_sample >= info.total_samples:
                sheet.errors.append(
                    TrackError(
                        tr.lead_line,
                        f"TRACK {tr.number:02d} 的 INDEX 00 {format_time(tr.lead)}"
                        f"（采样 {lead_sample}）超出音频范围（共 {info.total_samples} 采样）",
                        tr.number,
                        code="point_outside_file",
                    )
                )
            if prev_start_sample is not None and lead_sample < prev_start_sample:
                sheet.errors.append(
                    TrackError(
                        tr.lead_line,
                        f"TRACK {tr.number:02d} 的 INDEX 00 {format_time(tr.lead)}"
                        f"落入上一轨（第 {prev_start_line} 行起）的范围内，前导不能跨到上一轨之前",
                        tr.number,
                        code="lead_overlaps_previous",
                    )
                )
        if prev_track_no is not None and tr.number <= prev_track_no:
            sheet.warnings.append(
                Warning(
                    tr.source_line,
                    f"TRACK 编号 {tr.number:02d} 未按递增顺序（上一轨为 {prev_track_no:02d}）",
                )
            )
        prev_start_sample = start_sample
        prev_start_line = tr.start_line
        prev_track_no = tr.number
