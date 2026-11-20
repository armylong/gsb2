"""逐帧解码与相似度计算。"""

from __future__ import annotations

import subprocess
from typing import Callable, Iterator, Optional, Tuple

import numpy as np

from .timeline import FFmpegError, VideoTimeline, require_binary

ProgressCallback = Optional[Callable[[int, int], None]]


def feature_grid(frame: np.ndarray, tile: int) -> np.ndarray:
    """把灰度帧压成 tile×tile 的块均值网格(归一化到 [0,1])。

    块均值抑制编码噪声与亚像素抖动，同时保留"画面结构"的变化，
    是区分"停住"与"慢速移动"的关键。
    """
    data = frame.astype(np.float32) / 255.0
    h, w = data.shape
    th, tw = h // tile, w // tile
    if th == 0 or tw == 0:
        return data.reshape(1, 1, 1)
    data = data[: th * tile, : tw * tile]
    return data.reshape(th, tile, tw, tile).mean(axis=(1, 3))


def grid_distance(a: np.ndarray, b: np.ndarray) -> Tuple[float, float]:
    """两个特征网格的距离：返回 (均值, p99)。

    p99 用来发现"整体变化小、局部已经变了"的慢速移动。
    """
    diff = np.abs(a - b)
    return float(diff.mean()), float(np.percentile(diff, 99.0))


def scaled_size(width: int, height: int, analysis_width: int) -> Tuple[int, int]:
    w = max(2, min(int(analysis_width), int(width)))
    w -= w % 2
    h = int(round(height * (w / float(width)) / 2.0)) * 2
    return w, max(2, h)


def frame_distance(a: np.ndarray, b: np.ndarray) -> float:
    """归一化灰度平均绝对差：0 表示完全相同，1 表示反差最大。"""
    if a.shape != b.shape:
        raise ValueError("两帧尺寸不一致")
    diff = np.subtract(a, b, dtype=np.int16)
    return float(np.mean(np.abs(diff))) / 255.0


def iter_gray_frames(
    timeline: VideoTimeline,
    analysis_width: int,
    progress: ProgressCallback = None,
) -> Iterator["tuple[int, np.ndarray]"]:
    """按展示顺序逐帧解码，缩放到分析宽度并转灰度。

    使用 ``-fps_mode passthrough`` 保留原始帧节奏，不使用恒定帧率重采样。
    """
    width, height = scaled_size(
        timeline.width, timeline.height, analysis_width
    )
    vf = f"scale={width}:-2:flags=area,format=gray"
    cmd = [
        require_binary("ffmpeg"),
        "-hide_banner",
        "-v",
        "error",
        "-nostdin",
        "-i",
        timeline.path,
        "-an",
        "-vf",
        vf,
        "-fps_mode",
        "passthrough",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "gray",
        "-",
    ]
    proc = subprocess.Popen(
        cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE
    )
    assert proc.stdout is not None
    frame_bytes = width * height
    total = timeline.frame_count
    index = 0
    try:
        while True:
            buf = bytearray()
            while len(buf) < frame_bytes:
                chunk = proc.stdout.read(frame_bytes - len(buf))
                if not chunk:
                    break
                buf.extend(chunk)
            if len(buf) < frame_bytes:
                break
            frame = np.frombuffer(bytes(buf), dtype=np.uint8).reshape(
                height, width
            )
            yield index, frame
            index += 1
            if progress is not None and (index % 10 == 0 or index == total):
                progress(index, total)
    finally:
        if proc.poll() is None:
            proc.kill()
        try:
            proc.stdout.close()
        except Exception:
            pass
        stderr = proc.stderr.read().decode("utf-8", "replace") if proc.stderr else ""
        if proc.stderr is not None:
            proc.stderr.close()
        if index == 0 and proc.returncode not in (0, None):
            raise FFmpegError(f"ffmpeg 解码失败: {stderr.strip()[-500:]}")
