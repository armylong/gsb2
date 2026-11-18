"""样例生成: 带帧号、运动图形、不同时间短音(左右声道内容不同)的测试片."""

from __future__ import annotations

from fractions import Fraction
from pathlib import Path

import numpy as np

from .media import export_media

# 5x7 点阵数字, 每元素是一行的 5 位掩码
_DIGITS = {
    "0": [0x0E, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0E],
    "1": [0x04, 0x0C, 0x04, 0x04, 0x04, 0x04, 0x0E],
    "2": [0x0E, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1F],
    "3": [0x1F, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0E],
    "4": [0x02, 0x06, 0x0A, 0x12, 0x1F, 0x02, 0x02],
    "5": [0x1F, 0x10, 0x1E, 0x01, 0x01, 0x11, 0x0E],
    "6": [0x06, 0x08, 0x10, 0x1E, 0x11, 0x11, 0x0E],
    "7": [0x1F, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
    "8": [0x0E, 0x11, 0x11, 0x0E, 0x11, 0x11, 0x0E],
    "9": [0x0E, 0x11, 0x11, 0x0F, 0x01, 0x02, 0x0C],
}


def _draw_text(img: np.ndarray, x: int, y: int, text: str, scale: int, color=(255, 255, 255)) -> None:
    h, w = img.shape[:2]
    for ch in text:
        glyph = _DIGITS.get(ch)
        if glyph is not None:
            for row, bits in enumerate(glyph):
                for col in range(5):
                    if bits >> (4 - col) & 1:
                        y0, y1 = y + row * scale, y + (row + 1) * scale
                        x0, x1 = x + col * scale, x + (col + 1) * scale
                        if y1 <= h and x1 <= w:
                            img[y0:y1, x0:x1] = color
        x += 6 * scale


def make_frames(
    n_frames: int = 90,
    fps: int = 30,
    width: int = 640,
    height: int = 360,
) -> list[np.ndarray]:
    """每帧: 渐变背景 + 大号帧号 + 水平匀速移动的方块."""
    frames = []
    box_w, box_h = 60, 60
    travel = width - box_w
    for i in range(n_frames):
        img = np.zeros((height, width, 3), dtype=np.uint8)
        # 背景纵向渐变, 让帧与帧可区分
        img[..., 0] = np.linspace(30, 90, height, dtype=np.uint8)[:, None]
        img[..., 1] = 40
        img[..., 2] = np.linspace(90, 30, height, dtype=np.uint8)[:, None]
        # 帧号(大号, 便于肉眼核对)
        _draw_text(img, 20, 20, str(i), scale=8, color=(255, 255, 0))
        # 运动方块: 位置随帧号线性移动
        bx = int(round(travel * i / max(n_frames - 1, 1)))
        by = height - box_h - 40
        img[by : by + box_h, bx : bx + box_w] = (0, 220, 255)
        frames.append(img)
    return frames


def make_audio(
    n_frames: int = 90,
    fps: int = 30,
    sample_rate: int = 48000,
) -> np.ndarray:
    """立体声短音: 不同时刻、左右不同频率, 便于验证逆序和声道不交换.

    短音时刻(秒): 0.5 / 2.0 / 3.5, 每个 0.15s, 带 5ms 淡入淡出避免爆音.
    左声道频率 f, 右声道 1.5f, 两声道内容明显不同.
    """
    duration = n_frames / fps
    n = int(round(duration * sample_rate))
    t = np.arange(n, dtype=np.float64) / sample_rate
    left = np.zeros(n, dtype=np.float64)
    right = np.zeros(n, dtype=np.float64)
    for t0, f in ((0.5, 440.0), (2.0, 660.0), (3.5, 880.0)):
        tone_len = 0.15
        mask = (t >= t0) & (t < t0 + tone_len)
        tt = t[mask] - t0
        env = np.ones_like(tt)
        fade = min(int(0.005 * sample_rate), len(tt) // 2)
        if fade > 0:
            env[:fade] = np.linspace(0, 1, fade)
            env[-fade:] = np.linspace(1, 0, fade)
        left[mask] += 0.6 * env * np.sin(2 * np.pi * f * tt)
        right[mask] += 0.6 * env * np.sin(2 * np.pi * f * 1.5 * tt)
    return np.stack([left, right]).astype(np.float32)


def generate_sample(out_path: str | Path, n_frames: int = 90, fps: int = 30) -> Path:
    out_path = Path(out_path)
    frames = make_frames(n_frames=n_frames, fps=fps)
    audio = make_audio(n_frames=n_frames, fps=fps)
    export_media(out_path, frames, Fraction(fps, 1), audio, 48000)
    return out_path


if __name__ == "__main__":
    import sys

    out = sys.argv[1] if len(sys.argv) > 1 else "sample.mp4"
    p = generate_sample(out)
    print(f"已生成样例: {p}")
