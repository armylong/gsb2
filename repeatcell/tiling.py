"""导出: 单元图、两个平移量 (含小数角点)、以及按原图方向铺回去的比对图。"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional, Tuple

import numpy as np

from .geometry import CellBasis, Vec


# ---------------------------------------------------------------------------
# 单元图 -> 规则网格 / 反过来铺回图像坐标
# ---------------------------------------------------------------------------

def _periodic_sample(img: np.ndarray, ys: np.ndarray, xs: np.ndarray,
                     n: int) -> np.ndarray:
    """在 n x n 的周期图上双线性采样 (坐标可以越界, 自动回绕)。"""
    x0 = np.floor(xs).astype(np.int64)
    y0 = np.floor(ys).astype(np.int64)
    fx = (xs - x0)[..., None]
    fy = (ys - y0)[..., None]
    x0m = np.mod(x0, n)
    y0m = np.mod(y0, n)
    x1m = np.mod(x0 + 1, n)
    y1m = np.mod(y0 + 1, n)
    v00 = img[y0m, x0m]
    v01 = img[y0m, x1m]
    v10 = img[y1m, x0m]
    v11 = img[y1m, x1m]
    top = v00 * (1 - fx) + v01 * fx
    bot = v10 * (1 - fx) + v11 * fx
    return top * (1 - fy) + bot * fy


def tile_region(unit_rgb: np.ndarray, basis: CellBasis,
                region_xywh: Tuple[float, float, float, float],
                supersample: int = 2,
                unit_mask: Optional[np.ndarray] = None,
                gap_overlay: float = 0.75) -> np.ndarray:
    """把单元铺到"原图坐标"下的一个矩形区域。

    region_xywh: 原图坐标中的 (x, y, w, h)。单元按自己的 t1/t2 铺出去, 因此
    画布像素与原图像素一一对应, 可以直接和原图并排比较四个方向的边界。

    ``unit_mask`` 里为 False 的像素是缺口 (原图里没有真实像素), 铺出去时用洋红
    标出, 而不是拿边缘值涂抹 —— 以免把"没有数据"当成"花纹就是这样"。
    """
    x, y, w, h = region_xywh
    out_w = max(1, int(round(w)))
    out_h = max(1, int(round(h)))
    n = unit_rgb.shape[0]
    s = max(1, int(supersample))
    xs = x + (np.arange(out_w * s) + 0.5) / s
    ys = y + (np.arange(out_h * s) + 0.5) / s
    X, Y = np.meshgrid(xs, ys)
    local = basis.to_local(np.stack([X, Y], axis=-1))
    ux = local[..., 0] * n - 0.5
    uy = local[..., 1] * n - 0.5
    rgb = _periodic_sample(unit_rgb.astype(np.float32), uy, ux, n)
    if unit_mask is not None:
        valid = _periodic_sample(
            unit_mask.astype(np.float32)[..., None], uy, ux, n)[..., 0]
        if s > 1:
            rgb = rgb.reshape(out_h, s, out_w, s, 3).mean(axis=(1, 3))
            valid = valid.reshape(out_h, s, out_w, s).mean(axis=(1, 3))
        gap = valid < 0.999
        if gap.any():
            hatch = ((np.add.outer(np.arange(out_h), np.arange(out_w))
                      // 4) % 2 == 0)
            color = np.where(hatch[..., None],
                             np.array([0.95, 0.15, 0.65], dtype=np.float32),
                             np.array([0.48, 0.05, 0.34], dtype=np.float32))
            blend = np.clip((1.0 - valid) * (1.0 / max(gap_overlay, 1e-6)),
                            0.0, 1.0)[..., None]
            rgb = rgb * (1 - blend) + color * blend
        return np.clip(rgb, 0.0, 1.0).astype(np.float32)
    if s > 1:
        rgb = rgb.reshape(out_h, s, out_w, s, 3).mean(axis=(1, 3))
    return np.clip(rgb, 0.0, 1.0).astype(np.float32)


def tile_plane(unit_rgb: np.ndarray, basis: CellBasis,
               out_w: int, out_h: int, origin: Vec = (0.0, 0.0),
               supersample: int = 2) -> np.ndarray:
    """铺一张从 origin 开始的 out_w x out_h 画布 (origin 是单元 (0,0) 角)。"""
    shifted = CellBasis((basis.origin[0] + origin[0],
                         basis.origin[1] + origin[1]), basis.t1, basis.t2)
    return tile_region(unit_rgb, shifted, (origin[0], origin[1],
                                           float(out_w), float(out_h)),
                       supersample)


# ---------------------------------------------------------------------------
# 边界检查
# ---------------------------------------------------------------------------

def boundary_rms(unit_rgb: np.ndarray, axis: int) -> float:
    """单元第 1 圈与对面第 1 圈的 RMS 差 (axis=0 上下, 1 左右)。"""
    u = np.asarray(unit_rgb, dtype=np.float64)
    a = np.take(u, 0, axis=axis)
    b = np.take(u, u.shape[axis] - 1, axis=axis)
    return float(np.sqrt(((a - b) ** 2).mean()))


def wrap_error(unit_rgb: np.ndarray) -> dict:
    """单元作为周期图时, 上下/左右两对边的接缝误差。"""
    return {
        "vertical": boundary_rms(unit_rgb, 0),
        "horizontal": boundary_rms(unit_rgb, 1),
        "note": "边界对不上通常说明单元里还混着样本色差/磨损, 不一定是周期错。",
    }


# ---------------------------------------------------------------------------
# 输出
# ---------------------------------------------------------------------------

def to_uint8(rgb: np.ndarray) -> np.ndarray:
    return np.clip(np.round(np.asarray(rgb, dtype=np.float64) * 255.0), 0, 255
                   ).astype(np.uint8)


def save_png(path: Path, rgb: np.ndarray, mask: Optional[np.ndarray] = None,
             gap_color: Tuple[int, int, int] = (255, 0, 200),
             with_alpha: bool = False) -> None:
    """保存 PNG; mask 为 False 的缺口用醒目颜色标出。

    ``with_alpha=True`` 时把 mask 写成 alpha 通道: 缺口完全透明, 原始颜色保留
    (便于在别的软件里直接当作带透明边的单元使用)。
    """
    from PIL import Image
    arr = to_uint8(rgb)
    if mask is not None and with_alpha:
        alpha = np.where(mask, 255, 0).astype(np.uint8)
        rgba = np.dstack([arr, alpha])
        Image.fromarray(rgba, mode="RGBA").save(path)
        return
    if mask is not None and not np.all(mask):
        arr = arr.copy()
        arr[~mask] = np.array(gap_color, dtype=np.uint8)
    Image.fromarray(arr).save(path)


def _draw_corner_marks(canvas: np.ndarray, basis: CellBasis,
                       region_xywh: Tuple[float, float, float, float],
                       offset_x: int = 0, max_marks: int = 48) -> None:
    """在平铺画布上稀疏地标出单元角点 (小数角点用红色)。

    周期很小的图案格点多到会糊掉画面, 所以按格点总数抽稀, 只标一部分;
    标记画成 1 像素的十字, 不遮挡内容。
    """
    x0, y0, w, h = region_xywh
    M = basis.matrix
    o = np.array(basis.origin, dtype=float)
    inv = np.linalg.inv(M)
    corners = np.array([[x0, y0], [x0 + w, y0], [x0, y0 + h], [x0 + w, y0 + h]])
    rel = (corners - o) @ inv.T
    i_lo = int(np.floor(rel[:, 0].min())) - 1
    i_hi = int(np.ceil(rel[:, 0].max())) + 1
    j_lo = int(np.floor(rel[:, 1].min())) - 1
    j_hi = int(np.ceil(rel[:, 1].max())) + 1
    total = max(1, (i_hi - i_lo + 1) * (j_hi - j_lo + 1))
    stride = max(1, int(np.ceil(np.sqrt(total / float(max_marks)))))
    count = 0
    for i in range(i_lo, i_hi + 1, stride):
        for j in range(j_lo, j_hi + 1, stride):
            p = o + i * M[:, 0] + j * M[:, 1]
            sx = int(round(p[0] - x0))
            sy = int(round(p[1] - y0))
            if not (0 <= sx < w and 0 <= sy < h):
                continue
            count += 1
            if count > max_marks:
                return
            frac = (abs(p[0] - round(p[0])) > 1e-6
                    or abs(p[1] - round(p[1])) > 1e-6)
            color = (255, 70, 70) if frac else (40, 220, 220)
            px = offset_x + sx
            for dy, dx in ((0, 0), (-1, 0), (1, 0), (0, -1), (0, 1)):
                yy, xx = sy + dy, px + dx
                if 0 <= yy < canvas.shape[0] and 0 <= xx < canvas.shape[1]:
                    canvas[yy, xx] = color


@dataclass
class ExportResult:
    unit_path: Path
    compare_path: Path
    json_path: Path
    unit_alpha_path: Optional[Path] = None
    tiled_path: Optional[Path] = None
    warnings: List[str] = field(default_factory=list)


def export_cell(out_dir: str | Path,
                unit_rgb: np.ndarray,
                unit_mask: np.ndarray,
                basis: CellBasis,
                source_image: np.ndarray,
                source_name: str = "image",
                compare_cells: int = 4,
                extra: Optional[dict] = None) -> ExportResult:
    """导出单元图、比对图和描述两个平移量的 JSON。

    * ``unit.png``    – 单元重采样图; 缺口用洋红标出, 不做涂抹填充
    * ``compare.png`` – 左边原图裁切, 右边用同样的方向和步长铺回去, 便于看四个边界
    * ``tiled.png``   – 右边那张平铺图 (单独保存)
    * ``cell.json``   – origin / t1 / t2 (小数像素原样保留) 与角点信息
    """
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    warnings: List[str] = []

    unit_path = out_dir / "unit.png"
    save_png(unit_path, unit_rgb, unit_mask)
    unit_alpha_path = out_dir / "unit_alpha.png"
    save_png(unit_alpha_path, unit_rgb, unit_mask, with_alpha=True)

    h_src, w_src = source_image.shape[:2]
    # 比对区域: 以当前单元为中心, 覆盖 compare_cells 个周期左右
    span_x = abs(basis.t1[0]) + abs(basis.t2[0])
    span_y = abs(basis.t1[1]) + abs(basis.t2[1])
    cw = int(min(max(220, compare_cells * span_x), 900, w_src))
    ch = int(min(max(220, compare_cells * span_y), 900, h_src))
    cx = int(round(basis.origin[0]))
    cy = int(round(basis.origin[1]))
    x0 = int(np.clip(cx - cw // 2, 0, max(0, w_src - cw)))
    y0 = int(np.clip(cy - ch // 2, 0, max(0, h_src - ch)))
    region = (float(x0), float(y0), float(cw), float(ch))

    tiled = tile_region(unit_rgb, basis, region, supersample=2,
                        unit_mask=unit_mask)
    src = np.clip(np.asarray(source_image, dtype=np.float32), 0.0, 1.0)
    left = src[y0:y0 + ch, x0:x0 + cw]
    if left.shape[0] != ch or left.shape[1] != cw:  # 边缘裁齐
        pad = np.zeros((ch, cw, 3), dtype=np.float32)
        pad[:left.shape[0], :left.shape[1]] = left
        left = pad
    gap = np.ones((ch, 4, 3), dtype=np.float32)
    right = tiled.copy()
    _draw_corner_marks(right, basis, region)
    compare = np.concatenate([left, gap, right], axis=1)
    compare_path = out_dir / "compare.png"
    save_png(compare_path, compare)
    tiled_path = out_dir / "tiled.png"
    save_png(tiled_path, right)

    corners = basis.corners()
    frac = corners - np.floor(corners)
    fractional = bool(np.any(np.abs(frac) > 1e-6))
    if fractional:
        warnings.append("单元角点含小数像素; JSON 保留原始小数坐标, 未取整。")
    if not unit_mask.all():
        warnings.append(
            f"单元有 {(~unit_mask).mean() * 100:.1f}% 的像素在图外, 已标为洋红缺口。")

    payload = {
        "source": source_name,
        "unit": {
            "path": unit_path.name,
            "alpha_path": unit_alpha_path.name,
            "width": int(unit_rgb.shape[1]),
            "height": int(unit_rgb.shape[0]),
            "coverage": float(unit_mask.mean()),
        },
        "cell": basis.as_dict(),
        "t1": [float(basis.t1[0]), float(basis.t1[1])],
        "t2": [float(basis.t2[0]), float(basis.t2[1])],
        "corners": [[float(px), float(py)] for px, py in corners],
        "corners_fractional": fractional,
        "compare": {
            "path": compare_path.name,
            "region_xywh": [x0, y0, cw, ch],
            "layout": "左: 原图裁切; 右: 单元按 t1/t2 铺回同一坐标",
            "corner_marks": "青色=整数角点, 红色=小数角点",
        },
        "wrap_error": wrap_error(unit_rgb),
        "warnings": warnings,
    }
    if extra:
        payload.update(extra)
    json_path = out_dir / "cell.json"
    json_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2),
                         encoding="utf-8")
    return ExportResult(unit_path, compare_path, json_path,
                        unit_alpha_path, tiled_path, warnings)


def suggested_complete_cell(basis: CellBasis, img_w: int, img_h: int
                            ) -> Optional[CellBasis]:
    """找一个完整落在图内的等价单元 (没有就返回 None)。"""
    from .geometry import choose_complete_cell
    return choose_complete_cell(basis, img_w, img_h)
