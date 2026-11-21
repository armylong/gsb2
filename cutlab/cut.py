"""截取 / 重编码与输出体检。

本模块把“直接截取”（stream copy）和“重编码”放在同一套输入参数下执行，
再对输出做同一套测量，从而回答：同一次截取，两种做法差在哪里。

关键实现细节
------------
* 输入定位一律用绝对时间 + ``-seek_timestamp 1``。ffmpeg 的 ``-ss`` 放在
  ``-i`` 前默认按 **文件起点** 解释；对 start_time 非零的输入（手机录屏、
  MOV/TS 片段）直接用内容时间会静默截错位置。
* ``-t`` 按输出时间轴计算。经 ``-seek_timestamp`` 定位后，MP4 会用 edit list
  把展示起点裁到请求点（所以首帧正确），但容器声明的帧数与音轨仍按预滚
  计算；MKV/TS 没有 edit list，会直接回退到前一关键帧。这两种偏差都由本
  模块测量并展示。
* 首帧/末帧身份用样例里烧录的条码读出，而不是靠 PTS 推断。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from hashlib import sha1
from pathlib import Path

from . import audio, barcode, ffmpeg, media


@dataclass(slots=True)
class CutRequest:
    source: media.MediaInfo
    start: float          # 内容时间
    end: float            # 内容时间
    container: str = "mp4"   # mp4 / mkv / ts
    reencode: bool = False
    video_bitrate: str = "2M"
    audio_bitrate: str = "128k"
    crf: int = 20
    preset: str = "veryfast"

    @property
    def duration(self) -> float:
        return max(0.0, self.end - self.start)

    @property
    def start_abs(self) -> float:
        return self.source.to_absolute(self.start)

    @property
    def end_abs(self) -> float:
        return self.source.to_absolute(self.end)


@dataclass(slots=True)
class TrackMeasure:
    kind: str
    start: float | None
    end: float | None
    duration: float | None
    frames: int | None = None
    first_pts: float | None = None
    last_pts: float | None = None
    first_key: bool | None = None
    declared_frames: int | None = None   # 容器声明的帧数（可能含预滚）

    @property
    def span(self) -> float | None:
        if self.first_pts is None or self.last_pts is None:
            return None
        return self.last_pts - self.first_pts

    def summary(self) -> str:
        start = "—" if self.start is None else f"{self.start:.3f}s"
        dur = "—" if self.duration is None else f"{self.duration:.3f}s"
        return f"起点 {start} · 时长 {dur}"


@dataclass(slots=True)
class OutputMeasure:
    path: Path
    size: int
    format_start: float | None
    format_duration: float | None
    video: TrackMeasure | None
    audio: TrackMeasure | None
    first_frame_identity: barcode.BarcodeResult | None = None
    first_frame_rgb_sha: str | None = None
    last_frame_identity: barcode.BarcodeResult | None = None
    command: list[str] = field(default_factory=list)
    stderr_tail: str = ""

    @property
    def first_frame_index(self) -> int | None:
        return self.first_frame_identity.frame_index if self.first_frame_identity else None

    @property
    def last_frame_index(self) -> int | None:
        return self.last_frame_identity.frame_index if self.last_frame_identity else None


def build_command(req: CutRequest, target: Path) -> list[str]:
    fmt = req.container.lower().lstrip(".")
    args = [ffmpeg.ffmpeg_path(), "-hide_banner", "-loglevel", "error", "-y",
            "-seek_timestamp", "1",
            "-ss", f"{req.start_abs:.6f}",
            "-t", f"{req.duration:.6f}",
            "-i", str(req.source.path),
            "-map", "0:v:0"]
    if req.source.audio:
        args += ["-map", "0:a:0"]
    if req.reencode:
        args += ["-c:v", "libx264", "-preset", req.preset, "-crf", str(req.crf),
                 "-pix_fmt", "yuv420p"]
        if req.source.audio:
            args += ["-c:a", "aac", "-b:a", req.audio_bitrate]
    else:
        args += ["-c", "copy"]
    if fmt == "ts":
        args += ["-f", "mpegts"]
    elif fmt == "mkv":
        args += ["-f", "matroska"]
    elif fmt == "mp4":
        args += ["-f", "mp4", "-movflags", "+faststart"]
    elif fmt == "mov":
        args += ["-f", "mov"]
    args.append(str(target))
    return args


def run_cut(req: CutRequest, target: Path) -> OutputMeasure:
    cmd = build_command(req, target)
    proc = ffmpeg.run(cmd, check=False)
    if proc.returncode != 0:
        err = proc.stderr.decode("utf-8", "replace").strip()
        raise ffmpeg.FFmpegError(
            f"截取失败（退出码 {proc.returncode}）\n{err[-1200:]}", cmd, err
        )
    return measure_output(target, cmd)


def measure_output(path: str | Path, command: list[str] | None = None) -> OutputMeasure:
    """测量输出文件。

    ``start`` / ``duration`` 一律换算到 **展示时间轴**（相对文件 format
    start_time），因为对 MP4 来说 ffprobe 的 stream start_time 是 edit list
    之后的展示起点，而不是首帧 PTS。
    """
    path = Path(path)
    data = ffmpeg.ffprobe_json(path)
    fmt = data.get("format", {})
    streams = data.get("streams", [])
    origin = _f(fmt.get("start_time")) or 0.0

    video_stream = next((s for s in streams if s.get("codec_type") == "video"), None)
    audio_stream = next((s for s in streams if s.get("codec_type") == "audio"), None)

    video = _measure_video(path, video_stream, origin)
    audio = _measure_audio(path, audio_stream, origin)

    identity = None
    last_identity = None
    rgb_sha = None
    if video_stream:
        try:
            rgb, w, h = ffmpeg.extract_first_frame_rgb(path)
            identity = barcode.decode_identity(rgb, w, h)
            rgb_sha = sha1(rgb).hexdigest()
        except ffmpeg.FFmpegError:
            identity = None
        count = video.frames if video and video.frames else 0
        if count > 0:
            try:
                last_rgb = ffmpeg.extract_rgb_frame_number(path, count - 1, w, h)
                last_identity = barcode.decode_identity(last_rgb, w, h)
            except ffmpeg.FFmpegError:
                last_identity = None

    return OutputMeasure(
        path=path,
        size=ffmpeg.file_size(path),
        format_start=_f(fmt.get("start_time")),
        format_duration=_f(fmt.get("duration")),
        video=video,
        audio=audio,
        first_frame_identity=identity,
        first_frame_rgb_sha=rgb_sha,
        last_frame_identity=last_identity,
        command=command or [],
    )


def _f(value: object) -> float | None:
    try:
        out = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return None if out != out else out


def _measure_video(path: Path, stream: dict | None, origin: float) -> TrackMeasure | None:
    if not stream:
        return None
    frames = ffmpeg.ffprobe_frames(path, "v:0", "best_effort_timestamp_time,key_frame")
    pts = []
    first_key = None
    for i, fr in enumerate(frames):
        t = _f(fr.get("best_effort_timestamp_time"))
        if t is None:
            t = _f(fr.get("pts_time"))
        if t is not None:
            pts.append(t)
        if i == 0:
            first_key = str(fr.get("key_frame", "0")) == "1"
    start = _f(stream.get("start_time"))
    duration = _f(stream.get("duration"))
    nb = str(stream.get("nb_frames") or "")
    display_start = (start - origin) if start is not None else (
        (pts[0] - origin) if pts else None)
    first_pts = pts[0] if pts else None
    last_pts = pts[-1] if pts else None
    if duration is None and first_pts is not None and last_pts is not None and len(pts) > 1:
        frame_len = (last_pts - first_pts) / (len(pts) - 1)
        duration = (last_pts - first_pts) + frame_len
    return TrackMeasure(
        kind="video",
        start=display_start,
        end=(display_start + duration) if display_start is not None and duration is not None else None,
        duration=duration,
        frames=len(pts) or None,
        declared_frames=int(nb) if nb.isdigit() else None,
        first_pts=first_pts - origin if first_pts is not None else None,
        last_pts=last_pts - origin if last_pts is not None else None,
        first_key=first_key,
    )


def _measure_audio(path: Path, stream: dict | None, origin: float) -> TrackMeasure | None:
    if not stream:
        return None
    packets = ffmpeg.ffprobe_packets(path, "a:0", "pts_time,duration_time")
    starts = []
    end_max = None
    for pkt in packets:
        t = _f(pkt.get("pts_time"))
        if t is None:
            continue
        starts.append(t)
        dur = _f(pkt.get("duration_time")) or 0.0
        cand = t + dur
        end_max = cand if end_max is None else max(end_max, cand)
    start = _f(stream.get("start_time"))
    duration = _f(stream.get("duration"))
    first_pts = min(starts) if starts else None
    nb = str(stream.get("nb_frames") or "")
    display_start = (start - origin) if start is not None else (
        (first_pts - origin) if first_pts is not None else None)
    return TrackMeasure(
        kind="audio",
        start=display_start,
        end=(display_start + duration) if display_start is not None and duration is not None
        else ((end_max - origin) if end_max is not None else None),
        duration=duration if duration is not None else (
            (end_max - first_pts) if end_max is not None and first_pts is not None else None),
        frames=int(nb) if nb.isdigit() else None,
        first_pts=first_pts - origin if first_pts is not None else None,
        last_pts=end_max - origin if end_max is not None else None,
    )


# --------------------------------------------------------------------------
# 偏差分析
# --------------------------------------------------------------------------

@dataclass(slots=True)
class Deviation:
    label: str
    requested: float
    actual: float
    delta: float
    severity: str      # ok / warn / bad
    detail: str = ""
    unit: str = "frames"   # frames / seconds

    def describe(self) -> str:
        if self.unit == "seconds":
            return f"{self.delta:+.3f}s"
        return f"{self.delta:+.2f} 帧"


@dataclass(slots=True)
class Prediction:
    request: CutRequest
    start_keyframe: media.Keyframe | None
    end_keyframe: media.Keyframe | None
    preroll_seconds: float
    preroll_frames: float
    start_frame_index: int | None
    end_frame_index: int | None
    expected_frames: int | None
    start_on_key: bool
    notes: list[str] = field(default_factory=list)


def predict(req: CutRequest) -> Prediction:
    src = req.source
    start_kf = src.keyframe_at_or_before(req.start)
    end_kf = src.keyframe_at_or_before(req.end)
    preroll = req.start - start_kf.content_time if start_kf else 0.0
    fps = src.fps if src.fps > 0 else 30.0
    start_idx = src.frame_index_at(req.start)
    end_idx = src.frame_index_at(req.end)
    expected = None
    if start_idx is not None and end_idx is not None:
        expected = max(0, end_idx - start_idx)
    notes: list[str] = []
    if src.probed_frames == 0:
        notes.append("未逐帧解码源文件：关键帧位置来自 packet 标记，帧号按标称帧率推算。")
    if not src.fps_exact:
        notes.append(f"标称帧率与实测帧间隔不一致（实测 {src.fps:.4f} fps），帧号可能有 ±1 误差。")
    return Prediction(
        request=req,
        start_keyframe=start_kf,
        end_keyframe=end_kf,
        preroll_seconds=preroll,
        preroll_frames=preroll * fps,
        start_frame_index=start_idx,
        end_frame_index=end_idx,
        expected_frames=expected,
        start_on_key=bool(start_kf and preroll <= 1e-4),
        notes=notes,
    )


def compare(pred: Prediction, copy_out: OutputMeasure | None,
            reenc_out: OutputMeasure | None,
            copy_align: "audio.Alignment | None" = None,
            reenc_align: "audio.Alignment | None" = None) -> list[Deviation]:
    req = pred.request
    out: list[Deviation] = []

    def add(label: str, requested: float, actual: float | None,
            severity: str, detail: str = "", unit: str = "frames") -> None:
        if actual is None:
            return
        delta = actual - requested
        out.append(Deviation(label, requested, actual, delta, severity, detail, unit))

    def frames_of(measure: OutputMeasure | None) -> int | None:
        return measure.video.frames if measure and measure.video else None

    for tag, measure, align in (
        ("直接截取", copy_out, copy_align),
        ("重编码", reenc_out, reenc_align),
    ):
        if not measure or not measure.video:
            continue
        target_frame = float(pred.start_frame_index or 0)
        # 1) 首帧身份
        if measure.first_frame_index is not None:
            offset = measure.first_frame_index - target_frame
            if offset == 0:
                sev = "ok"
            elif abs(offset) <= 1:
                sev = "warn"
            else:
                sev = "bad"
            add(f"{tag} · 首帧身份", target_frame, float(measure.first_frame_index),
                sev, "条码读出的帧号 vs 计划起点帧号", "frames")
        # 2) 首帧显示时刻
        if measure.video.first_pts is not None:
            pts = measure.video.first_pts
            sev = "ok" if abs(pts) <= 0.002 else "warn"
            add(f"{tag} · 首帧时刻", 0.0, pts, sev,
                "0 = 输出从首帧计时；负值 = 写入了预滚帧", "seconds")
        # 3) 视频帧数
        actual_frames = frames_of(measure)
        if actual_frames is not None and pred.expected_frames is not None:
            delta = actual_frames - pred.expected_frames
            sev = "ok" if abs(delta) <= 1 else ("warn" if abs(delta) <= 4 else "bad")
            add(f"{tag} · 视频帧数", float(pred.expected_frames), float(actual_frames),
                sev, f"请求 {req.duration:.3f}s ≈ {pred.expected_frames} 帧", "frames")
        # 4) 音轨起点
        if measure.audio and measure.audio.first_pts is not None:
            a0 = measure.audio.first_pts
            sev = "ok" if a0 >= -0.001 else "warn"
            add(f"{tag} · 音轨首采样", 0.0, a0, sev,
                "负值 = 编解码器预滚样本被保留", "seconds")
        # 5) 音轨内容对齐
        if align and align.lag is not None:
            sev = "ok" if abs(align.lag) <= 0.03 else ("warn" if abs(align.lag) <= 0.2 else "bad")
            add(f"{tag} · 音画内容对齐", 0.0, align.lag, sev,
                f"包络互相关置信度 {align.confidence:.0%}", "seconds")
    return out
