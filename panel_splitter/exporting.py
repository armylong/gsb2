"""按原图像素裁边导出。

要点:
- 裁剪坐标一律来自模型里的原图像素矩形, 显示缩放完全不参与计算;
- 留边 margin_px 只在原图坐标系外扩, 并夹到图像边界内;
- 导出顺序清单 (manifest) 与每张小图一一对应, 含像素坐标和跨行标记;
- 回查图把裁框、序号、方向画回原图, 方便人工核对。
"""

from __future__ import annotations

import csv
import json
import os
from dataclasses import dataclass

import cv2
import numpy as np

from .ordering import OrderInfo

Rect = tuple[int, int, int, int]


@dataclass
class ExportItem:
    seq: int  # 1 起的阅读序号
    panel_index: int
    rect: Rect
    filename: str
    spanning: bool
    band: int


def _padded_rect(rect: Rect, margin: int, page_w: int, page_h: int) -> Rect:
    x0, y0, x1, y1 = rect
    return (
        max(0, x0 - margin),
        max(0, y0 - margin),
        min(page_w, x1 + margin),
        min(page_h, y1 + margin),
    )


def build_export_items(
    panels: list[Rect],
    order_info: OrderInfo,
    margin_px: int,
    page_w: int,
    page_h: int,
    order_override: list[int] | None = None,
) -> list[ExportItem]:
    band_of: dict[int, int] = {}
    for bi, ids in order_info.bands:
        for i in ids:
            band_of[i] = bi

    # 手工拖序优先; 否则用自动阅读顺序
    seq_order = (
        order_override
        if order_override is not None
        else order_info.order
        if order_info.order
        else list(range(len(panels)))
    )
    items: list[ExportItem] = []
    for seq, idx in enumerate(seq_order, start=1):
        rect = _padded_rect(panels[idx], margin_px, page_w, page_h)
        items.append(
            ExportItem(
                seq=seq,
                panel_index=idx,
                rect=rect,
                filename=f"panel_{seq:03d}.png",
                spanning=idx in order_info.spanning,
                band=band_of.get(idx, -1),
            )
        )
    return items


def export_panels(
    image_bgr: np.ndarray,
    panels: list[Rect],
    order_info: OrderInfo,
    out_dir: str,
    *,
    margin_px: int = 0,
    prefix: str = "panel",
    order_override: list[int] | None = None,
) -> tuple[list[ExportItem], str, str]:
    """裁图 + 写清单 + 画回查图。返回 (items, manifest 路径, 回查图路径)。

    order_override 给定时 (通常是 PageModel.manual_order), 导出顺序以它为准。
    """
    page_h, page_w = image_bgr.shape[:2]
    os.makedirs(out_dir, exist_ok=True)
    items = build_export_items(
        panels, order_info, margin_px, page_w, page_h, order_override
    )

    manifest_rows = []
    for item in items:
        x0, y0, x1, y1 = item.rect
        crop = image_bgr[y0:y1, x0:x1]
        fname = f"{prefix}_{item.seq:03d}.png"
        item.filename = fname
        cv2.imwrite(os.path.join(out_dir, fname), crop)
        manifest_rows.append(
            {
                "seq": item.seq,
                "file": fname,
                "panel_index": item.panel_index,
                "x0": x0,
                "y0": y0,
                "x1": x1,
                "y1": y1,
                "width": x1 - x0,
                "height": y1 - y0,
                "margin_px": margin_px,
                "spanning": item.spanning,
                "band": item.band,
                "direction": order_info.direction,
            }
        )

    manifest_json = os.path.join(out_dir, "manifest.json")
    with open(manifest_json, "w", encoding="utf-8") as f:
        json.dump(
            {
                "direction": order_info.direction,
                "margin_px": margin_px,
                "image_size": [page_w, page_h],
                "count": len(manifest_rows),
                "panels": manifest_rows,
            },
            f,
            ensure_ascii=False,
            indent=2,
        )

    manifest_csv = os.path.join(out_dir, "manifest.csv")
    with open(manifest_csv, "w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=list(manifest_rows[0].keys()))
        writer.writeheader()
        writer.writerows(manifest_rows)

    review_path = os.path.join(out_dir, "review.png")
    review = draw_review(image_bgr, items, order_info)
    cv2.imwrite(review_path, review)
    return items, manifest_json, review_path


def draw_review(
    image_bgr: np.ndarray,
    items: list[ExportItem],
    order_info: OrderInfo,
) -> np.ndarray:
    """回查图: 裁框 + 序号 + 跨行标记 + 方向箭头。"""
    canvas = image_bgr.copy()
    page_h, page_w = canvas.shape[:2]
    font = cv2.FONT_HERSHEY_SIMPLEX
    label_h = max(18, page_h // 45)
    thickness = max(2, page_w // 400)

    for item in items:
        x0, y0, x1, y1 = item.rect
        color = (0, 140, 255) if item.spanning else (60, 180, 75)
        cv2.rectangle(canvas, (x0, y0), (x1 - 1, y1 - 1), color, thickness)
        tag = f"#{item.seq}" + (" T" if item.spanning else "")
        scale = label_h / 30.0
        (tw, th), base = cv2.getTextSize(tag, font, scale, thickness)
        # 贴边时把标签收进框内, 避免被图像边界裁掉
        lx = min(x0 + 4, max(4, page_w - tw - 12))
        ly = min(y0 + th + base + 6, y1 - 4)
        ly = max(ly, th + base + 6)
        cv2.rectangle(
            canvas,
            (lx - 4, ly - th - base),
            (lx + tw + 8, ly + 2),
            (0, 0, 0),
            -1,
        )
        cv2.putText(
            canvas,
            tag,
            (lx, ly - base // 2),
            font,
            scale,
            (255, 255, 255),
            thickness,
            cv2.LINE_AA,
        )

    # 方向标注画在底部留白处, 避免压住左上角面板的序号标签
    arrow = f"reading: {order_info.direction.upper()}  |  " \
            f"{len(items)} panels"
    scale = label_h / 30.0
    (tw, th), base = cv2.getTextSize(arrow, font, scale, thickness)
    cv2.rectangle(
        canvas,
        (8, page_h - th - base - 12),
        (8 + tw + 16, page_h - 6),
        (255, 255, 255),
        -1,
    )
    cv2.putText(
        canvas,
        arrow,
        (16, page_h - base - 10),
        font,
        scale,
        (0, 0, 200),
        thickness,
        cv2.LINE_AA,
    )
    return canvas
