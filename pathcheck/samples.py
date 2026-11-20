"""Mask import/export and sample generation.

Samples are generated in memory (no external assets).  Each sample is
constructed so that every acceptance point of the task is exercised:

==============  =========================================================
``metaballs``   several blobs, a hole, a one-pixel "bridge" and a detached
                block; a blob touches the left edge and another touches the
                top edge.
``grid``        a rounded hollow ring with four separate islands (clean
                reference for hole preservation).
``bridges``     thin 1-px bridges between large lobes and 1-px holes; a
                simplification that is too aggressive destroys the bridge
                or closes the hole.
``noise``       random blocky noise, useful for stress-testing vertex counts.
==============  =========================================================
"""

from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np


@dataclass(frozen=True)
class SampleSpec:
    key: str
    title: str
    description: str


SAMPLES = [
    SampleSpec(
        "metaballs",
        "有洞 / 细桥 / 独立块 (默认)",
        "左侧触边的大块带内洞; 一根 1 像素细桥连接两个块; 右下独立小块; 底部触边结构",
    ),
    SampleSpec(
        "bridges",
        "细桥与单像素洞",
        "两个大块由 1 像素桥连接, 单像素洞, 简化过猛会断桥/填洞",
    ),
    SampleSpec(
        "grid",
        "圆角环 + 四个岛屿",
        "干净参考: 外环 + 内洞 + 4 个独立组件, 触边结构",
    ),
    SampleSpec(
        "noise",
        "块状噪声",
        "随机 2x2 块, 顶点多, 用于观察简化与非法简化",
    ),
]

SAMPLES_BY_KEY = {s.key: s for s in SAMPLES}


def _line4(m: np.ndarray, x0: int, y0: int, x1: int, y1: int, value: int = 1) -> None:
    """Draw a 4-connected one-pixel staircase line.

    ``cv2.line`` with ``LINE_8`` produces 8-connected (diagonal) pixels; under
    the checker's 4-connectivity convention that would break the line into
    separate components.  This helper alternates horizontal and vertical unit
    steps so the line stays one component.
    """
    dx, dy = x1 - x0, y1 - y0
    n = max(abs(dx), abs(dy))
    if n == 0:
        m[y0, x0] = value
        return
    x, y = x0, y0
    horiz = 0.0
    vert = 0.0
    for _ in range(n):
        horiz += abs(dx) / n
        vert += abs(dy) / n
        if horiz >= 1.0 and (vert < 1.0 or horiz >= vert):
            x += 1 if dx > 0 else -1
            horiz -= 1.0
        else:
            y += 1 if dy > 0 else -1
            vert -= 1.0
        m[y, x] = value


def generate_sample(key: str, size: tuple[int, int] = (96, 96), seed: int = 7) -> np.ndarray:
    """Return a uint8 mask (0/1) generated procedurally."""
    h, w = size
    if key == "metaballs":
        return _sample_metaballs(w, h)
    if key == "bridges":
        return _sample_bridges(w, h)
    if key == "grid":
        return _sample_grid(w, h)
    if key == "noise":
        return _sample_noise(w, h, seed)
    raise KeyError(f"unknown sample {key!r}")


def _sample_metaballs(w: int, h: int) -> np.ndarray:
    m = np.zeros((h, w), np.uint8)
    # Blob A touches the left edge and has a large hole.
    cv2.ellipse(m, (12, 26), (13, 16), 0, 0, 360, 1, -1)
    # Blob B touches the top edge.
    cv2.ellipse(m, (46, 12), (16, 15), 0, 0, 360, 1, -1)
    # Thin 1-px bridge between B and a detached-ish lobe C.
    _line4(m, 56, 24, 70, 36)
    cv2.circle(m, (74, 40), 8, 1, -1)
    # Hole inside blob A (kept away from the border by >= 5 px).
    cv2.circle(m, (12, 26), 5, 0, -1)
    # Hole inside lobe C.
    cv2.circle(m, (74, 40), 3, 0, -1)
    # Independent block, no relation to others.
    cv2.rectangle(m, (70, 72), (82, 84), 1, -1)
    cv2.circle(m, (76, 78), 2, 0, -1)
    # Border-touching structure at the bottom with a notch.
    cv2.rectangle(m, (10, h - 12), (34, h), 1, -1)
    cv2.rectangle(m, (18, h - 8), (24, h), 0, -1)
    # A single-pixel island (stress case).
    m[h - 4, w - 5] = 1
    return m


