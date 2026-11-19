"""误差指标计算:全部基于 8 位 sRGB 编码值 (uint8, RGB)。

- 逐通道平均绝对误差 (MAE) 与总 MAE
- 峰值信噪比 (PSNR),完全一致时返回 inf 且 identical=True,不产生 NaN
- 固定像素网格分区统计,边缘非整块按实际像素数计入,
  各块 MAE 按像素数加权后须与全图 MAE 一致 (见 weighted_mae)
"""

from __future__ import annotations

import numpy as np

PEAK = 255.0


def _check_pair(ref: np.ndarray, dec: np.ndarray) -> None:
    if ref.shape != dec.shape:
        raise ValueError(f"形状不一致: ref{ref.shape} vs dec{dec.shape}")
    if ref.ndim != 3 or ref.shape[2] != 3:
        raise ValueError(f"期望 (H, W, 3) RGB 数组, 得到 {ref.shape}")


def abs_diff(ref: np.ndarray, dec: np.ndarray) -> np.ndarray:
    """逐像素逐通道绝对差, uint8 (H, W, 3)。"""
    _check_pair(ref, dec)
    return np.abs(ref.astype(np.int16) - dec.astype(np.int16)).astype(np.uint8)


def error_map(ref: np.ndarray, dec: np.ndarray) -> np.ndarray:
    """逐像素误差强度 = 三通道绝对差的最大值, uint8 (H, W)。用于热图显示。"""
    return abs_diff(ref, dec).max(axis=2)


def clamp_rect(rect, width: int, height: int):
    """把 (x, y, w, h) 裁剪到图像范围内, 返回 None 表示无交集。"""
    x, y, w, h = rect
    x0 = max(0, int(x))
    y0 = max(0, int(y))
    x1 = min(width, int(x) + int(w))
    y1 = min(height, int(y) + int(h))
    if x1 <= x0 or y1 <= y0:
        return None
    return (x0, y0, x1 - x0, y1 - y0)


def region_stats(ref: np.ndarray, dec: np.ndarray, rect=None) -> dict:
    """统计一个矩形区域 (x, y, w, h);rect=None 表示全图。

    返回:
      pixels    区域像素数
      mae_r/g/b 各通道平均绝对误差 (0~255)
      mae       三通道合并的平均绝对误差
      mse       三通道合并的均方误差
      psnr      峰值信噪比 (dB);完全一致时为 float('inf')
      identical 是否完全一致 (此时 MAE 全为 0, 明确表示无误差)
    """
    _check_pair(ref, dec)
    if rect is not None:
        rect = clamp_rect(rect, ref.shape[1], ref.shape[0])
        if rect is None:
            raise ValueError("区域与图像无交集")
        x, y, w, h = rect
        ref = ref[y:y + h, x:x + w]
        dec = dec[y:y + h, x:x + w]
    d = abs_diff(ref, dec).astype(np.float64)
    ch_mae = d.mean(axis=(0, 1))
    mae = float(d.mean())
    mse = float((d ** 2).mean())
    identical = mse == 0.0
    psnr = float("inf") if identical else float(20.0 * np.log10(PEAK / np.sqrt(mse)))
    return {
        "pixels": int(ref.shape[0] * ref.shape[1]),
        "mae_r": float(ch_mae[0]),
        "mae_g": float(ch_mae[1]),
        "mae_b": float(ch_mae[2]),
        "mae": mae,
        "mse": mse,
        "psnr": psnr,
        "identical": identical,
    }


def grid_rects(shape, block: int):
    """按固定像素网格切分 (H, W[, ...]),边缘不足一块的按实际尺寸保留。

    返回 [(x, y, w, h), ...],按行优先排列。
    """
    if block < 1:
        raise ValueError("block 必须 >= 1")
    h, w = shape[:2]
    out = []
    for y in range(0, h, block):
        for x in range(0, w, block):
            out.append((x, y, min(block, w - x), min(block, h - y)))
    return out


def grid_stats(ref: np.ndarray, dec: np.ndarray, block: int) -> list[dict]:
    """对固定网格的每个块计算 region_stats,并附加 rect 字段。"""
    _check_pair(ref, dec)
    blocks = []
    for rect in grid_rects(ref.shape, block):
        s = region_stats(ref, dec, rect)
        s["rect"] = rect
        blocks.append(s)
    return blocks


def weighted_mae(blocks: list[dict]) -> float:
    """各块 MAE 按实际像素数加权。对同一网格切分,结果等于全图 MAE。

    原理:块 MAE = 块内误差和 / (块像素数 * 3),乘以块像素数后求和即全图误差和。
    """
    total_px = sum(b["pixels"] for b in blocks)
    if total_px == 0:
        raise ValueError("没有像素")
    return sum(b["mae"] * b["pixels"] for b in blocks) / total_px
