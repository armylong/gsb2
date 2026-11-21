"""内置测试素材生成器。

画面用 PySide6 的 QPainter 在 Python 里逐帧绘制（不依赖 ffmpeg 的
drawtext/libfreetype），通过 rawvideo 管道喂给 ffmpeg 编码；
再用流复制的第二步写入方向元数据，不重编码、不动时基。

全部素材都带：
- 四角编号 1..4（编号按“播放画面”的左上/右上/左下/右下定义，
  旋转烘焙后编号应仍在对应逻辑角落，可直接肉眼核对）；
- 中心十字与移动圆点，便于判断朝向与节奏；
- 440Hz 正弦音，便于验证音轨保留与时基不变。

素材清单
--------
A. par_only.mp4   720x480, PAR 40:33, 无旋转 —— 经典 NTSC 非方形像素
B. rot_only.mov   1920x1080, 方形像素, 旋转 90°（竖屏容器里存横画面）
C. par_rot.mov    720x480, PAR 40:33, 旋转 90° —— 两种变化叠加（必有项）
D. rot_180.mp4    640x480, 方形像素, 旋转 180°
E. unsupported.mov 640x480, 旋转 45° —— 用于验证“不支持方向”的明确提示
"""
from __future__ import annotations

import os
import subprocess
from dataclasses import dataclass
from typing import List, Optional

from PySide6.QtCore import QPointF, Qt
from PySide6.QtGui import QColor, QFont, QImage, QPainter, QPen

from .ffutils import find_ffmpeg


@dataclass
class SampleSpec:
    filename: str
    width: int
    height: int
    par_num: int
    par_den: int
    rotation: Optional[int]          # None 表示不写方向元数据
    duration: float = 2.0
    fps: int = 30
    note: str = ""


SAMPLE_SPECS = [
    SampleSpec("par_only.mp4", 720, 480, 40, 33, None,
               note="非方形像素 40:33（NTSC DV 风格），无旋转"),
    SampleSpec("rot_only.mov", 1920, 1080, 1, 1, 90,
               note="方形像素，旋转元数据 90°（横画存竖播）"),
    SampleSpec("par_rot.mov", 720, 480, 40, 33, 90,
               note="非方形像素 40:33 + 旋转 90°（两种变化叠加）"),
    SampleSpec("rot_180.mp4", 640, 480, 1, 1, 180,
               note="方形像素，旋转 180°"),
    SampleSpec("unsupported.mov", 640, 480, 1, 1, 45,
               note="旋转 45°，超出直角支持范围，仅用于提示验证"),
]


