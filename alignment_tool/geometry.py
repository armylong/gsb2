"""几何与残差：warp 矩阵、实际重叠区域、边缘填充标记、残差统计。"""

from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

# 边缘填充固定值。取 0 便于在残差/可视化里单独标出，
# 同时与自然纹理（基准 40 起步）区分开。
FILL_VALUE = 0


def shift_to_warp(dx: float, dy: float) -> np.ndarray:
    """位移 -> cv2.warpAffine 的 2x3 仿射矩阵。

    输出图像素 (x', y') 采样自输入图的 (x' - dx, y' - dy)，
    即输入内容整体向右移动 dx、向下移动 dy。
    """
    return np.array([[1.0, 0.0, float(dx)],
                     [0.0, 1.0, float(dy)]], dtype=np.float64)


def overlap_mask(shape: tuple[int, int], dx: float, dy: float) -> np.ndarray:
    """返回 moving 按 (dx, dy) 平移、再反向 warp 对齐后与 ref 的实际重叠掩码。

    shape 为 (H, W)。掩码 True 的像素表示该位置在两张图中都有真实内容
    （而非边缘填充）。

    推导：moving 由 ref 按 (dx, dy) 平移得到，对齐图满足
        aligned(x) = moving(x + dx)
    仅当 x + dx 落在 moving 的真实内容区 [0, W) 内时有效，即
    x ∈ [-dx, W-dx)，再与画面对齐坐标系 [0, W) 取交集：
        x: [max(0, -dx), min(W, W-dx))
        y: [max(0, -dy), min(H, H-dy))
    例：dx=+0.7（moving 右移）时，对齐图右侧 0.7px 为填充带。

    边界取整采用保守策略（ceil/floor）：warpAffine 的线性插值会把填充值
    与真实内容混合，使理论填充带内出现非零的插值污染像素，这些像素一并
    排除在有效区外，保证残差只统计两张图都有真实内容的区域。因此本掩码
    是"实际零值像素集合"的超集，差异即插值污染带。
    """
    h, w = shape
    x0 = max(0, int(np.ceil(-dx)))
    x1 = min(w, int(np.floor(w - dx)))
    y0 = max(0, int(np.ceil(-dy)))
    y1 = min(h, int(np.floor(h - dy)))
    mask = np.zeros((h, w), dtype=bool)
    if x1 > x0 and y1 > y0:
        mask[y0:y1, x0:x1] = True
    return mask


def filled_mask(aligned_moving: np.ndarray, fill_value: int = FILL_VALUE) -> np.ndarray:
    """从对齐后的图中识别填充像素（等于填充值且处于边缘带）。

    直接用固定填充值判断即可：warpAffine 使用 BORDER_CONSTANT，
    插值不会在填充带内部产生恰好等于 fill_value 的孤立点，
    这里再做一次形态学闭运算消除边缘插值的零星影响。
    """
    raw = aligned_moving == fill_value
    if not raw.any():
        return raw
    kernel = np.ones((3, 3), np.uint8)
    cleaned = cv2.morphologyEx(raw.astype(np.uint8), cv2.MORPH_CLOSE, kernel).astype(bool)
    return cleaned


def warp_align(
    moving: np.ndarray,
    dx: float,
    dy: float,
    fill_value: int = FILL_VALUE,
) -> np.ndarray:
    """把 moving 按 (-dx, -dy) 平移回 ref 坐标系，得到对齐图。

    moving 是 ref 内容平移 (dx, dy) 得到的，因此反向 warp 的平移量为 (-dx, -dy)。
    空白边缘仍用 fill_value 填充，可通过 filled_mask 单独标出。
    """
    h, w = moving.shape[:2]
    m = shift_to_warp(-dx, -dy)
    return cv2.warpAffine(
        moving, m, (w, h),
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=(int(fill_value),),
    )


@dataclass
class ResidualStats:
    """仅在实际重叠区域上统计的残差结果。"""

    n_valid: int          # 参与统计的有效像素数
    n_filled: int         # 边缘填充像素数（不参与统计）
    mae: float            # 平均绝对误差
    rmse: float           # 均方根误差
    max_abs: float        # 最大绝对误差
    mean_diff: float      # 残差均值（>0 表示 moving 整体更亮）
    rmse_corrected: float # 扣除亮度均值差后的 RMSE
    residual: np.ndarray  # 与原图同尺寸的残差图（填充区置 0）
    valid_mask: np.ndarray
    fill_mask: np.ndarray


def residual_stats(
    ref: np.ndarray,
    aligned_moving: np.ndarray,
    dx: float,
    dy: float,
) -> ResidualStats:
    """在两张图的实际重叠区域内统计残差，填充像素单独计数。"""
    if ref.shape != aligned_moving.shape:
        raise ValueError("ref 与 aligned_moving 必须同尺寸")
    valid = overlap_mask(ref.shape[:2], dx, dy)
    fill = ~valid

    a = ref.astype(np.float32)
    b = aligned_moving.astype(np.float32)
    diff = np.zeros_like(a)
    diff[valid] = b[valid] - a[valid]

    if valid.any():
        vals = diff[valid]
        mae = float(np.mean(np.abs(vals)))
        rmse = float(np.sqrt(np.mean(vals**2)))
        max_abs = float(np.max(np.abs(vals)))
        mean_diff = float(np.mean(vals))
        rmse_corrected = float(np.sqrt(np.mean((vals - mean_diff) ** 2)))
    else:
        mae = rmse = max_abs = mean_diff = rmse_corrected = float("nan")

    return ResidualStats(
        n_valid=int(valid.sum()),
        n_filled=int(fill.sum()),
        mae=mae,
        rmse=rmse,
        max_abs=max_abs,
        mean_diff=mean_diff,
        rmse_corrected=rmse_corrected,
        residual=diff,
        valid_mask=valid,
        fill_mask=fill,
    )
