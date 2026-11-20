"""灰度量化算法与可复现噪声。

所有输入输出约定：
    gray  : float64 二维数组，取值 [0, 1]，连续高光原图；
    alpha : float64 二维数组，取值 [0, 1]，透明区为 0；
    levels: 升序 float64 数组，取值 [0, 1]，至少 2 个元素。

量化只作用于 alpha>0 的像素；完全透明的像素原样透传，
从而在整条流水线（噪声 -> 量化 -> 分析 -> 导出）中保留透明区。
"""
from __future__ import annotations

from bisect import bisect_right

import numpy as np

METHODS = ("nearest", "floor", "ordered", "fs", "random")
METHOD_LABELS = {
    "nearest": "最近邻取级",
    "floor": "向下取级(硬色带)",
    "ordered": "Bayer 有序抖动",
    "fs": "Floyd-Steinberg 扩散",
    "random": "随机抖动",
}


def add_noise(gray: np.ndarray, alpha: np.ndarray, strength: float, seed: int) -> np.ndarray:
    """按种子复现的高斯噪声扰动，只作用在不透明像素上。

    strength 以 [0,1] 灰度为单位（例如 0.02 ≈ 8-bit 下 5 个码值）。
    相同 (seed, 图像尺寸, strength) 一定产生相同结果。
    """
    if strength <= 0:
        return gray.copy()
    rng = np.random.default_rng(seed)
    noise = rng.normal(0.0, strength, size=gray.shape)
    out = gray + noise
    np.clip(out, 0.0, 1.0, out=out)
    opaque = alpha > 0
    return np.where(opaque, out, gray)


def _nearest_index(values: np.ndarray, levels: np.ndarray) -> np.ndarray:
    """向量化的最近邻级别索引：以相邻级别中点为判决门限。"""
    mids = (levels[:-1] + levels[1:]) / 2.0
    return np.searchsorted(mids, values)


def _floor_index(values: np.ndarray, levels: np.ndarray) -> np.ndarray:
    """向下取级：value 落在 [Lk, Lk+1) 时归到 Lk。"""
    idx = np.searchsorted(levels, values, side="right") - 1
    return np.clip(idx, 0, levels.size - 1)


def _bayer_matrix(order: int) -> np.ndarray:
    """生成 2^order 边长的 Bayer 阈值矩阵，归一化到 (0,1)。"""
    matrix = np.zeros((1, 1), dtype=np.float64)
    for _ in range(order):
        n = matrix.shape[0]
        base = np.zeros((2 * n, 2 * n), dtype=np.float64)
        base[:n, :n] = 4.0 * matrix + 1.0
        base[:n, n:] = 4.0 * matrix + 3.0
        base[n:, :n] = 4.0 * matrix + 4.0
        base[n:, n:] = 4.0 * matrix + 2.0
        matrix = base
    return (matrix + 0.5) / matrix.size


def quantize(
    gray: np.ndarray,
    alpha: np.ndarray,
    levels: np.ndarray,
    method: str = "nearest",
    seed: int = 0,
    bayer_order: int = 3,
) -> np.ndarray:
    """按指定方法量化灰度，返回量化后的灰度数组（透明像素保持原值）。"""
    if method not in METHOD_LABELS:
        raise ValueError(f"未知量化方法: {method!r}，可选 {METHODS}")
    levels = np.asarray(levels, dtype=np.float64)
    gray = np.asarray(gray, dtype=np.float64)
    alpha = np.asarray(alpha, dtype=np.float64)
    opaque = alpha > 0

    if method == "nearest":
        idx = _nearest_index(np.clip(gray, 0.0, 1.0), levels)
        return np.where(opaque, levels[idx], gray)

    if method == "floor":
        idx = _floor_index(np.clip(gray, 0.0, 1.0), levels)
        return np.where(opaque, levels[idx], gray)

    if method == "ordered":
        idx = ordered_indices(gray, levels, bayer_order=bayer_order)
        return np.where(opaque, levels[idx], gray)

    if method == "random":
        rng = np.random.default_rng(seed + 7919)
        rand = rng.random(gray.shape)
        base = _floor_index(np.clip(gray, 0.0, 1.0), levels)
        # 门限在所在区间内随机：value 高于随机门限则升一级
        lo = levels[base]
        hi = levels[np.minimum(base + 1, levels.size - 1)]
        threshold = lo + rand * (hi - lo)
        idx = np.where(gray >= threshold, base + 1, base)
        idx = np.minimum(idx, levels.size - 1)
        # 最高级像素无法再升，直接保持
        idx = np.where(base >= levels.size - 1, base, idx)
        return np.where(opaque, levels[idx], gray)

    if method == "fs":
        return _floyd_steinberg(gray, alpha, levels, seed)

    raise AssertionError("unreachable")


def ordered_indices(gray: np.ndarray, levels: np.ndarray, bayer_order: int = 3) -> np.ndarray:
    """Bayer 有序抖动的级别索引（纯函数，便于单测）。"""
    bayer = _bayer_matrix(max(1, int(bayer_order)))
    bh, bw = bayer.shape
    h, w = gray.shape
    tiled = np.tile(bayer, (h // bh + 1, w // bw + 1))[:h, :w]
    base = _floor_index(np.clip(gray, 0.0, 1.0), levels)
    lo = levels[base]
    hi = levels[np.minimum(base + 1, levels.size - 1)]
    threshold = lo + tiled * (hi - lo)
    idx = np.where(gray >= threshold, base + 1, base)
    return np.minimum(idx, levels.size - 1)


def _floyd_steinberg(gray: np.ndarray, alpha: np.ndarray, levels: np.ndarray,
                     seed: int) -> np.ndarray:
    """蛇形扫描的 Floyd-Steinberg 误差扩散，透明像素不参与扩散。

    蛇形扫描可减弱单向扩散产生的方向性纹路；误差只扩散给不透明邻居。
    逐像素 Python 循环，配合 bisect 门限，默认测试图尺寸下耗时可接受。
    """
    h, w = gray.shape
    work = gray.astype(np.float64).copy()
    out = gray.copy()
    mids = (levels[:-1] + levels[1:]) / 2.0
    opaque = alpha > 0

    for y in range(h):
        left_to_right = (y % 2 == 0)
        xs = range(w) if left_to_right else range(w - 1, -1, -1)
        for x in xs:
            if not opaque[y, x]:
                continue
            v = work[y, x]
            idx = bisect_right(mids, min(max(v, 0.0), 1.0))
            chosen = levels[idx]
            out[y, x] = chosen
            err = v - chosen
            # 按扫描方向决定左右邻居
            if left_to_right:
                neighbors = ((y, x + 1, 7 / 16),
                             (y + 1, x - 1, 3 / 16),
                             (y + 1, x, 5 / 16),
                             (y + 1, x + 1, 1 / 16))
            else:
                neighbors = ((y, x - 1, 7 / 16),
                             (y + 1, x + 1, 3 / 16),
                             (y + 1, x, 5 / 16),
                             (y + 1, x - 1, 1 / 16))
            for ny, nx, weight in neighbors:
                if 0 <= ny < h and 0 <= nx < w and opaque[ny, nx]:
                    work[ny, nx] += err * weight
    return out
