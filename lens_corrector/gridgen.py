"""程序生成直线网格原图与带已知畸变的样例图。

不依赖任何外部素材：网格、刻度、方向标记全部由代码绘制。
图像坐标系为像素坐标：原点 (0,0) 在左上角，u 向右、v 向下，
与 OpenCV 约定一致。
"""

from __future__ import annotations

from dataclasses import dataclass
import numpy as np
import cv2

from .distortion import (
    DistortionParams,
    build_distort_map,
    remap_image,
    valid_mask_from_map,
)

DEFAULT_WIDTH = 640
DEFAULT_HEIGHT = 480
DEFAULT_SPACING = 40
MAJOR_EVERY = 5  # 每 5 条细线画一条粗线


@dataclass
class GridMeta:
    width: int
    height: int
    spacing: int
    cx: int
    cy: int

    @property
    def shape(self) -> tuple[int, int]:
        return (self.height, self.width)

    def intersections(self) -> np.ndarray:
        """所有网格交点的像素坐标 (u,v)，形状 (N,2)。"""
        xs = np.arange(self.spacing, self.width, self.spacing)
        ys = np.arange(self.spacing, self.height, self.spacing)
        vv, uu = np.meshgrid(ys, xs, indexing="ij")
        return np.column_stack([uu.ravel(), vv.ravel()]).astype(np.float64)


def _put_text(img: np.ndarray, text: str, org: tuple[int, int],
              scale: float = 0.4, color=(0, 0, 0), thickness: int = 1):
    cv2.putText(img, text, org, cv2.FONT_HERSHEY_SIMPLEX, scale,
                color, thickness, cv2.LINE_AA)


