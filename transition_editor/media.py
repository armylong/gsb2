"""ffprobe/ffmpeg 基础封装与全局常量."""
from __future__ import annotations

import json
import shutil
import subprocess

FPS = 30
WIDTH, HEIGHT = 1280, 720          # 720p 输出
MAX_SOURCE_SECONDS = 8.0           # 每段素材上限
MIN_TRANSITION = 0.2
MAX_TRANSITION = 2.0
FRAME = 1.0 / FPS                  # 一个输出帧的时长


class MediaError(Exception):
    """ffmpeg/ffprobe 调用或媒体参数错误."""


def require_ffmpeg() -> None:
    missing = [t for t in ("ffmpeg", "ffprobe") if shutil.which(t) is None]
    if missing:
        raise MediaError("未找到命令: " + ", ".join(missing) + "（请先安装 ffmpeg）")


def run(cmd: list[str], capture: bool = True) -> subprocess.CompletedProcess:
    """运行命令, 失败时抛出带 stderr 末尾的 MediaError."""
    proc = subprocess.run(
        cmd,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE,
    )
    if proc.returncode != 0:
        tail = (proc.stderr or b"").decode("utf-8", "replace")[-2000:]
        raise MediaError(f"命令失败 ({cmd[0]}):\n{tail}")
    return proc


def probe_duration(path: str) -> float:
    """容器总时长(秒)."""
    require_ffmpeg()
    proc = run([
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "json", path,
    ])
    return float(json.loads(proc.stdout)["format"]["duration"])


def probe_streams(path: str, count_frames: bool = False) -> dict:
    """返回 {duration, audio_duration, video_duration, nb_frames(可选)}."""
    require_ffmpeg()
    cmd = [
        "ffprobe", "-v", "error",
        "-show_entries", "format=duration:stream=codec_type,duration,nb_frames",
        "-of", "json",
    ]
    if count_frames:
        cmd += ["-count_frames"]
    cmd.append(path)
    info = json.loads(run(cmd).stdout)
    out = {"duration": float(info["format"]["duration"]), "audio_duration": None,
           "video_duration": None, "nb_frames": None}
    for s in info.get("streams", []):
        dur = float(s["duration"]) if s.get("duration") else None
        if s.get("codec_type") == "audio":
            out["audio_duration"] = dur
        elif s.get("codec_type") == "video":
            out["video_duration"] = dur
            if count_frames and s.get("nb_frames"):
                out["nb_frames"] = int(s["nb_frames"])
    return out
