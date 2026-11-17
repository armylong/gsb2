"""ffprobe 封装：读取单个视频片段的元数据。"""
from __future__ import annotations

import json
import shutil
import subprocess
from dataclasses import dataclass
from fractions import Fraction


class ProbeError(Exception):
    """片段无法被识别或不含视频流时抛出，message 中带片段序号由上层补充。"""


@dataclass(frozen=True)
class MediaInfo:
    path: str
    duration: float          # 秒（容器时长；异常时回退到流时长）
    width: int
    height: int
    fps: float               # 平均帧率
    fps_fraction: str        # 形如 "30000/1001"，原样传给 ffmpeg
    has_audio: bool
    audio_duration: float | None  # 音轨时长，用于发现音画轨道长度不一致
    video_codec: str
    audio_codec: str | None

    @property
    def label(self) -> str:
        return f"{self.width}x{self.height} @ {self.fps:g}fps"


def _ffprobe_bin() -> str:
    binary = shutil.which("ffprobe")
    if not binary:
        raise ProbeError("系统未找到 ffprobe，请先安装 ffmpeg 并加入 PATH")
    return binary


def _parse_fraction(text: str | None) -> float:
    if not text or text in ("0/0", "N/A"):
        return 0.0
    try:
        value = Fraction(text)
        return float(value)
    except (ValueError, ZeroDivisionError):
        return 0.0


def probe_media(path: str) -> MediaInfo:
    """探测一个媒体文件，失败时抛 ProbeError（消息面向用户，可直接展示）。"""
    cmd = [
        _ffprobe_bin(), "-v", "error",
        "-print_format", "json",
        "-show_format", "-show_streams",
        path,
    ]
    try:
        proc = subprocess.run(
            cmd, capture_output=True, text=True, timeout=60, check=False
        )
    except subprocess.TimeoutExpired as exc:
        raise ProbeError(f"探测超时（>60s），文件可能已损坏：{path}") from exc
    except OSError as exc:
        raise ProbeError(f"无法执行 ffprobe：{exc}") from exc

    if proc.returncode != 0:
        detail = proc.stderr.strip().splitlines()
        tail = detail[-1] if detail else "未知错误"
        raise ProbeError(f"ffprobe 读取失败：{tail}")

    try:
        data = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise ProbeError("ffprobe 输出无法解析，文件可能不是有效媒体") from exc

    streams = data.get("streams", [])
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    if video is None:
        raise ProbeError("文件中没有视频流")

    width = int(video.get("width") or 0)
    height = int(video.get("height") or 0)
    if width <= 0 or height <= 0:
        raise ProbeError("视频流尺寸无效")

    # 优先 r_frame_rate：对恒定帧率（含 29.97 这类分数帧率）它是精确的流时基帧率；
    # avg_frame_rate = 总帧数/容器时长，拼接后容器时长有编码余量时会被拉偏，仅作兜底
    fps_fraction = video.get("r_frame_rate") or video.get("avg_frame_rate") or "0/0"
    fps = _parse_fraction(fps_fraction)
    if fps <= 0:
        fps_fraction = video.get("avg_frame_rate") or "0/0"
        fps = _parse_fraction(fps_fraction)
    if fps <= 0:
        raise ProbeError("视频帧率无效或为可变帧率且无法确定平均帧率")

    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    has_audio = audio is not None
    audio_duration = None
    if audio is not None:
        raw = audio.get("duration")
        try:
            audio_duration = float(raw) if raw else None
        except (TypeError, ValueError):
            audio_duration = None

    duration = _extract_duration(data.get("format", {}), video)
    if duration <= 0:
        raise ProbeError("无法确定视频时长")

    return MediaInfo(
        path=path,
        duration=duration,
        width=width,
        height=height,
        fps=fps,
        fps_fraction=fps_fraction,
        has_audio=has_audio,
        audio_duration=audio_duration,
        video_codec=video.get("codec_name", "unknown"),
        audio_codec=audio.get("codec_name") if audio else None,
    )


def _extract_duration(fmt: dict, video: dict) -> float:
    for source in (fmt, video):
        raw = source.get("duration")
        try:
            value = float(raw) if raw else 0.0
        except (TypeError, ValueError):
            value = 0.0
        if value > 0:
            return value
    return 0.0
