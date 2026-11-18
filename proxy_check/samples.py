"""自生成测试素材: 带帧号、移动图形和定时声音的短原片,
以及正常代理、错开起点代理、内容不同代理。全程无需外部附件。
"""

from __future__ import annotations

import math
import subprocess
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

from .ffmedia import FFmpegError
from .proxy import build_proxy


def _draw_frame(index: int, width: int, height: int, fps: float) -> bytes:
    """一帧内容: 渐变背景 + 横移圆(移动图形) + 大号帧号 + 时间码。"""
    yy, xx = np.mgrid[0:height, 0:width]
    base = (
        40
        + 90 * (xx / max(width - 1, 1))
        + 60 * (yy / max(height - 1, 1))
        + 25 * math.sin(index / fps * math.pi)
    )
    arr = np.empty((height, width, 3), dtype=np.uint8)
    arr[..., 0] = np.clip(base, 0, 255)
    arr[..., 1] = np.clip(base * 0.7 + 30, 0, 255)
    arr[..., 2] = np.clip(255 - base * 0.5, 0, 255)

    img = Image.fromarray(arr, "RGB")
    draw = ImageDraw.Draw(img)

    # 横移圆: 周期 4 秒, 保证画面持续运动。
    r = max(height // 10, 8)
    phase = (index / fps) % 4.0 / 4.0
    cx = int(r + phase * (width - 2 * r))
    cy = height // 2 + int(height * 0.18 * math.sin(index / fps * 2 * math.pi))
    draw.ellipse((cx - r, cy - r, cx + r, cy + r), fill=(255, 230, 80),
                 outline=(255, 255, 255), width=2)

    # 大号帧号 + 时间码, 帧号本身就是错位的可视化证据。
    draw.rectangle((0, 0, width, 58), fill=(0, 0, 0))
    draw.text((12, 8), f"FRAME {index:04d}", fill=(255, 255, 255))
    draw.text((12, 32), f"t={index / fps:6.3f}s", fill=(180, 255, 180))
    return img.tobytes()


def _ffmpeg_pipe(cmd: list[str], feed) -> None:
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE,
                            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    try:
        feed(proc.stdin)
        proc.stdin.close()
    except BrokenPipeError:
        pass
    err = proc.stderr.read().decode("utf-8", "replace")
    ret = proc.wait()
    if ret != 0:
        raise FFmpegError(f"样例合成失败:\n{err[-800:]}")


def make_source(path: str | Path, *, width: int = 960, height: int = 540,
                fps: float = 30.0, duration: float = 10.0) -> Path:
    """生成 CFR 短原片: 视频为逐帧绘制内容, 音频为每秒一次 0.15s 蜂鸣。"""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    n = int(round(duration * fps))
    cmd = [
        "ffmpeg", "-y", "-v", "error",
        "-f", "rawvideo", "-pix_fmt", "rgb24",
        "-s", f"{width}x{height}", "-r", f"{fps:g}", "-i", "-",
        "-f", "lavfi", "-i",
        "sine=frequency=880:sample_rate=48000:duration=" + str(duration),
        "-af", "volume=volume=0:enable='gt(mod(t,1),0.15)'",
        "-c:v", "libx264", "-preset", "medium", "-crf", "20",
        "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart", str(path),
    ]

    def feed(stdin):
        for i in range(n):
            stdin.write(_draw_frame(i, width, height, fps))

    _ffmpeg_pipe(cmd, feed)
    return path


def make_offset_proxy(source: str | Path, dest: str | Path,
                      offset_frames: int = 15) -> Path:
    """错开起点的代理: 丢掉开头 N 帧, 尾部补黑帧保持总帧数,
    帧率/分辨率/编码与正常代理完全一致, 专门暴露时间错位。"""
    dest = Path(dest)
    cmd = [
        "ffmpeg", "-y", "-v", "error", "-i", str(source),
        "-vf", (
            f"trim=start_frame={offset_frames},setpts=PTS-STARTPTS,"
            f"tpad=stop_mode=add:stop={offset_frames},"
            f"scale=-2:360:flags=lanczos,setsar=1"
        ),
        "-c:v", "libx264", "-crf", "23", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart", str(dest),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if proc.returncode != 0:
        raise FFmpegError(f"错位代理生成失败:\n{proc.stderr[-600:]}")
    return dest


def make_different_content(path: str | Path, *, width: int = 640,
                           height: int = 360, fps: float = 30.0,
                           duration: float = 10.0) -> Path:
    """另一份"原片"的 360p 版本: 同帧率/同尺寸/同编码, 但画面完全不同
    (棋盘格 + 反色), 模拟代理指向了另一份视频。元数据相近, 内容对不上。"""
    path = Path(path)
    n = int(round(duration * fps))
    cmd = [
        "ffmpeg", "-y", "-v", "error",
        "-f", "rawvideo", "-pix_fmt", "rgb24",
        "-s", f"{width}x{height}", "-r", f"{fps:g}", "-i", "-",
        "-f", "lavfi", "-i",
        "sine=frequency=330:sample_rate=48000:duration=" + str(duration),
        "-c:v", "libx264", "-preset", "medium", "-crf", "23",
        "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart", str(path),
    ]

    def feed(stdin):
        cell = 40
        for i in range(n):
            arr = np.zeros((height, width, 3), dtype=np.uint8)
            for y in range(0, height, cell):
                for x in range(0, width, cell):
                    if ((x // cell) + (y // cell) + i // 8) % 2 == 0:
                        arr[y:y + cell, x:x + cell] = (200, 60, 60)
                    else:
                        arr[y:y + cell, x:x + cell] = (40, 60, 200)
            img = Image.fromarray(arr, "RGB")
            ImageDraw.Draw(img).text(
                (12, 10), f"OTHER CLIP {i:04d}", fill=(255, 255, 255))
            stdin.write(img.tobytes())

    _ffmpeg_pipe(cmd, feed)
    return path


def generate_sample_set(out_dir: str | Path, progress=None) -> dict[str, Path]:
    """一次性生成整套样例, 返回各文件路径。"""
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    if progress:
        progress("绘制原片…")
    source = make_source(out / "source.mp4")
    if progress:
        progress("生成正常代理…")
    good, _ = build_proxy(source, out / "proxy_good.mp4", progress=progress)
    if progress:
        progress("生成错位代理…")
    offset = make_offset_proxy(source, out / "proxy_offset.mp4")
    if progress:
        progress("生成错片代理…")
    different = make_different_content(out / "proxy_different.mp4")
    return {"source": source, "good": Path(good.path),
            "offset": offset, "different": different}
