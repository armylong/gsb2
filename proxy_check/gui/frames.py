"""GUI 播放素材准备: 解码全片 RGB 帧(JPEG 压缩驻留内存)并抽出音频。

只服务于 <=15s 的短视频, 全片驻留内存简单且帧精确;
核对逻辑不经过这里, 仍由 ffmedia 的灰度网格路径独立完成。
"""

from __future__ import annotations

import subprocess
from pathlib import Path

from PySide6.QtCore import QBuffer, QByteArray, QIODevice
from PySide6.QtGui import QImage

from ..errors import FFmpegError

DISPLAY_W, DISPLAY_H = 480, 270
JPEG_QUALITY = 80


def decode_rgb_frames(path: str | Path, width: int = DISPLAY_W,
                      height: int = DISPLAY_H) -> list[QImage]:
    """解码全部帧为统一尺寸 QImage(保持比例、黑边填充)。"""
    cmd = [
        "ffmpeg", "-v", "error", "-nostdin", "-i", str(path),
        "-vf", (
            f"scale={width}:{height}:force_original_aspect_ratio=decrease:flags=area,"
            f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black,"
            f"format=rgb24"
        ),
        "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
    ]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    frame_size = width * height * 3
    images: list[QImage] = []
    assert proc.stdout is not None
    while True:
        raw = proc.stdout.read(frame_size)
        if len(raw) < frame_size:
            break
        img = QImage(bytes(raw), width, height, width * 3,
                     QImage.Format.Format_RGB888).copy()
        images.append(img)
    err = proc.stderr.read().decode("utf-8", "replace")
    if proc.wait() != 0:
        raise FFmpegError(f"播放帧解码失败: {path}\n{err[-500:]}")
    if not images:
        raise FFmpegError(f"播放帧解码为空: {path}")
    return images


def jpeg_bytes(images: list[QImage]) -> list[QByteArray]:
    """把 QImage 压成 JPEG 字节驻留, 降低内存占用。"""
    out: list[QByteArray] = []
    for img in images:
        ba = QByteArray()
        buf = QBuffer(ba)
        buf.open(QIODevice.OpenModeFlag.WriteOnly)
        img.save(buf, "JPEG", JPEG_QUALITY)
        out.append(ba)
    return out


def extract_audio(path: str | Path, dest: str | Path) -> Path | None:
    """抽出音频为 m4a(AAC), 无音轨返回 None。"""
    dest = Path(dest)
    cmd = [
        "ffmpeg", "-y", "-v", "error", "-nostdin", "-i", str(path),
        "-map", "0:a:0", "-c:a", "aac", "-b:a", "128k", str(dest),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if proc.returncode != 0:
        # 无音轨时 ffmpeg 报错, 由调用方按 None 处理。
        if dest.exists():
            dest.unlink()
        return None
    return dest
