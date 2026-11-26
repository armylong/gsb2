"""渲染层: 原始数值 -> uint8 显示图。

设计原则:
  - 输入 BandData 与显示范围, 输出 RGBA uint8, 绝不修改原始数组;
  - 无值、下界裁剪、上界裁剪用独立覆盖色, 因此「范围太窄被挤成同色」的点始终可辨;
  - 所有线性映射在 float64 上做, 兼容 uint16/uint32/float 高位深。
"""

from __future__ import annotations

from typing import Optional

import numpy as np

from .constants import (
    HIGH_CLIP_RGBA,
    LOW_CLIP_RGBA,
    LOW_DENOM_RGBA,
    NDVI_COLORMAP,
    NODATA_RGBA,
)
from .model import BandData


def scale_to_uint8(
    data: np.ndarray,
    valid: np.ndarray,
    lo: float,
    hi: float,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """把有效像素线性拉伸到 0..255。

    返回 (gray, low_clip, high_clip):
      gray     —— uint8, 无效像素位置为 0
      low_clip —— 布尔, v < lo
      high_clip—— 布尔, v > hi
    平范围 (lo == hi) 时有效像素统一映射为 128, 同时全部计入裁剪提示。
    """
    values = data.astype(np.float64, copy=False)
    gray = np.zeros(data.shape, dtype=np.uint8)
    low_clip = np.zeros(data.shape, dtype=bool)
    high_clip = np.zeros(data.shape, dtype=bool)

    if not np.isfinite(lo) or not np.isfinite(hi):
        return gray, low_clip, high_clip

    inside = valid & (values >= lo) & (values <= hi)
    low_clip = valid & (values < lo)
    high_clip = valid & (values > hi)

    if hi > lo:
        scaled = (values[inside] - lo) * (255.0 / (hi - lo))
        gray[inside] = np.rint(np.clip(scaled, 0.0, 255.0)).astype(np.uint8)
    else:
        gray[inside] = 128
    return gray, low_clip, high_clip


def _apply_overlays(
    base_rgb: np.ndarray,
    valid: np.ndarray,
    low_clip: Optional[np.ndarray],
    high_clip: Optional[np.ndarray],
    show_clip: bool,
) -> np.ndarray:
    """在 RGB 底色上叠无值/裁剪覆盖色, 返回 RGBA。"""
    rgba = np.empty(base_rgb.shape[:2] + (4,), dtype=np.uint8)
    rgba[:, :, :3] = base_rgb
    rgba[:, :, 3] = 255
    rgba[~valid] = NODATA_RGBA
    if show_clip:
        if low_clip is not None:
            rgba[low_clip] = LOW_CLIP_RGBA
        if high_clip is not None:
            rgba[high_clip] = HIGH_CLIP_RGBA
    return rgba


def render_grayscale(
    band: BandData,
    lo: float,
    hi: float,
    show_clip: bool = True,
) -> np.ndarray:
    """单波段灰度视图。"""
    gray, low_clip, high_clip = scale_to_uint8(band.data, band.valid, lo, hi)
    base = np.repeat(gray[:, :, None], 3, axis=2)
    return _apply_overlays(base, band.valid, low_clip, high_clip, show_clip)


def render_composite(
    bands: tuple[Optional[BandData], Optional[BandData], Optional[BandData]],
    ranges: tuple[tuple[float, float], tuple[float, float], tuple[float, float]],
    show_clip: bool = True,
) -> np.ndarray:
    """三通道合成。

    bands/ranges 依次对应 R/G/B; 位置为 None 表示该屏幕通道未分配 (按 0 处理)。
    无值掩码取三个已分配波段的交集 (任一波段无值则该像素无值)。
    任一通道发生裁剪, 该像素即标为对应裁剪色。
    """
    h, w = bands[0].shape if bands[0] is not None else (
        bands[1].shape if bands[1] is not None else bands[2].shape
    )
    rgb = np.zeros((h, w, 3), dtype=np.uint8)
    valid = np.ones((h, w), dtype=bool)
    any_low = np.zeros((h, w), dtype=bool)
    any_high = np.zeros((h, w), dtype=bool)

    for ch, (band, (lo, hi)) in enumerate(zip(bands, ranges)):
        if band is None:
            continue
        gray, low_clip, high_clip = scale_to_uint8(band.data, band.valid, lo, hi)
        rgb[:, :, ch] = gray
        valid &= band.valid
        any_low |= low_clip
        any_high |= high_clip

    return _apply_overlays(rgb, valid, any_low, any_high, show_clip)


def normalized_difference(
    band_a: BandData,
    band_b: BandData,
    denom_eps: float,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """计算 (a - b) / (a + b)。

    返回 (ndvi, valid_mask, low_denom_mask):
      ndvi          —— float64, 无效/分母过小位置为 0
      valid_mask    —— 两波段都有效
      low_denom_mask—— 有效但 |a+b| < denom_eps, 独立显示
    """
    if band_a.shape != band_b.shape:
        raise ValueError("两个波段尺寸不一致, 无法做归一化差值")
    a = band_a.data.astype(np.float64, copy=False)
    b = band_b.data.astype(np.float64, copy=False)
    valid = band_a.valid & band_b.valid
    denom = a + b
    low_denom = valid & (np.abs(denom) < denom_eps)

    ndvi = np.zeros(a.shape, dtype=np.float64)
    usable = valid & ~low_denom
    ndvi[usable] = (a[usable] - b[usable]) / denom[usable]
    # 理论上 |ndvi| <= 1; 浮点误差做一次保护
    ndvi[usable] = np.clip(ndvi[usable], -1.0, 1.0)
    return ndvi, valid, low_denom


def _sample_colormap(values: np.ndarray) -> np.ndarray:
    """按 NDVI_COLORMAP 分段线性插值; 输入可为任意形状, 返回同形状的 (..., 3)。"""
    flat = values.reshape(-1)
    stops = np.array([s[0] for s in NDVI_COLORMAP], dtype=np.float64)
    colors = np.array([s[1] for s in NDVI_COLORMAP], dtype=np.float64)
    idx = np.searchsorted(stops, flat, side="right") - 1
    idx = np.clip(idx, 0, len(stops) - 2)
    lo_stop = stops[idx]
    hi_stop = stops[idx + 1]
    t = ((flat - lo_stop) / (hi_stop - lo_stop))[:, None]
    rgb = colors[idx] * (1.0 - t) + colors[idx + 1] * t
    out = np.rint(np.clip(rgb, 0, 255)).astype(np.uint8)
    return out.reshape(values.shape + (3,))


def render_ndvi(
    band_a: BandData,
    band_b: BandData,
    denom_eps: float,
    show_clip: bool = True,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """归一化差值彩色图。

    返回 (rgba, ndvi, valid, low_denom), 后三者供读数与测试核对。
    """
    ndvi, valid, low_denom = normalized_difference(band_a, band_b, denom_eps)
    h, w = band_a.shape
    rgb = np.zeros((h, w, 3), dtype=np.uint8)
    rgb[valid & ~low_denom] = _sample_colormap(ndvi[valid & ~low_denom])
    rgba = np.empty((h, w, 4), dtype=np.uint8)
    rgba[:, :, :3] = rgb
    rgba[:, :, 3] = 255
    rgba[~valid] = NODATA_RGBA
    if show_clip:
        rgba[low_denom] = LOW_DENOM_RGBA
    return rgba, ndvi, valid, low_denom
