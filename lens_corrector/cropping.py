"""有效区域掩膜与裁切矩形。"""

from __future__ import annotations

from dataclasses import dataclass
import numpy as np

from .distortion import (
    DistortionParams,
    build_undistort_map,
    valid_mask_from_map,
)


@dataclass
class CropRect:
    """像素坐标系下的裁切矩形（左、上、宽、高），均为整数。"""

    x: int
    y: int
    width: int
    height: int

    @property
    def right(self) -> int:
        return self.x + self.width

    @property
    def bottom(self) -> int:
        return self.y + self.height

    def as_tuple(self) -> tuple[int, int, int, int]:
        return (self.x, self.y, self.width, self.height)


def compute_valid_mask(shape: tuple[int, int],
                       p: DistortionParams) -> np.ndarray:
    """校正图的有效像素掩膜：采样落在畸变图范围内即为有效。"""
    map_xy = build_undistort_map(shape, p)
    return valid_mask_from_map(map_xy, shape)


def valid_bounding_rect(mask: np.ndarray) -> CropRect | None:
    """有效区域的外接（包围）矩形，矩形内可能仍含无效像素。"""
    ys, xs = np.where(mask)
    if xs.size == 0:
        return None
    x0, x1 = int(xs.min()), int(xs.max()) + 1
    y0, y1 = int(ys.min()), int(ys.max()) + 1
    return CropRect(x0, y0, x1 - x0, y1 - y0)


def largest_all_valid_rect(mask: np.ndarray) -> CropRect | None:
    """最大的全部像素均有效的轴对齐矩形（直方图法）。

    保证裁出的画面不含任何越界/无效像素；找不到时返回 None。
    """
    h, w = mask.shape
    heights = np.zeros(w, dtype=np.int32)
    best_area = 0
    best: CropRect | None = None

    for row in range(h):
        heights = np.where(mask[row], heights + 1, 0)
        # 单调栈求当前行的最大全 1 矩形
        stack: list[tuple[int, int]] = []
        for col in range(w + 1):
            cur = int(heights[col]) if col < w else 0
            start = col
            while stack and stack[-1][1] > cur:
                c, hgt = stack.pop()
                area = (col - c) * hgt
                if area > best_area:
                    best_area = area
                    best = CropRect(c, row - hgt + 1, col - c, hgt)
                start = c
            if not stack or stack[-1][1] < cur:
                stack.append((start, cur))

    return best


def crop_info_text(rect: CropRect | None) -> str:
    """界面/导出用的裁切说明文字（像素坐标与尺寸）。"""
    if rect is None:
        return "无有效裁切区域"
    return (f"左上角 ({rect.x}, {rect.y}) px，尺寸 "
            f"{rect.width} x {rect.height} px，"
            f"右下角 ({rect.right - 1}, {rect.bottom - 1})")