# ---------------------------------------------------------------------- #
# QPainter 绘制
# ---------------------------------------------------------------------- #
def _draw_frame(width: int, height: int, t: float) -> QImage:
    """画一帧 RGB 画面。t 为时间（秒）。"""
    img = QImage(width, height, QImage.Format_RGB888)
    img.fill(QColor("white"))
    p = QPainter(img)
    try:
        margin = max(8, min(width, height) // 25)
        num_size = max(18, min(width, height) // 8)

        # 外红框、内蓝框：旋转后用框线不对称性判断朝向
        p.setPen(QPen(QColor("red"), 4))
        p.drawRect(6, 6, width - 12, height - 12)
        p.setPen(QPen(QColor("blue"), 3))
        p.drawRect(width // 4, height // 4, width // 2, height // 2)

        # 中心十字
        p.setPen(Qt.black)
        p.setBrush(QColor("black"))
        p.drawRect(width // 2 - 2, height // 2 - 30, 4, 60)
        p.drawRect(width // 2 - 30, height // 2 - 2, 60, 4)

        # 四角编号（绘制在存储画面的四个物理角）
        p.setFont(QFont("Arial", num_size, QFont.Bold))
        p.setPen(QColor("black"))
        p.drawText(
            margin, margin, num_size * 2, num_size * 2,
            Qt.AlignLeft | Qt.AlignTop, "1",
        )
        p.drawText(
            width - margin - num_size * 2, margin,
            num_size * 2, num_size * 2,
            Qt.AlignRight | Qt.AlignTop, "2",
        )
        p.drawText(
            margin, height - margin - num_size * 2,
            num_size * 2, num_size * 2,
            Qt.AlignLeft | Qt.AlignBottom, "3",
        )
        p.drawText(
            width - margin - num_size * 2,
            height - margin - num_size * 2,
            num_size * 2, num_size * 2,
            Qt.AlignRight | Qt.AlignBottom, "4",
        )

        # 存储尺寸标注
        p.setFont(QFont("Arial", max(10, num_size // 2)))
        p.drawText(
            0, int(height * 0.60), width, height // 10,
            Qt.AlignCenter, f"{width}x{height} stored",
        )

        # 沿上边缘往返移动的绿色圆点：确认时基/节奏未被改变
        travel = width - 2 * margin - 14
        phase = (t * 120) % (2 * travel)
        x = margin + (phase if phase <= travel else 2 * travel - phase)
        p.setBrush(QColor("green"))
        p.setPen(Qt.NoPen)
        p.drawEllipse(QPointF(x + 7, margin + 7), 7, 7)
    finally:
        p.end()
    return img


def _run(cmd: List[str], stdin_data: Optional[bytes] = None) -> None:
    proc = subprocess.run(
        cmd, input=stdin_data, capture_output=True, check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            "素材生成失败：" + "\n".join(
                proc.stderr.decode("utf-8", "replace").splitlines()[-10:]
            )
        )


# ---------------------------------------------------------------------- #
def generate_one(spec: SampleSpec, out_dir: str) -> str:
    """生成单条素材，返回文件路径。"""
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, spec.filename)
    base = out_path + ".base.mp4"
    frames = round(spec.duration * spec.fps)

    # 1) Python 绘制全部帧 -> rawvideo 管道 -> ffmpeg 编码 + 正弦音
    sar = (
        f"{spec.par_num}/{spec.par_den}"
        if spec.par_num != spec.par_den else "1"
    )
    cmd = [
        find_ffmpeg(), "-hide_banner", "-nostdin", "-y",
        "-f", "rawvideo", "-pix_fmt", "rgb24",
        "-s", f"{spec.width}x{spec.height}",
        "-framerate", str(spec.fps),
        "-i", "pipe:0",
        "-f", "lavfi", "-i",
        "sine=frequency=440:sample_rate=48000:duration=" + str(spec.duration),
        "-map", "0:v:0", "-map", "1:a:0",
        "-vf", f"setsar={sar},format=yuv420p",
        "-c:v", "libx264", "-crf", "18",
        "-c:a", "aac", "-b:a", "128k",
        "-shortest", "-t", f"{spec.duration}",
        base,
    ]
    buf = bytearray()
    for i in range(frames):
        img = _draw_frame(spec.width, spec.height, i / spec.fps)
        buf += img.bits().tobytes()
    _run(cmd, stdin_data=bytes(buf))

    # 2) 写方向元数据（流复制，不重编码、不动时基）
    if spec.rotation is None:
        os.replace(base, out_path)
    else:
        cmd = [
            find_ffmpeg(), "-hide_banner", "-nostdin", "-y",
            "-display_rotation", str(spec.rotation),
            "-i", base,
            "-map", "0", "-c", "copy",
            out_path,
        ]
        _run(cmd)
        os.remove(base)
    return out_path


def generate_all(out_dir: str, progress=None) -> List[str]:
    """生成整套素材。progress(done, total, filename) 可选回调。"""
    os.makedirs(out_dir, exist_ok=True)
    paths = []
    total = len(SAMPLE_SPECS)
    for i, spec in enumerate(SAMPLE_SPECS, 1):
        paths.append(generate_one(spec, out_dir))
        if progress:
            progress(i, total, spec.filename)
    return paths
