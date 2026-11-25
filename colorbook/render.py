"""渲染：原图 / 填色方案 / 黑白稿三种视图，以及同尺寸导出。

所有输出都与输入 PNG 同尺寸；边界线、数字、引线均按图像像素绘制。
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

from .labels import LabelPlan, plan_region_label, resolve_label_overlaps

VIEW_ORIGINAL = "original"
VIEW_COLOR = "color"
VIEW_LINE = "line"

BOUNDARY_COLOR = (20, 20, 20)
LEADER_COLOR = (60, 60, 60)
HIGHLIGHT_COLOR = (255, 120, 0)
UNFIT_COLOR = (220, 0, 0)


# ---------------------------------------------------------------------- #
# 字体
# ---------------------------------------------------------------------- #
def load_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    """按字号找一个可用的 TrueType 字体，找不到就退回 PIL 默认位图字体。"""
    candidates = [
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "C:/Windows/Fonts/arial.ttf",
    ]
    for path in candidates:
        if Path(path).exists():
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return ImageFont.load_default()


def measure_text(
    font: ImageFont.ImageFont, text: str
) -> tuple[int, int]:
    """返回文字外接框 (宽, 高)，兼容位图字体。"""
    if hasattr(font, "getbbox"):
        left, top, right, bottom = font.getbbox(text)
        return right - left, bottom - top
    return font.getsize(text)  # type: ignore[attr-defined]


# ---------------------------------------------------------------------- #
# 边界
# ---------------------------------------------------------------------- #
def boundary_mask(labels: np.ndarray) -> np.ndarray:
    """区域共享边界：相邻（4 邻域）标签不同的像素。"""
    mask = np.zeros(labels.shape, dtype=bool)
    mask[:, :-1] |= labels[:, :-1] != labels[:, 1:]
    mask[:, 1:] |= labels[:, :-1] != labels[:, 1:]
    mask[:-1, :] |= labels[:-1, :] != labels[1:, :]
    mask[1:, :] |= labels[:-1, :] != labels[1:, :]
    return mask


def dilate_mask(mask: np.ndarray, radius: int) -> np.ndarray:
    """小半径膨胀，用来控制线宽；十字形邻域，足够画边界。"""
    if radius <= 0:
        return mask
    out = mask.copy()
    for r in range(1, radius + 1):
        out[:, r:] |= mask[:, :-r]
        out[:, :-r] |= mask[:, r:]
        out[r:, :] |= mask[:-r, :]
        out[:-r, :] |= mask[r:, :]
    return out


# ---------------------------------------------------------------------- #
# 标签方案
# ---------------------------------------------------------------------- #
def plan_all_labels(
    model,
    font: ImageFont.ImageFont,
    pad: int = 4,
) -> dict[int, LabelPlan]:
    """给模型里每个非背景区域生成一份 LabelPlan。

    背景（左上角所在连通块）在涂色页里不填色，不画数字。
    按面积从大到小规划，先确定大区域标签，小区域/外部标签避让它们。
    """
    plans: dict[int, LabelPlan] = {}
    occupied: list[tuple[int, int, int, int]] = []
    ordered = sorted(
        (lid for lid in model.regions if lid != model.background_id),
        key=lambda lid: model.regions[lid].area,
        reverse=True,
    )
    for lid in ordered:
        text = str(model.color_number(lid))
        tw, th = measure_text(font, text)
        box_w, box_h = tw + pad * 2, th + pad * 2
        plan = plan_region_label(
            model.labels,
            lid,
            text,
            box_w,
            box_h,
            manual_anchor=model.manual_anchors.get(lid),
            occupied_rects=occupied,
        )
        plans[lid] = plan
        occupied.append((plan.anchor[0], plan.anchor[1], box_w, box_h))
    # 外部标签之间再做一次碰撞消解兜底
    resolve_label_overlaps(
        plans,
        (model.width, model.height),
        region_bboxes={lid: r.bbox for lid, r in model.regions.items()},
        region_ids=set(model.regions),
    )
    return plans


# ---------------------------------------------------------------------- #
# 视图渲染
# ---------------------------------------------------------------------- #
def _flat_color_image(model) -> np.ndarray:
    """按当前标签图和区域颜色生成（合并后的）纯色方案图。"""
    h, w = model.labels.shape
    rgb = np.zeros((h, w, 3), dtype=np.uint8)
    for lid, region in model.regions.items():
        rgb[model.labels == lid] = region.color
    return rgb


def render_view(
    model,
    view: str,
    font: ImageFont.ImageFont,
    *,
    show_labels: bool = True,
    line_width: int = 2,
    selected: set[int] | None = None,
    plans: dict[int, LabelPlan] | None = None,
) -> Image.Image:
    """渲染三种视图之一，输出尺寸与原图完全一致。"""
    h, w = model.height, model.width
    selected = selected or set()

    if view == VIEW_ORIGINAL:
        base = model.source_image.copy().convert("RGB")
    elif view == VIEW_COLOR:
        base = Image.fromarray(_flat_color_image(model), mode="RGB")
    else:  # VIEW_LINE：黑白稿
        base = Image.new("RGB", (w, h), (255, 255, 255))

    draw = ImageDraw.Draw(base)

    # 边界（原图视图保持原样，不描边）
    if view in (VIEW_COLOR, VIEW_LINE):
        borders = dilate_mask(boundary_mask(model.labels), max(0, line_width // 2))
        arr = np.asarray(base).copy()
        arr[borders] = BOUNDARY_COLOR
        base = Image.fromarray(arr, mode="RGB")
        draw = ImageDraw.Draw(base)

    # 选中高亮：选中区域盖一层半透明橙色
    if selected:
        sel_mask = np.isin(model.labels, list(selected))
        orange = np.array(HIGHLIGHT_COLOR, dtype=np.uint8)
        arr = np.asarray(base).copy().astype(np.float32)
        factor = np.where(sel_mask[..., None], 0.45, 0.0)
        arr = arr * (1 - factor) + orange * factor
        base = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), mode="RGB")
        draw = ImageDraw.Draw(base)

    # 数字标签 + 引线
    if show_labels and view != VIEW_ORIGINAL:
        if plans is None:
            plans = plan_all_labels(model, font)
        _draw_labels(draw, plans, font, view, selected)

    return base


def _draw_labels(
    draw: ImageDraw.Draw,
    plans: dict[int, LabelPlan],
    font: ImageFont.ImageFont,
    view: str,
    selected: set[int],
) -> None:
    for plan in plans.values():
        x, y = plan.anchor
        box_w, box_h = plan.box_size

        # 引线：从文字框朝向区域的那条边的中点，连到区域内落点
        if not plan.inside and plan.leader_to is not None:
            lx, ly = plan.leader_to
            cx_box = x + box_w // 2
            cy_box = y + box_h // 2
            # 按引线点相对框中心的方位，选框边上的起点
            dx = lx - cx_box
            dy = ly - cy_box
            if abs(dx) * box_h >= abs(dy) * box_w:
                # 水平方向为主：从左/右边中点出发
                edge_x = x if dx < 0 else x + box_w - 1
                edge_y = cy_box
            else:
                # 垂直方向为主：从上/下边中点出发
                edge_x = cx_box
                edge_y = y if dy < 0 else y + box_h - 1
            line_color = UNFIT_COLOR if not plan.fits else (0, 0, 0)
            draw.line(
                [(edge_x, edge_y), (lx, ly)],
                fill=line_color,
                width=2,
            )
            draw.ellipse(
                [lx - 3, ly - 3, lx + 3, ly + 3],
                fill=line_color,
            )

        # 文字衬底：黑白稿白底，彩色方案图半透明白底保证可读
        if view == VIEW_LINE:
            draw.rectangle(
                [x, y, x + box_w - 1, y + box_h - 1],
                fill=(255, 255, 255),
                outline=UNFIT_COLOR if not plan.fits else (120, 120, 120),
            )
            text_color = UNFIT_COLOR if not plan.fits else (0, 0, 0)
        else:
            draw.rectangle(
                [x, y, x + box_w - 1, y + box_h - 1],
                fill=(255, 255, 255),
            )
            text_color = (0, 0, 0)

        if plan.region_id in selected:
            draw.rectangle(
                [x - 1, y - 1, x + box_w, y + box_h],
                outline=HIGHLIGHT_COLOR,
                width=2,
            )

        if hasattr(font, "getbbox"):
            left, top, right, bottom = font.getbbox(plan.text)
            tx = x + (box_w - (right - left)) // 2 - left
            ty = y + (box_h - (bottom - top)) // 2 - top
        else:
            tw, th = measure_text(font, plan.text)
            tx = x + (box_w - tw) // 2
            ty = y + (box_h - th) // 2
        draw.text((tx, ty), plan.text, fill=text_color, font=font)


# ---------------------------------------------------------------------- #
# 导出
# ---------------------------------------------------------------------- #
def export_line_art(
    model,
    path: str | Path,
    font: ImageFont.ImageFont,
    *,
    line_width: int = 2,
    plans: dict[int, LabelPlan] | None = None,
) -> Path:
    """导出与原图同尺寸的黑白涂色稿（含数字与引线）。"""
    image = render_view(
        model,
        VIEW_LINE,
        font,
        show_labels=True,
        line_width=line_width,
        plans=plans,
    )
    path = Path(path)
    image.save(path)
    return path


def export_reference(
    model,
    path: str | Path,
    font: ImageFont.ImageFont,
    *,
    line_width: int = 2,
    plans: dict[int, LabelPlan] | None = None,
) -> Path:
    """导出与原图同尺寸的彩色参考图（含边界与数字）。"""
    image = render_view(
        model,
        VIEW_COLOR,
        font,
        show_labels=True,
        line_width=line_width,
        plans=plans,
    )
    path = Path(path)
    image.save(path)
    return path
