"""平移对齐工具核心包。

模块划分
--------
synthetic  : 生成带亚像素平移 / 亮度扰动 / 噪声的配对图
estimator  : 相位相关 + ECC 的亚像素平移估计、候选峰与可信度
geometry   : 重叠区域、填充掩码、对齐 warp 与残差统计
regression : 用已知位移做批量回归
"""

from .estimator import EstimateResult, estimate_shift
from .geometry import (
    FILL_VALUE,
    overlap_mask,
    residual_stats,
    shift_to_warp,
    warp_align,
)
from .synthetic import make_pair, make_texture

__all__ = [
    "EstimateResult",
    "estimate_shift",
    "FILL_VALUE",
    "overlap_mask",
    "residual_stats",
    "shift_to_warp",
    "warp_align",
    "make_pair",
    "make_texture",
]

__version__ = "1.0.0"
