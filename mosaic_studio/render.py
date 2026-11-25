"""用 Pillow 渲染马赛克预览图和导出成品。

支持三种定位视图：
- final:      正常马赛克；
- similarity: 按距离绿-黄-红热力着色，可额外圈出最差的若干格；
- source:     按样块来源分组着色，或只高亮某一个来源（其余压暗）。

未匹配格统一画深红斜纹，固定格画蓝色边框，选中格/最差格画高亮框。
"""
from __future__ import annotations

import colorsys
import zlib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from PIL import Image, ImageDraw

from .session import MosaicSession

BG = (28, 28, 34)


@dataclass
class RenderOptions:
    mode: str = "final"             # final | similarity | source
    selected: int | None = None
    highlight_source: str | None = None   # source 模式下只高亮该来源分组
    highlight_tile: str | None = None     # 只高亮某一块具体样块的使用位置
    worst_cells: set[int] = field(default_factory=set)
    show_grid: bool = True
    show_fixed: bool = True
    preview: bool = True            # True 用缩略图，False 导出走原图高清裁切
    cell_px: int | None = None      # 显式指定每格像素


def group_color(group: str) -> tuple[int, int, int]:
    h = (zlib.crc32(group.encode("utf-8")) % 360) / 360.0
    r, g, b = colorsys.hsv_to_rgb(h, 0.42, 0.95)
    return int(r * 255), int(g * 255), int(b * 255)


def heat_color(t: float) -> tuple[int, int, int]:
    """t∈[0,1]：0 绿（相似）→ 0.5 黄 → 1 红（差异大）。"""
    t = max(0.0, min(1.0, t))
    if t < 0.5:
        k = t / 0.5
        return int(60 + (235 - 60) * k), int(195 + (200 - 195) * k), 90
    k = (t - 0.5) / 0.5
    return 235, int(200 - 140 * k), int(90 - 40 * k)


def heat_t(distance: float | None) -> float:
    if distance is None:
        return 1.0
    # 实际距离大多落在 0.05~0.45，按 0.45 封顶让差异肉眼可辨。
    return max(0.0, min(1.0, distance / 0.45))


