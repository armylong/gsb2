"""sRGB / 线性光 / CIELAB 之间的转换，全部基于 numpy 向量化实现。

约定：
- sRGB 像素值为 0-255 的浮点数组；
- 颜色修正矩阵在线性光空间（linear RGB, 0-1）中拟合与应用；
- Lab 用 D65 白点计算，色差用 CIE76（欧氏距离，单位 ΔE，1 ΔE 约为普通人眼可辨阈值）。
"""

from __future__ import annotations

import numpy as np

# sRGB 分段 gamma 的拐点
_SRGB_THRESHOLD = 0.04045
_SRGB_SLOPE = 12.92
_SRGB_GAMMA = 2.4
_SRGB_A = 1.055
_SRGB_B = 0.055

# D65 白点（线性 sRGB → XYZ，参考 IEC 61966-2-1）
_M_RGB2XYZ = np.array(
    [
        [0.4123908, 0.3575843, 0.1804808],
        [0.2126390, 0.7151687, 0.0721923],
        [0.0193308, 0.1191948, 0.9505322],
    ],
    dtype=np.float64,
)
_M_XYZ2RGB = np.linalg.inv(_M_RGB2XYZ)
_D65 = np.array([0.95047, 1.0, 1.08883], dtype=np.float64)


def srgb_to_linear(values: np.ndarray) -> np.ndarray:
    """sRGB 0-255 → 线性光 0-1，支持任意形状最后一维为 3。"""
    v = np.asarray(values, dtype=np.float64) / 255.0
    return np.where(
        v <= _SRGB_THRESHOLD,
        v / _SRGB_SLOPE,
        np.power(np.maximum((v + _SRGB_B) / _SRGB_A, 0.0), _SRGB_GAMMA),
    )


def linear_to_srgb(values: np.ndarray) -> np.ndarray:
    """线性光 0-1 → sRGB 0-255（不做裁剪，可能超出 0-255）。"""
    v = np.asarray(values, dtype=np.float64)
    out = np.where(
        v <= _SRGB_THRESHOLD / _SRGB_SLOPE,
        v * _SRGB_SLOPE,
        _SRGB_A * np.power(np.maximum(v, 0.0), 1.0 / _SRGB_GAMMA) - _SRGB_B,
    )
    return out * 255.0


def linear_to_xyz(rgb_linear: np.ndarray) -> np.ndarray:
    return rgb_linear @ _M_RGB2XYZ.T


def xyz_to_lab(xyz: np.ndarray) -> np.ndarray:
    """XYZ（D65）→ CIELAB。输入最后一维为 3。"""
    scaled = np.asarray(xyz, dtype=np.float64) / _D65
    eps = 216.0 / 24389.0
    kappa = 24389.0 / 27.0
    f = np.where(
        scaled > eps,
        np.cbrt(np.maximum(scaled, 0.0)),
        (kappa * scaled + 16.0) / 116.0,
    )
    fx, fy, fz = f[..., 0], f[..., 1], f[..., 2]
    l = 116.0 * fy - 16.0
    a = 500.0 * (fx - fy)
    b = 200.0 * (fy - fz)
    return np.stack([l, a, b], axis=-1)


def srgb_to_lab(values: np.ndarray) -> tuple[float, float, float]:
    """单个 sRGB 三元组（0-255）→ Lab 三元组。"""
    arr = np.asarray(values, dtype=np.float64).reshape(1, 3)
    lab = xyz_to_lab(linear_to_xyz(srgb_to_linear(arr)))
    return tuple(float(x) for x in lab[0])  # type: ignore[return-value]


def srgb_array_to_lab(values: np.ndarray) -> np.ndarray:
    """一批 sRGB 0-255 像素（..., 3）→ Lab 数组。"""
    return xyz_to_lab(linear_to_xyz(srgb_to_linear(values)))


def delta_e(lab_a: np.ndarray, lab_b: np.ndarray) -> np.ndarray:
    """CIE76 色差 ΔE（Lab 空间欧氏距离）。"""
    return np.linalg.norm(
        np.asarray(lab_a, dtype=np.float64) - np.asarray(lab_b, dtype=np.float64),
        axis=-1,
    )


def apply_linear_matrix(srgb_image: np.ndarray, matrix: np.ndarray) -> np.ndarray:
    """把 3x3 线性光矩阵作用到整张 sRGB 图上，返回 sRGB 浮点图（可能越界）。

    输入输出均为 HxWx3、0-255 量纲。矩阵在线性空间应用后转回 sRGB，
    结果可能落在 0-255 之外（表示超出 sRGB 可表示范围），由调用方决定如何处理。
    """
    lin = srgb_to_linear(srgb_image)
    corrected = lin @ np.asarray(matrix, dtype=np.float64).T
    return linear_to_srgb(corrected)


def clip_srgb(image: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """把浮点 sRGB 图裁剪到 0-255，并返回被裁剪像素的掩码。

    掩码为 True 的像素即“超出可显示范围、被压到边界”的像素，
    其真实颜色在 sRGB 内无法表示，预览与导出必须用同一套处理。
    """
    arr = np.asarray(image, dtype=np.float64)
    clipped_mask = np.any((arr < 0.0) | (arr > 255.0), axis=-1)
    return np.clip(arr, 0.0, 255.0), clipped_mask
