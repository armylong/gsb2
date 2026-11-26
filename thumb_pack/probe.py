"""FFprobe wrapper and zero-based timeline normalization."""

from __future__ import annotations

import json
import math
import os
import shutil
import subprocess
from dataclasses import asdict, dataclass, field
from typing import Any


TIME_EPSILON = 1e-6


class ProbeError(RuntimeError):
    pass


def resolve_binary(name: str, explicit: str | None = None) -> str:
    if explicit:
        return explicit
    found = shutil.which(name)
    if found:
        return found
    # Common macOS location when FFmpeg is installed but PATH is minimal.
    for candidate in ("/opt/homebrew/bin", "/usr/local/bin"):
        path = os.path.join(candidate, name)
        if os.path.exists(path):
            return path
    raise ProbeError(f"could not find {name!r}; install FFmpeg or pass its path explicitly")


def sibling_ffprobe(ffmpeg_bin: str) -> str:
    candidate = os.path.join(os.path.dirname(ffmpeg_bin), "ffprobe")
    if os.path.exists(candidate):
        return candidate
    return resolve_binary("ffprobe")


def run_json(cmd: list[str]) -> dict[str, Any]:
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if proc.returncode != 0:
        raise ProbeError(proc.stderr.decode("utf-8", "replace").strip() or "ffprobe failed")
    try:
        return json.loads(proc.stdout.decode("utf-8"))
    except json.JSONDecodeError as exc:
        raise ProbeError(f"ffprobe returned invalid JSON: {exc}") from exc


def parse_float(value: Any) -> float | None:
    if value is None or value == "N/A":
        return None
    try:
        out = float(value)
        return out if math.isfinite(out) else None
    except (TypeError, ValueError):
        return None


def parse_fraction(value: Any) -> float | None:
    if not value or value == "N/A":
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value)
    if "/" in text:
        num, den = text.split("/", 1)
        try:
            den_v = float(den)
            return float(num) / den_v if den_v else None
        except ValueError:
            return None
    return parse_float(text)


@dataclass
class FrameInfo:
    index: int
    raw_pts: float
    time: float
    duration: float
    key_frame: bool = False
    pts_integer: int | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class VideoInfo:
    path: str
    width: int
    height: int
    display_width: int
    display_height: int
    rotation: int
    sample_aspect_ratio: str
    avg_frame_rate: str | None
    r_frame_rate: str | None
    origin_raw_pts: float
    duration: float
    duration_source: str
    is_vfr: bool
    frames: list[FrameInfo] = field(default_factory=list)
    raw_start_time: float | None = None
    frame_count_reported: int | None = None

    @property
    def aspect_width(self) -> int:
        return self.display_width or self.width

    @property
    def aspect_height(self) -> int:
        return self.display_height or self.height

    def to_public_dict(self) -> dict[str, Any]:
        return {
            "path": self.path,
            "width": self.width,
            "height": self.height,
            "displayWidth": self.display_width,
            "displayHeight": self.display_height,
            "rotation": self.rotation,
            "sampleAspectRatio": self.sample_aspect_ratio,
            "avgFrameRate": self.avg_frame_rate,
            "rFrameRate": self.r_frame_rate,
            "originRawPtsTime": round(self.origin_raw_pts, 9),
            "rawStartTime": self.raw_start_time,
            "duration": round(self.duration, 9),
            "durationSource": self.duration_source,
            "isVfr": self.is_vfr,
            "frameCount": len(self.frames),
            "frameCountReported": self.frame_count_reported,
            "timelineWidth": self.display_width,
            "timelineHeight": self.display_height,
        }


def _rotation_from_stream(stream: dict[str, Any]) -> int:
    for side in stream.get("side_data_list") or []:
        rot = side.get("rotation")
        if rot is not None:
            try:
                return int(round(float(rot))) % 360
            except (TypeError, ValueError):
                pass
    tags = stream.get("tags") or {}
    if "rotate" in tags:
        try:
            return int(round(float(tags["rotate"]))) % 360
        except (TypeError, ValueError):
            pass
    return 0


def _frame_raw_time(frame: dict[str, Any], time_base: float | None) -> float | None:
    for key in ("best_effort_timestamp_time", "pts_time"):
        value = parse_float(frame.get(key))
        if value is not None:
            return value
    pts = frame.get("pts")
    if pts not in (None, "N/A") and time_base:
        try:
            return int(pts) * time_base
        except (TypeError, ValueError):
            return None
    return None


