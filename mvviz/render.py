"""把帧画面与运动向量叠加渲染成可显示的图像。"""

from __future__ import annotations

import numpy as np
from PIL import Image, ImageDraw

from .groundtruth import GroundTruth
from .mvdata import MotionVector

# 参考方向配色
COLOR_PAST = (38, 109, 211)      # 蓝：来自过去
COLOR_FUTURE = (224, 112, 24)    # 橙：来自未来
COLOR_UNKNOWN_DIR = (150, 90, 180)
COLOR_BLOCK_BORDER = (255, 255, 255)
COLOR_SELECTED = (255, 235, 60)
COLOR_MISMATCH = (235, 40, 40)
COLOR_EXPECTED = (40, 190, 90)   # 绿虚线：程序预设的期望向量


def direction_color(mv: MotionVector) -> tuple[int, int, int]:
    if mv.direction == "past":
        return COLOR_PAST
    if mv.direction == "future":
        return COLOR_FUTURE
    return COLOR_UNKNOWN_DIR


def passes_filters(mv: MotionVector, min_length: float,
                   show_past: bool, show_future: bool) -> bool:
    """显示筛选。筛选只影响绘制，原始数据始终保留在 VideoData 中。"""
    if mv.length < min_length:
        return False
    if mv.direction == "past" and not show_past:
        return False
    if mv.direction == "future" and not show_future:
        return False
    if mv.direction == "unknown" and not (show_past or show_future):
        return False
    return True


def _arrow(draw: ImageDraw.ImageDraw, x0: float, y0: float, x1: float, y1: float,
           color: tuple[int, int, int], width: int = 2, dashed: bool = False) -> None:
    if dashed:
        _dashed_line(draw, (x0, y0), (x1, y1), color, width=width, dash=6)
    else:
        draw.line([x0, y0, x1, y1], fill=color, width=width)
    # 箭头头部
    v = np.array([x1 - x0, y1 - y0], dtype=float)
    norm = np.hypot(*v)
    if norm < 1e-6:
        return
    u = v / norm
    perp = np.array([-u[1], u[0]])
    head = 7.0
    base = np.array([x1, y1]) - u * head
    p1 = base + perp * head * 0.55
    p2 = base - perp * head * 0.55
    draw.polygon([(x1, y1), tuple(p1), tuple(p2)], fill=color)


def _dashed_line(draw: ImageDraw.ImageDraw, p0: tuple[float, float],
                 p1: tuple[float, float], color: tuple[int, int, int],
                 width: int = 1, dash: int = 6) -> None:
    a = np.array(p0, dtype=float)
    b = np.array(p1, dtype=float)
    total = np.linalg.norm(b - a)
    if total < 1e-6:
        return
    u = (b - a) / total
    n = int(total // dash)
    for i in range(0, n + 1, 2):
        s = a + u * (i * dash)
        e = a + u * min((i + 1) * dash, total)
        draw.line([tuple(s), tuple(e)], fill=color, width=width)


def render_overlay(frame_rgb: np.ndarray, vectors: list[MotionVector],
                   gt: GroundTruth | None, frame_index: int,
                   min_length: float = 0.0,
                   show_past: bool = True, show_future: bool = True,
                   show_blocks: bool = False,
                   show_expected: bool = False,
                   show_mismatch: bool = False,
                   selected: MotionVector | None = None) -> Image.Image:
    """生成叠加后的 PIL 图像（原始帧不被修改）。"""
    img = Image.fromarray(frame_rgb).convert("RGB")
    draw = ImageDraw.Draw(img)

    for mv in vectors:
        visible = passes_filters(mv, min_length, show_past, show_future)
        is_selected = selected is not None and _same_block(mv, selected)

        if show_mismatch and gt is not None and visible:
            verdict, _exp = gt.compare(frame_index, mv)
            if verdict == "mismatch":
                draw.rectangle(
                    [mv.block_x, mv.block_y,
                     mv.block_x + mv.block_w - 1, mv.block_y + mv.block_h - 1],
                    outline=COLOR_MISMATCH, width=3,
                )

        if show_blocks:
            draw.rectangle(
                [mv.block_x, mv.block_y,
                 mv.block_x + mv.block_w - 1, mv.block_y + mv.block_h - 1],
                outline=COLOR_BLOCK_BORDER, width=1,
            )

        if not visible:
            continue

        color = direction_color(mv)
        # 选中块加粗 + 黄框
        width = 3 if is_selected else 2
        if is_selected:
            draw.rectangle(
                [mv.block_x, mv.block_y,
                 mv.block_x + mv.block_w - 1, mv.block_y + mv.block_h - 1],
                outline=COLOR_SELECTED, width=3,
            )
        _arrow(draw, mv.dst_x, mv.dst_y, mv.src_x, mv.src_y, color, width=width)

        # 期望向量（绿色虚线），仅在有期望且参考帧可确认时绘制
        if show_expected and gt is not None:
            exp = gt.expectation_at(frame_index, mv.dst_x, mv.dst_y, mv.ref_frame)
            if exp.kind in ("object", "background"):
                _arrow(draw, mv.dst_x, mv.dst_y,
                       mv.dst_x + exp.exp_mv_x, mv.dst_y + exp.exp_mv_y,
                       COLOR_EXPECTED, width=1, dashed=True)

    return img


def _same_block(a: MotionVector, b: MotionVector) -> bool:
    return (a.block_x == b.block_x and a.block_y == b.block_y
            and a.block_w == b.block_w and a.block_h == b.block_h
            and a.direction == b.direction)


def find_vector_at(vectors: list[MotionVector], x: int, y: int) -> MotionVector | None:
    """点选：返回包含该像素的最后一个块的向量（同块可能有过去/未来两条）。"""
    hits = [mv for mv in vectors
            if mv.block_x <= x < mv.block_x + mv.block_w
            and mv.block_y <= y < mv.block_y + mv.block_h]
    if not hits:
        return None
    return hits[-1]
