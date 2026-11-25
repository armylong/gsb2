from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

from .errors import ExportPlanError, UnsupportedScopeError
from .media import SourceInfo, StreamInfo

TrackKind = Literal["audio", "subtitle"]


@dataclass
class TrackDraft:
    """Editable state for one audio or text-subtitle stream.

    The source StreamInfo remains untouched, which is what lets the UI keep
    original markers visible while the user experiments with the export state.
    """

    source: StreamInfo
    language: str
    title: str
    included: bool = True
    is_default: bool = False
    is_forced: bool = False

    @property
    def source_index(self) -> int:
        return self.source.index

    @property
    def kind(self) -> TrackKind:
        if self.source.codec_type not in {"audio", "subtitle"}:
            raise ExportPlanError(f"流 {self.source.index} 不是可编辑的音轨/字幕")
        return self.source.codec_type  # type: ignore[return-value]

    @property
    def source_default(self) -> bool:
        return self.source.default

    @property
    def source_forced(self) -> bool:
        return self.source.forced


@dataclass(frozen=True)
class ExpectedStream:
    source_index: int
    output_index: int
    codec_type: str
    codec_name: str
    language: str
    title: str
    default: bool
    forced: bool
    source_start_time: float | None
    relative_offset: float | None
    packet_hash: str | None = None
    source_disposition: dict[str, bool] = field(default_factory=dict)


@dataclass
class ExportPlan:
    source: Path
    output: Path
    expected: list[ExpectedStream]
    overwrite: bool = False
    verify_content: bool = True
    acknowledged_unsupported: bool = False
    unsupported: list[StreamInfo] = field(default_factory=list)
    ffmpeg: str | Path | None = None
    ffprobe: str | Path | None = None

    @property
    def video_expected(self) -> ExpectedStream:
        return self.expected[0]


