"""ffprobe / ffmpeg 的最小封装。

设计原则:
- 帧数以 ffprobe 的视频 packet 列表为准(容器里真实存在的包),
  不相信 codec 级元数据的 nb_frames(部分封装为 -1)。
- 所有解码帧统一走 rawvideo 管道, 再在 numpy 里处理, 不依赖第三方解码器。
"""

from __future__ import annotations

import hashlib
import json
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from .errors import FFmpegError, MediaProbeError

# CFR 判定: 相邻包间隔相对标称帧周期的最大相对偏差。
# MP4 时间基取整会让 30fps 帧间隔在 33.3/33.4ms 间抖动(约 0.1%),
# 因此阈值取 0.5%, 真正的 VFR/丢帧抖动远大于此。
CFR_TOLERANCE = 5e-4
# 允许的极小 PTS 绝对抖动(秒)。
PTS_EPS = 1e-5


def _run(cmd: list[str]) -> subprocess.CompletedProcess:
    try:
        proc = subprocess.run(
            cmd, capture_output=True, text=True, check=False,
        )
    except FileNotFoundError as exc:  # pragma: no cover - 环境缺 ffmpeg
        raise MediaProbeError(f"找不到可执行文件: {cmd[0]}") from exc
    if proc.returncode != 0:
        raise FFmpegError(
            f"命令失败({proc.returncode}): {' '.join(cmd[:2])}\n{proc.stderr.strip()[-800:]}"
        )
    return proc


@dataclass
class MediaInfo:
    """一份媒体文件被实际探测出的信息(全部来自 ffprobe/解码, 不来自文件名)。"""

    path: str
    container: str
    width: int
    height: int
    sample_aspect_ratio: str
    frame_rate: float
    nb_video_frames: int
    duration: float          # format 级时长(秒)
    video_duration: float    # 末帧 PTS + 帧周期(秒)
    has_audio: bool
    audio_duration: float | None
    audio_sample_rate: int | None
    packet_pts: list[float] = field(repr=False, default_factory=list)
    sha256: str = ""
    content_digest: str = ""

    @property
    def resolution(self) -> str:
        return f"{self.width}x{self.height}"

    def to_dict(self) -> dict:
        return {
            "path": self.path,
            "container": self.container,
            "width": self.width,
            "height": self.height,
            "resolution": self.resolution,
            "sample_aspect_ratio": self.sample_aspect_ratio,
            "frame_rate": round(self.frame_rate, 6),
            "nb_video_frames": self.nb_video_frames,
            "duration": round(self.duration, 6),
            "video_duration": round(self.video_duration, 6),
            "has_audio": self.has_audio,
            "audio_duration": (
                round(self.audio_duration, 6) if self.audio_duration is not None else None
            ),
            "audio_sample_rate": self.audio_sample_rate,
            "sha256": self.sha256,
            "content_digest": self.content_digest,
        }


def ffprobe_json(path: str | Path) -> dict:
    proc = _run([
        "ffprobe", "-v", "error", "-print_format", "json",
        "-show_format", "-show_streams", str(path),
    ])
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise MediaProbeError(f"ffprobe 输出无法解析: {path}") from exc


def probe_packet_pts(path: str | Path) -> list[float]:
    """返回视频流每个 packet 的 PTS(秒), 列表长度即真实帧数。"""
    proc = _run([
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "packet=pts_time",
        "-of", "json", str(path),
    ])
    try:
        data = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise MediaProbeError(f"ffprobe packet 输出无法解析: {path}") from exc
    pts = [float(p["pts_time"]) for p in data.get("packets", []) if "pts_time" in p]
    if not pts:
        raise MediaProbeError(f"视频流没有任何 packet: {path}")
    # packet 按解码顺序排列(含 B 帧时 PTS 非单调), 呈现顺序需排序。
    pts.sort()
    return pts


def _parse_fraction(text: str | None) -> float | None:
    if not text or text == "0/0":
        return None
    if "/" in text:
        num, den = text.split("/", 1)
        den_f = float(den)
        if den_f == 0:
            return None
        return float(num) / den_f
    return float(text)


def _is_constant_frame_rate(pts: list[float], frame_rate: float) -> bool:
    if len(pts) < 2:
        return True
    nominal = 1.0 / frame_rate
    deltas = np.diff(np.asarray(pts, dtype=np.float64))
    # 第一帧 PTS 可能不是 0, 但间隔必须稳定。
    return bool(np.max(np.abs(deltas - nominal)) <= CFR_TOLERANCE * nominal + PTS_EPS)


