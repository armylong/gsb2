"""ffmpeg / ffprobe 子进程封装。"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any

from .model import VideoInfo


def ffmpeg_bin() -> str:
    return os.environ.get("FFMPEG_BIN") or shutil.which("ffmpeg") or "ffmpeg"


def ffprobe_bin() -> str:
    return os.environ.get("FFPROBE_BIN") or shutil.which("ffprobe") or "ffprobe"


def run_command(args: list[str], **kwargs: Any) -> subprocess.CompletedProcess:
    return subprocess.run(args, check=True, capture_output=True, text=True, **kwargs)


def probe_video(path: str | Path) -> VideoInfo:
    cmd = [
        ffprobe_bin(),
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        str(path),
    ]
    proc = run_command(cmd)
    data = json.loads(proc.stdout)
    video = next(
        (s for s in data.get("streams", []) if s.get("codec_type") == "video"),
        None,
    )
    if video is None:
        raise RuntimeError(f"文件中没有视频流: {path}")

    width = int(video["width"])
    height = int(video["height"])
    fps = 30.0
    rate = video.get("avg_frame_rate") or video.get("r_frame_rate") or "30/1"
    if "/" in rate:
        num, den = rate.split("/", 1)
        den_f = float(den) or 1.0
        fps = float(num) / den_f if den_f else 30.0
    elif rate:
        fps = float(rate)

    duration = 0.0
    if "duration" in video:
        duration = float(video["duration"])
    elif data.get("format", {}).get("duration"):
        duration = float(data["format"]["duration"])

    has_audio = any(s.get("codec_type") == "audio" for s in data.get("streams", []))
    return VideoInfo(
        path=str(path),
        width=width,
        height=height,
        fps=fps or 30.0,
        duration=duration,
        has_audio=has_audio,
    )


def run_ffmpeg(args: list[str]) -> None:
    cmd = [ffmpeg_bin(), "-hide_banner", "-loglevel", "error", "-y", *args]
    proc = subprocess.run(cmd, text=True, capture_output=True)
    if proc.returncode != 0:
        raise RuntimeError(
            "ffmpeg 执行失败:\n"
            + " ".join(cmd)
            + "\nSTDOUT:\n"
            + proc.stdout
            + "\nSTDERR:\n"
            + proc.stderr
        )


def extract_frame(video_path: str | Path, time_seconds: float, output_png: str | Path) -> Path:
    output_png = Path(output_png)
    output_png.parent.mkdir(parents=True, exist_ok=True)
    run_ffmpeg(
        [
            "-ss",
            f"{max(0.0, time_seconds):.6f}",
            "-i",
            str(video_path),
            "-frames:v",
            "1",
            "-q:v",
            "2",
            str(output_png),
        ]
    )
    return output_png
