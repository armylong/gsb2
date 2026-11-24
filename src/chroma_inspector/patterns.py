"""内置验证图案短片生成。

所有图案直接在色度网格上构造，几何位置可追溯；用 FFV1 无损封装，
避免压缩伪影干扰逐像素核对。统一 256x192 / 4:2:0 / 10fps / 16 帧。

- pat_horizontal.mkv  垂直色边：核对**水平**半像素偏移（left vs center）
- pat_vertical.mkv    水平色边：核对**垂直**半像素偏移（top vs center）
- pat_neutral.mkv     中性灰 + 亮度条：两种解释下都必须保持中性
- pat_fine_lines.mkv  细彩线网格：横纵边缘误差同屏可见
- pat_motion.mkv      逐帧滚动的垂直色边：切帧核对相位
- pat_neutral.yuv     中性灰的裸 .yuv：验证无声明文件的处理
"""
from __future__ import annotations

import os
import subprocess
from dataclasses import dataclass

import numpy as np

from .errors import MediaError

W, H = 256, 192
CW, CH = W // 2, H // 2
FRAMES = 16
FPS = 10
NEUTRAL_C = 128
NEUTRAL_Y = 128


@dataclass(frozen=True)
class PatternSpec:
    filename: str
    title: str
    description: str
    declared: str | None  # setparams 写入的声明；None 表示不声明


PATTERNS: tuple[PatternSpec, ...] = (
    PatternSpec(
        "pat_horizontal.mkv",
        "垂直色边（水平偏移验证）",
        "Cb 在色度列 63/64 之间阶跃。left 解释下边沿落在亮度 x=128，"
        "center 解释落在 x=128.5，放大后可见半像素横向位移。",
        "left",
    ),
    PatternSpec(
        "pat_vertical.mkv",
        "水平色边（垂直偏移验证）",
        "Cr 在色度行 47/48 之间阶跃。top 解释下边沿落在亮度 y=96，"
        "center 解释落在 y=96.5，放大后可见半像素纵向位移。",
        "top",
    ),
    PatternSpec(
        "pat_neutral.mkv",
        "中性灰样例",
        "Cb=Cr=128 恒定，亮度面带灰度条。任何解释下重建画面都必须保持中性灰，"
        "不得出现偏色。",
        None,
    ),
    PatternSpec(
        "pat_fine_lines.mkv",
        "细彩线网格",
        "色度面每隔 4 个色度样本出现一根彩线，水平与垂直方向同屏呈现，"
        "用于同时检查两个方向的边缘误差。",
        "center",
    ),
    PatternSpec(
        "pat_motion.mkv",
        "滚动色边（切帧相位验证）",
        "垂直色边每帧移动一个色度列（两个亮度像素），逐帧切换可核对"
        "两种解释下边沿相位是否始终相差半像素。",
        "left",
    ),
)
RAW_PATTERN = "pat_neutral.yuv"


def _blank_planes() -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    y = np.full((H, W), NEUTRAL_Y, np.uint8)
    u = np.full((CH, CW), NEUTRAL_C, np.uint8)
    v = np.full((CH, CW), NEUTRAL_C, np.uint8)
    return y, u, v


def _frame_bytes(y: np.ndarray, u: np.ndarray, v: np.ndarray) -> bytes:
    return y.tobytes() + u.tobytes() + v.tobytes()


def _build_frame(spec: PatternSpec, frame_idx: int) -> bytes:
    y, u, v = _blank_planes()

    if spec.filename == "pat_horizontal.mkv":
        u[:, : CW // 2] = 160
        u[:, CW // 2 :] = 96
    elif spec.filename == "pat_vertical.mkv":
        v[: CH // 2, :] = 160
        v[CH // 2 :, :] = 96
    elif spec.filename == "pat_neutral.mkv":
        # 仅亮度变化：灰度条 + 渐变，色度恒定
        for x in range(W):
            y[:, x] = 16 + int(219 * x / (W - 1))
        for bar in range(4):
            x0, x1 = bar * W // 4, (bar + 1) * W // 4
            y[:, x0:x1] = (40, 90, 160, 220)[bar]
    elif spec.filename == "pat_fine_lines.mkv":
        u[:, 3::4] = 160
        u[:, 1::4] = 96
        v[3::4, :] = 160
        v[1::4, :] = 96
    elif spec.filename == "pat_motion.mkv":
        edge = (CW // 2 + frame_idx) % (CW - 2) + 1
        u[:, :edge] = 160
        u[:, edge:] = 96
    return _frame_bytes(y, u, v)


def generate_all(out_dir: str) -> list[str]:
    """生成全部图案短片，返回产出文件的绝对路径列表。"""
    os.makedirs(out_dir, exist_ok=True)
    written: list[str] = []
    raw_path = os.path.join(out_dir, RAW_PATTERN)

    for spec in PATTERNS:
        raw_blob = b"".join(_build_frame(spec, i) for i in range(FRAMES))
        # 中性灰同时落一份裸 .yuv
        if spec.filename == "pat_neutral.mkv":
            with open(raw_path, "wb") as f:
                f.write(raw_blob)
            written.append(os.path.abspath(raw_path))

        out_path = os.path.join(out_dir, spec.filename)
        vf = "format=yuv420p"
        if spec.declared is not None:
            vf = f"setparams=chroma_location={spec.declared},format=yuv420p"
        cmd = [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "yuv420p",
            "-s",
            f"{W}x{H}",
            "-r",
            str(FPS),
            "-i",
            "-",
            "-vf",
            vf,
            "-c:v",
            "ffv1",
            "-level",
            "3",
            out_path,
        ]
        proc = subprocess.run(cmd, input=raw_blob, capture_output=True, timeout=120)
        if proc.returncode != 0:
            raise MediaError(
                f"图案 {spec.filename} 生成失败：\n{proc.stderr.decode()[:600]}"
            )
        written.append(os.path.abspath(out_path))
    return written
