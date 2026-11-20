"""生成带已知损伤的合成纹理图.

样例刻意包含:
  * 中部一条竖直明暗边缘(亮度阶跃)
  * 一条深色细线斜跨明暗边缘  -> 用于检验修补后结构能否接上
  * 叠加正弦织物纹理与高斯噪声, 模拟老照片质感
损伤:
  * 多条随机游走的浅色细划痕(其中一条正好压过细线与明暗边缘的交叉区)
  * 两个小块状污渍
返回干净图 / 损伤图 / 损伤遮罩 / 细线遮罩, 便于定量比较.
"""

from __future__ import annotations

import numpy as np


def _random_walk_scratch(shape, rng, start, steps, width, value):
    """在图上画一条随机游走的细划痕, 返回遮罩."""
    h, w = shape
    mask = np.zeros((h, w), np.uint8)
    y, x = start
    angle = rng.uniform(0, 2 * np.pi)
    yy, xx = np.mgrid[0:h, 0:w]
    pts = []
    for _ in range(steps):
        angle += rng.normal(0, 0.25)
        y += np.sin(angle)
        x += np.cos(angle)
        if 0 <= y < h and 0 <= x < w:
            pts.append((y, x))
    if not pts:
        return mask
    for (py, px) in pts:
        d2 = (yy - py) ** 2 + (xx - px) ** 2
        mask[d2 <= (width / 2.0) ** 2] = 255
    return mask


def generate_sample(seed: int = 7, size: int = 480):
    """返回 dict(clean, damaged, mask, line_mask), 均为 uint8, 图像是 3 通道 RGB."""
    rng = np.random.default_rng(seed)
    h = w = size
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)

    # 背景: 平滑渐变 + 中部竖直明暗边缘(右侧亮 / 左侧暗)
    base = 120 + 30 * np.sin(xx / w * np.pi) + 20 * np.cos(yy / h * np.pi)
    edge_x = w // 2
    base += np.where(xx >= edge_x, 38.0, -18.0)

    # 织物纹理: 两组正弦叠加
    tex = 9 * np.sin(xx / 5.0) * np.sin(yy / 7.0) + 5 * np.sin((xx + yy) / 3.5)
    img = base + tex

    # 深色细线: 斜跨明暗边缘 (从左上到右下, 宽度约 2px)
    # 线方程: y = 0.55*x + 40
    line_dist = np.abs(yy - (0.55 * xx + 40)) / np.sqrt(1 + 0.55**2)
    line_mask = (line_dist <= 1.2).astype(np.uint8) * 255
    img = np.where(line_mask > 0, img * 0.35, img)

    clean = np.clip(img + rng.normal(0, 2.5, img.shape), 0, 255).astype(np.uint8)
    clean_rgb = np.stack([clean] * 3, axis=-1)

    # ---- 损伤 ----
    damaged = clean_rgb.copy()
    mask = np.zeros((h, w), np.uint8)

    # 划痕 1: 故意穿过细线与明暗边缘交叉处 (交叉点约在 x=edge_x, y=0.55*edge_x+40)
    cross_y = 0.55 * edge_x + 40
    s1 = _random_walk_scratch(
        (h, w), rng, start=(cross_y - 60, edge_x - 70), steps=180, width=3.0, value=255
    )
    # 划痕 2,3: 随机位置
    s2 = _random_walk_scratch((h, w), rng, start=(h * 0.2, w * 0.7), steps=140, width=2.0, value=255)
    s3 = _random_walk_scratch((h, w), rng, start=(h * 0.8, w * 0.25), steps=160, width=4.0, value=255)
    for s in (s1, s2, s3):
        mask = np.maximum(mask, s)

    # 块状污渍两个
    for (cy, cx, r) in [(int(h * 0.3), int(w * 0.35), 14), (int(h * 0.72), int(w * 0.62), 10)]:
        blob = ((yy - cy) ** 2 + (xx - cx) ** 2 <= r**2).astype(np.uint8) * 255
        mask = np.maximum(mask, blob)

    # 损伤区域填上老化的浅灰白色(带一点噪声), 模拟相纸划痕反光
    noise = rng.normal(0, 6, (h, w, 1))
    scratch_color = np.clip(225 + noise, 0, 255)
    damaged = np.where(mask[..., None] > 0, scratch_color, damaged).astype(np.uint8)

    return {
        "clean": clean_rgb,
        "damaged": damaged,
        "mask": mask,
        "line_mask": line_mask,
    }
