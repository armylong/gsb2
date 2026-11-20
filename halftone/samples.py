"""程序自带素材：渐变、细线、均匀灰块、斜边。

全部在代码里生成，尺寸最长边不超过 1200，不透明 BGR uint8，
用户无需准备任何附件即可观察网点行为。
"""

from __future__ import annotations

import numpy as np

SAMPLE_GRADIENT = "gradient"
SAMPLE_LINES = "lines"
SAMPLE_PATCHES = "patches"
SAMPLE_SLANT = "slant"

SAMPLE_NAMES = {
    SAMPLE_GRADIENT: "水平渐变(黑→白)",
    SAMPLE_LINES: "不同宽度细线",
    SAMPLE_PATCHES: "均匀灰块阶梯",
    SAMPLE_SLANT: "斜边(对角分界)",
}

_WIDTH = 600
_HEIGHT = 420


def _bgr(gray: np.ndarray) -> np.ndarray:
    return np.repeat(gray[:, :, None], 3, axis=2)


def _gradient() -> np.ndarray:
    row = np.linspace(0, 255, _WIDTH, dtype=np.float32)
    gray = np.repeat(row[None, :], _HEIGHT, axis=0).astype(np.uint8)
    return _bgr(gray)


def _lines() -> np.ndarray:
    gray = np.full((_HEIGHT, _WIDTH), 255, dtype=np.uint8)
    # 从左到右依次放宽度 1/2/4/8/16 像素的黑色竖线组，组间留白
    x = 10
    for lw in (1, 2, 4, 8, 16):
        for k in range(4):
            gray[:, x : x + lw] = 0
            x += lw * 2
        x += 24
    # 再加一组灰线，观察非端点灰阶在线条结构上的表现
    for k in range(6):
        gray[:, x : x + 6] = 128
        x += 18
    return _bgr(gray)


def _patches() -> np.ndarray:
    levels = (0, 64, 128, 192, 255)
    band = _HEIGHT // len(levels)
    gray = np.empty((_HEIGHT, _WIDTH), dtype=np.uint8)
    for i, level in enumerate(levels):
        y0 = i * band
        y1 = _HEIGHT if i == len(levels) - 1 else (i + 1) * band
        gray[y0:y1, :] = level
    return _bgr(gray)


def _slant() -> np.ndarray:
    xs = np.arange(_WIDTH, dtype=np.float32)[None, :]
    ys = np.arange(_HEIGHT, dtype=np.float32)[:, None]
    # 主对角线方向的分界，左下黑、右上白
    gray = np.where(xs + ys > _WIDTH, 255, 0).astype(np.uint8)
    return _bgr(gray)


_BUILDERS = {
    SAMPLE_GRADIENT: _gradient,
    SAMPLE_LINES: _lines,
    SAMPLE_PATCHES: _patches,
    SAMPLE_SLANT: _slant,
}


def build_sample(name: str) -> np.ndarray:
    try:
        return _BUILDERS[name]().copy()
    except KeyError as exc:
        raise KeyError(f"未知素材: {name}") from exc


def all_samples() -> dict[str, np.ndarray]:
    return {name: builder() for name, builder in _BUILDERS.items()}