def _sample_bridges(w: int, h: int) -> np.ndarray:
    m = np.zeros((h, w), np.uint8)
    cv2.circle(m, (24, 30), 14, 1, -1)
    cv2.circle(m, (58, 30), 12, 1, -1)
    # Two one-pixel bridges of different lengths between the lobes.
    _line4(m, 36, 30, 47, 30)
    _line4(m, 34, 40, 46, 46)
    # small lobe: a one-pixel *neck* (not a diagonal line) so the bridge can
    # be cut cleanly by a large epsilon while the lobe stays an independent
    # component when it is.
    cv2.circle(m, (62, 58), 7, 1, -1)
    m[42:51, 60] = 1
    # two one-pixel holes
    m[26, 22] = 0
    m[34, 27] = 0
    # detached islands
    cv2.rectangle(m, (8, 58), (22, 68), 1, -1)
    m[62, 14] = 0
    m[64, 60] = 1
    # A short, straight 1-px neck that a too-large epsilon provably cuts (the
    # RDP chord across the end caps jumps over it).  Keep it far from the
    # other structures so its 4-component stays independent.
    _line4(m, 40, 74, 52, 74)
    m[68:81, 34:41] = 1
    m[68:81, 52:59] = 1
    return m


def _sample_grid(w: int, h: int) -> np.ndarray:
    m = np.zeros((h, w), np.uint8)
    cv2.rectangle(m, (12, 12), (w - 13, h - 13), 1, -1)
    cv2.rectangle(m, (22, 22), (w - 23, h - 23), 0, -1)
    # round outer corners by clearing 3x3 at each corner
    for cx, cy in ((12, 12), (w - 13, 12), (12, h - 13), (w - 13, h - 13)):
        cv2.circle(m, (cx, cy), 4, 0, -1)
    # four islands in/around
    for cx, cy in ((4, 4), (w - 5, 4), (4, h - 5), (w - 5, h - 5)):
        cv2.circle(m, (cx, cy), 3, 1, -1)
    # a bridge touching two islands at the top row edge? keep simple
    # bottom border structure
    cv2.rectangle(m, (30, h - 3), (w - 31, h - 1), 1, -1)
    cv2.rectangle(m, (38, h - 3), (42, h - 1), 0, -1)
    return m


def _sample_noise(w: int, h: int, seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    small = (rng.random((h // 4, w // 4)) < 0.52).astype(np.uint8)
    m = cv2.resize(small, (w, h), interpolation=cv2.INTER_NEAREST)
    # clear a frame so the result is not one giant component
    m[:2, :] = 0
    m[-2:, :] = 0
    m[:, :2] = 0
    m[:, -2:] = 0
    # A well formed island with a hole (kept away from the random field).
    m[20:44, 20:44] = 0
    cv2.rectangle(m, (20, 20), (43, 43), 1, -1)
    cv2.rectangle(m, (28, 28), (35, 35), 0, -1)
    return m
    return m


def load_mask(path: str, threshold: int = 127) -> np.ndarray:
    """Load an image as a binary mask.

    Uses ``cv2.imdecode`` so non-ASCII paths work on all platforms.
    * Colour images are converted to grey (BT.601 luma).
    * RGBA is composited over black using the alpha channel first, so the
      transparent background of an icon does not become a dark foreground.
    * Every other bit depth is stretched to 0..255 before thresholding.
    Pixels ``>= threshold`` become foreground.
    """
    data = np.fromfile(path, dtype=np.uint8)
    if data.size == 0:
        raise ValueError(f"无法读取文件或文件为空: {path}")
    img = cv2.imdecode(data, cv2.IMREAD_UNCHANGED)
    if img is None:
        raise ValueError(f"不支持的图像格式: {path}")
    if img.ndim == 3:
        if img.shape[2] == 4:
            # cv2.cvtColor on float32 only accepts 3 or 4 channels for some
            # code paths; average BGR weighted by alpha ourselves to stay
            # explicit (BT.601 weights, then composite over black).
            alpha = img[:, :, 3].astype(np.float32) / 255.0
            bgr = img[:, :, :3].astype(np.float32)
            grey_f = (
                0.114 * bgr[:, :, 0]
                + 0.587 * bgr[:, :, 1]
                + 0.299 * bgr[:, :, 2]
            ) * alpha
            grey = np.clip(grey_f, 0, 255).astype(np.uint8)
        else:
            grey = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    else:
        grey = img
    if grey.dtype != np.uint8:
        grey = cv2.normalize(grey, None, 0, 255, cv2.NORM_MINMAX).astype(np.uint8)
    return (grey >= threshold).astype(np.uint8)
