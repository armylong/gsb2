"""内置样例：一张带已知偏色、局部反光和轻微噪声的合成图。

生成过程完全确定（固定随机种子），并且“真实偏色”由一个已知的
3x3 线性光矩阵施加，便于 tests/check_calibration.py 做定量核对：
校准后留出格子的 Lab 色差应当显著下降、并接近目标值。

布局：4 列 x 3 行共 12 个色格，第二行第三格叠加了一块柔和反光。
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .reference import ReferencePatch
from .sampling import ROIRect
from .srgb import linear_to_srgb, srgb_to_linear

PATCH = 96          # 单个色格边长（像素）
GAP = 24            # 色格间距
MARGIN = 40         # 四周边距
COLS, ROWS = 4, 3
IMAGE_W = MARGIN * 2 + COLS * PATCH + (COLS - 1) * GAP   # 536
IMAGE_H = MARGIN * 2 + ROWS * PATCH + (ROWS - 1) * GAP   # 416
ROI_INSET = 14      # 内置取样框相对色格边缘的内缩

# 12 个目标色（sRGB 8bit）：含中性灰、三原色、二次色与肤色等
_TARGET_SRGB: list[tuple[int, int, int]] = [
    (243, 243, 242),  # A1 亮灰
    (200, 201, 201),  # A2 中灰
    (122, 123, 122),  # A3 暗灰
    (52, 52, 52),     # A4 近黑
    (186, 61, 55),    # B1 红
    (224, 122, 47),   # B2 橙
    (228, 205, 64),   # B3 黄
    (82, 163, 92),    # B4 绿
    (47, 96, 172),    # C1 蓝
    (99, 71, 151),    # C2 紫
    (224, 132, 166),  # C3 粉
    (91, 174, 189),   # C4 青
]

# 已知的“拍摄偏色”矩阵（线性光空间）：暖灯效果 + 轻微通道串扰
_CAST_MATRIX = np.array(
    [
        [1.16, 0.03, 0.00],
        [0.02, 1.00, 0.01],
        [-0.04, -0.02, 0.84],
    ],
    dtype=np.float64,
)
# 反光覆盖的色格（0 基索引）：第二行第三格 -> B3
GLARE_PATCH_INDEX = 6
_NOISE_SIGMA = 1.6  # sRGB 8bit 量纲的高斯噪声标准差


@dataclass
class SampleImage:
    image: np.ndarray            # uint8 HxWx3
    references: list[ReferencePatch]
    rois: list[ROIRect]
    cast_matrix: np.ndarray      # 施加的已知偏色矩阵（供测试核对）
    glare_patch_id: str


def _patch_origin(col: int, row: int) -> tuple[int, int]:
    x0 = MARGIN + col * (PATCH + GAP)
    y0 = MARGIN + row * (PATCH + GAP)
    return x0, y0


def build_sample_image() -> SampleImage:
    """生成内置样例图、参考色与取样框。"""
    rng = np.random.default_rng(20261127)
    image = np.full((IMAGE_H, IMAGE_W, 3), 235.0, dtype=np.float64)  # 浅灰背景

    targets = np.asarray(_TARGET_SRGB, dtype=np.float64)
    target_lin = srgb_to_linear(targets)
    cast_lin = target_lin @ _CAST_MATRIX.T
    cast_srgb = linear_to_srgb(cast_lin)

    references: list[ReferencePatch] = []
    rois: list[ROIRect] = []
    glare_id = ""

    for index, target in enumerate(targets):
        col, row = index % COLS, index // COLS
        x0, y0 = _patch_origin(col, row)
        x1, y1 = x0 + PATCH, y0 + PATCH
        patch_id = f"{chr(65 + row)}{col + 1}"

        fill = np.tile(cast_srgb[index], (PATCH, PATCH, 1))
        fill += rng.normal(0.0, _NOISE_SIGMA, size=(PATCH, PATCH, 3))

        if index == GLARE_PATCH_INDEX:
            glare_id = patch_id
            # 柔和高斯光斑，中心推到接近饱和，模拟局部反光
            yy, xx = np.mgrid[0:PATCH, 0:PATCH]
            cx, cy = PATCH * 0.62, PATCH * 0.38
            blob = np.exp(-(((xx - cx) ** 2 + (yy - cy) ** 2) / (2.0 * 18.0 ** 2)))
            fill = fill + blob[..., None] * 72.0

        image[y0:y1, x0:x1, :] = fill

        # 细深色描边，模拟色卡格子的边框
        image[y0:y1, x0:x0 + 2, :] *= 0.55
        image[y0:y1, x1 - 2:x1, :] *= 0.55
        image[y0:y0 + 2, x0:x1, :] *= 0.55
        image[y1 - 2:y1, x0:x1, :] *= 0.55

        references.append(ReferencePatch(id=patch_id, rgb=tuple(float(v) for v in target)))
        rois.append(
            ROIRect(
                patch_id=patch_id,
                x0=x0 + ROI_INSET,
                y0=y0 + ROI_INSET,
                x1=x1 - ROI_INSET,
                y1=y1 - ROI_INSET,
                role="fit",
            )
        )

    image = np.clip(image, 0.0, 255.0).astype(np.uint8)
    return SampleImage(
        image=image,
        references=references,
        rois=rois,
        cast_matrix=_CAST_MATRIX.copy(),
        glare_patch_id=glare_id,
    )
