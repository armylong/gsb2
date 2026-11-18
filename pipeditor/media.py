"""ffprobe/ffmpeg 封装: 探测、逐帧解码(预览)与导出。

所有解码均为本地 ffmpeg 子进程 + 原始 rgb24 管道, 不依赖系统解码器。
预览只用于显示, 导出时重新解码原文件, 二者共用 :mod:`pipeditor.model`
的坐标与插值规则。
"""

from __future__ import annotations

import json
import subprocess
from fractions import Fraction

import numpy as np

from .model import Project


class FFmpegNotFound(RuntimeError):
    pass


def _ffmpeg_bin(name: str) -> str:
    return name  # 依赖 PATH; README 要求 brew install ffmpeg


def _run(cmd: list[str]) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(cmd, capture_output=True, check=True)
    except FileNotFoundError as exc:  # pragma: no cover - 环境问题
        raise FFmpegNotFound(
            f"找不到 {cmd[0]}, 请先安装 ffmpeg: brew install ffmpeg"
        ) from exc
    except subprocess.CalledProcessError as exc:
        raise RuntimeError(
            f"命令执行失败:\n{' '.join(cmd)}\n{exc.stderr.decode('utf-8', 'replace')}"
        ) from exc


class VideoInfo:
    def __init__(
        self,
        path: str,
        width: int,
        height: int,
        fps: Fraction,
        frame_count: int,
        duration: float,
        has_audio: bool,
    ) -> None:
        self.path = path
        self.width = width
        self.height = height
        self.fps = fps
        self.frame_count = frame_count
        self.duration = duration
        self.has_audio = has_audio

    def __repr__(self) -> str:  # pragma: no cover - 调试用
        return (
            f"VideoInfo({self.path} {self.width}x{self.height} "
            f"{float(self.fps):g}fps {self.frame_count}帧 "
            f"audio={self.has_audio})"
        )


def probe(path: str) -> VideoInfo:
    """用 ffprobe 读取视频流参数与音频是否存在。"""

    cmd = [
        _ffmpeg_bin("ffprobe"),
        "-v",
        "error",
        "-show_streams",
        "-show_format",
        "-of",
        "json",
        path,
    ]
    data = json.loads(_run(cmd).stdout)
    streams = data.get("streams", [])
    vstreams = [s for s in streams if s.get("codec_type") == "video"]
    if not vstreams:
        raise RuntimeError(f"{path} 中没有视频流")
    v = vstreams[0]
    width = int(v["width"])
    height = int(v["height"])

    rate = v.get("r_frame_rate", "0/0")
    num, den = rate.split("/")
    fps = Fraction(int(num), int(den)) if int(den) else Fraction(30, 1)
    if fps <= 0:
        fps = Fraction(30, 1)

    duration = float(
        v.get("duration")
        or data.get("format", {}).get("duration")
        or 0.0
    )

    nb = v.get("nb_frames")
    if nb and nb != "N/A":
        frame_count = int(nb)
    elif duration > 0:
        frame_count = round(duration * float(fps))
    else:  # 兜底: 全量解码计数
        frame_count = count_frames(path, width, height)
    if frame_count <= 0:
        raise RuntimeError(f"{path} 无法确定帧数")

    has_audio = any(s.get("codec_type") == "audio" for s in streams)
    return VideoInfo(path, width, height, fps, frame_count, duration, has_audio)


def count_frames(path: str, width: int, height: int) -> int:
    cmd = [
        _ffmpeg_bin("ffmpeg"),
        "-v",
        "error",
        "-i",
        path,
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "pipe:1",
    ]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    assert proc.stdout is not None
    frame_bytes = width * height * 3
    total = 0
    while True:
        chunk = proc.stdout.read(frame_bytes)
        if len(chunk) < frame_bytes:
            break
        total += 1
    proc.wait()
    return total


def read_frame_rgb(path: str, width: int, height: int, frame: int,
                   fps: Fraction) -> np.ndarray:
    """精确读取某一帧(输出端 -ss, 慢但帧号准确), 返回 HxWx3 uint8。"""

    t = frame / float(fps)
    cmd = [
        _ffmpeg_bin("ffmpeg"),
        "-v",
        "error",
        "-i",
        path,
        "-ss",
        f"{t:.6f}",
        "-frames:v",
        "1",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "pipe:1",
    ]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    assert proc.stdout is not None
    raw = proc.stdout.read(width * height * 3)
    err = proc.stderr.read()
    proc.wait()
    if proc.returncode != 0:
        raise RuntimeError(f"解码帧 {frame} 失败: {err.decode('utf-8', 'replace')}")
    if len(raw) != width * height * 3:
        raise RuntimeError(f"解码帧 {frame} 数据不完整: {len(raw)} 字节")
    return np.frombuffer(raw, dtype=np.uint8).reshape(height, width, 3).copy()


def iter_frames_rgb(path: str, width: int, height: int):
    """顺序解码整段视频, 逐帧 yield HxWx3 uint8 数组。"""

    cmd = [
        _ffmpeg_bin("ffmpeg"),
        "-v",
        "error",
        "-i",
        path,
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "pipe:1",
    ]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    assert proc.stdout is not None
    frame_bytes = width * height * 3
    try:
        while True:
            raw = proc.stdout.read(frame_bytes)
            if len(raw) < frame_bytes:
                break
            yield np.frombuffer(raw, dtype=np.uint8).reshape(
                height, width, 3
            ).copy()
    finally:
        if proc.poll() is None:
            proc.terminate()
        proc.wait()
        err = proc.stderr.read()
        if proc.returncode not in (0, -15) and err:
            raise RuntimeError(err.decode("utf-8", "replace"))


def build_project(bg: VideoInfo, ov: VideoInfo,
                  overlay_w: int, overlay_h: int) -> Project:
    """根据两段视频构造 :class:`Project`, 帧数一律按背景帧率换算。

    叠加层从零点开始, 它在背景时间轴上占多少帧由其时长乘背景帧率决定;
    长于背景的部分天然落在输出范围外(导出再由 ``-frames:v`` 硬截断)。
    """

    overlay_frames = max(1, round(ov.duration * float(bg.fps)))
    return Project(
        canvas_w=bg.width,
        canvas_h=bg.height,
        fps=bg.fps,
        frame_count=bg.frame_count,
        duration=bg.frame_count / float(bg.fps),
        overlay_w=overlay_w,
        overlay_h=overlay_h,
        overlay_frame_count=min(overlay_frames, bg.frame_count),
    )
