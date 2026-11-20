"""处理流水线: 照明均衡 -> 整页旋转 -> (可选) 二值化。

每一步都从原始灰度图重新计算, 切换参数不会在上一次结果上累积误差。
"""

from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

from .geometry import rotate_image
from .illumination import flatten_illumination

MODE_GRAY = "gray"
MODE_BINARY = "binary"


@dataclass
class PipelineParams:
    angle: float = 0.0              # 校正角 (度)
    deskew: bool = True             # 是否启用倾斜校正
    illumination: bool = True       # 是否启用照明均衡
    illum_strength: float = 1.0     # 0..1
    mode: str = MODE_GRAY           # 'gray' | 'binary'
    bin_block: int = 35             # 自适应二值化邻域 (奇数)
    bin_c: int = 10                 # 自适应二值化常数


@dataclass
class PipelineResult:
    image: np.ndarray               # 输出图 (灰度或二值)
    mask: np.ndarray                # 有效区域掩膜 uint8{0,255}, 0 = 旋转填充区
    matrix: np.ndarray              # 源图 -> 输出图 的 2x3 仿射矩阵
    fill_value: int                 # 旋转新增区域的填充灰度 (纸白)
    paper_level: float              # 估计的纸面亮度


def process(gray: np.ndarray, params: PipelineParams) -> PipelineResult:
    """对单页灰度图执行完整流水线。gray 不会被修改。"""
    if params.illumination:
        src, paper = flatten_illumination(gray, params.illum_strength)
    else:
        paper = float(np.percentile(gray, 90))
        src = gray.copy()
    fill = int(round(paper))

    h, w = src.shape
    if params.deskew and abs(params.angle) > 1e-9:
        img, mask, M = rotate_image(src, params.angle, fill)
    else:
        img = src
        mask = np.full((h, w), 255, np.uint8)
        M = np.array([[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]])

    if params.mode == MODE_BINARY:
        block = max(3, int(params.bin_block) | 1)
        out = cv2.adaptiveThreshold(img, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                    cv2.THRESH_BINARY, block, float(params.bin_c))
        out[mask == 0] = 255        # 填充区在二值输出中保持纯白
        img = out

    return PipelineResult(img, mask, M, fill, paper)
