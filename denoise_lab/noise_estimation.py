"""从带噪图的手选平坦区估计逐级噪声强度。

严格约束：本模块只接收带噪图，函数签名里不存在 clean，
处理管线（processing.py）也只消费这里产出的 NoiseModel。
估计结果与“对干净参考的评估”（metrics.py）完全分开。

两种模式：
- fixed:     把所有采样框合并，给一个全局 sigma（稳健 MAD 估计）；
- luminance: 在每个采样框内取中位亮度与稳健 sigma，得到 (亮度, sigma) 点列，
             再拟合 sigma(y) = a + b*sqrt(y)（截距=读出噪声，斜率=信号相关项）。
"""
from __future__ import annotations

from dataclasses import dataclass, field

import cv2
import numpy as np

Rect = tuple[int, int, int, int]  # (y0, y1, x0, x1)


@dataclass
class LevelEstimate:
    """一个手选平坦框的估计结果。"""

    rect: Rect
    median_luma: float
    sigma: float
    n_pixels: int


@dataclass
class NoiseModel:
    """供处理管线使用的噪声模型（不含任何干净参考信息）。"""

    mode: str                       # "fixed" | "luminance"
    sigma_fixed: float              # fixed 模式的全局 sigma
    read_sigma: float               # luminance: 截距 a
    signal_k: float                # luminance: sigma(y) = a + b*sqrt(y) 中的 b
    levels: list[LevelEstimate] = field(default_factory=list)
    fit_residual: float = 0.0       # 拟合 RMSE，帮助判断采样质量

    def sigma_at(self, luma: np.ndarray) -> np.ndarray:
        """逐像素 sigma 图（输入 luma 0..1）。"""
        if self.mode == "fixed":
            return np.full(luma.shape, self.sigma_fixed, np.float32)
        return self.read_sigma + self.signal_k * np.sqrt(np.maximum(luma, 0.0))


def _luma(img01: np.ndarray) -> np.ndarray:
    ycrcb = cv2.cvtColor(img01.astype(np.float32), cv2.COLOR_RGB2YCrCb)
    return ycrcb[..., 0]


def _robust_sigma(patch: np.ndarray) -> float:
    """MAD 稳健标准差：对框内残留的轻微纹理不敏感。"""
    flat = patch.reshape(-1).astype(np.float32)
    med = np.median(flat)
    mad = np.median(np.abs(flat - med))
    return float(1.4826 * mad)


def _clip_rect(rect: Rect, h: int, w: int) -> Rect | None:
    y0, y1, x0, x1 = rect
    y0, y1 = max(0, y0), min(h, y1)
    x0, x1 = max(0, x0), min(w, x1)
    if y1 - y0 < 4 or x1 - x0 < 4:
        return None
    return (y0, y1, x0, x1)


def estimate_levels(noisy01: np.ndarray, rects: list[Rect]) -> list[LevelEstimate]:
    """逐个手选平坦框估计 (中位亮度, 稳健 sigma)。"""
    luma = _luma(noisy01)
    h, w = luma.shape
    out: list[LevelEstimate] = []
    for rect in rects:
        clipped = _clip_rect(rect, h, w)
        if clipped is None:
            continue
        y0, y1, x0, x1 = clipped
        patch = luma[y0:y1, x0:x1]
        out.append(
            LevelEstimate(
                rect=clipped,
                median_luma=float(np.median(patch)),
                sigma=_robust_sigma(patch),
                n_pixels=int(patch.size),
            )
        )
    return out


def fit_noise_model(noisy01: np.ndarray, rects: list[Rect], mode: str) -> NoiseModel:
    """根据手选框拟合噪声模型。

    fixed: 合并框内像素做一次稳健估计；
    luminance: 对 (sqrt(median_luma), sigma) 做最小二乘直线拟合，
    采样点不足两个时退化为固定 sigma。
    """
    if mode not in ("fixed", "luminance"):
        raise ValueError(f"unknown mode: {mode}")
    levels = estimate_levels(noisy01, rects)
    if not levels:
        return NoiseModel(mode=mode, sigma_fixed=0.02, read_sigma=0.02, signal_k=0.0)

    if mode == "fixed":
        # 各平坦块亮度不同，不能拼接后做一次 MAD（块间均值差会污染尺度）；
        # 逐块稳健估计后取中位数，才是与亮度无关的噪声 sigma。
        sigma = float(np.median([lv.sigma for lv in levels]))
        return NoiseModel(mode="fixed", sigma_fixed=sigma, read_sigma=sigma,
                          signal_k=0.0, levels=levels)

    # luminance 模式
    if len(levels) < 2:
        s = levels[0].sigma
        return NoiseModel(mode="luminance", sigma_fixed=s, read_sigma=s,
                          signal_k=0.0, levels=levels)

    x = np.sqrt(np.array([lv.median_luma for lv in levels], np.float32))
    y = np.array([lv.sigma for lv in levels], np.float32)
    # 最小二乘 y = a + b*x
    a, b = np.polyfit(x, y, 1)  # 返回 [b, a]
    b, a = float(a), float(b)
    a = max(a, 1e-4)            # 读出噪声保持正
    b = max(b, 0.0)             # 信号相关项不允许负
    pred = a + b * x
    rmse = float(np.sqrt(np.mean((pred - y) ** 2)))
    return NoiseModel(mode="luminance", sigma_fixed=a, read_sigma=a,
                      signal_k=b, levels=levels, fit_residual=rmse)
