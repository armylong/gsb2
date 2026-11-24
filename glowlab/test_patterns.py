"""内置测试样图 (纯 numpy 生成，512x512)。

三张图各自对应一个实验问题：

red_paint     暗红颜料块 (低亮度、高饱和) + 白点源 + 亮红点源。
              证明资格只看亮度：暗红块永不发光，亮红点降门槛后才发光。
edge_cluster  贴边/压角的白点 + 中央四个相邻亮点。验证零填充边界与
              相邻晕圈合并，且放大预览与全图一致。
luma_ramp     中性灰亮度斜坡 + 同亮度的红条/灰条对照。蒙版只由
              亮度决定，同亮度不同颜色拿到完全相同的资格。
"""

from __future__ import annotations

import numpy as np

SIZE = 512


def _canvas(value=(16, 16, 20)) -> np.ndarray:
    img = np.zeros((SIZE, SIZE, 3), dtype=np.uint8)
    img[..., :] = np.array(value, dtype=np.uint8)
    return img


def _disk(img: np.ndarray, cx: int, cy: int, radius: int, color) -> None:
    yy, xx = np.ogrid[: img.shape[0], : img.shape[1]]
    m = (xx - cx) ** 2 + (yy - cy) ** 2 <= radius ** 2
    img[m] = np.array(color, dtype=np.uint8)


def _rect(img: np.ndarray, y0, y1, x0, x1, color) -> None:
    img[y0:y1, x0:x1] = np.array(color, dtype=np.uint8)


def red_paint() -> np.ndarray:
    """暗底 + 暗红颜料块 + 白点源 + 亮红点源。"""
    img = _canvas()
    # 暗红颜料块：颜色很红，但 luma 只有约 0.11 —— 任何合理门槛下都没资格
    _rect(img, 60, 220, 50, 250, (92, 12, 10))
    # 块内再压一道更暗的红色渐变，模拟颜料厚薄
    grad = np.linspace(60, 110, 200, dtype=np.uint8)
    img[90:120, 80:280, 0] = grad
    img[90:120, 80:280, 1] = 8
    img[90:120, 80:280, 2] = 6
    # 白点源：luma=1，默认门槛下有资格 (x=140, y=380)
    _disk(img, 140, 380, 18, (255, 255, 255))
    # 亮红点源：luma≈0.48，默认 0.7 门槛下没资格，把门槛降到 0.4 才发光
    _disk(img, 340, 380, 18, (255, 90, 70))
    # 暗红点源：luma≈0.12，再怎么降门槛（在合理范围内）也不会亮
    _disk(img, 360, 150, 18, (120, 14, 10))
    return img


def edge_cluster() -> np.ndarray:
    """压角/贴边亮点 + 中央相邻亮点簇。"""
    img = _canvas((8, 8, 10))
    # 四个压角点，圆心在画布外或贴边
    _disk(img, 8, 8, 26, (255, 255, 255))
    _disk(img, 36, 504, 26, (255, 255, 255))
    _disk(img, 504, 40, 26, (255, 255, 255))
    _disk(img, 504, 504, 26, (255, 255, 255))
    # 贴边但不压角的点 (x=256, y=3)
    _disk(img, 256, 3, 20, (255, 240, 220))
    # 中央四个相邻亮点，晕圈会互相合并
    for cx in (216, 268):
        for cy in (220, 272):
            _disk(img, cx, cy, 15, (255, 255, 255))
    # 隔离点作对照
    _disk(img, 400, 400, 12, (255, 255, 255))
    return img


def luma_ramp() -> np.ndarray:
    """亮度斜坡 + 同亮度红条/灰条对照 (各占独立区域，互不覆盖)。"""
    img = _canvas((24, 24, 28))
    # 中央竖向中性灰斜坡 luma 0→1 (沿列方向渐变，宽 170)
    x0, x1 = 171, 341
    grad = np.linspace(0, 255, x1 - x0, dtype=np.uint8)
    ramp = np.tile(grad, (SIZE, 1))
    img[:, x0:x1, 0] = ramp
    img[:, x0:x1, 1] = ramp
    img[:, x0:x1, 2] = ramp
    # 左红条、右灰条取相同 luma(≈0.27)，资格蒙版应一致
    red = (180, 40, 30)
    gray_luma = 0.2126 * red[0] + 0.7152 * red[1] + 0.0722 * red[2]
    g = int(round(gray_luma))
    _rect(img, 120, 392, 40, 120, red)      # 左侧红条
    _rect(img, 120, 392, 392, 472, (g, g, g))  # 右侧同亮度灰条
    # 斜坡中段的白色标记点 (x=256, y=140)
    _disk(img, 256, 140, 14, (255, 255, 255))
    return img


PATTERNS = {
    "样图1: 暗红颜料与点源 (red_paint)": red_paint,
    "样图2: 边缘与相邻亮点 (edge_cluster)": edge_cluster,
    "样图3: 亮度斜坡 (luma_ramp)": luma_ramp,
}
