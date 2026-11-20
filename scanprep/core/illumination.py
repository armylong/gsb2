"""照明 (背景亮度) 估计与均衡。

思路: 用大尺寸结构元素做形态学闭运算, 把细笔画"填"回纸面, 得到缓慢变化的
背景亮度场; 再用除法把纸面拉到统一亮度。

核尺寸取页面短边的约 8%: 远大于笔画宽度 (细线/文字被视作前景), 但小于大块
黑色图形, 因此大黑块会保留在背景估计里, 相除后依然保持深色, 不会被提亮成背景。
"""

from __future__ import annotations

import cv2
import numpy as np


def estimate_background(gray: np.ndarray, kernel_frac: float = 0.08) -> np.ndarray:
    """估计缓慢变化的背景亮度场 (uint8, 与输入同尺寸)。"""
    h, w = gray.shape
    k = max(15, int(round(min(h, w) * kernel_frac)) | 1)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))
    bg = cv2.morphologyEx(gray, cv2.MORPH_CLOSE, kernel)
    # 再平滑一次, 去掉闭运算留下的块效应, 只保留低频照明
    bg = cv2.GaussianBlur(bg, (0, 0), sigmaX=k / 3.0, sigmaY=k / 3.0)
    return bg


def flatten_illumination(gray: np.ndarray, strength: float = 1.0,
                         background: np.ndarray | None = None,
                         paper_level: float | None = None):
    """照明均衡。

    strength: 0 = 原图, 1 = 完全拉平, 中间值为线性混合 (界面滑杆)。
    返回 (均衡后图像 uint8, 纸面亮度 paper_level)。
    """
    if background is None:
        background = estimate_background(gray)
    if paper_level is None:
        paper_level = float(np.percentile(gray, 90))
    bg = np.maximum(background.astype(np.float32), 1.0)
    flat = gray.astype(np.float32) * (paper_level / bg)
    np.clip(flat, 0, 255, out=flat)
    s = float(np.clip(strength, 0.0, 1.0))
    out = (1.0 - s) * gray.astype(np.float32) + s * flat
    return out.astype(np.uint8), paper_level
