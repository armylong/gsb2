"""输入视频校验、时间戳探测与帧解码。"""
from __future__ import annotations

import os
import tempfile
from dataclasses import dataclass, field

from . import MAX_DURATION_SECONDS, MAX_HEIGHT
from . import ffmpeg_utils


class InputError(ValueError):
    """输入文件不满足约束或无法解析。"""


@dataclass
class InputVideo:
    """一次成功导入的输入视频及其解码结果。"""

    path: str
    width: int
    height: int
    codec: str
    container_duration: float          # 容器声明的时长(秒)
    raw_pts: list[float]               # ffprobe 给出的原始显示时间戳(秒)
    zero_ts: list[float]               # 以首个可显示画面为零点的时间
    intervals: list[float | None]      # 与上一帧的间隔, 首帧为 None
    is_vfr: bool
    avg_fps: float | None
    has_audio: bool
    work_dir: str
    frame_files: list[str] = field(default_factory=list)

    @property
    def frame_count(self) -> int:
        return len(self.zero_ts)

    @property
    def source_span(self) -> float:
        """最后一帧相对零点的时间(内容时间跨度)。"""
        return self.zero_ts[-1] if self.zero_ts else 0.0


def _read_video_meta(path: str) -> dict:
    meta = ffmpeg_utils.probe_streams(path)
    videos = [s for s in meta.get("streams", []) if s.get("codec_type") == "video"]
    if not videos:
        raise InputError("文件中没有视频流")
    meta["_video"] = videos[0]
    return meta


def load_video(path: str, work_dir: str | None = None,
               progress=None) -> InputVideo:
    """校验并导入视频: 探测时间戳、逐帧解码到工作目录。

    progress: 可选回调 (current, total)。
    """
    if not os.path.isfile(path):
        raise InputError(f"文件不存在: {path}")
    ext = os.path.splitext(path)[1].lower()
    if ext != ".mp4":
        raise InputError(f"仅支持 mp4 容器, 当前为 {ext or '无扩展名'}")

    try:
        return _load_checked(path, work_dir, progress)
    except ffmpeg_utils.FFmpegError as exc:
        # 底层 ffmpeg/ffprobe 失败统一转成输入错误, UI 只面对一种异常
        raise InputError(f"文件无法被 ffmpeg 解析或解码: {exc}") from exc


def _load_checked(path: str, work_dir: str | None, progress) -> InputVideo:
    info = _read_video_meta(path)
    v = info["_video"]
    width = int(v.get("width", 0))
    height = int(v.get("height", 0))
    if height > MAX_HEIGHT:
        raise InputError(f"高度 {height}p 超过上限 {MAX_HEIGHT}p")
    if height <= 0 or width <= 0:
        raise InputError("无法识别视频分辨率")

    duration = float(info.get("format", {}).get("duration", 0.0) or 0.0)
    if duration <= 0:
        raise InputError("无法识别视频时长")
    if duration > MAX_DURATION_SECONDS + 1e-6:
        raise InputError(
            f"时长 {duration:.3f}s 超过上限 {MAX_DURATION_SECONDS:.0f}s"
        )

    raw_pts = ffmpeg_utils.probe_frame_timestamps(path)
    if len(raw_pts) < 2:
        raise InputError("视频至少需要 2 帧")
    t0 = raw_pts[0]
    zero_ts = [t - t0 for t in raw_pts]
    intervals: list[float | None] = [None]
    intervals.extend(zero_ts[i] - zero_ts[i - 1] for i in range(1, len(zero_ts)))

    # 间隔明显不均匀即判定为 VFR(容差 2ms, 避开容器时间基量化噪声)
    real_gaps = [g for g in intervals if g is not None]
    is_vfr = (max(real_gaps) - min(real_gaps)) > 0.002

    avg_fps: float | None = None
    rate = v.get("avg_frame_rate", "0/0")
    try:
        num, den = rate.split("/")
        if float(den) != 0:
            avg_fps = float(num) / float(den)
    except (ValueError, ZeroDivisionError):
        avg_fps = None

    has_audio = any(
        s.get("codec_type") == "audio" for s in info.get("streams", [])
    )

    if work_dir is None:
        work_dir = tempfile.mkdtemp(prefix="fpsc_")
    os.makedirs(work_dir, exist_ok=True)
    pattern = os.path.join(work_dir, "frame_%06d.jpg")
    ffmpeg_utils.extract_frames(path, pattern)
    frame_files = [
        os.path.join(work_dir, f"frame_{i:06d}.jpg")
        for i in range(1, len(raw_pts) + 1)
    ]
    missing = [p for p in frame_files if not os.path.isfile(p)]
    if missing:
        raise InputError(
            f"解码帧数与探测不一致, 缺少 {len(missing)} 帧 (期望 {len(raw_pts)})"
        )
    if progress:
        progress(len(frame_files), len(frame_files))

    return InputVideo(
        path=os.path.abspath(path),
        width=width,
        height=height,
        codec=v.get("codec_name", "unknown"),
        container_duration=duration,
        raw_pts=raw_pts,
        zero_ts=zero_ts,
        intervals=intervals,
        is_vfr=is_vfr,
        avg_fps=avg_fps,
        has_audio=has_audio,
        work_dir=work_dir,
        frame_files=frame_files,
    )