def _draw_f_marker(img: np.ndarray, origin: tuple[int, int],
                   size: int, color=(30, 30, 200)):
    """不对称 F 形标记：两横一竖，旋转后无法与自身重合，用于辨认方向。"""
    x0, y0 = origin
    t = max(3, size // 8)
    cv2.line(img, (x0, y0), (x0, y0 + size), color, t)
    cv2.line(img, (x0, y0), (x0 + size, y0), color, t)
    cv2.line(img, (x0, y0 + size // 2),
             (x0 + int(size * 0.7), y0 + size // 2), color, t)


def _draw_l_marker(img: np.ndarray, origin: tuple[int, int],
                   size: int, color=(200, 60, 30)):
    """右下角 L 形标记，与 F 一起提供非对称方向信息。"""
    x0, y0 = origin
    t = max(3, size // 8)
    cv2.line(img, (x0, y0), (x0, y0 + size), color, t)
    cv2.line(img, (x0, y0 + size), (x0 + size, y0 + size), color, t)


def generate_grid(width: int = DEFAULT_WIDTH,
                  height: int = DEFAULT_HEIGHT,
                  spacing: int = DEFAULT_SPACING) -> tuple[np.ndarray, GridMeta]:
    """生成白底直线网格图（BGR）与网格元数据。

    包含：细/粗两级网格线、过中心的红 x 轴与绿 y 轴（带箭头）、
    像素坐标刻度、中心圆点、F/L/三角三种不对称方向标记、象限编号。
    """
    img = np.full((height, width, 3), 255, dtype=np.uint8)
    cx, cy = width // 2, height // 2

    # 细网格线与粗网格线
    for x in range(spacing, width, spacing):
        major = (x // spacing) % MAJOR_EVERY == 0
        cv2.line(img, (x, 0), (x, height),
                 (150, 150, 150) if major else (218, 218, 218),
                 1 if not major else 1)
    for y in range(spacing, height, spacing):
        major = (y // spacing) % MAJOR_EVERY == 0
        cv2.line(img, (0, y), (width, y),
                 (150, 150, 150) if major else (218, 218, 218), 1)

    # 坐标轴：x 轴红（水平）、y 轴绿（竖直），带箭头
    cv2.line(img, (0, cy), (width - 1, cy), (60, 60, 220), 2)
    cv2.line(img, (cx, 0), (cx, height - 1), (60, 170, 60), 2)
    cv2.arrowedLine(img, (width - 30, cy), (width - 2, cy),
                    (60, 60, 220), 2, tipLength=0.5)
    cv2.arrowedLine(img, (cx, 30), (cx, 2), (60, 170, 60),
                    2, tipLength=0.5)
    cv2.circle(img, (cx, cy), 5, (0, 0, 0), -1)
    _put_text(img, "u ->", (width - 60, cy - 8), 0.45, (60, 60, 220))
    _put_text(img, "v", (cx + 8, 18), 0.45, (60, 170, 60))

    # 像素坐标刻度（顶边与左边，绝对像素值）
    for x in range(spacing * 2, width, spacing * 2):
        cv2.line(img, (x, 0), (x, 6), (0, 0, 0), 1)
        _put_text(img, str(x), (x - 14, 18), 0.35, (40, 40, 40))
    for y in range(spacing * 2, height, spacing * 2):
        cv2.line(img, (0, y), (6, y), (0, 0, 0), 1)
        _put_text(img, str(y), (8, y + 4), 0.35, (40, 40, 40))
    _put_text(img, "0", (cx + 4, cy + 14), 0.38, (0, 0, 0))

    # 不对称方向标记
    m = min(70, height // 6)
    _draw_f_marker(img, (14, 14), m)
    _put_text(img, "F", (18 + m, 30), 0.6, (30, 30, 200), 2)
    _draw_l_marker(img, (width - 14 - m, height - 14 - m), m)
    _put_text(img, "L", (width - 14 - m - 24, height - 14 - m - 4),
              0.6, (200, 60, 30), 2)
    tri = np.array([[width - 70, 14], [width - 14, 14],
                    [width - 14, 70]], dtype=np.int32)
    cv2.fillPoly(img, [tri], (40, 160, 200))

    # 象限编号（以中心为原点，图像像素坐标下的四个象限）
    qx, qy = spacing, spacing
    _put_text(img, "Q1 (+u,-v)", (cx + qx, cy - qy), 0.42, (90, 90, 90))
    _put_text(img, "Q2 (-u,-v)", (cx - qx - 95, cy - qy), 0.42, (90, 90, 90))
    _put_text(img, "Q3 (-u,+v)", (cx - qx - 95, cy + qy + 12), 0.42, (90, 90, 90))
    _put_text(img, "Q4 (+u,+v)", (cx + qx, cy + qy + 12), 0.42, (90, 90, 90))

    return img, GridMeta(width, height, spacing, cx, cy)


@dataclass
class SampleData:
    ref_image: np.ndarray          # 理想直线网格原图（原始尺寸）
    dist_image: np.ndarray         # 按已知参数生成的畸变图（同尺寸）
    valid_mask: np.ndarray         # 畸变图中有效像素掩膜
    params: DistortionParams       # 生成样例所用的真实参数
    meta: GridMeta

    @property
    def shape(self) -> tuple[int, int]:
        return self.ref_image.shape[:2]


def default_sample_params(width: int, height: int) -> DistortionParams:
    """一组温和且非对称的真实参数，反投稳定、肉眼可辨。"""
    return DistortionParams(
        k1=-0.28, k2=0.06, p1=0.010, p2=-0.015,
        cx=width / 2.0, cy=height / 2.0)


def make_sample(width: int = DEFAULT_WIDTH,
                height: int = DEFAULT_HEIGHT,
                spacing: int = DEFAULT_SPACING,
                params: DistortionParams | None = None) -> SampleData:
    """生成网格原图并施加已知畸变，保留原始尺寸与真实参数。"""
    ref, meta = generate_grid(width, height, spacing)
    if params is None:
        params = default_sample_params(width, height)
    map_xy, converged = build_distort_map(ref.shape, params)
    dist = remap_image(ref, map_xy)
    valid = valid_mask_from_map(map_xy, ref.shape) & converged
    dist[~valid] = 0
    return SampleData(ref, dist, valid, params, meta)
