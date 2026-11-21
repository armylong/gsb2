"""文件探测、时间轴换算与关键帧列表。

时间约定
--------
* 绝对时间（absolute）：文件里记录的 PTS，可能不从 0 开始。
* 内容时间（content）：以视频首帧 PTS 为 0 的时间轴，界面默认使用。

ffmpeg 的 ``-ss``（放在 ``-i`` 之前时）默认按 **文件起点** 解释。因此本工具
总是把内容时间换算成绝对时间，并配合 ``-seek_timestamp 1`` 使用，以免在
非零起点的输入上切错位置。
"""

from __future__ import annotations

import math
import statistics
from dataclasses import dataclass, field
from fractions import Fraction
from pathlib import Path
from typing import Iterable

from . import ffmpeg


def _as_float(value: object, default: float | None = None) -> float | None:
    try:
        num = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default
    if math.isnan(num) or math.isinf(num):
        return default
    return num


def _as_int(value: object, default: int | None = None) -> int | None:
    try:
        return int(str(value))
    except (TypeError, ValueError):
        return default


def _parse_rate(value: object) -> float | None:
    try:
        frac = Fraction(str(value))
    except (ValueError, ZeroDivisionError):
        return None
    if frac.numerator <= 0 or frac.denominator <= 0:
        return None
    return float(frac)


def _median_delta(times: Iterable[float]) -> float | None:
    ordered = sorted(times)
    diffs = [b - a for a, b in zip(ordered, ordered[1:]) if b - a > 1e-7]
    if not diffs:
        return None
    return statistics.median(diffs)


@dataclass(slots=True)
class StreamInfo:
    index: int
    codec_type: str
    codec_name: str
    start_time: float | None
    duration: float | None
    width: int | None = None
    height: int | None = None
    declared_fps: float | None = None
    sample_rate: int | None = None
    channels: int | None = None
    nb_frames: int | None = None

    @property
    def label(self) -> str:
        if self.codec_type == "video":
            size = f" {self.width}x{self.height}" if self.width and self.height else ""
            return f"视频 #{self.index} · {self.codec_name}{size}"
        if self.codec_type == "audio":
            rate = f" {self.sample_rate} Hz" if self.sample_rate else ""
            ch = f" {self.channels}ch" if self.channels else ""
            return f"音频 #{self.index} · {self.codec_name}{rate}{ch}"
        return f"{self.codec_type} #{self.index} · {self.codec_name}"


@dataclass(slots=True)
class Keyframe:
    index: int                 # 关键帧序号（0 起）
    pts: float                 # 绝对 pts（秒）
    content_time: float        # 相对视频首帧
    frame_index: int | None    # 内容帧序号
    gop_frames: int | None     # 与上一关键帧的帧数差
    fps: float | None = None

    @property
    def gop_seconds(self) -> float | None:
        if self.gop_frames is None or not self.fps:
            return None
        return self.gop_frames / self.fps


@dataclass(slots=True)
class MediaInfo:
    path: Path
    format_name: str
    format_start: float
    format_duration: float | None
    video: StreamInfo | None
    audio: StreamInfo | None
    streams: list[StreamInfo]
    time_base: float | None = None
    frame_times: list[float] = field(default_factory=list)      # 呈现顺序的绝对 pts
    frame_key_flags: list[bool] = field(default_factory=list)
    keyframes: list[Keyframe] = field(default_factory=list)
    fps: float = 0.0
    fps_exact: bool = False
    probed_frames: int = 0
    first_pts: float | None = None
    notes: list[str] = field(default_factory=list)

    # ---- 时间轴换算 ----
    @property
    def video_start(self) -> float:
        return self.video.start_time if self.video else self.format_start

    @property
    def content_origin(self) -> float:
        """内容时间 0 对应的绝对时间。"""
        if self.first_pts is not None:
            return self.first_pts
        return self.video_start

    @property
    def audio_start(self) -> float | None:
        if not self.audio:
            return None
        return self.audio.start_time if self.audio.start_time is not None else self.format_start

    @property
    def has_nonzero_origin(self) -> bool:
        return abs(self.content_origin) > 0.0005

    @property
    def frame_period(self) -> float:
        return 1.0 / self.fps if self.fps > 0 else 0.0

    def to_absolute(self, content_time: float) -> float:
        return self.content_origin + content_time

    def to_content(self, absolute_time: float) -> float:
        return absolute_time - self.content_origin

    def content_duration(self) -> float:
        if self.frame_times:
            tail = self.frame_period
            return max(0.0, self.frame_times[-1] - self.content_origin + tail)
        return self.format_duration or 0.0

    def keyframe_at_or_before(self, content_time: float) -> Keyframe | None:
        found = None
        for kf in self.keyframes:
            if kf.content_time <= content_time + 1e-4:
                found = kf
            else:
                break
        return found

    def keyframe_at_or_after(self, content_time: float) -> Keyframe | None:
        for kf in self.keyframes:
            if kf.content_time >= content_time - 1e-4:
                return kf
        return None

    def frame_index_at(self, content_time: float) -> int | None:
        if self.fps <= 0:
            return None
        return max(0, round(content_time * self.fps))

    def frame_time(self, frame_index: int) -> float:
        """某一帧的内容时间（优先用实测时间）。"""
        if 0 <= frame_index < len(self.frame_times):
            return self.frame_times[frame_index] - self.content_origin
        return frame_index * self.frame_period

    def frame_is_key(self, frame_index: int) -> bool:
        if 0 <= frame_index < len(self.frame_key_flags):
            return self.frame_key_flags[frame_index]
        kf = self.keyframe_at_or_before(self.frame_time(frame_index) + 1e-4)
        return bool(kf and abs(kf.content_time - self.frame_time(frame_index)) < 1e-4)


