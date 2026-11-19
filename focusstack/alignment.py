"""对齐模型: 每张输入图相对参考图的 平移(dx, dy) + 等比缩放(scale)。

约定:
- 所有结果都在"参考图坐标系"中表达, 人工笔迹也存参考图坐标。
- 缩放以参考图中心为基准: p_ref = s * (p_src + d - c) + c
- 图外区域通过有效掩膜(valid mask)表达, 绝不当作黑色内容参与清晰度比较。
"""
from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

# 允许的手动调整范围(界面与校验共用)
MAX_SHIFT = 15.0
MIN_SCALE = 0.98
MAX_SCALE = 1.02


@dataclass
class AlignParams:
    dx: float = 0.0
    dy: float = 0.0
    scale: float = 1.0

    def clamped(self) -> "AlignParams":
        return AlignParams(
            dx=float(np.clip(self.dx, -MAX_SHIFT, MAX_SHIFT)),
            dy=float(np.clip(self.dy, -MAX_SHIFT, MAX_SHIFT)),
            scale=float(np.clip(self.scale, MIN_SCALE, MAX_SCALE)),
        )

    def matrix(self, center: tuple[float, float]) -> np.ndarray:
        """返回 2x3 仿射矩阵, 把源图坐标映射到参考图坐标。"""
        cx, cy = center
        s = self.scale
        return np.array(
            [
                [s, 0.0, cx + s * (self.dx - cx)],
                [0.0, s, cy + s * (self.dy - cy)],
            ],
            dtype=np.float64,
        )


def warp_to_reference(
    img: np.ndarray,
    params: AlignParams,
    center: tuple[float, float],
    out_shape: tuple[int, int],
    interpolation: int = cv2.INTER_LINEAR,
) -> np.ndarray:
    """把 img 变换到参考图坐标系, 图外填 0(由 valid_mask 排除, 不参与选择)。"""
    h, w = out_shape
    m = params.matrix(center)
    return cv2.warpAffine(
        img,
        m,
        (w, h),
        flags=interpolation,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=0,
    )


def valid_mask(
    src_shape: tuple[int, int],
    params: AlignParams,
    center: tuple[float, float],
    out_shape: tuple[int, int],
    erode: int = 1,
) -> np.ndarray:
    """源图的哪些像素变换后落在参考图画幅内(且远离插值边缘)。"""
    ones = np.ones(src_shape[:2], dtype=np.uint8)
    m = warp_to_reference(ones, params, center, out_shape, interpolation=cv2.INTER_NEAREST)
    if erode > 0:
        m = cv2.erode(m, np.ones((3, 3), np.uint8), iterations=erode)
    return m.astype(bool)


def common_valid(valids: list[np.ndarray]) -> np.ndarray:
    """所有来源都有效的公共区域。"""
    return np.logical_and.reduce(valids)


def crop_rect(common: np.ndarray) -> tuple[int, int, int, int]:
    """公共有效区的外接矩形 (x, y, w, h)。"""
    ys, xs = np.nonzero(common)
    if len(xs) == 0:
        raise ValueError("公共有效区为空: 对齐参数可能偏差过大")
    x0, x1 = int(xs.min()), int(xs.max()) + 1
    y0, y1 = int(ys.min()), int(ys.max()) + 1
    return x0, y0, x1 - x0, y1 - y0
