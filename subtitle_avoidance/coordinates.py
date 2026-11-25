"""预览控件缩放与源视频坐标互转。"""

from __future__ import annotations

from .model import Rect


def fitted_video_rect(
    widget_width: float,
    widget_height: float,
    video_width: float,
    video_height: float,
) -> Rect:
    if widget_width <= 0 or widget_height <= 0 or video_width <= 0 or video_height <= 0:
        return Rect(0, 0, 0, 0)
    scale = min(widget_width / video_width, widget_height / video_height)
    w = video_width * scale
    h = video_height * scale
    return Rect((widget_width - w) / 2, (widget_height - h) / 2, w, h)


def widget_to_source(
    x: float,
    y: float,
    widget_width: float,
    widget_height: float,
    video_width: int,
    video_height: int,
) -> tuple[float, float]:
    dest = fitted_video_rect(
        widget_width, widget_height, video_width, video_height
    )
    if dest.w == 0 or dest.h == 0:
        return 0.0, 0.0
    sx = (x - dest.x) / dest.w * video_width
    sy = (y - dest.y) / dest.h * video_height
    return sx, sy


def source_to_widget(
    x: float,
    y: float,
    widget_width: float,
    widget_height: float,
    video_width: int,
    video_height: int,
) -> tuple[float, float]:
    dest = fitted_video_rect(
        widget_width, widget_height, video_width, video_height
    )
    px = dest.x + x / video_width * dest.w
    py = dest.y + y / video_height * dest.h
    return px, py