def probe_video(path: str, ffprobe_bin: str | None = None) -> VideoInfo:
    ffprobe = resolve_binary("ffprobe", ffprobe_bin)
    data = run_json(
        [
            ffprobe,
            "-v",
            "error",
            "-show_streams",
            "-show_format",
            "-of",
            "json",
            path,
        ]
    )
    streams = data.get("streams") or []
    stream = next((s for s in streams if s.get("codec_type") == "video"), None)
    if stream is None:
        raise ProbeError(f"no video stream found in {path!r}")

    width = int(stream.get("width") or 0)
    height = int(stream.get("height") or 0)
    if width <= 0 or height <= 0:
        raise ProbeError(f"invalid video dimensions {width}x{height}")

    rotation = _rotation_from_stream(stream)
    if rotation in (90, 270):
        display_width, display_height = height, width
    else:
        display_width, display_height = width, height

    time_base = parse_fraction(stream.get("time_base"))
    raw_start = parse_float(stream.get("start_time"))

    frame_data = run_json(
        [
            ffprobe,
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_frames",
            "-show_entries",
            "frame=pts,pts_time,best_effort_timestamp_time,duration,duration_time,key_frame",
            "-of",
            "json",
            path,
        ]
    )
    raw_frames = frame_data.get("frames") or []
    if not raw_frames:
        raise ProbeError(f"ffprobe returned no decoded video frames for {path!r}")

    timed: list[tuple[int, float, float | None, bool, int | None]] = []
    for idx, fr in enumerate(raw_frames):
        raw_t = _frame_raw_time(fr, time_base)
        if raw_t is None:
            continue
        dur = parse_float(fr.get("duration_time"))
        if dur is None:
            dur = parse_fraction(fr.get("duration"))
        pts_int: int | None
        try:
            pts_int = int(fr.get("pts")) if fr.get("pts") not in (None, "N/A") else None
        except (TypeError, ValueError):
            pts_int = None
        timed.append((idx, raw_t, dur, fr.get("key_frame") == 1, pts_int))

    if not timed:
        raise ProbeError(f"could not read PTS timestamps for any frame in {path!r}")

    # FFprobe normally returns decode order here.  Sort by PTS for timeline
    # math while retaining decoded index for exact extraction.
    timed.sort(key=lambda item: item[1])
    origin = min(item[1] for item in timed)

    format_info = data.get("format") or {}
    container_duration = parse_float(format_info.get("duration"))
    duration_source = "format.duration"
    if container_duration is None or container_duration <= 0:
        container_duration = parse_float(stream.get("duration"))
        duration_source = "stream.duration"

    normalized: list[FrameInfo] = []
    raw_times = [item[1] for item in timed]
    for pos, (decoded_index, raw_t, explicit_dur, key, pts_int) in enumerate(timed):
        if explicit_dur is not None and explicit_dur > 0:
            dur = explicit_dur
        elif pos + 1 < len(timed):
            dur = max(0.0, raw_times[pos + 1] - raw_t)
        else:
            dur = 0.0
        normalized.append(
            FrameInfo(
                index=decoded_index,
                raw_pts=raw_t,
                time=max(0.0, raw_t - origin),
                duration=max(0.0, dur),
                key_frame=key,
                pts_integer=pts_int,
            )
        )

    if container_duration is None or container_duration <= 0:
        last = normalized[-1]
        container_duration = last.time + (last.duration if last.duration > 0 else _median_frame_duration(normalized))
        duration_source = "derived-last-pts-duration"
    else:
        # Format duration is an interval length.  Guard against weird files
        # whose last PTS sits beyond the reported container duration.
        last_end = normalized[-1].time + max(normalized[-1].duration, 0.0)
        if last_end > container_duration + 0.05:
            container_duration = last_end
            duration_source += "+last-frame-end"

    # Fill a missing/zero last-frame duration.
    if normalized and normalized[-1].duration <= 0:
        vals = [f.duration for f in normalized[:-1] if f.duration > 0]
        fallback = sorted(vals)[len(vals) // 2] if vals else 1.0 / 30.0
        normalized[-1].duration = max(1e-4, container_duration - normalized[-1].time)
        if normalized[-1].duration <= 0:
            normalized[-1].duration = fallback

    durations = [f.duration for f in normalized if f.duration > 0]
    is_vfr = False
    if len(durations) >= 4:
        median = _median_frame_duration(normalized)
        if median > 0:
            variation = max(abs(d - median) for d in durations) / median
            is_vfr = variation > 0.08

    reported_nb = parse_float(stream.get("nb_frames"))
    return VideoInfo(
        path=os.path.abspath(path),
        width=width,
        height=height,
        display_width=display_width,
        display_height=display_height,
        rotation=rotation,
        sample_aspect_ratio=str(stream.get("sample_aspect_ratio") or "1:1"),
        avg_frame_rate=stream.get("avg_frame_rate"),
        r_frame_rate=stream.get("r_frame_rate"),
        origin_raw_pts=origin,
        raw_start_time=raw_start,
        duration=max(container_duration, normalized[-1].time + 1e-4),
        duration_source=duration_source,
        is_vfr=is_vfr,
        frames=normalized,
        frame_count_reported=int(reported_nb) if reported_nb is not None else None,
    )


def _median_frame_duration(frames: list[FrameInfo]) -> float:
    vals = sorted(f.duration for f in frames if f.duration > 1e-8)
    if not vals:
        return 0.0
    return vals[len(vals) // 2]


def choose_frame(frames: list[FrameInfo], time_seconds: float) -> FrameInfo:
    """Return the frame displayed at ``time_seconds`` on the zero timeline.

    The selected frame is the last frame whose normalized PTS is less than or
    equal to the target (with a tiny float tolerance).  At a non-terminal
    frame boundary this intentionally chooses the incoming frame.
    """
    if not frames:
        raise ProbeError("cannot choose a frame from an empty list")
    target = max(0.0, float(time_seconds)) + TIME_EPSILON
    lo, hi = 0, len(frames)
    while lo < hi:
        mid = (lo + hi) // 2
        if frames[mid].time <= target:
            lo = mid + 1
        else:
            hi = mid
    idx = max(0, lo - 1)
    return frames[idx]
