"""清晰度度量与权重融合。

思路(不依赖相机标定/景深重建):
- 清晰度: 局部拉普拉斯能量, 窗口内只统计有效像素(图外区域不参与)。
- 权重: 各来源清晰度归一化后取高次幂(赢者占优), 再做空间高斯平滑,
  平滑半径即"边缘过渡"参数; 低纹理区域自动加大平滑, 避免来源密集跳变。
- 来源编号图 = 最终权重的 argmax(主要贡献图), 过渡区图像可混合。
"""
from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

_EPS = 1e-6


@dataclass
class FusionParams:
    window: int = 15       # 清晰度判断窗口(奇数, 像素)
    smooth: float = 14.0   # 边缘过渡(权重空间平滑半径, 像素)
    lowtex: bool = True    # 低纹理防抖(低纹理区加大平滑, 抑制跳源)


def _odd(k: int) -> int:
    k = max(1, int(k))
    return k if k % 2 == 1 else k + 1


def local_std(gray: np.ndarray, k: int) -> np.ndarray:
    k = _odd(k)
    m1 = cv2.boxFilter(gray, cv2.CV_32F, (k, k))
    m2 = cv2.boxFilter(gray * gray, cv2.CV_32F, (k, k))
    return np.sqrt(np.maximum(m2 - m1 * m1, 0.0))


def focus_score(gray: np.ndarray, valid: np.ndarray, window: int) -> np.ndarray:
    """局部拉普拉斯能量。gray: float32; valid: bool。无效像素不参与统计。"""
    lap = cv2.Laplacian(gray, cv2.CV_32F, ksize=3)
    energy = lap * lap
    v = valid.astype(np.float32)
    k = _odd(window)
    num = cv2.boxFilter(energy * v, cv2.CV_32F, (k, k), normalize=False)
    den = cv2.boxFilter(v, cv2.CV_32F, (k, k), normalize=False)
    score = num / np.maximum(den, _EPS)
    score[den < 0.5] = 0.0  # 窗口内几乎没有有效像素
    return score.astype(np.float32)


def compute_weights(
    scores: list[np.ndarray],
    valids: list[np.ndarray],
    smooth: float,
    ref_gray: np.ndarray | None = None,
    lowtex: bool = True,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """由清晰度计算融合权重。

    返回 (weights, label, conf):
    - weights: (N, H, W) float32, 每像素在有效来源上归一化
    - label:   (H, W) uint8, 主要来源编号, 255 = 无有效来源
    - conf:    (H, W) float32, 置信度 = (w1 - w2) / (w1 + w2)
    """
    s = np.stack(scores).astype(np.float32)
    v = np.stack(valids).astype(np.float32)
    s = s * v

    m = s.max(axis=0, keepdims=True)
    w = ((s + _EPS) / (m + _EPS)) ** 8  # 赢者占优, 避免简单平均
    w = w * v

    if smooth > 0:
        k = _odd(int(round(smooth)) * 2 + 1)
        ws = np.stack([cv2.GaussianBlur(w[i], (k, k), 0) for i in range(len(w))])
        if lowtex and ref_gray is not None:
            # 低纹理区: 清晰度信号弱, 权重加倍平滑, 避免来源逐像素跳动
            tex = local_std(ref_gray, 31)
            alpha = np.clip((8.0 - tex) / 8.0, 0.0, 1.0).astype(np.float32)
            alpha = cv2.GaussianBlur(alpha, (31, 31), 0)[None, ...]
            k2 = _odd(k * 2 + 1)
            wb = np.stack([cv2.GaussianBlur(w[i], (k2, k2), 0) for i in range(len(w))])
            ws = ws * (1.0 - alpha) + wb * alpha
        w = ws

    total = w.sum(axis=0, keepdims=True)
    any_valid = total[0] > 1e-9
    w = w / np.maximum(total, 1e-9)
    w = w * any_valid[None, ...]

    label = w.argmax(axis=0).astype(np.uint8)
    label[~any_valid] = 255

    part = np.partition(w, max(0, len(w) - 2), axis=0)
    w1 = part[-1]
    w2 = part[-2] if len(w) > 1 else np.zeros_like(w1)
    conf = ((w1 - w2) / np.maximum(w1 + w2, _EPS)).astype(np.float32)
    conf[~any_valid] = 0.0

    if smooth >= 8:
        # 众数滤波去散点: 低纹理区的孤立跳源被多数票吸收
        filtered = cv2.medianBlur(label, 5)
        label = np.where(any_valid, filtered, 255).astype(np.uint8)

    return w, label, conf
