"""重建渲染: 普通位图缩放 与 距离场重建 共用同一套坐标映射。

坐标约定 (两条渲染路径完全一致, 保证轮廓不错半个像素):
- 显示(输出)画布像素 p 的中心为 (p+0.5)。
- 显示像素中心映射到源连续坐标:  u = (p + 0.5) / scale - t
  其中 scale 为放大倍率, t 为平移量 (单位: 源图像素, 正数表示字形向显示坐标
  正方向移动)。
- 逆映射(用于在显示画布上绘制参考轮廓):  p = (u + t) * scale - 0.5,
  连续线宽绘制时用 X = (u + t) * scale。

宽度参数 (柔边、描边) 一律以最终显示像素表达, 内部除以 scale 换算成源像素,
因此改变倍率后读数仍然是显示像素宽度。
"""
from __future__ import annotations

from dataclasses import dataclass, asdict

import numpy as np
from scipy.ndimage import map_coordinates


@dataclass
class RenderParams:
    scale: float = 2.0        # 放大倍率 0.5 .. 8
    tx: float = 0.0           # 亚像素平移 (源图像素)
    ty: float = 0.0
    threshold: float = 0.0    # 轮廓阈值 (源图像素距离)
    softness_px: float = 1.0  # 柔边宽度 (显示像素)
    outline_px: float = 0.0   # 描边宽度 (显示像素)

    def to_dict(self) -> dict:
        return asdict(self)


def canvas_size(n: int, scale: float) -> int:
    return max(1, int(round(n * scale)))


def source_coords(px: np.ndarray, scale: float, t: float) -> np.ndarray:
    """显示像素索引 -> 源连续坐标 (正 t = 字形向显示正方向平移)。"""
    return (px + 0.5) / scale - t


def _sample_grid(field: np.ndarray, xs: np.ndarray, ys: np.ndarray,
                 scale: float, tx: float, ty: float) -> np.ndarray:
    u = source_coords(xs, scale, tx)
    v = source_coords(ys, scale, ty)
    uu, vv = np.meshgrid(u, v)
    return map_coordinates(field, [vv - 0.5, uu - 0.5], order=1, mode="nearest")


def _coverage(d: np.ndarray, threshold: float, soft_src: float) -> np.ndarray:
    if soft_src <= 1e-9:
        return (d >= threshold).astype(np.float64)
    return np.clip((d - threshold) / soft_src + 0.5, 0.0, 1.0)


def render_bitmap(bitmap: np.ndarray, xs: np.ndarray, ys: np.ndarray,
                  p: RenderParams) -> np.ndarray:
    """普通位图双线性缩放, 返回覆盖率 (len(ys), len(xs))。"""
    return _sample_grid(bitmap, xs, ys, p.scale, p.tx, p.ty)


def render_sdf_coverage(sdf: np.ndarray, xs: np.ndarray, ys: np.ndarray,
                        p: RenderParams):
    """距离场重建。返回 (填充覆盖率, 描边覆盖率), 形状 (len(ys), len(xs))。

    柔边与描边宽度以显示像素给出, 除以 scale 换算到源像素距离域;
    描边是围绕阈值等值线的窄带 (|d - threshold| <= outline/2),
    不是整图模糊。内部为正 -> 描边自然向孔洞内、外轮廓外两个正确方向扩展。
    """
    d = _sample_grid(sdf, xs, ys, p.scale, p.tx, p.ty)
    soft_src = p.softness_px / p.scale
    fill = _coverage(d, p.threshold, soft_src)
    if p.outline_px > 0.0:
        half_src = 0.5 * p.outline_px / p.scale
        band = _coverage(half_src - np.abs(d - p.threshold), 0.0, soft_src)
    else:
        band = np.zeros_like(fill)
    return fill, band


def compose_rgba(fill: np.ndarray, band: np.ndarray,
                 fill_rgb=(255, 255, 255), band_rgb=(255, 64, 48)) -> np.ndarray:
    """填充与描边合成为 RGBA uint8 (透明背景)。"""
    alpha = np.maximum(fill, band)
    out = np.zeros(fill.shape + (4,), dtype=np.uint8)
    f = np.asarray(fill_rgb, dtype=np.float64)
    b = np.asarray(band_rgb, dtype=np.float64)
    w = band[..., None]
    rgb = f * (1.0 - w) + b * w
    out[..., :3] = np.clip(rgb + 0.5, 0, 255).astype(np.uint8)
    out[..., 3] = np.clip(alpha * 255.0 + 0.5, 0, 255).astype(np.uint8)
    return out


def sdf_colormap(sdf: np.ndarray, value_range: float) -> np.ndarray:
    """距离场可视化: 内部(正)暖色、外部(负)冷色, 零附近亮, 截断处饱和。RGB uint8。"""
    t = np.clip(sdf / max(value_range, 1e-9), -1.0, 1.0)
    pos = np.clip(t, 0.0, 1.0)
    neg = np.clip(-t, 0.0, 1.0)
    r = 0.15 + 0.85 * pos + 0.10 * (1 - neg)
    g = 0.15 + 0.55 * (1 - np.abs(t))
    b = 0.15 + 0.85 * neg + 0.10 * (1 - pos)
    rgb = np.stack([r, g, b], axis=-1)
    return np.clip(rgb * 255.0, 0, 255).astype(np.uint8)
