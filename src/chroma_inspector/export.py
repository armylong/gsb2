"""并排检查图导出。

纯 numpy 部分负责把两路 RGB 拼成一张带标注带的画布；
PNG 编码与文字标注在 ui.export_png 里用 QPainter 完成，
这样核心逻辑不依赖 GUI，也方便单元测试。
"""
from __future__ import annotations

import numpy as np

MARGIN = 12
HEADER = 28
LABEL_H = 22
GAP = MARGIN  # 两面板之间的间隙宽度


def _nearest_zoom(rgb: np.ndarray, crop: tuple[int, int, int, int], scale: int):
    x0, y0, x1, y1 = crop
    return np.kron(
        rgb[y0:y1, x0:x1], np.ones((scale, scale, 1), dtype=np.uint8)
    )


def assemble_side_by_side(
    rgb_a: np.ndarray,
    rgb_b: np.ndarray,
    title_a: str,
    title_b: str,
    frame_label: str,
    zoom_crop: tuple[int, int, int, int] | None = None,
) -> tuple[np.ndarray, dict]:
    """拼成 uint8 RGB(H,W,3) 画布，并返回 QPainter 所需的几何信息。

    zoom_crop 给定时 (x0,y0,x1,y1)，只导出该区域的放大对比（最近邻 4 倍）。
    返回 (canvas, geometry)，geometry 含面板原点/尺寸与文字坐标。
    """
    scale = 1
    if zoom_crop is not None:
        scale = 4
        a = _nearest_zoom(rgb_a, zoom_crop, scale)
        b = _nearest_zoom(rgb_b, zoom_crop, scale)
    else:
        a, b = rgb_a, rgb_b

    panel_h = max(a.shape[0], b.shape[0])
    panel_w = max(a.shape[1], b.shape[1])
    ax = MARGIN
    bx = MARGIN + panel_w + GAP
    top = HEADER + LABEL_H
    canvas_w = bx + panel_w + MARGIN
    canvas_h = top + panel_h + MARGIN

    canvas = np.full((canvas_h, canvas_w, 3), 245, np.uint8)
    canvas[top - 1, :] = (90, 90, 90)
    canvas[top:top + a.shape[0], ax:ax + a.shape[1]] = a
    canvas[top:top + b.shape[0], bx:bx + b.shape[1]] = b

    geometry = {
        "top": top,
        "panel_w": panel_w,
        "panel_h": panel_h,
        "ax": ax,
        "bx": bx,
        "frame_text": (MARGIN, 2, canvas_w - 2 * MARGIN, HEADER - 4),
        "label_a": (ax, HEADER, panel_w, LABEL_H - 2),
        "label_b": (bx, HEADER, panel_w, LABEL_H - 2),
        "frames": (
            (ax - 1, top - 1, panel_w + 2, panel_h + 2),
            (bx - 1, top - 1, panel_w + 2, panel_h + 2),
        ),
    }
    return canvas, geometry
