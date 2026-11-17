"""ffprobe / ffmpeg 封装、输入校验与音频处理。"""
from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass
from pathlib import Path

FFMPEG = "ffmpeg"
FFPROBE = "ffprobe"

# 输入约束 (需求 1)
MAX_DURATION_SEC = 15.0
MAX_HEIGHT = 720
VIDEO_CONTAINER_EXT = {".mp4"}


class MediaError(ValueError):
    """输入文件不满足约束或媒体信息异常。"""


@dataclass
class VideoInfo:
    width: int
    height: int
    fps: float
    frame_count: int
    duration: float
    has_audio: bool
    audio_codec: str | None
    video_codec: str | None


def _run(cmd: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, check=False)


def probe(path: str | Path) -> VideoInfo:
    p = Path(path)
    if p.suffix.lower() not in VIDEO_CONTAINER_EXT:
        raise MediaError(f"仅支持 mp4 容器, 收到: {p.suffix or '无扩展名'}")
    cmd = [
        FFPROBE, "-v", "error", "-print_format", "json",
        "-show_format", "-show_streams", str(p),
    ]
    res = _run(cmd)
    if res.returncode != 0:
        raise MediaError(f"ffprobe 无法读取文件: {res.stderr.strip()[:300]}")
    meta = json.loads(res.stdout)
    vstreams = [s for s in meta.get("streams", []) if s.get("codec_type") == "video"]
    astreams = [s for s in meta.get("streams", []) if s.get("codec_type") == "audio"]
    if not vstreams:
        raise MediaError("文件中没有视频流")
    vs = vstreams[0]

    # 帧率: 优先 avg_frame_rate, 回退 r_frame_rate
    def parse_rate(token: str) -> float:
        num, _, den = token.partition("/")
        den = float(den) if den else 1.0
        return float(num) / den if den else 0.0

    fps = parse_rate(vs.get("avg_frame_rate", "0/1"))
    if fps <= 0:
        fps = parse_rate(vs.get("r_frame_rate", "30/1"))
    # 恒定帧率校验: r_frame_rate 与 avg_frame_rate 应一致
    r_fps = parse_rate(vs.get("r_frame_rate", "0/1"))
    if r_fps > 0 and abs(r_fps - fps) > 0.02:
        raise MediaError(
            f"仅支持恒定帧率(CFR)视频, avg={fps:.3f} r={r_fps:.3f} 不一致"
        )

    width, height = int(vs["width"]), int(vs["height"])
    if height > MAX_HEIGHT:
        raise MediaError(f"高度 {height}px 超过上限 {MAX_HEIGHT}p")

    duration = float(meta.get("format", {}).get("duration", 0.0) or 0.0)
    if duration > MAX_DURATION_SEC + 0.05:
        raise MediaError(f"时长 {duration:.2f}s 超过上限 {MAX_DURATION_SEC:.0f}s")

    # 帧数: 优先 nb_frames, 否则用时长*帧率
    nb = vs.get("nb_frames")
    frame_count = int(nb) if nb and nb.isdigit() else round(duration * fps)
    if frame_count <= 0:
        raise MediaError("无法确定视频帧数")
    if duration <= 0:
        duration = frame_count / fps

    has_audio = bool(astreams)
    audio_codec = astreams[0].get("codec_name") if has_audio else None
    return VideoInfo(
        width=width, height=height, fps=fps, frame_count=frame_count,
        duration=duration, has_audio=has_audio, audio_codec=audio_codec,
        video_codec=vs.get("codec_name"),
    )


def extract_audio(src: str | Path, dst: str | Path) -> bool:
    """抽出原始音频为 m4a, 保留编码参数。无音频时返回 False。"""
    # 先探测, 无音频流直接返回, 避免 ffmpeg 对空输出报错
    if not probe(src).has_audio:
        return False
    cmd = [
        FFMPEG, "-y", "-v", "error", "-i", str(src),
        "-vn", "-acodec", "copy", str(dst),
    ]
    res = _run(cmd)
    if res.returncode == 0 and Path(dst).exists() and Path(dst).stat().st_size > 0:
        return True
    # 某些编码不能直接 copy 进 m4a, 回退 AAC 重编 (仍是原音频内容)
    cmd = [
        FFMPEG, "-y", "-v", "error", "-i", str(src),
        "-vn", "-acodec", "aac", "-b:a", "192k", str(dst),
    ]
    res = _run(cmd)
    if res.returncode != 0:
        raise MediaError(f"音频提取失败: {res.stderr.strip()[:300]}")
    return Path(dst).exists() and Path(dst).stat().st_size > 0


def mux_video_audio(
    video_only: str | Path, audio: str | Path | None, out: str | Path,
    metadata: dict | None = None,
) -> None:
    """合并无声视频与原始音频; metadata 以字符串形式写入容器元数据。"""
    cmd = [FFMPEG, "-y", "-v", "error", "-i", str(video_only)]
    if audio is not None:
        cmd += ["-i", str(audio)]
    cmd += ["-c:v", "copy"]
    if audio is not None:
        cmd += ["-c:a", "copy", "-map", "0:v:0", "-map", "1:a:0"]
    else:
        cmd += ["-map", "0:v:0"]
    if metadata:
        for k, v in metadata.items():
            cmd += ["-metadata", f"{k}={v}"]
    cmd += ["-movflags", "+faststart", str(out)]
    res = _run(cmd)
    if res.returncode != 0:
        raise MediaError(f"ffmpeg 封装失败: {res.stderr.strip()[:400]}")


def encode_video_only(
    video_only: str | Path, out: str | Path, metadata: dict | None = None,
) -> None:
    """无音频源时直接封装并写入元数据。"""
    cmd = [FFMPEG, "-y", "-v", "error", "-i", str(video_only),
           "-c:v", "copy", "-map", "0:v:0"]
    if metadata:
        for k, v in metadata.items():
            cmd += ["-metadata", f"{k}={v}"]
    cmd += ["-movflags", "+faststart", str(out)]
    res = _run(cmd)
    if res.returncode != 0:
        raise MediaError(f"ffmpeg 封装失败: {res.stderr.strip()[:400]}")