class TrackEditSession:
    """All edit operations live here; Qt selection never resets this state."""

    def __init__(self, source: SourceInfo):
        self.source_info = source
        videos = source.main_videos
        if len(videos) != 1:
            raise UnsupportedScopeError(
                "当前工具范围要求恰好一个主视频流；"
                f"{source.path.name} 中有 {len(videos)} 个。"
            )
        self.video: StreamInfo = videos[0]
        self.audio: list[TrackDraft] = [
            TrackDraft(s, s.language, s.title, is_default=s.default) for s in source.audios
        ]
        self.subtitles: list[TrackDraft] = []
        for s in source.subtitles:
            if not s.is_text_subtitle:
                continue
            self.subtitles.append(
                TrackDraft(s, s.language, s.title, is_default=s.default, is_forced=s.forced)
            )
        self.notices: list[str] = []
        audio_notice = self._normalize_initial_defaults(self.audio, "音频")
        if audio_notice:
            self.notices.append(audio_notice)
        subtitle_notice = self._normalize_initial_defaults(self.subtitles, "字幕")
        if subtitle_notice:
            self.notices.append(subtitle_notice)
        if source.unsupported_streams:
            indexes = ", ".join(f"#{s.index}:{s.codec_name}" for s in source.unsupported_streams)
            self.notices.append(f"存在超出当前保留范围的流：{indexes}")

    @staticmethod
    def _normalize_initial_defaults(tracks: list[TrackDraft], label: str) -> str | None:
        defaults = [t for t in tracks if t.is_default]
        if len(defaults) > 1:
            # ffprobe can show several default=1 flags.  The export model is a
            # single choice per kind; keep the first and tell the user.
            for t in defaults[1:]:
                t.is_default = False
            return f"源中有多个{label}默认标记；导出方案先选择源 #{defaults[0].source_index}，可更改。"
        return None

    def tracks_for(self, kind: TrackKind) -> list[TrackDraft]:
        return self.audio if kind == "audio" else self.subtitles

    def all_tracks(self) -> list[TrackDraft]:
        return [*self.audio, *self.subtitles]

    def find(self, source_index: int) -> TrackDraft:
        for track in self.all_tracks():
            if track.source_index == source_index:
                return track
        raise KeyError(source_index)

    def selected_kind_list(self, source_index: int) -> list[TrackDraft]:
        track = self.find(source_index)
        return self.tracks_for(track.kind)

    def set_language(self, source_index: int, language: str) -> None:
        self.find(source_index).language = language.strip()

    def set_title(self, source_index: int, title: str) -> None:
        self.find(source_index).title = title

    def set_included(self, source_index: int, included: bool) -> None:
        track = self.find(source_index)
        track.included = included
        if not included and track.is_default:
            track.is_default = False

    def set_default(self, source_index: int, is_default: bool) -> None:
        target = self.find(source_index)
        if is_default and not target.included:
            raise ExportPlanError("不能把已移除的流设为默认；请先保留它。")
        if is_default:
            for track in self.tracks_for(target.kind):
                track.is_default = track.source_index == source_index
        else:
            # Unchecking a non-current row must not clear the real default.
            target.is_default = False

    def set_forced(self, source_index: int, forced: bool) -> None:
        self.find(source_index).is_forced = forced

    def move(self, source_index: int, delta: int) -> bool:
        tracks = self.selected_kind_list(source_index)
        for i, track in enumerate(tracks):
            if track.source_index == source_index:
                j = max(0, min(len(tracks) - 1, i + delta))
                if i == j:
                    return False
                tracks.insert(j, tracks.pop(i))
                return True
        return False

    def included_audio(self) -> list[TrackDraft]:
        return [t for t in self.audio if t.included]

    def included_subtitles(self) -> list[TrackDraft]:
        return [t for t in self.subtitles if t.included]

    def default_track(self, kind: TrackKind) -> TrackDraft | None:
        chosen = [t for t in self.tracks_for(kind) if t.is_default and t.included]
        if len(chosen) > 1:
            raise ExportPlanError(f"{kind} 出现了多个默认项")
        return chosen[0] if chosen else None

    def validate(self, *, acknowledge_unsupported: bool = False) -> None:
        if not self.video:
            raise UnsupportedScopeError("没有可保留的视频流。")
        unsupported = self.source_info.unsupported_streams
        if unsupported and not acknowledge_unsupported:
            desc = ", ".join(f"#{s.index} {s.codec_type}/{s.codec_name}" for s in unsupported)
            raise UnsupportedScopeError(
                "有源流超出当前支持范围（多视频/位图字幕/数据/附件）："
                f"{desc}。请显式确认导出时不保留它们。"
            )
        for track in self.all_tracks():
            if track.included and track.kind == "subtitle" and not track.source.is_text_subtitle:
                raise UnsupportedScopeError(f"字幕流 #{track.source_index} 不是常见文本字幕。")
            if len(track.language) > 64:
                raise ExportPlanError(f"流 #{track.source_index} 的语言标记过长。")
        # Validate exclusive defaults even if UI was driven programmatically.
        for kind in ("audio", "subtitle"):
            chosen = [t for t in self.tracks_for(kind) if t.is_default]
            if len(chosen) > 1:
                raise ExportPlanError(f"{kind} 默认项必须唯一。")
            if chosen and not chosen[0].included:
                raise ExportPlanError(f"{kind} 默认项已被标记移除。")

    def build_plan(
        self,
        output: str | Path,
        *,
        overwrite: bool = False,
        verify_content: bool = True,
        acknowledge_unsupported: bool = False,
        ffmpeg: str | Path | None = None,
        ffprobe: str | Path | None = None,
    ) -> ExportPlan:
        self.validate(acknowledge_unsupported=acknowledge_unsupported)
        out = Path(output).expanduser().absolute()
        source = self.source_info.path
        if out == source:
            raise ExportPlanError("输出文件不能覆盖源文件，请换一个新的 MKV 路径。")
        if out.suffix.lower() != ".mkv":
            raise ExportPlanError("输出路径请使用 .mkv 后缀。")
        if out.exists() and not overwrite:
            raise ExportPlanError(f"输出文件已存在，且未允许覆盖：{out}")

        expected: list[ExpectedStream] = []
        output_index = 0

        def add(
            source_index: int,
            codec_type: str,
            codec_name: str,
            language: str,
            title: str,
            default: bool,
            forced: bool,
            start_time: float | None,
        ) -> None:
            nonlocal output_index
            stream = self.source_info.get(source_index)
            expected.append(
                ExpectedStream(
                    source_index=source_index,
                    output_index=output_index,
                    codec_type=codec_type,
                    codec_name=codec_name,
                    language=language or "",
                    title=title or "",
                    default=default,
                    forced=forced,
                    source_start_time=start_time,
                    relative_offset=self.source_info.relative_offset(stream),
                    source_disposition=dict(stream.disposition),
                )
            )
            output_index += 1

        add(
            self.video.index,
            self.video.codec_type,
            self.video.codec_name,
            self.video.language,
            self.video.title,
            self.video.default,
            self.video.forced,
            self.video.start_time,
        )
        for track in self.included_audio():
            add(
                track.source_index,
                "audio",
                track.source.codec_name,
                track.language,
                track.title,
                track.is_default,
                False,
                track.source.start_time,
            )
        for track in self.included_subtitles():
            add(
                track.source_index,
                "subtitle",
                track.source.codec_name,
                track.language,
                track.title,
                track.is_default,
                track.is_forced,
                track.source.start_time,
            )

        return ExportPlan(
            source=source,
            output=out,
            expected=expected,
            overwrite=overwrite,
            verify_content=verify_content,
            acknowledged_unsupported=acknowledge_unsupported,
            unsupported=list(self.source_info.unsupported_streams),
            ffmpeg=ffmpeg,
            ffprobe=ffprobe,
        )


def format_offset(value: float | None) -> str:
    if value is None:
        return "—"
    if abs(value) < 0.0005:
        return "0.000 s"
    return f"{value:+.3f} s"


def track_label(track: TrackDraft | StreamInfo) -> str:
    if isinstance(track, TrackDraft):
        s = track.source
        lang = track.language or "无语言"
        title = track.title or s.title or "无标题"
        return f"#{s.index} {s.codec_type}/{s.codec_name} [{lang}] {title}"
    lang = track.language or "无语言"
    title = track.title or "无标题"
    return f"#{track.index} {track.codec_type}/{track.codec_name} [{lang}] {title}"
