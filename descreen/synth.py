"""两张测试图生成：已知斜网纹 + 真实平行细线，用来判断误伤。"""

from __future__ import annotations

import numpy as np


def make_halftone_test(size: int = 512, period: float = 8.0,
                       angle_deg: float = 45.0, seed: int = 7) -> np.ndarray:
    """合成一张带已知斜网纹（AM 网点）的图。

    网点由两个斜向余弦叠加 + 阈值调制产生，频谱上会在
    ±(u,v) 方向出现清晰、成对的周期峰，参数全部已知，
    可用来核对界面上标注的方向和间距。
    """
    rng = np.random.default_rng(seed)
    y, x = np.mgrid[0:size, 0:size].astype(np.float64)

    base = (0.72
            + 0.10 * np.sin(2 * np.pi * x / 130.0)          # 缓慢的大块明暗
            + 0.08 * np.cos(2 * np.pi * y / 95.0))

    ang = np.radians(angle_deg)
    # 旋转后的两个网点轴
    c, s = np.cos(ang), np.sin(ang)
    x1 = c * x + s * y
    y1 = -s * x + c * y
    screen = (np.cos(2 * np.pi * x1 / period)
              + np.cos(2 * np.pi * y1 / period))

    # 网点强度随底图变化（模拟 AM 调幅），并加一点扫描噪声
    tone = 0.5 + 0.5 * screen
    halftone = base - 0.35 * tone * (0.6 + 0.4 * base)
    halftone += rng.normal(0, 0.012, size=halftone.shape)
    halftone = np.clip(halftone, 0, 1)

    return np.round(halftone * 255).astype(np.uint8)


def make_parallel_lines_test(size: int = 512, spacing: float = 5.0,
                             angle_deg: float = 20.0,
                             seed: int = 11) -> np.ndarray:
    """合成一张含真实平行细线的图（模拟衣料纹理、栅栏等）。

    这些细线是图像内容而不是网纹：如果陷波选得太宽把它们的
    基频/谐波也压掉，线条会发虚。配合差图即可判断误伤。
    """
    rng = np.random.default_rng(seed)
    y, x = np.mgrid[0:size, 0:size].astype(np.float64)

    base = 0.82 + 0.06 * np.cos(2 * np.pi * (x + y) / 200.0)

    ang = np.radians(angle_deg)
    # 沿垂直于角度方向做周期细线，宽度约为间距的 30%
    t = x * np.cos(ang) + y * np.sin(ang)
    phase = (t / spacing) % 1.0
    line = np.where(phase < 0.3, 0.28, 0.0)

    # 让部分区域线条更密，模拟真实纹理的局部变化
    dense = np.where(((x / spacing) % 1.0) < 0.12, 0.12, 0.0)
    dense *= (np.sin(2 * np.pi * y / 180.0) > 0).astype(float)

    img = base - line - dense
    img += rng.normal(0, 0.01, size=img.shape)
    img = np.clip(img, 0, 1)
    return np.round(img * 255).astype(np.uint8)
