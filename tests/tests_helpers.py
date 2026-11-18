"""测试辅助: 帧级像素差异 (在指定水平条带内比较两个视频的同一帧)。"""
from __future__ import annotations

import subprocess
import tempfile
from pathlib import Path

from PySide6.QtGui import QImage

from deinterlace_lab.ffmpeg_tools import find_executable


def _extract_one(video: Path, frame_index: int, out: Path) -> QImage:
    # frame_index 为 0 基; 用 select 取指定帧。
    cmd = [
        find_executable("ffmpeg"), "-hide_banner", "-loglevel", "error", "-y",
        "-i", str(video),
        "-vf", f"select=eq(n\\,{frame_index})",
        "-vframes", "1", "-fps_mode", "passthrough", str(out),
    ]
    subprocess.run(cmd, check=True, capture_output=True, text=True)
    return QImage(str(out)).convertToFormat(QImage.Format.Format_RGB888)


def frame_diff(video_a: Path, video_b: Path, frame_index: int,
               band: tuple[int, int]) -> float:
    """返回两条带内逐像素平均绝对差 (0-255)。"""
    tmp = Path(tempfile.mkdtemp(prefix="dlab_diff_"))
    a = _extract_one(Path(video_a), frame_index, tmp / "a.png")
    b = _extract_one(Path(video_b), frame_index, tmp / "b.png")
    if a.size() != b.size():
        # 参考片是 50p、输出是 50fps 双倍, 尺寸应一致; 不一致则按较小者裁。
        w = min(a.width(), b.width())
        h = min(a.height(), b.height())
        a = a.copy(0, 0, w, h)
        b = b.copy(0, 0, w, h)
    y0, y1 = band
    total, count = 0, 0
    step = 3
    for y in range(max(0, y0), min(a.height(), y1), step):
        for x in range(0, a.width(), step):
            ca, cb = a.pixelColor(x, y), b.pixelColor(x, y)
            total += abs(ca.red() - cb.red()) + abs(ca.green() - cb.green()) \
                + abs(ca.blue() - cb.blue())
            count += 3
    return total / max(1, count)
