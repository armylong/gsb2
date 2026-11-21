"""“不从零开始”的输入上的时间定位演示。

ffmpeg 的 ``-ss`` 放在 ``-i`` 之前时，默认按 **文件起点**（format
start_time）解释。对 start_time 非零的输入，这会产生一个静默偏移：
``-ss content_time`` 实际跳到的位置与用户以为的位置不一致。

本模块用两种命令分别截一小段，然后读输出首帧的烧录条码，把“实际落到哪一帧”
用证据显示出来。
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from . import barcode, ffmpeg, media


@dataclass(slots=True)
class ProbePoint:
    content_time: float
    absolute_time: float


@dataclass(slots=True)
class Trial:
    label: str
    command: list[str]
    first_frame: int | None
    expected_frame: int | None
    video_first_pts: float | None
    audio_first_pts: float | None
    format_start: float | None
    note: str = ""

    @property
    def ok(self) -> bool:
        return self.first_frame is not None and self.expected_frame is not None \
            and self.first_frame == self.expected_frame

    @property
    def offset_frames(self) -> int | None:
        if self.first_frame is None or self.expected_frame is None:
            return None
        return self.first_frame - self.expected_frame


@dataclass(slots=True)
class TimeMapReport:
    path: Path
    format_start: float
    video_first_pts: float
    audio_first_pts: float | None
    content_origin: float
    fps: float
    expected_frame: int
    trials: list[Trial]

    @property
    def naive(self) -> Trial | None:
        return next((t for t in self.trials if t.label.startswith("相对")), None)

    @property
    def absolute(self) -> Trial | None:
        return next((t for t in self.trials if t.label.startswith("绝对")), None)

    @property
    def naive_is_wrong(self) -> bool:
        return bool(self.naive and not self.naive.ok)

    def explanation(self) -> str:
        lines = [
            f"文件起点 format.start_time = {self.format_start:.6f}s",
            f"视频首帧 PTS = {self.video_first_pts:.6f}s",
        ]
        if self.audio_first_pts is not None:
            lead = self.video_first_pts - self.audio_first_pts
            lines.append(
                f"音频首采样 PTS = {self.audio_first_pts:.6f}s"
                + (f"（比画面早 {lead:+.3f}s）" if abs(lead) > 1e-4 else "（与画面同步）")
            )
        lines.append(f"工具内部用绝对时间：content {self.content_origin:.6f} + t")
        return "\n".join(lines)


def _first_frame_barcode(path: Path) -> int | None:
    try:
        rgb, w, h = ffmpeg.extract_first_frame_rgb(path)
        return barcode.decode_identity(rgb, w, h).frame_index
    except ffmpeg.FFmpegError:
        return None


def _first_video_pts(path: Path) -> float | None:
    frames = ffmpeg.ffprobe_frames(path, "v:0", "best_effort_timestamp_time",
                                   interval="%+#1")
    if not frames:
        return None
    try:
        return float(frames[0]["best_effort_timestamp_time"])
    except (KeyError, TypeError, ValueError):
        return None


def _first_audio_pts(path: Path) -> float | None:
    packets = ffmpeg.ffprobe_packets(path, "a:0", "pts_time")
    for pkt in packets:
        try:
            return float(pkt["pts_time"])
        except (KeyError, TypeError, ValueError):
            continue
    return None


def demonstrate(info: media.MediaInfo, content_time: float,
                workdir: str | Path, *, clip_seconds: float = 0.5) -> TimeMapReport:
    """用两种 seek 方式各截 clip_seconds，并对照期望帧号。"""
    workdir = Path(workdir)
    workdir.mkdir(parents=True, exist_ok=True)
    absolute = info.to_absolute(content_time)
    expected = info.frame_index_at(content_time) or 0

    trials: list[Trial] = []

    def _run(label: str, pre: list[str], note: str) -> Trial:
        target = workdir / f"timemap_{len(trials)}.mp4"
        cmd = [ffmpeg.ffmpeg_path(), "-hide_banner", "-loglevel", "error", "-y",
               *pre, "-t", f"{clip_seconds:.6f}", "-i", str(info.path),
               "-map", "0:v:0", "-c:v", "libx264", "-preset", "veryfast",
               "-crf", "20", "-pix_fmt", "yuv420p", str(target)]
        proc = ffmpeg.run(cmd, check=False)
        if proc.returncode != 0:
            return Trial(label, cmd, None, expected, None, None, None,
                         proc.stderr.decode("utf-8", "replace")[-300:])
        data = ffmpeg.ffprobe_json(target)
        fmt = data.get("format", {})
        return Trial(
            label=label,
            command=cmd,
            first_frame=_first_frame_barcode(target),
            expected_frame=expected,
            video_first_pts=_first_video_pts(target),
            audio_first_pts=_first_audio_pts(target),
            format_start=float(fmt.get("start_time") or 0.0),
            note=note,
        )

    # 1) 用户最常写的方式：相对文件起点的 -ss
    trials.append(_run(
        "相对定位 · -ss 内容时间",
        ["-ss", f"{content_time:.6f}"],
        "ffmpeg 把 -ss 当作相对 format.start_time 的偏移",
    ))
    # 2) 正确方式：先换算成绝对 PTS，再显式要求绝对定位
    trials.append(_run(
        "绝对定位 · -seek_timestamp 1",
        ["-seek_timestamp", "1", "-ss", f"{absolute:.6f}"],
        f"content {content_time:.3f}s → 绝对 {absolute:.3f}s",
    ))

    naive = trials[0]
    if naive.ok and abs(absolute - content_time) > 1e-4:
        naive.note = "本文件起点恰好为 0，两种写法等价"
    elif not naive.ok:
        reachable = info.format_start + content_time
        naive.note = (
            f"按文件起点解释后落到绝对 {reachable:.3f}s，"
            f"比目标 {absolute:.3f}s "
            + ("早" if reachable < absolute else "晚")
            + f" {abs(reachable - absolute):.3f}s"
        )

    return TimeMapReport(
        path=info.path,
        format_start=info.format_start,
        video_first_pts=info.content_origin,
        audio_first_pts=info.audio_start,
        content_origin=info.content_origin,
        fps=info.fps,
        expected_frame=expected,
        trials=trials,
    )
