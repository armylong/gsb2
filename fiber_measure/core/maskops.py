"""灰度图/二值掩膜 → 分析用掩膜。绝不修改原图,只产出新数组。"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass, field

import cv2
import numpy as np


@dataclass
class MaskParams:
    threshold: int = 128          # 灰度阈值(仅灰度模式生效)
    dark_object: bool = True      # True: 纤维比背景暗(取 < 阈值); False: 取 >= 阈值
    min_size: int = 8             # 去除面积小于该值的孤立连通块(0 = 不去除)
    roi: tuple | None = None      # (x, y, w, h),None = 全图
    binary_input: bool = False    # 输入本身已是二值掩膜(阈值不再生效)

    def signature(self, image_id: str = "") -> str:
        """参数签名:判断之前的标记是否还适用于当前分析参数。"""
        s = f"{image_id}|{self.threshold}|{self.dark_object}|{self.min_size}|{self.roi}|{self.binary_input}"
        return hashlib.md5(s.encode()).hexdigest()[:10]


def is_binary_image(gray: np.ndarray) -> bool:
    """只含 <=2 个灰度值则视为已有掩膜。"""
    return len(np.unique(gray)) <= 2


def make_mask(gray: np.ndarray, p: MaskParams) -> np.ndarray:
    """返回 0/1 uint8 掩膜,尺寸与输入相同。不改动 gray。"""
    if p.binary_input:
        # 二值输入:dark_object 决定前景是暗值还是亮值
        m = (gray == gray.min()) if p.dark_object else (gray == gray.max())
    elif p.dark_object:
        m = gray < p.threshold
    else:
        m = gray >= p.threshold
    mask = m.astype(np.uint8)

    if p.roi is not None:
        x, y, w, h = [int(v) for v in p.roi]
        clipped = np.zeros_like(mask)
        x0, y0 = max(x, 0), max(y, 0)
        x1, y1 = min(x + w, mask.shape[1]), min(y + h, mask.shape[0])
        if x1 > x0 and y1 > y0:
            clipped[y0:y1, x0:x1] = mask[y0:y1, x0:x1]
        mask = clipped

    if p.min_size > 0 and mask.any():
        n, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
        keep = np.zeros_like(mask)
        for i in range(1, n):
            if stats[i, cv2.CC_STAT_AREA] >= p.min_size:
                keep[labels == i] = 1
        mask = keep
    return mask