DEEP_PROBE_LIMIT = 15 * 60.0   # 超过 15 分钟改用 packet 标记，避免逐帧解码过慢


def probe(path: str | Path, *, deep: bool | None = None) -> MediaInfo:
    """探测媒体文件。

    ``deep=True`` 会逐帧解码以拿到精确的关键帧位置；``None`` 表示按时长
    自动选择（超过 15 分钟改走 packet 标记，速度更快但帧号为标称推算）。
    """
    path = Path(path)
    if not path.is_file():
        raise ffmpeg.FFmpegError(f"文件不存在: {path}")
    data = ffmpeg.ffprobe_json(path)
    fmt = data.get("format", {})
    fmt_start = _as_float(fmt.get("start_time"), 0.0) or 0.0
    fmt_duration = _as_float(fmt.get("duration"))
    if deep is None:
        deep = fmt_duration is None or fmt_duration <= DEEP_PROBE_LIMIT

    raw_streams = data.get("streams", [])
    streams: list[StreamInfo] = []
    for s in raw_streams:
        streams.append(StreamInfo(
            index=_as_int(s.get("index"), 0) or 0,
            codec_type=s.get("codec_type", "unknown"),
            codec_name=s.get("codec_name", "?"),
            start_time=_as_float(s.get("start_time")),
            duration=_as_float(s.get("duration")),
            width=_as_int(s.get("width")),
            height=_as_int(s.get("height")),
            declared_fps=_parse_rate(s.get("avg_frame_rate")) or _parse_rate(s.get("r_frame_rate")),
            sample_rate=_as_int(s.get("sample_rate")),
            channels=_as_int(s.get("channels")),
            nb_frames=_as_int(s.get("nb_frames")),
        ))

    video = next((s for s in streams if s.codec_type == "video"), None)
    audio = next((s for s in streams if s.codec_type == "audio"), None)
    if video is None:
        raise ffmpeg.FFmpegError("该文件没有视频流，无法做关键帧检查")

    raw_video = next((s for s in raw_streams if _as_int(s.get("index")) == video.index), {})
    time_base = _fraction_value(raw_video.get("time_base"))

    info = MediaInfo(
        path=path,
        format_name=fmt.get("format_name", "?"),
        format_start=fmt_start,
        format_duration=fmt_duration,
        video=video,
        audio=audio,
        streams=streams,
        time_base=time_base,
    )

    times, flags = _probe_frames(info) if deep else _probe_packets(info)
    info.first_pts = _first_pts(info, times)
    info.fps = _resolve_fps(info, times)
    info.keyframes = _build_keyframes(info, times, flags)
    info.probed_frames = len(info.frame_times)
    if not deep:
        info.notes.append("未逐帧解码：关键帧位置来自 packet 标记，帧号按标称帧率推算。")
    if not info.keyframes:
        info.notes.append("未找到关键帧信息（可能是不支持的封装或仅含单帧）")
    return info


def _fraction_value(value: object) -> float | None:
    try:
        return float(Fraction(str(value)))
    except (ValueError, ZeroDivisionError):
        return None


def _probe_frames(info: MediaInfo) -> tuple[list[float], list[bool]]:
    frames = ffmpeg.ffprobe_frames(
        info.path, "v:0", "best_effort_timestamp_time,key_frame,pict_type"
    )
    times: list[float] = []
    flags: list[bool] = []
    for fr in frames:
        t = _as_float(fr.get("best_effort_timestamp_time"))
        if t is None:
            t = _as_float(fr.get("pts_time"))
        if t is None:
            continue
        times.append(t)
        flags.append(str(fr.get("key_frame", "0")) == "1")
    info.frame_times = times
    info.frame_key_flags = flags
    return times, flags


def _probe_packets(info: MediaInfo) -> tuple[list[float], list[bool]]:
    packets = ffmpeg.ffprobe_packets(info.path, "v:0", "pts_time,dts_time,flags")
    times: list[float] = []
    flags: list[bool] = []
    for pkt in packets:
        t = _as_float(pkt.get("pts_time"))
        if t is None:
            t = _as_float(pkt.get("dts_time"))
        if t is None:
            continue
        times.append(t)
        flags.append("K" in str(pkt.get("flags", "")))
    info.frame_times = []          # 未逐帧解码，不提供实测帧时间
    info.frame_key_flags = []
    return times, flags


def _first_pts(info: MediaInfo, times: list[float]) -> float:
    if info.frame_times:
        return info.frame_times[0]
    if info.video and info.video.start_time is not None:
        return info.video.start_time
    return times[0] if times else info.format_start


def _resolve_fps(info: MediaInfo, times: list[float]) -> float:
    if len(times) > 2:
        delta = _median_delta(times)
        if delta and delta > 1e-6:
            fps = 1.0 / delta
            declared = info.video.declared_fps if info.video else None
            info.fps_exact = bool(
                declared and abs(fps - declared) / declared < 0.02
            )
            return fps
    if info.video and info.video.declared_fps:
        return info.video.declared_fps
    return 0.0


def _build_keyframes(info: MediaInfo, times: list[float],
                     flags: list[bool]) -> list[Keyframe]:
    origin = info.content_origin
    keys: list[Keyframe] = []
    last_t: float | None = None
    for t, is_key in zip(times, flags):
        if not is_key:
            continue
        gop = None
        if last_t is not None and info.fps > 0:
            gop = max(1, round((t - last_t) * info.fps))
        content = t - origin
        keys.append(Keyframe(
            index=len(keys),
            pts=t,
            content_time=content,
            frame_index=max(0, round(content * info.fps)) if info.fps > 0 else None,
            gop_frames=gop,
            fps=info.fps,
        ))
        last_t = t
    return keys
