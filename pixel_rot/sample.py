"""内置测试图样: 斜线拐角、两个小孔、孤立像素、贴边像素与一条带缺口的一格线。

画布 18x18, 4 个色号:
0 蓝  实心块(内含两个 1x1 孔)
1 红  斜线 + 拐角 + 一格宽水平线
2 绿  三个孤立像素
3 橙  三个贴着画布不同边的像素
"""

from __future__ import annotations

import numpy as np

from .core import TRANSPARENT, PaletteImage

WIDTH = HEIGHT = 18

BLUE = (38, 70, 160, 255)
RED = (206, 64, 64, 255)
GREEN = (56, 168, 96, 255)
ORANGE = (232, 152, 44, 255)


def build_sample() -> tuple[PaletteImage, list[tuple[str, np.ndarray]]]:
    indices = np.full((HEIGHT, WIDTH), TRANSPARENT, dtype=np.int16)

    # --- 蓝色实心块 r2..6, c2..9, 两个 1x1 小孔 ---
    indices[2:7, 2:10] = 0
    indices[3, 4] = TRANSPARENT  # 孔 1
    indices[5, 7] = TRANSPARENT  # 孔 2

    # --- 红色: 斜率 1 的斜线 (11,2)->(14,5), 拐角后接一格宽水平线 ---
    for k in range(4):
        indices[11 + k, 2 + k] = 1  # (11,2) (12,3) (13,4) (14,5)
    indices[14, 6:11] = 1  # (14,6)..(14,10), 拐角在 (14,5)

    # --- 绿色: 三个互不相邻的孤立像素 ---
    for r, c in [(9, 13), (12, 15), (16, 12)]:
        indices[r, c] = 2

    # --- 橙色: 分别贴上/下/右三条边 ---
    indices[0, 14] = 3
    indices[17, 6] = 3
    indices[8, 17] = 3

    # --- 红色一格宽水平线, 中间留一个缺口, 专门暴露断线 ---
    indices[16, 2] = 1
    indices[16, 3] = 1
    # (16,4) 空
    indices[16, 5] = 1
    indices[16, 6] = 1

    img = PaletteImage(indices, [BLUE, RED, GREEN, ORANGE], source_mode="P")

    # --- 预置关注区 (连续坐标多边形, 画在源格网上) ---
    rois = [
        (
            "斜线拐角",
            np.array([(1.5, 10.5), (11.5, 10.5), (11.5, 15.0), (1.5, 15.0)]),
        ),
        (
            "蓝块双孔",
            np.array([(1.5, 1.5), (10.5, 1.5), (10.5, 7.5), (1.5, 7.5)]),
        ),
        (
            "缺口横线",
            np.array([(1.5, 15.5), (7.5, 15.5), (7.5, 17.0), (1.5, 17.0)]),
        ),
    ]
    return img, rois


def sample_ascii(img: PaletteImage) -> str:
    """终端里快速核对图样用的字符画。"""
    glyph = {TRANSPARENT: ".", 0: "#", 1: "/", 2: "o", 3: "+"}
    lines = []
    for r in range(img.height):
        lines.append("".join(glyph[int(v)] for v in img.indices[r]))
    return "\n".join(lines)
