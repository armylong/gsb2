"""程序内置测试图生成。

每张图返回 (gray, alpha) 两个 [0,1] float64 二维数组；
综合样例与暗角图都带透明区（右下角切出透明方块），用于验证透明保留。
"""
from __future__ import annotations

import numpy as np

from .font5x7 import draw_text, text_width

PATTERN_KINDS = ("composite", "gradient", "vignette", "sharp", "text", "grayscale")
PATTERN_LABELS = {
    "composite": "综合(渐变+暗角+小字+透明区)",
    "gradient": "水平均匀坡度",
    "vignette": "径向暗角",
    "sharp": "尖锐边缘+硬台阶",
    "text": "小字清晰度",
    "grayscale": "纯灰阶斜坡(灰度图)",
}


def _coerce_size(size) -> tuple[int, int]:
    if isinstance(size, (tuple, list)):
        return int(size[1]), int(size[0])  # (h, w)
    n = int(size)
    return n, n


def _cut_corner(alpha: np.ndarray, fraction: float = 0.22) -> np.ndarray:
    """在右下角切出一个全透明方块，并让边界有一格抗锯齿过渡。"""
    h, w = alpha.shape
    ch, cw = max(8, int(h * fraction)), max(8, int(w * fraction))
    alpha = alpha.copy()
    alpha[h - ch:, w - cw:] = 0.0
    return alpha


def gradient(size=384) -> tuple[np.ndarray, np.ndarray]:
    """水平方向 0->1 的均匀坡度，右下角透明方块。"""
    h, w = _coerce_size(size)
    x = np.linspace(0.0, 1.0, w, dtype=np.float64)
    gray = np.repeat(x[None, :], h, axis=0)
    alpha = np.ones((h, w), dtype=np.float64)
    alpha = _cut_corner(alpha)
    return gray, alpha


def vignette(size=384) -> tuple[np.ndarray, np.ndarray]:
    """径向暗角：中心亮、四周平滑变暗，右下角透明方块。"""
    h, w = _coerce_size(size)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float64)
    r2 = ((xx - (w - 1) / 2.0) / (w / 2.0)) ** 2 + ((yy - (h - 1) / 2.0) / (h / 2.0)) ** 2
    gray = np.exp(-1.6 * r2)
    gray = np.clip(gray, 0.0, 1.0)
    alpha = np.ones((h, w), dtype=np.float64)
    alpha = _cut_corner(alpha)
    return gray, alpha


def sharp(size=384) -> tuple[np.ndarray, np.ndarray]:
    """尖锐边缘检查图：左半是细坡度、右半是 8 级硬台阶，含垂直黑白边。"""
    h, w = _coerce_size(size)
    gray = np.zeros((h, w), dtype=np.float64)
    half = w // 2
    ramp = np.linspace(0.0, 1.0, half, dtype=np.float64)
    gray[:, :half] = ramp[None, :]
    steps = np.linspace(0.0, 1.0, 8, dtype=np.float64)
    bands = np.repeat(steps, max(1, (w - half) // 8 + 1))[: w - half]
    gray[:, half:] = bands[None, :]
    # 一条贯穿的锐利垂直边（x = quarter 处两列黑白跳变）
    q = w // 4
    gray[:, q] = 1.0
    if q + 1 < w:
        gray[:, q + 1] = 0.0
    alpha = np.ones((h, w), dtype=np.float64)
    alpha = _cut_corner(alpha, fraction=0.15)
    return gray, alpha


def text_pattern(size=384) -> tuple[np.ndarray, np.ndarray]:
    """小字清晰度图：多级灰度背景上绘制不同大小的点阵小字。"""
    h, w = _coerce_size(size)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float64)
    gray = (0.25 + 0.5 * (xx / max(1, w - 1)) + 0.15 * (yy / max(1, h - 1)))
    gray = np.clip(gray, 0.0, 1.0)
    lines = ("BAND VIEWER 0123456789", "GRAY QUANT TEST", "ABCDEFGHIJKLMNOPQRSTUVWXYZ")
    y = 12
    for i, line in enumerate(lines):
        scale = 1 + i  # 1x / 2x / 3x 真实像素小字
        draw_text(gray, 10, y, line, scale=scale, value=1.0)
        y += scale * 9 + 6
    # 深底反白一行，检查暗部小字
    gray[h - 24:h - 8, 8:8 + text_width("LOW KEY 9876543210", 1)] = 0.05
    draw_text(gray, 10, h - 22, "LOW KEY 9876543210", scale=1, value=0.95)
    alpha = np.ones((h, w), dtype=np.float64)
    alpha = _cut_corner(alpha, fraction=0.15)
    return gray, alpha


def composite(size=384) -> tuple[np.ndarray, np.ndarray]:
    """综合样例：水平连续高光坡度 + 径向暗角叠加 + 小字 + 透明区。"""
    h, w = _coerce_size(size)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float64)
    ramp = xx / max(1, w - 1)
    r2 = ((xx - (w - 1) / 2.0) / (w / 2.0)) ** 2 + ((yy - (h - 1) / 2.0) / (h / 2.0)) ** 2
    vignette = np.exp(-1.1 * r2)
    gray = 0.15 + 0.7 * ramp * vignette
    gray = np.clip(gray, 0.0, 1.0)
    draw_text(gray, 10, 10, "HIGHLIGHT RAMP", scale=2, value=0.95)
    draw_text(gray, 10, 40, "0123456789 ABC", scale=1, value=0.1)
    # 一条尖锐亮边用于检查边缘扩散
    gray[:, w // 2] = 1.0
    alpha = np.ones((h, w), dtype=np.float64)
    alpha = _cut_corner(alpha)
    return gray, alpha


def grayscale_ramp(size=384) -> tuple[np.ndarray, np.ndarray]:
    """不透明的纯灰度斜坡（无透明区），对应“也支持灰度图”。"""
    h, w = _coerce_size(size)
    x = np.linspace(0.0, 1.0, w, dtype=np.float64)
    gray = np.repeat(x[None, :], h, axis=0)
    alpha = np.ones((h, w), dtype=np.float64)
    return gray, alpha


def generate_pattern(kind: str, size=384) -> tuple[np.ndarray, np.ndarray]:
    """按名称生成测试图，返回 (gray, alpha)，取值均为 [0,1] float64。"""
    table = {
        "composite": composite,
        "gradient": gradient,
        "vignette": vignette,
        "sharp": sharp,
        "text": text_pattern,
        "grayscale": grayscale_ramp,
    }
    if kind not in table:
        raise ValueError(f"未知测试图: {kind!r}，可选 {PATTERN_KINDS}")
    return table[kind](size)
