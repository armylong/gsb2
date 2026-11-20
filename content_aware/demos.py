"""自生成演示素材：背景纹理 + 可辨认主体 + 独立核对标记。

不依赖任何外部素材、模型或网络。所有随机数固定种子，重复生成完全一致。
"""

from __future__ import annotations

import cv2
import numpy as np

from .engine import RNG_SEED

# 独立标记块的颜色（BGR），放在深色条带上，肉眼与程序都容易辨认。
MARKER_COLORS = [
    (0, 0, 230),      # 红
    (0, 230, 230),    # 黄
    (230, 0, 0),      # 蓝
    (230, 0, 230),    # 品红
    (0, 180, 0),      # 绿
    (230, 230, 230),  # 白
]


def make_demo_scene(width: int = 800, height: int = 500):
    """生成一张横向演示图：低能量纹理背景 + 高反差主体 + 独立标记。

    返回 ``(image_bgr, markers)``，markers 为
    ``[(x, y, size, bgr), ...]``，记录每个独立标记块的位置与颜色，
    供测试与人工核对像素对应关系。
    """
    rng = np.random.default_rng(RNG_SEED)
    h, w = height, width

    # ---- 背景：竖向渐变 + 低频正弦纹理 + 轻噪声（能量低，适合被删缝） ----
    yy = np.linspace(0, 1, h, dtype=np.float64)[:, None]
    xx = np.linspace(0, 1, w, dtype=np.float64)[None, :]
    base = np.dstack(
        [
            205 - 40 * yy + 10 * np.sin(xx * 7.0),
            190 - 25 * yy + 10 * np.sin(xx * 5.3 + 1.2),
            170 - 10 * yy + 10 * np.sin(xx * 6.1 + 2.4),
        ]
    )
    noise = rng.normal(0, 3.0, (h, w, 1))
    image = np.clip(base + noise, 0, 255).astype(np.uint8)

    # ---- 地面：一条柔和分界的色带 ----
    ground_top = int(h * 0.72)
    image[ground_top:] = np.clip(
        image[ground_top:].astype(np.int16) + np.array([18, 10, -12]), 0, 255
    ).astype(np.uint8)
    cv2.line(image, (0, ground_top), (w, ground_top), (90, 110, 70), 2)

    # ---- 太阳：圆形主体 ----
    cv2.circle(image, (int(w * 0.82), int(h * 0.18)), 34, (60, 200, 240), -1)
    cv2.circle(image, (int(w * 0.82), int(h * 0.18)), 34, (20, 140, 200), 2)

    # ---- 房子：高反差矩形 + 三角屋顶，主体轮廓清晰 ----
    hx, hy, hw, hh = int(w * 0.18), int(h * 0.40), int(w * 0.20), int(h * 0.28)
    cv2.rectangle(image, (hx, hy), (hx + hw, hy + hh), (160, 130, 90), -1)
    cv2.rectangle(image, (hx, hy), (hx + hw, hy + hh), (60, 50, 40), 2)
    roof = np.array(
        [[(hx - 14, hy), (hx + hw // 2, hy - 56), (hx + hw + 14, hy)]],
        dtype=np.int32,
    )
    cv2.fillPoly(image, roof, (60, 60, 180))
    cv2.polylines(image, roof, True, (30, 30, 110), 2)
    # 门与窗
    cv2.rectangle(
        image,
        (hx + hw // 2 - 16, hy + hh - 66),
        (hx + hw // 2 + 16, hy + hh),
        (50, 80, 130),
        -1,
    )
    for wx in (hx + 18, hx + hw - 52):
        cv2.rectangle(image, (wx, hy + 20), (wx + 34, hy + 54), (200, 210, 230), -1)
        cv2.rectangle(image, (wx, hy + 20), (wx + 34, hy + 54), (40, 50, 70), 2)

    # ---- 树：树干 + 树冠 ----
    tx, ty = int(w * 0.55), int(h * 0.56)
    cv2.rectangle(image, (tx - 9, ty), (tx + 9, ground_top), (50, 90, 120), -1)
    cv2.circle(image, (tx, ty - 46), 46, (60, 140, 50), -1)
    cv2.circle(image, (tx - 34, ty - 20), 30, (70, 155, 55), -1)
    cv2.circle(image, (tx + 34, ty - 20), 30, (70, 155, 55), -1)
    cv2.circle(image, (tx, ty - 46), 46, (30, 90, 30), 2)

    # ---- 底部深色条带 + 6 个独立颜色标记，用于逐像素核对 ----
    band_y0 = h - 38
    image[band_y0:] = (32, 32, 40)
    markers = []
    step = (w - 120) // (len(MARKER_COLORS) - 1)
    size = 24
    for i, color in enumerate(MARKER_COLORS):
        x = 60 + i * step
        y = band_y0 + 7
        cv2.rectangle(image, (x, y), (x + size, y + size), color, -1)
        cv2.rectangle(image, (x, y), (x + size, y + size), (10, 10, 10), 1)
        markers.append((x, y, size, tuple(int(v) for v in color)))

    return image, markers


def make_blocked_mask(height: int, width: int) -> np.ndarray:
    """全宽横向保护带：任何竖向接缝都必然穿过，第一次查找即不可行。

    用于演示“保护约束阻断所有路径”，处理应停在原图宽度、删除 0 条接缝。
    """
    mask = np.zeros((height, width), dtype=bool)
    y0, y1 = int(height * 0.45), int(height * 0.55)
    mask[y0:y1, :] = True
    return mask


def make_partial_band_mask(height: int, width: int) -> np.ndarray:
    """中部横向保护带（只覆盖中间 60% 列），演示删除若干缝后才被阻断。

    每行被保护像素数固定，可删除数量有明确上限，便于测试“停在最后
    有效尺寸”而不是一开始就不可行。
    """
    mask = np.zeros((height, width), dtype=bool)
    y0, y1 = int(height * 0.45), int(height * 0.55)
    x0, x1 = int(width * 0.20), int(width * 0.80)
    mask[y0:y1, x0:x1] = True
    return mask
