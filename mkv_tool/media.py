from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .errors import ProbeError, ffprobe_path, require_source
from .runner import run_capture

# Common text subtitle codecs found in MKV releases.  Bitmap subtitles are
# intentionally outside the editing/preview scope.
TEXT_SUBTITLE_CODECS = frozenset(
    {
        "subrip",
        "ass",
        "ssa",
        "webvtt",
        "mov_text",
        "text",
        "ttml",
    }
)


def _optional_float(value: Any) -> float | None:
    if value in (None, "N/A", ""):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _bool_flag(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class StreamInfo:
    index: int
    codec_type: str
    codec_name: str = "unknown"
    language: str = ""
    title: str = ""
    default: bool = False
    forced: bool = False
    start_time: float | None = None
    first_pts: float | None = None
    duration: float | None = None
    disposition: dict[str, bool] = field(default_factory=dict)
    tags: dict[str, str] = field(default_factory=dict)
    width: int | None = None
    height: int | None = None

    @property
    def is_text_subtitle(self) -> bool:
        return self.codec_type == "subtitle" and self.codec_name.lower() in TEXT_SUBTITLE_CODECS

    @property
    def is_bitmap_subtitle(self) -> bool:
        return self.codec_type == "subtitle" and not self.is_text_subtitle

    @property
    def attached_pic(self) -> bool:
        return bool(self.disposition.get("attached_pic"))

    @property
    def flag_text(self) -> str:
        flags = []
        if self.default:
            flags.append("D")
        if self.forced:
            flags.append("F")
        for key, label in (
            ("hearing_impaired", "HI"),
            ("visual_impaired", "VI"),
            ("comment", "C"),
            ("lyrics", "L"),
            ("karaoke", "K"),
        ):
            if self.disposition.get(key):
                flags.append(label)
        return "+".join(flags)

    @classmethod
    def from_ffprobe(cls, raw: dict[str, Any], *, first_pts: float | None = None) -> "StreamInfo":
        tags = raw.get("tags") or {}
        disposition_raw = raw.get("disposition") or {}
        disposition = {k: _bool_flag(v) for k, v in disposition_raw.items()}
        return cls(
            index=int(raw["index"]),
            codec_type=str(raw.get("codec_type") or "unknown"),
            codec_name=str(raw.get("codec_name") or "unknown"),
            language=str(tags.get("language") or ""),
            title=str(tags.get("title") or ""),
            default=bool(disposition.get("default")),
            forced=bool(disposition.get("forced")),
            start_time=_optional_float(raw.get("start_time")),
            first_pts=first_pts,
            duration=_optional_float(raw.get("duration")),
            disposition=disposition,
            tags={str(k): str(v) for k, v in tags.items() if v is not None},
            width=raw.get("width"),
            height=raw.get("height"),
        )


@dataclass
class SourceInfo:
    path: Path
    streams: list[StreamInfo]
    format_name: str = ""
    duration: float | None = None
    raw: dict[str, Any] = field(default_factory=dict)

    @property
    def videos(self) -> list[StreamInfo]:
        return [s for s in self.streams if s.codec_type == "video"]

    @property
    def main_videos(self) -> list[StreamInfo]:
        # Cover art is codec_type=video but is not the one feature video.
        return [s for s in self.videos if not s.attached_pic]

    @property
    def audios(self) -> list[StreamInfo]:
        return [s for s in self.streams if s.codec_type == "audio"]

    @property
    def subtitles(self) -> list[StreamInfo]:
        return [s for s in self.streams if s.codec_type == "subtitle"]

    @property
    def unsupported_streams(self) -> list[StreamInfo]:
        result = [s for s in self.subtitles if s.is_bitmap_subtitle]
        # Cover art is codec_type=video but is not the one feature video.  It
        # must not be labelled "fixed" and silently omitted from the export.
        result.extend(s for s in self.videos if s.attached_pic)
        result.extend(s for s in self.streams if s.codec_type in {"data", "attachment", "unknown"})
        return result

    def get(self, index: int) -> StreamInfo:
        for stream in self.streams:
            if stream.index == index:
                return stream
        raise KeyError(index)

    @staticmethod
    def effective_start(stream: StreamInfo) -> float | None:
        # For audio/video ffprobe's start_time is the muxer-adjusted start and
        # avoids AAC priming noise in the first packet PTS.  For some subtitle
        # streams start_time is occasionally 0 while the first packet PTS is
        # the real cue position, so prefer packet PTS there.
        if stream.codec_type == "subtitle":
            return stream.first_pts if stream.first_pts is not None else stream.start_time
        return stream.start_time if stream.start_time is not None else stream.first_pts

    def reference_start(self) -> float | None:
        """Reference clock: the main video start, otherwise earliest stream."""
        main = self.main_videos[0] if self.main_videos else None
        if main:
            start = self.effective_start(main)
            if start is not None:
                return start
        starts = [self.effective_start(s) for s in self.streams]
        valid = [value for value in starts if value is not None]
        return min(valid) if valid else None

    def relative_offset(self, stream: StreamInfo | int) -> float | None:
        info = stream if isinstance(stream, StreamInfo) else self.get(stream)
        start = self.effective_start(info)
        if start is None:
            return None
        base = self.reference_start()
        if base is None:
            return None
        return start - base


def first_packet_pts(
    path: str | Path,
    stream_index: int,
    exe: str | Path | None = None,
) -> float | None:
    """Return the first packet PTS for one global ffprobe stream index."""
    ffprobe_exe = ffprobe_path(exe)
    result = run_capture(
        [
            ffprobe_exe,
            "-v",
            "error",
            "-select_streams",
            str(stream_index),
            "-show_entries",
            "packet=pts_time",
            "-of",
            "csv=p=0",
            "-read_intervals",
            "%+#1",
            str(path),
        ]
    )
    if result.returncode != 0:
        return None
    for line in result.stdout_text.splitlines():
        value = line.strip().rstrip(",")
        pts = _optional_float(value)
        if pts is not None:
            return pts
    return None


def probe_file(path: str | Path, *, ffprobe: str | Path | None = None) -> SourceInfo:
    source = require_source(path)
    exe = ffprobe_path(ffprobe)
    result = run_capture(
        [
            exe,
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            str(source),
        ]
    )
    if result.returncode != 0:
        raise ProbeError(f"ffprobe 无法读取 {source}：\n{result.stderr_tail()}")
    try:
        data = result.json()
    except Exception as exc:  # noqa: BLE001 - include parser context
        raise ProbeError(f"ffprobe 返回了无法解析的 JSON：{exc}") from exc

    streams: list[StreamInfo] = []
    for raw in data.get("streams", []):
        index = int(raw["index"])
        pts = first_packet_pts(source, index, exe)
        streams.append(StreamInfo.from_ffprobe(raw, first_pts=pts))
    if not streams:
        raise ProbeError(f"文件中没有可识别的流：{source}")
    fmt = data.get("format") or {}
    return SourceInfo(
        path=source,
        streams=streams,
        format_name=str(fmt.get("format_name") or ""),
        duration=_optional_float(fmt.get("duration")),
        raw=data,
    )