def probe(path: str | Path, with_packets: bool = True) -> MediaInfo:
    """完整探测一个媒体文件。"""
    p = Path(path)
    if not p.is_file():
        raise MediaProbeError(f"文件不存在: {path}")
    data = ffprobe_json(p)
    streams = data.get("streams", [])
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    if video is None:
        raise MediaProbeError(f"没有视频流: {path}")
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)

    frame_rate = _parse_fraction(video.get("avg_frame_rate"))
    if frame_rate is None or frame_rate <= 0:
        raise MediaProbeError(f"无法解析帧率: {path}")

    pts = probe_packet_pts(p) if with_packets else []
    if pts and not _is_constant_frame_rate(pts, frame_rate):
        raise MediaProbeError(
            f"不是恒定帧率(CFR): {path}, 标称 {frame_rate:.3f}fps, "
            f"包间隔存在超出 ±{CFR_TOLERANCE:.2%} 的抖动"
        )

    width = int(video["width"])
    height = int(video["height"])
    nominal_period = 1.0 / frame_rate
    video_duration = (pts[-1] + nominal_period) if pts else float(
        data.get("format", {}).get("duration", 0.0)
    )

    fmt = data.get("format", {})
    duration = float(fmt.get("duration", video_duration))

    audio_duration = None
    audio_sr = None
    if audio is not None:
        audio_sr = int(audio.get("sample_rate", 0)) or None
        ad = _parse_fraction(audio.get("duration"))
        if ad is None:
            ad = float(fmt.get("duration", 0.0))
        audio_duration = ad

    return MediaInfo(
        path=str(p.resolve()),
        container=(fmt.get("format_name") or p.suffix.lstrip(".")),
        width=width,
        height=height,
        sample_aspect_ratio=video.get("sample_aspect_ratio", "1:1") or "1:1",
        frame_rate=frame_rate,
        nb_video_frames=len(pts) if pts else int(video.get("nb_frames", 0) or 0),
        duration=duration,
        video_duration=video_duration,
        has_audio=audio is not None,
        audio_duration=audio_duration,
        audio_sample_rate=audio_sr,
        packet_pts=pts,
    )


def sha256_file(path: str | Path, chunk: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        while True:
            block = fh.read(chunk)
            if not block:
                break
            h.update(block)
    return h.hexdigest()


def decode_gray_frames(
    path: str | Path,
    width: int,
    height: int,
    frame_indices: list[int] | None = None,
) -> np.ndarray:
    """解码视频为灰度浮点帧, shape=(N, height, width), 值域 0..1。

    frame_indices 为 None 时返回全部帧; 否则按呈现顺序取指定序号(从 0 起)。
    短视频统一全量解码再在 numpy 侧取帧, 避免 select 滤镜转义在不同
    ffmpeg 版本上的歧义, 帧号与 packet 排序后的呈现序号严格一致。
    """
    cmd = [
        "ffmpeg", "-v", "error", "-nostdin", "-i", str(path),
        "-vf", f"scale={width}:{height}:flags=area,format=gray",
        "-f", "rawvideo", "-pix_fmt", "gray", "-",
    ]
    proc = subprocess.Popen(
        cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    frame_size = width * height
    frames: list[np.ndarray] = []
    assert proc.stdout is not None
    while True:
        raw = proc.stdout.read(frame_size)
        if len(raw) < frame_size:
            break
        frames.append(np.frombuffer(raw, dtype=np.uint8).reshape(height, width))
    stderr = proc.stderr.read().decode("utf-8", "replace")
    ret = proc.wait()
    if ret != 0:
        raise FFmpegError(f"灰度解码失败: {path}\n{stderr[-600:]}")
    if not frames:
        raise FFmpegError(f"灰度解码未得到任何帧: {path}")
    all_frames = np.stack(frames).astype(np.float32) / 255.0
    if frame_indices is None:
        return all_frames
    wanted = sorted(set(int(i) for i in frame_indices))
    if any(i < 0 or i >= len(all_frames) for i in wanted):
        raise FFmpegError(
            f"请求帧号超出范围(共 {len(all_frames)} 帧): {wanted}")
    return all_frames[wanted]


GRID_W, GRID_H = 32, 18


def content_digest(path: str | Path) -> tuple[str, np.ndarray]:
    """整段视频的内容指纹: 每帧缩到 32x18 灰度, 量化后整体取 sha256。

    与文件 sha256 不同: 同内容重新编码后文件哈希必然变化,
    而内容指纹应保持高度接近(校验逻辑里按容差比较)。
    返回 (16 进制摘要, 全部网格帧数组)。
    """
    frames = decode_gray_frames(path, GRID_W, GRID_H)
    quantized = np.round(frames * 255).astype(np.uint8)
    return hashlib.sha256(quantized.tobytes()).hexdigest(), frames
