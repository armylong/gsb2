"""自生成对照图:灰度渐变、红蓝细线、棋盘纹理、纯色块。

不依赖任何外部附件,输出确定的 uint8 RGB 数组,便于测试复现。
"""

from __future__ import annotations

import numpy as np

WIDTH = 640
HEIGHT = 400


def generate(width: int = WIDTH, height: int = HEIGHT) -> np.ndarray:
    """生成对照图,布局(按 640x400 设计,其他尺寸按比例缩放):

    - 上半左: 水平灰度渐变(0 -> 255)
    - 上半右: 垂直灰度渐变
    - 中部: 1 像素红/蓝细线(水平、垂直、对角)
    - 下半左: 4px 与 8px 棋盘纹理
    - 下半右: 纯色块(红/绿/蓝/灰/白/黑)
    """
    img = np.zeros((height, width, 3), dtype=np.uint8)
    half_h = height // 2
    half_w = width // 2

    # 水平灰度渐变(左上)
    ramp = np.linspace(0, 255, half_w).round().astype(np.uint8)
    img[0:half_h // 2, 0:half_w] = ramp[None, :, None]

    # 垂直灰度渐变(右上)
    vramp = np.linspace(0, 255, half_h // 2).round().astype(np.uint8)
    img[0:half_h // 2, half_w:width] = vramp[:, None, None]

    # 红蓝细线区域(第二行带)
    band_y0 = half_h // 2
    band_y1 = half_h
    img[band_y0:band_y1, :] = 32  # 深灰底,便于观察细线
    # 水平 1px 红线 / 蓝线
    for i, y in enumerate(range(band_y0 + 4, band_y1 - 4, 8)):
        color = (255, 0, 0) if i % 2 == 0 else (0, 0, 255)
        img[y, 0:width] = color
    # 垂直 1px 线
    for i, x in enumerate(range(8, width, 16)):
        color = (0, 0, 255) if i % 2 == 0 else (255, 0, 0)
        img[band_y0:band_y1, x] = color
    # 对角 1px 线(左下->右上)
    diag_len = min(band_y1 - band_y0, width // 3)
    for i in range(diag_len):
        img[band_y1 - 1 - i, i] = (255, 0, 0)
        img[band_y1 - 1 - i, width - 1 - i] = (0, 0, 255)

    # 棋盘纹理(下半左): 4px 与 8px
    cell_small, cell_big = 4, 8
    region = img[half_h:height, 0:half_w]
    rh, rw = region.shape[:2]
    yy, xx = np.mgrid[0:rh, 0:rw]
    left_half = xx < rw // 2
    check4 = ((xx // cell_small + yy // cell_small) % 2 == 0)
    check8 = ((xx // cell_big + yy // cell_big) % 2 == 0)
    pattern = np.where(left_half, check4, check8)
    region[pattern] = 255
    region[~pattern] = 0

    # 纯色块(下半右): 2 行 3 列
    colors = [
        (255, 0, 0), (0, 255, 0), (0, 0, 255),
        (128, 128, 128), (255, 255, 255), (0, 0, 0),
    ]
    bx0, by0 = half_w, half_h
    bw = (width - half_w) // 3
    bh = (height - half_h) // 2
    for idx, c in enumerate(colors):
        r, col = divmod(idx, 3)
        y0 = by0 + r * bh
        x0 = bx0 + col * bw
        y1 = by0 + (r + 1) * bh if r == 0 else height
        x1 = bx0 + (col + 1) * bw if col < 2 else width
        img[y0:y1, x0:x1] = c

    return img
