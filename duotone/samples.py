"""程序内置样例：渐变图、色卡、检查用例条（无需外部素材即可运行）。

所有生成函数返回线性 RGB 浮点数组 (H,W,3)，0..1。
"""

from __future__ import annotations

import numpy as np

from . import color as C

# 一组说明性 sRGB 色卡（含亮、暗、高饱和 —— 后两者大概率落在双色色域之外）
CHART_HEXES = [
    "#ffffff", "#f2f2f2", "#9d9d9d", "#1a1a1a",
    "#c8102e", "#f2c127", "#2e7d32", "#1565c0",
    "#6a1b9a", "#00838f", "#ef6c00", "#ad1457",
    "#ffe0b2", "#b3e5fc", "#c8e6c9", "#ffcdd2",
]


def make_gradient(width: int = 640, height: int = 360) -> np.ndarray:
    """水平方向色相渐变、垂直方向明度渐变（sRGB HSL 构造后转线性）。"""
    h = np.linspace(0.0, 1.0, width, dtype=np.float64)[None, :]
    l = np.linspace(0.08, 0.92, height, dtype=np.float64)[:, None]
    s = np.ones_like(h) * 0.75

    def hue2rgb(p, q, t):
        t = t % 1.0
        return np.select(
            [t < 1 / 6, t < 1 / 2, t < 2 / 3],
            [p + (q - p) * 6 * t, q, p + (q - p) * (2 / 3 - t) * 6],
            default=p,
        )

    q = np.where(l < 0.5, l * (1 + s), l + s - l * s)
    p = 2 * l - q
    r = hue2rgb(p, q, h + 1 / 3)
    g = hue2rgb(p, q, h)
    b = hue2rgb(p, q, h - 1 / 3)
    srgb = np.stack([r, g, b], axis=-1)
    return C.srgb_to_rgb(srgb)


def make_color_chart(swatch: int = 120, cols: int = 4) -> np.ndarray:
    """规则色卡（纯色块，不写字 —— 文字由 GUI/导出层叠加）。"""
    hexes = CHART_HEXES
    rows = (len(hexes) + cols - 1) // cols
    img = np.ones((rows * swatch, cols * swatch, 3), dtype=np.float64)
    for i, hx in enumerate(hexes):
        r, c = divmod(i, cols)
        img[r * swatch:(r + 1) * swatch, c * swatch:(c + 1) * swatch] = C.hex_to_rgb(hx)
    return img


def make_check_strip(ink_a_hex: str, ink_b_hex: str, paper_hex: str,
                     block: int = 160) -> tuple[np.ndarray, list[str]]:
    """检查用例条：空纸 / 纯墨A / 纯墨B / 双色叠印（各一块实底）。"""
    from .model import InkParams

    p = InkParams.from_hex(paper_hex, ink_a_hex, ink_b_hex)
    cells = [
        (p.paper_rgb, "paper"),
        (p.solid_a_rgb, "ink_A_100%"),
        (p.solid_b_rgb, "ink_B_100%"),
        (p.overprint_rgb, "overprint_A+B"),
    ]
    img = np.empty((block, block * len(cells), 3), dtype=np.float64)
    labels = []
    for i, (rgb, label) in enumerate(cells):
        img[:, i * block:(i + 1) * block] = rgb
        labels.append(label)
    return img, labels


def srgb_image_to_rgb(u8: np.ndarray) -> np.ndarray:
    """外部 8 位图（H,W,3 或 H,W,4）转线性 RGB。"""
    a = u8[..., :3].astype(np.float64) / 255.0
    return C.srgb_to_rgb(a)
