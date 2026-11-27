"""双面透印修复工具 (descan)。

模块划分:
- alignment: 点对驱动的小范围对齐(镜像 + 相似/仿射/单应), 输出 warp 与覆盖掩膜
- bleed: 按对齐后的背面逐像素估计透印, 留白区标定, 保护掩膜与局部强度
- synth: 生成略错位的合成双页黑白图与无透印底稿, 供校对与测试
- gui: PySide6 四视图交互窗口
"""

from .alignment import (
    Alignment,
    fit_transform,
    warp_back,
    coverage_mask,
    map_point,
    residuals,
)
from .bleed import (
    LocalPatch,
    ProcessParams,
    ProcessResult,
    calibrate_strength,
    process_front,
)

__all__ = [
    "Alignment",
    "fit_transform",
    "warp_back",
    "coverage_mask",
    "map_point",
    "residuals",
    "LocalPatch",
    "ProcessParams",
    "ProcessResult",
    "calibrate_strength",
    "process_front",
]
