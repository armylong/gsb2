"""预览帧合成(纯 numpy, 不依赖 Qt)。

与导出的区别只在实现路径: 导出由 ffmpeg overlay 滤镜按同一组 x/y 表达式
逐帧放置; 这里由 :class:`~pipeditor.model.Project.position_at` 给出同样的
整数坐标后手工拷贝像素。两者输入规则完全相同。
"""

from __future__ import annotations

import numpy as np

from .model import Project


def place_overlay(
    background: np.ndarray,
    overlay: np.ndarray,
    x: int,
    y: int,
    overlay_w: int,
    overlay_h: int,
    canvas_w: int,
    canvas_h: int,
) -> np.ndarray:
    """把 overlay 贴到 background 的 (x, y) 左上角, 返回新数组。

    坐标由模型保证在界内; 这里再做一次防御性裁剪。
    """

    frame = background.copy()
    x0, y0 = max(0, x), max(0, y)
    x1, y1 = min(canvas_w, x + overlay_w), min(canvas_h, y + overlay_h)
    if x1 <= x0 or y1 <= y0:
        return frame
    sx0, sy0 = x0 - x, y0 - y
    sx1, sy1 = sx0 + (x1 - x0), sy0 + (y1 - y0)
    frame[y0:y1, x0:x1] = overlay[sy0:sy1, sx0:sx1]
    return frame


def render_frame(
    project: Project,
    frame: int,
    background: np.ndarray,
    overlay: np.ndarray | None,
) -> np.ndarray:
    """按模型规则渲染一帧(不含拖动框/辅助线, 那些只由 Qt 层画)。"""

    if overlay is not None and project.overlay_visible(frame):
        x, y = project.position_at(frame)
        return place_overlay(
            background,
            overlay,
            x,
            y,
            project.overlay_w,
            project.overlay_h,
            project.canvas_w,
            project.canvas_h,
        )
    return background.copy()
