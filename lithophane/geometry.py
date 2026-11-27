"""板体几何：物理尺寸、采样密度、边框、等比例留边与高度场构建。"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .imaging import apply_levels, resize_grid
from .mapping import ThicknessParams, thickness_from_gray

# 网格节点数上限（nx * ny），超出即拒绝，保留旧预览
MAX_GRID_NODES = 1_000_000


class GridLimitError(ValueError):
    """采样密度导致网格规模超过预设上限。"""

    def __init__(self, nodes: int, cols: int, rows: int) -> None:
        super().__init__(
            f"网格规模超限：当前 {cols} × {rows} = {nodes:,} 个节点，"
            f"上限 {MAX_GRID_NODES:,}。请降低上下/左右采样密度后重试。"
        )


@dataclass
class BoardParams:
    """板体参数。所有长度单位为毫米，尺寸与像素/采样点数完全独立。"""

    width_mm: float = 100.0          # 板宽（x）
    height_mm: float = 80.0          # 板高（y，对应原图上下方向）
    cols: int = 200                  # x 方向采样格点数
    rows: int = 160                  # y 方向采样格点数
    border_mm: float = 4.0           # 一圈边框的宽度
    border_thickness_mm: float = 3.0 # 边框正面高度
    keep_aspect: bool = False        # 非正方形图是否等比例留边

    def validate(self) -> None:
        if self.width_mm <= 0 or self.height_mm <= 0:
            raise ValueError("板宽高必须为正数")
        if self.cols < 2 or self.rows < 2:
            raise ValueError("每个方向的采样格点至少为 2")
        if self.border_mm < 0 or self.border_thickness_mm <= 0:
            raise ValueError("边框宽度不能为负、边框厚度必须为正")
        if 2.0 * self.border_mm >= min(self.width_mm, self.height_mm):
            raise ValueError("边框过宽：两侧边框已占满整板，请缩小边框或加大板子")


@dataclass
class HeightField:
    """高度场结果。

    thickness: (rows, cols) 毫米厚度，行 0 对应板顶（图像顶部）
    x_coords:  (cols,) x 坐标，0..width_mm
    y_coords:  (rows,) y 坐标，0..板顶 height_mm（行 0 最大）
    is_border: (rows, cols) bool，True 为边框区域
    uniform:   True 表示整板厚度完全一致（完全同色 / 单列等退化输入）
    image_window: (x0, y0, x1, y1) mm，图像实际占用的矩形（留边模式）
    """

    thickness: np.ndarray
    x_coords: np.ndarray
    y_coords: np.ndarray
    is_border: np.ndarray
    uniform: bool
    image_window: tuple[float, float, float, float]


def build_heightfield(gray: np.ndarray, bp: BoardParams,
                      tp: ThicknessParams) -> HeightField:
    """由灰度图与参数构建毫米高度场。

    物理尺寸始终来自 BoardParams（毫米），cols/rows 只决定离散密度，
    切换分辨率不会把实体尺寸变成像素数。
    """
    bp.validate()
    tp.validate()
    rows, cols = bp.rows, bp.cols
    nodes = rows * cols
    if nodes > MAX_GRID_NODES:
        raise GridLimitError(nodes, cols, rows)

    src_h, src_w = gray.shape
    single_col = src_w == 1
    single_row = src_h == 1

    # 等比例留边：按原图纵横比在板内居中放置图像，周围以边框厚度填充
    fit = bp.keep_aspect and not (single_col or single_row)
    W, H, B = bp.width_mm, bp.height_mm, bp.border_mm
    inner_w, inner_h = W - 2.0 * B, H - 2.0 * B

    if fit:
        image_aspect = src_w / src_h
        inner_aspect = inner_w / inner_h
        if image_aspect > inner_aspect:
            win_w = inner_w
            win_h = inner_w / image_aspect
        else:
            win_h = inner_h
            win_w = inner_h * image_aspect
        x0 = B + (inner_w - win_w) / 2.0
        y1 = H - B - (inner_h - win_h) / 2.0   # 窗口顶边
        y0 = y1 - win_h
    else:
        x0, y0 = B, 0.0
        win_w, win_h = inner_w, inner_h
        y1 = H - B

    leveled = apply_levels(gray, tp.black_point, tp.white_point)
    image_t = thickness_from_gray(leveled, tp)
    image_grid = resize_grid(image_t, rows, cols)

    thickness = np.full((rows, cols), bp.border_thickness_mm, dtype=np.float64)
    is_border = np.ones((rows, cols), dtype=bool)

    x_coords = np.linspace(0.0, W, cols)
    y_coords = np.linspace(H, 0.0, rows)   # 行 0 在板顶

    if inner_w > 0 and inner_h > 0:
        in_x = (x_coords >= B) & (x_coords <= W - B)
        in_y = (y_coords <= H - B) & (y_coords >= B)
        if fit:
            in_x = in_x & (x_coords >= x0) & (x_coords <= x0 + win_w)
            in_y = in_y & (y_coords <= y1) & (y_coords >= y0)
        sel = np.ix_(in_y, in_x)
        if in_x.any() and in_y.any():
            thickness[sel] = image_grid[sel]
            is_border[sel] = False

    uniform = bool(np.all(np.abs(thickness - thickness.flat[0]) < 1e-12))
    return HeightField(
        thickness=thickness,
        x_coords=x_coords,
        y_coords=y_coords,
        is_border=is_border,
        uniform=uniform,
        image_window=(x0, y0, x0 + win_w, y1),
    )