def resolve_cell_px(session: MosaicSession, options: RenderOptions,
                    max_side: int = 1500) -> int:
    if options.cell_px:
        return max(2, int(options.cell_px))
    assert session.grid is not None
    longest = max(session.grid.cols, session.grid.rows)
    if options.preview:
        return max(6, min(110, max_side // longest))
    return max(16, 3600 // longest)


def _sprite(tile, px: int, cache: dict, preview: bool) -> Image.Image:
    key = (tile.id, px, preview)
    if key in cache:
        return cache[key]
    if preview:
        src = tile.thumb.convert("RGB")
        if src.width != px:
            spr = src.resize((px, px), Image.Resampling.BILINEAR)
        else:
            spr = src.copy()
    else:
        spr = tile.tile_image(px)
    cache[key] = spr
    return spr


def _draw_hatch(base: Image.Image, x0: int, y0: int, s: int) -> None:
    d = ImageDraw.Draw(base)
    d.rectangle((x0, y0, x0 + s, y0 + s), fill=(74, 26, 34))
    step = max(8, s // 4)
    for k in range(-s, 2 * s, step):
        d.line((x0 + k, y0 + s, x0 + k + s, y0),
               fill=(220, 84, 84), width=max(2, s // 18))
    d.rectangle((x0 + 1, y0 + 1, x0 + s - 2, y0 + s - 2),
                outline=(255, 120, 120), width=max(1, s // 24))


def render_mosaic(session: MosaicSession,
                  options: RenderOptions | None = None,
                  max_side: int = 1500,
                  progress_cb: Callable[[int, int], None] | None = None,
                  ) -> tuple[Image.Image, int]:
    """返回 (RGB 图, 每格像素)。必须已有求解结果。"""
    if session.grid is None or session.result is None:
        raise RuntimeError("请先载入素材并完成计算")
    options = options or RenderOptions()
    g = session.grid
    res = session.result
    s = resolve_cell_px(session, options, max_side=max_side)
    width, height = g.cols * s, g.rows * s

    canvas = Image.new("RGB", (width, height), BG)
    sprite_cache: dict = {}

    total = g.count
    for o in res.outcomes:
        x0, y0 = o.col * s, o.row * s
        if o.tile is not None:
            tile = session.tiles[o.tile]
            spr = _sprite(tile, s, sprite_cache, options.preview)
            canvas.paste(spr, (x0, y0))
        else:
            _draw_hatch(canvas, x0, y0, s)
        if progress_cb and (o.cell % 50 == 0 or o.cell == total - 1):
            progress_cb(o.cell + 1, total)

    # 半透明叠加层：热力 / 来源着色 / 网格 / 框线一次合成。
    overlay = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)

    for o in res.outcomes:
        x0, y0 = o.col * s, o.row * s
        x1, y1 = x0 + s - 1, y0 + s - 1

        if options.mode == "similarity":
            color = heat_color(heat_t(o.cost))
            od.rectangle((x0, y0, x1, y1), fill=color + (100,))
        elif options.mode == "source" and o.tile is not None:
            tile = session.tiles[o.tile]
            if options.highlight_tile:
                if tile.id == options.highlight_tile:
                    od.rectangle((x0, y0, x1, y1),
                                 outline=(255, 230, 90, 255),
                                 width=max(3, s // 12))
                else:
                    od.rectangle((x0, y0, x1, y1), fill=(20, 22, 30, 175))
            elif options.highlight_source:
                if tile.source_group == options.highlight_source:
                    od.rectangle((x0, y0, x1, y1),
                                 outline=(255, 230, 90, 255),
                                 width=max(2, s // 14))
                else:
                    od.rectangle((x0, y0, x1, y1), fill=(20, 22, 30, 165))
            else:
                color = group_color(tile.source_group)
                od.rectangle((x0, y0, x1, y1), fill=color + (120,))

        if options.show_fixed and o.fixed:
            w = max(2, s // 14)
            od.rectangle((x0 + w // 2, y0 + w // 2,
                          x1 - w // 2, y1 - w // 2),
                         outline=(64, 196, 255, 255), width=w)
            # 左上角小实心块，表示“钉子”。
            pin = max(6, s // 5)
            od.rectangle((x0, y0, x0 + pin, y0 + pin),
                         fill=(64, 196, 255, 235))

        if o.cell in options.worst_cells:
            w = max(3, s // 10)
            od.rectangle((x0 + w, y0 + w, x1 - w, y1 - w),
                         outline=(255, 196, 40, 255), width=w)

        if options.selected == o.cell:
            w = max(3, s // 9)
            od.rectangle((x0 + 1, y0 + 1, x1 - 1, y1 - 1),
                         outline=(255, 255, 255, 255), width=w)

    if options.show_grid and s >= 16:
        step_alpha = 70 if options.mode == "final" else 40
        for c in range(g.cols + 1):
            x = c * s
            od.line((x, 0, x, height), fill=(0, 0, 0, step_alpha), width=1)
        for r in range(g.rows + 1):
            y = r * s
            od.line((0, y, width, y), fill=(0, 0, 0, step_alpha), width=1)

    canvas = Image.alpha_composite(canvas.convert("RGBA"), overlay).convert("RGB")
    return canvas, s


def export_final_image(session: MosaicSession, out_path: str | Path,
                       long_edge: int = 3600,
                       progress_cb: Callable[[int, int], None] | None = None
                       ) -> tuple[Path, int, tuple[int, int]]:
    """高清导出成品（final 视图、不走缩略图缓存）。"""
    if session.grid is None:
        raise RuntimeError("没有可导出的作品")
    longest = max(session.grid.cols, session.grid.rows)
    cell_px = max(24, long_edge // longest)
    # 防止极端格子数撑爆内存：长边硬上限 12000px。
    if cell_px * longest > 12000:
        cell_px = 12000 // longest
    options = RenderOptions(mode="final", preview=False,
                            cell_px=cell_px, show_grid=False)
    img, used_px = render_mosaic(session, options, progress_cb=progress_cb)
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    if out_path.suffix.lower() in (".jpg", ".jpeg"):
        img.save(out_path, quality=92, subsampling=1)
    else:
        if out_path.suffix.lower() != ".png":
            out_path = out_path.with_suffix(".png")
        img.save(out_path, format="PNG")
    return out_path, used_px, img.size
