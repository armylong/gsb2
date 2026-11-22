"""程序生成已知模糊程度的斜边样例, 用于验证读数与可信度提示。

模糊模型: 理想阶跃与高斯核卷积, ESF = 0.5*(1+erf(d/(sqrt2*sigma)))。
理论 MTF: H(f) = exp(-2*pi^2*sigma^2*f^2),
理论 MTF50(周期/像素) = sqrt(ln2/2)/(pi*sigma)。
"""

from __future__ import annotations

import math

import numpy as np
from scipy.special import erf

from .analysis import BIN_WIDTH  # noqa: F401  (保持单位约定一致)


def gaussian_mtf50(sigma_px: float) -> float:
    """已知高斯模糊 sigma(像素)对应的理论 MTF50(周期/像素)。"""
    return math.sqrt(math.log(2.0) / 2.0) / (math.pi * sigma_px)


def _distance_field(height: int, width: int, angle_deg: float,
                    offset_px: float = 0.0) -> np.ndarray:
    """每个像素中心到斜直边的有符号距离(像素), 边过 ROI 中心 + offset。"""
    theta = math.radians(angle_deg)            # 边与竖直轴的夹角
    nx, ny = math.cos(theta), -math.sin(theta)  # 法向(黑->白)
    cy, cx = (height - 1) / 2.0, (width - 1) / 2.0
    ys, xs = np.mgrid[0:height, 0:width]
    return nx * (xs - cx) + ny * (ys - cy) - offset_px


def slanted_edge(height: int = 180, width: int = 220, angle_deg: float = 10.0,
                 sigma_px: float = 1.5, contrast: float = 0.8,
                 mid_level: float = 0.5, noise_sigma: float = 0.0,
                 ringing: float = 0.0, ring_sigma: float | None = None,
                 offset_px: float = 0.0,
                 supersample: int = 3, seed: int = 0) -> np.ndarray:
    """生成一张带已知高斯模糊的斜边图(灰度 float64, 0..1)。

    ringing>0 时改用"双高斯差" LSF 模拟过锐:
      LSF = (G(sigma) - a*G(ring_sigma)) / (1-a), a=ringing,
    产生负瓣与 ESF 过冲。supersample 做子像素面积积分, 模拟传感器像元。
    offset_px 让边沿法向平移。
    """
    rng = np.random.default_rng(seed)
    ss = max(1, int(supersample))
    theta = math.radians(angle_deg)
    nx, ny = math.cos(theta), -math.sin(theta)
    cx, cy = (width - 1) / 2.0, (height - 1) / 2.0
    if ss == 1:
        d = _distance_field(height, width, angle_deg, offset_px)
    else:
        # 在每个像元内 ss×ss 子采样后平均
        d = np.zeros((height, width))
        for iy in range(ss):
            for ix in range(ss):
                ys, xs = np.mgrid[0:height, 0:width]
                px = xs + 0.5 + (ix - (ss - 1) / 2.0) / ss
                py = ys + 0.5 + (iy - (ss - 1) / 2.0) / ss
                d += nx * (px - cx) + ny * (py - cy)
        d = d / (ss * ss) - offset_px

    def erf_edge(sigma: float) -> np.ndarray:
        return 0.5 * (1.0 + erf(d / (math.sqrt(2.0) * sigma)))

    if ringing <= 0.0:
        esf = erf_edge(sigma_px)
    else:
        # 模拟相机过锐: 对已模糊边缘做 unsharp mask,
        # LSF = (1+k)*G(sigma) - k*G(s), 带负瓣; ESF 出现过冲与振铃。
        k = float(np.clip(ringing, 0.0, 2.5))
        # 锐化核比模糊核宽 -> 负瓣较宽(真实相机振铃形态), 不会被
        # ESF 平滑完全抹掉; 归一化保持 DC 增益为 1。
        s = ring_sigma if ring_sigma is not None else max(0.8, 1.6 * sigma_px)
        esf = (1.0 + k) * erf_edge(sigma_px) - k * erf_edge(s)

    img = mid_level + contrast * (esf - 0.5)
    if noise_sigma > 0:
        img = img + rng.normal(0.0, noise_sigma, img.shape)
    return np.clip(img, 0.0, 1.0)


def double_edges(height: int = 180, width: int = 220, angle_deg: float = 12.0,
                 separation_px: float = 5.0, sigma_px: float = 1.2,
                 noise_sigma: float = 0.005) -> np.ndarray:
    """两条平行直边(同极性), 用于验证"轮廓混叠"可信度提示。"""
    rng = np.random.default_rng(42)
    d = _distance_field(height, width, angle_deg)
    e1 = 0.5 * (1.0 + erf((d + separation_px / 2) /
                          (math.sqrt(2.0) * sigma_px)))
    e2 = 0.5 * (1.0 + erf((d - separation_px / 2) /
                          (math.sqrt(2.0) * sigma_px)))
    img = 0.15 + 0.55 * (e1 + e2) / 2.0
    if noise_sigma:
        img += rng.normal(0, noise_sigma, img.shape)
    return np.clip(img, 0.0, 1.0)


def edge_near_border(height: int = 160, width: int = 200,
                     angle_deg: float = 8.0, sigma_px: float = 1.2
                     ) -> tuple[np.ndarray, tuple[int, int, int, int]]:
    """边缘落在靠近 ROI 一侧的样例, 返回(图, 建议ROI)。

    边本身在图中央, 但 ROI 右缘只越过边几个像素, 白侧平台几乎缺失。
    """
    img = slanted_edge(height, width, angle_deg, sigma_px,
                       noise_sigma=0.004)
    cx = (width - 1) / 2.0
    # ROI 右边界 = 边中心 + 约 4px, 左边界给足黑侧平台
    x0 = int(cx - width * 0.30)
    x1 = int(cx + 4)
    roi = (x0, 20, x1 - x0, height - 40)
    return img, roi


# 验证套件使用的标准工况
STEEP_ANGLE = 10.0     # 较陡的边(与竖直轴夹角小)
SHALLOW_ANGLE = 35.0   # 较平的边
BLUR_SIGMAS = (0.7, 1.2, 2.0, 3.2)
