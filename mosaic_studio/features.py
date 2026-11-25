"""图像特征与相似度距离。

只用平均色无法区分“颜色相近、纹理不同”的样块，所以特征由三部分组成：

1. mean    —— 平均 RGB，保证远看颜色对；
2. grid    —— 6×6 缩小图的空间 RGB，捕捉明暗/颜色的空间排布；
3. texture —— 去均值、L2 归一化的亮度网格，只描述纹理走向，不受颜色影响。

三个距离分量都归一化到 [0, 1]，再加权求和，总距离也在 [0, 1]，
similarity = 1 - distance，方便界面做相似度定位。
"""
from __future__ import annotations

import math
from dataclasses import dataclass

from PIL import Image

from .config import FEATURE_GRID, MosaicParams


@dataclass(frozen=True)
class Feature:
    mean_rgb: tuple[float, float, float]
    grid_rgb: tuple[float, ...]       # FEATURE_GRID²×3，取值 0..255
    texture: tuple[float, ...]        # FEATURE_GRID²，去均值并归一化
    texture_flat: bool                # 是否为几乎无纹理的纯色图


def extract_feature(image: Image.Image, grid_n: int = FEATURE_GRID) -> Feature:
    """从任意 PIL 图提取特征（内部统一转 RGB 并缩小）。"""
    im = image.convert("RGB")
    # BOX 下采样对条纹/点阵更稳，不会因奇偶行产生偶然偏差。
    grid_img = im.resize((grid_n, grid_n), Image.Resampling.BOX)
    access = grid_img.load()

    count = grid_n * grid_n
    sum_r = sum_g = sum_b = 0.0
    grid: list[float] = []
    luminances: list[float] = []
    for y in range(grid_n):
        for x in range(grid_n):
            r, g, b = access[x, y][:3]
            sum_r += r
            sum_g += g
            sum_b += b
            grid.extend((float(r), float(g), float(b)))
            luminances.append(0.299 * r + 0.587 * g + 0.114 * b)

    mean_rgb = (sum_r / count, sum_g / count, sum_b / count)

    mean_lum = sum(luminances) / count
    centered = [v - mean_lum for v in luminances]
    norm = math.sqrt(sum(v * v for v in centered))
    if norm > 1e-4:
        texture = tuple(v / norm for v in centered)
        flat = False
    else:
        texture = tuple(0.0 for _ in centered)
        flat = True

    return Feature(mean_rgb=mean_rgb, grid_rgb=tuple(grid),
                   texture=texture, texture_flat=flat)


def _color_distance(a: Feature, b: Feature) -> float:
    dr = a.mean_rgb[0] - b.mean_rgb[0]
    dg = a.mean_rgb[1] - b.mean_rgb[1]
    db = a.mean_rgb[2] - b.mean_rgb[2]
    # 通道 RMS 差异 / 255，理论最大 1。
    return math.sqrt((dr * dr + dg * dg + db * db) / 3.0) / 255.0


def _layout_distance(a: Feature, b: Feature) -> float:
    ga, gb = a.grid_rgb, b.grid_rgb
    total = 0.0
    for i in range(0, len(ga), 3):
        dr = ga[i] - gb[i]
        dg = ga[i + 1] - gb[i + 1]
        db = ga[i + 2] - gb[i + 2]
        total += dr * dr + dg * dg + db * db
    # 每个分量的均方值再开根，归一化到 [0,1]。
    components = len(ga)
    return math.sqrt(total / components) / 255.0


def _texture_distance(a: Feature, b: Feature) -> float:
    if a.texture_flat and b.texture_flat:
        return 0.0
    if a.texture_flat or b.texture_flat:
        # 纯色块 vs 有明显纹理的块，纹理层面给很大差异。
        return 0.85
    dot = sum(x * y for x, y in zip(a.texture, b.texture))
    dot = max(-1.0, min(1.0, dot))
    # 余弦距离映射到 [0,1]。
    return math.sqrt(max(0.0, 1.0 - dot) / 2.0)


def feature_distance(a: Feature, b: Feature,
                     weights: tuple[float, float, float] | None = None) -> float:
    """加权距离，返回 [0,1]。weights 不给定时使用默认权重。"""
    if weights is None:
        w = MosaicParams().normalized_weights()
    else:
        total = sum(weights)
        w = tuple(x / total for x in weights) if total > 1e-9 else (1 / 3, 1 / 3, 1 / 3)  # type: ignore
    d = (w[0] * _color_distance(a, b)
         + w[1] * _layout_distance(a, b)
         + w[2] * _texture_distance(a, b))
    return max(0.0, min(1.0, d))


def similarity(distance: float) -> float:
    """距离转相似度百分制浮点 [0,1]。"""
    return max(0.0, min(1.0, 1.0 - distance))


def build_cost_matrix(targets: list[Feature], tiles: list[Feature],
                      params: MosaicParams) -> list[list[float]]:
    """costs[cell_index][tile_ordinal] = 距离。"""
    w = params.normalized_weights()
    costs: list[list[float]] = []
    for target in targets:
        row = [feature_distance(target, tf, w) for tf in tiles]
        costs.append(row)
    return costs
