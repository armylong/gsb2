"""与预览、导出共用的实际换行和字幕绘制逻辑。

所有尺寸都以原视频像素为单位。预览时只做整体缩放，因此窗口尺寸变化不会
改变源坐标中的字框、换行和位置。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from PySide6.QtCore import QPointF, QRectF, Qt
from PySide6.QtGui import (
    QBrush,
    QColor,
    QFont,
    QFontMetricsF,
    QPainter,
    QPainterPath,
    QPen,
    QTextLayout,
    QTextOption,
)

from .model import Rect

DEFAULT_FONT_FAMILIES = [
    "PingFang SC",
    "Microsoft YaHei",
    "Noto Sans CJK SC",
    "Source Han Sans SC",
    "Heiti SC",
    "Arial Unicode MS",
]


def make_style(video_height: int, overrides: dict[str, Any] | None = None) -> dict[str, Any]:
    h = max(1, int(video_height))
    style: dict[str, Any] = {
        "font_families": DEFAULT_FONT_FAMILIES,
        "font_pixel_size": max(18, round(h * 0.052)),
        "bold": True,
        "line_spacing": 1.18,
        "max_box_width_ratio": 0.92,
        "padding_x": max(14, round(h * 0.026)),
        "padding_y": max(7, round(h * 0.012)),
        "outline_width": max(2.0, h * 0.0045),
        "background_color": "#000000",
        "background_alpha": 165,
        "text_color": "#ffffff",
        "outline_color": "#000000",
        "radius": max(8.0, h * 0.018),
        "collision_gap": 2.0,
    }
    style.update(overrides or {})
    return style


def make_font(style: dict[str, Any]) -> QFont:
    font = QFont()
    families = style.get("font_families") or DEFAULT_FONT_FAMILIES
    if isinstance(families, str):
        families = [families]
    font.setFamilies(list(families))
    font.setPixelSize(int(style["font_pixel_size"]))
    font.setBold(bool(style.get("bold", True)))
    return font


@dataclass(frozen=True)
class LaidOutText:
    text: str
    lines: tuple[str, ...]
    line_widths: tuple[float, ...]
    width: float
    height: float
    box_w: float
    box_h: float
    font_pixel_size: int
    padding_x: float
    padding_y: float

    @property
    def line_count(self) -> int:
        return len(self.lines)


class LayoutEngine:
    """按 QFontMetrics/QTextLayout 的真实字形宽度贪心换行。"""

    def __init__(self, video_width: int, video_height: int, style: dict[str, Any] | None = None):
        self.video_width = max(1, int(video_width))
        self.video_height = max(1, int(video_height))
        self.style = make_style(self.video_height, style)
        self.font = make_font(self.style)
        self.metrics = QFontMetricsF(self.font)
        self.line_height = self.metrics.height() * float(self.style["line_spacing"])
        self.pad_x = float(self.style["padding_x"])
        self.pad_y = float(self.style["padding_y"])
        max_box_w = self.video_width * float(self.style["max_box_width_ratio"])
        self.max_text_width = max(10.0, max_box_w - 2 * self.pad_x)
        self._cache: dict[str, LaidOutText] = {}

    def layout(self, text: str) -> LaidOutText:
        key = text
        cached = self._cache.get(key)
        if cached is not None:
            return cached

        all_lines: list[str] = []
        all_widths: list[float] = []
        # 保留 SRT 中已有的硬换行；每一段再按最大宽度实际折行。
        blocks = text.replace("\r", "").split("\n") or [""]
        for block in blocks:
            wrapped = self._wrap_block(block)
            for line in wrapped:
                line = line if line else " "
                all_lines.append(line)
                all_widths.append(float(self.metrics.horizontalAdvance(line)))

        if not all_lines:
            all_lines = [" "]
            all_widths = [float(self.metrics.horizontalAdvance(" "))]

        text_w = max(all_widths)
        text_h = len(all_lines) * self.line_height
        box_w = min(
            self.video_width * float(self.style["max_box_width_ratio"]),
            text_w + 2 * self.pad_x,
        )
        box_h = text_h + 2 * self.pad_y
        result = LaidOutText(
            text=text,
            lines=tuple(all_lines),
            line_widths=tuple(all_widths),
            width=text_w,
            height=text_h,
            box_w=box_w,
            box_h=box_h,
            font_pixel_size=int(self.style["font_pixel_size"]),
            padding_x=self.pad_x,
            padding_y=self.pad_y,
        )
        self._cache[key] = result
        return result

    def _wrap_block(self, block: str) -> list[str]:
        if block == "":
            return [""]

        text_layout = QTextLayout(block, self.font)
        option = QTextOption()
        option.setWrapMode(QTextOption.WrapMode.WrapAtWordBoundaryOrAnywhere)
        option.setAlignment(Qt.AlignmentFlag.AlignLeft)
        text_layout.setTextOption(option)
        text_layout.beginLayout()
        lines: list[str] = []
        try:
            while True:
                line = text_layout.createLine()
                if not line.isValid():
                    break
                line.setLineWidth(self.max_text_width)
                start = line.textStart()
                length = line.textLength()
                fragment = block[start : start + length]
                # QTextLayout 有时把行尾换行/空白计入 length。
                fragment = fragment.strip("\n").rstrip()
                lines.append(fragment)
        finally:
            text_layout.endLayout()

        if not lines:
            return [block]
        return lines


def render_subtitle(
    painter: QPainter,
    laid: LaidOutText,
    box: Rect,
    style: dict[str, Any] | None = None,
) -> None:
    """在 painter 当前坐标系中按源视频坐标绘制字幕。"""
    if style is None:
        style = make_style(720)
    painter.save()
    painter.setRenderHint(QPainter.RenderHint.Antialiasing, True)
    painter.setRenderHint(QPainter.RenderHint.TextAntialiasing, True)

    rect = QRectF(box.x, box.y, box.w, box.h)
    bg = QColor(str(style.get("background_color", "#000000")))
    bg.setAlpha(int(style.get("background_alpha", 165)))
    radius = float(style.get("radius", 10))
    painter.setPen(Qt.PenStyle.NoPen)
    painter.setBrush(QBrush(bg))
    painter.drawRoundedRect(rect, radius, radius)

    font = make_font(style)
    metrics = QFontMetricsF(font)
    line_h = metrics.height() * float(style.get("line_spacing", 1.18))
    outline = float(style.get("outline_width", 2.0))
    text_color = QColor(str(style.get("text_color", "#ffffff")))
    outline_color = QColor(str(style.get("outline_color", "#000000")))

    for i, (line, line_w) in enumerate(zip(laid.lines, laid.line_widths)):
        baseline = (
            box.y
            + float(style.get("padding_y", laid.padding_y))
            + metrics.ascent()
            + i * line_h
            + (line_h - metrics.height()) / 2
        )
        x = box.center_x - line_w / 2
        path = QPainterPath()
        path.addText(QPointF(x, baseline), font, line)

        pen = QPen(outline_color)
        pen.setWidthF(outline)
        pen.setJoinStyle(Qt.PenJoinStyle.RoundJoin)
        painter.setPen(pen)
        painter.setBrush(Qt.BrushStyle.NoBrush)
        painter.drawPath(path)

        painter.setPen(Qt.PenStyle.NoPen)
        painter.setBrush(QBrush(text_color))
        painter.drawPath(path)

    painter.restore()
