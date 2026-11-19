"""自生成测试纹理:渐变叠加颗粒、跨边界斜线、四角不一致。

全部使用固定种子的 numpy 随机数,不依赖外部图片或在线服务;
同一种子生成的纹理完全一致,可复现。
"""
from __future__ import annotations

import cv2
import numpy as np


def gradient_grain(w: int = 256, h: int = 256, seed: int = 42) -> np.ndarray:
    """对角渐变底色 + 大尺度色块 + 细颗粒噪声。边缘不对齐,平铺必有缝。"""
    rng = np.random.default_rng(seed)
    xx, yy = np.meshgrid(np.linspace(0, 1, w), np.linspace(0, 1, h))
    base = np.stack([
        60 + 140 * xx,
        60 + 140 * yy,
        60 + 140 * (0.5 * xx + 0.5 * yy),
    ], axis=-1)
    # 大尺度随机色块(低分辨率噪声放大)
    coarse = rng.normal(0, 1, (max(h // 16, 2), max(w // 16, 2), 3))
    coarse = cv2.resize(coarse, (w, h), interpolation=cv2.INTER_CUBIC) * 35
    # 细颗粒
    grain = rng.normal(0, 14, (h, w, 1))
    img = base + coarse + grain
    return np.rint(img).clip(0, 255).astype(np.uint8)


def diagonal_lines(w: int = 256, h: int = 256, seed: int = 7) -> np.ndarray:
    """跨边界斜线:条纹周期不整除宽高,边界处必然错位。"""
    rng = np.random.default_rng(seed)
    xx, yy = np.meshgrid(np.arange(w, dtype=np.float64),
                         np.arange(h, dtype=np.float64))
    # 周期取非整除值,保证斜线跨过边界时断开
    period = 23.0
    phase = (xx + yy) * 2.0 * np.pi / period
    stripes = (np.sin(phase) > 0).astype(np.float64)
    img = np.stack([
        40 + 180 * stripes,
        90 + 120 * stripes,
        200 - 150 * stripes,
    ], axis=-1)
    img += rng.normal(0, 6, (h, w, 1))
    return np.rint(img).clip(0, 255).astype(np.uint8)


def corner_mismatch(w: int = 256, h: int = 256, seed: int = 99) -> np.ndarray:
    """四角颜色/纹理不一致:检验双向同时开启时角点交汇的连续性。"""
    rng = np.random.default_rng(seed)
    corners = np.array([
        [220, 60, 60],    # 左上 红
        [60, 200, 80],    # 右上 绿
        [70, 90, 220],    # 左下 蓝
        [230, 210, 60],   # 右下 黄
    ], dtype=np.float64)
    xx, yy = np.meshgrid(np.linspace(0, 1, w), np.linspace(0, 1, h))
    img = np.zeros((h, w, 3), dtype=np.float64)
    weights = [
        (1 - xx) * (1 - yy),  # 左上
        xx * (1 - yy),        # 右上
        (1 - xx) * yy,        # 左下
        xx * yy,              # 右下
    ]
    for c, wgt in zip(corners, weights):
        img += wgt[..., None] * c[None, None, :]
    # 叠加各自的局部纹理,让角区不只是平滑渐变
    tex = rng.normal(0, 1, (h // 4, w // 4))
    tex = cv2.resize(tex, (w, h), interpolation=cv2.INTER_CUBIC)[..., None] * 22
    img += tex
    img += rng.normal(0, 5, (h, w, 1))
    return np.rint(img).clip(0, 255).astype(np.uint8)


GENERATORS = {
    "gradient_grain": ("渐变+颗粒", gradient_grain),
    "diagonal_lines": ("跨边界斜线", diagonal_lines),
    "corner_mismatch": ("四角不一致", corner_mismatch),
}
