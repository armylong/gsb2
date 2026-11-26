"""核心逻辑: 调色板图像、三套像素旋转引擎、统计分析与往返自检。

坐标约定
========
连续坐标以 *格点* 为整数: 第 r 行第 c 列像素的中心在 (x=c+0.5, y=r+0.5),
像素四角是整数坐标点。角度正方向为屏幕顺时针 (y 轴向下)。

旋转中心两种典型落点:
- 像素中心: 坐标两个分量都是 x.5
- 像素之间的角点(格点): 两个分量都是整数
本模块对任意浮点中心都能算, 但 90° 倍数的无损往返只在上述两种格点下成立。

所有引擎都只搬运原有色号, 不产生新颜色; 透明格保持透明。
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from PIL import Image

# ---------------------------------------------------------------------------
# 数据模型
# ---------------------------------------------------------------------------

TRANSPARENT = -1

FORWARD_NN = "forward_nn"   # 正向最近像素: 源像素直接投到最近目标格
INVERSE_NN = "inverse_nn"   # 反向最近像素: 目标格回查最近源像素
SSAA = "ssaa"               # 保轮廓: 超采样面积占优
METHODS = (FORWARD_NN, INVERSE_NN, SSAA)
METHOD_LABELS = {
    FORWARD_NN: "正向最近像素",
    INVERSE_NN: "反向最近像素",
    SSAA: "保轮廓(超采样面积占优)",
}

EXPAND = "expand"
FIXED = "fixed"
CANVAS_MODES = (EXPAND, FIXED)


@dataclass
class PaletteImage:
    """低色数透明图。indices 中 -1 表示透明, 其余值是 palette 的下标。"""

    indices: np.ndarray  # shape (H, W), dtype int16
    palette: list[tuple[int, int, int, int]]  # 每个色号一个 RGBA
    path: str | None = None
    source_mode: str = "P"  # 原图是 P 模式还是 RGBA

    @property
    def width(self) -> int:
        return self.indices.shape[1]

    @property
    def height(self) -> int:
        return self.indices.shape[0]

    @property
    def size(self) -> tuple[int, int]:
        return self.width, self.height

    def opaque_mask(self) -> np.ndarray:
        return self.indices != TRANSPARENT

    def copy(self) -> "PaletteImage":
        return PaletteImage(
            self.indices.copy(),
            list(self.palette),
            self.path,
            self.source_mode,
        )


def load_png(path: str | Path) -> PaletteImage:
    """导入透明低色数 PNG。P 模式保留原色号表, RGBA 模式按出现顺序编号。"""
    path = str(path)
    im = Image.open(path)
    if im.mode == "P":
        rgba = im.convert("RGBA")
        raw = np.asarray(im)
        transparency = im.info.get("transparency")
        transparent_indices: set[int] = set()
        if isinstance(transparency, int):
            transparent_indices.add(transparency)
        elif isinstance(transparency, (bytes, bytearray)):
            transparent_indices = {i for i, a in enumerate(transparency) if a == 0}
        # Pillow 保存时可能重排过调色板, 因此按调色板的实际 RGBA 值重建,
        # 不假设磁盘上的色号与内存中的一致
        pal_colors: dict[int, tuple[int, int, int, int]] = {}
        for raw_idx in sorted(int(v) for v in np.unique(raw)):
            if raw_idx in transparent_indices:
                continue
            ys, xs = np.nonzero(raw == raw_idx)
            pal_colors[raw_idx] = tuple(
                int(v) for v in rgba.getpixel((int(xs[0]), int(ys[0])))
            )
        ordered = sorted(pal_colors.items(), key=lambda kv: kv[1])
        palette = [color for _idx, color in ordered]
        color_to_new = {color: i for i, color in enumerate(palette)}
        indices = np.full(raw.shape, TRANSPARENT, dtype=np.int16)
        for raw_idx, color in pal_colors.items():
            indices[raw == raw_idx] = color_to_new[color]
        for raw_idx in transparent_indices:
            indices[raw == raw_idx] = TRANSPARENT
        return PaletteImage(indices, palette, path=path, source_mode="P")

    rgba = im.convert("RGBA")
    arr = np.asarray(rgba)
    return _palette_from_rgba(arr, path)


def _palette_from_rgba(arr: np.ndarray, path: str | None) -> PaletteImage:
    h, w = arr.shape[:2]
    flat = arr.reshape(-1, 4)
    opaque = flat[flat[:, 3] != 0]
    # 按 (RGBA) 字典序编号, 保证可复现
    colors = [tuple(int(v) for v in c) for c in np.unique(opaque, axis=0)]
    indices = np.full(h * w, TRANSPARENT, dtype=np.int16)
    if colors:
        lookup = {c: i for i, c in enumerate(colors)}
        for i, c in enumerate(flat):
            if c[3] == 0:
                continue
            indices[i] = lookup[tuple(int(v) for v in c)]
    return PaletteImage(indices.reshape(h, w), colors, path=path, source_mode="RGBA")


def save_png(path: str | Path, img: PaletteImage) -> None:
    """导出 PNG。色数 <=255 时写 P 模式(保留色号表), 否则写 RGBA。"""
    path = str(path)
    n = len(img.palette)
    if n <= 255:
        flat_pal = [0] * (256 * 3)
        for i, (r, g, b, _a) in enumerate(img.palette):
            flat_pal[i * 3 : i * 3 + 3] = [r, g, b]
        # 选一个未使用的色号作为全透明色
        used = set(int(v) for v in np.unique(img.indices[img.indices != TRANSPARENT]))
        trans_idx = next(i for i in range(255, -1, -1) if i not in used)
        raw = np.full(img.indices.shape, trans_idx, dtype=np.uint8)
        mask = img.indices != TRANSPARENT
        raw[mask] = img.indices[mask].astype(np.uint8)
        out = Image.fromarray(raw, mode="P")
        out.putpalette(flat_pal)
        out.info["transparency"] = trans_idx
        out.save(path, optimize=True)
    else:
        Image.fromarray(to_rgba_array(img), "RGBA").save(path)


def to_rgba_array(img: PaletteImage) -> np.ndarray:
    h, w = img.indices.shape
    out = np.zeros((h, w, 4), dtype=np.uint8)
    for i, color in enumerate(img.palette):
        out[img.indices == i] = color
    return out


# ---------------------------------------------------------------------------
# 几何
# ---------------------------------------------------------------------------


def rotate_points(
    points: np.ndarray, center: tuple[float, float], theta_deg: float
) -> np.ndarray:
    """屏幕顺时针旋转。points shape (..., 2) 的 (x, y) 连续坐标。"""
    theta = math.radians(theta_deg)
    c, s = math.cos(theta), math.sin(theta)
    cx, cy = center
    p = np.asarray(points, dtype=np.float64)
    dx = p[..., 0] - cx
    dy = p[..., 1] - cy
    x = cx + c * dx - s * dy
    y = cy + s * dx + c * dy
    return np.stack([x, y], axis=-1)


def frame_corners(width: int, height: int) -> np.ndarray:
    """原画框四个角点 (整数格点), 顺序: 左上、右上、右下、左下。"""
    return np.array(
        [(0.0, 0.0), (float(width), 0.0), (float(width), float(height)), (0.0, float(height))]
    )


def pixel_centers(width: int, height: int) -> np.ndarray:
    ys, xs = np.meshgrid(
        np.arange(height, dtype=np.float64) + 0.5,
        np.arange(width, dtype=np.float64) + 0.5,
        indexing="ij",
    )
    return np.stack([xs, ys], axis=-1)


def _output_geometry(
    img: PaletteImage,
    center: tuple[float, float],
    theta_deg: float,
    canvas_mode: str,
    fixed_size: tuple[int, int] | None,
) -> tuple[int, int, float, float]:
    """返回 (out_w, out_h, origin_x, origin_y); origin 是输出格网在旋转后坐标系中的左下... 不, 左上角点。"""
    if canvas_mode == FIXED:
        if fixed_size is None:
            return img.width, img.height, 0.0, 0.0
        fw, fh = fixed_size
        return fw, fh, 0.0, 0.0
    corners = rotate_points(frame_corners(img.width, img.height), center, theta_deg)
    min_x, min_y = corners[:, 0].min(), corners[:, 1].min()
    max_x, max_y = corners[:, 0].max(), corners[:, 1].max()
    origin_x = math.floor(min_x)
    origin_y = math.floor(min_y)
    out_w = int(math.ceil(max_x) - origin_x)
    out_h = int(math.ceil(max_y) - origin_y)
    return out_w, out_h, float(origin_x), float(origin_y)


def point_in_polygon(points: np.ndarray, polygon: np.ndarray) -> np.ndarray:
    """射线法。points (N,2), polygon (K,2), 返回 bool (N,)。"""
    pts = np.asarray(points, dtype=np.float64)
    poly = np.asarray(polygon, dtype=np.float64)
    inside = np.zeros(len(pts), dtype=bool)
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % n]
        cross = ((y1 > pts[:, 1]) != (y2 > pts[:, 1]))
        x_hit = (x2 - x1) * (pts[:, 1] - y1) / (y2 - y1 + 1e-18) + x1
        inside ^= cross & (pts[:, 0] < x_hit)
    return inside


# ---------------------------------------------------------------------------
# 旋转结果与统计
# ---------------------------------------------------------------------------


@dataclass
class Hole:
    size: int
    centroid: tuple[float, float]  # 连续坐标(输出格网)


@dataclass
class RotationStats:
    pixel_count: int
    color_counts: dict[int, int]
    components: int
    component_sizes: list[int]
    holes: list[Hole]
    bbox: tuple[int, int, int, int] | None  # x0,y0,x1,y1 (像素列行, 半开)
    border_contacts: list[str]  # 'left'/'right'/'top'/'bottom'
    colors_used: list[int]


@dataclass
class ROIResult:
    name: str
    polygon: list[tuple[float, float]]  # 输出格网坐标
    pixels: int
    components: int
    holes: int
    hole_sizes: list[int]
    colors_used: list[int]
    changed: bool
    note: str = ""


@dataclass
class RotationResult:
    method: str
    angle: float
    center: tuple[float, float]
    center_out: tuple[float, float]
    canvas_mode: str
    image: PaletteImage
    origin: tuple[float, float]
    frame_quad: np.ndarray  # 旋转后原画框四角, 输出格网坐标
    outside_pixels: int     # 固定画布下被裁掉的源像素数
    collisions: int         # 多个源像素挤进同一格的次数
    stats: RotationStats
    roi_results: list[ROIResult]
    outside_frame_mask: np.ndarray  # 扩画布: 落在原画框之外的像素
    border_mask: np.ndarray         # 贴输出画布边的像素
    params: dict = field(default_factory=dict)


def label_components(mask: np.ndarray) -> tuple[np.ndarray, int]:
    """4 连通标记, 不依赖 scipy。返回 (labels, 数量)。"""
    h, w = mask.shape
    labels = np.full((h, w), -1, dtype=np.int32)
    parent: list[int] = []

    def find(a: int) -> int:
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    def union(a: int, b: int) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[max(ra, rb)] = min(ra, rb)

    next_label = 0
    for r in range(h):
        for c in range(w):
            if not mask[r, c]:
                continue
            neigh = []
            if r > 0 and labels[r - 1, c] >= 0:
                neigh.append(labels[r - 1, c])
            if c > 0 and labels[r, c - 1] >= 0:
                neigh.append(labels[r, c - 1])
            if not neigh:
                parent.append(next_label)
                labels[r, c] = next_label
                next_label += 1
            else:
                lab = min(find(x) for x in neigh)
                labels[r, c] = lab
                for x in neigh:
                    union(lab, x)
    # 压实标签
    remap: dict[int, int] = {}
    out = np.full_like(labels, -1)
    for r in range(h):
        for c in range(w):
            if labels[r, c] < 0:
                continue
            root = find(labels[r, c])
            if root not in remap:
                remap[root] = len(remap)
            out[r, c] = remap[root]
    return out, len(remap)


def find_holes(mask: np.ndarray) -> list[Hole]:
    """背景 4 连通域中不接触画布边的就是孔洞。"""
    h, w = mask.shape
    background = ~mask
    labels, n = label_components(background)
    if n == 0:
        return []
    touches = set()
    if h > 0 and w > 0:
        touches.update(int(v) for v in labels[0, :] if v >= 0)
        touches.update(int(v) for v in labels[h - 1, :] if v >= 0)
        touches.update(int(v) for v in labels[:, 0] if v >= 0)
        touches.update(int(v) for v in labels[:, w - 1] if v >= 0)
    holes = []
    for lab in range(n):
        if lab in touches:
            continue
        ys, xs = np.nonzero(labels == lab)
        cy = float(ys.mean()) + 0.5
        cx = float(xs.mean()) + 0.5
        holes.append(Hole(size=int(len(ys)), centroid=(cx, cy)))
    return holes


def compute_stats(img: PaletteImage) -> RotationStats:
    mask = img.opaque_mask()
    count = int(mask.sum())
    labels, n_comp = label_components(mask)
    sizes = []
    for lab in range(n_comp):
        sizes.append(int((labels == lab).sum()))
    sizes.sort(reverse=True)
    color_counts: dict[int, int] = {}
    for idx in np.unique(img.indices[mask]):
        color_counts[int(idx)] = int((img.indices == idx).sum())
    if count:
        ys, xs = np.nonzero(mask)
        bbox = (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)
        contacts = []
        if xs.min() == 0:
            contacts.append("left")
        if xs.max() == img.width - 1:
            contacts.append("right")
        if ys.min() == 0:
            contacts.append("top")
        if ys.max() == img.height - 1:
            contacts.append("bottom")
    else:
        bbox = None
        contacts = []
    return RotationStats(
        pixel_count=count,
        color_counts=color_counts,
        components=n_comp,
        component_sizes=sizes,
        holes=find_holes(mask),
        bbox=bbox,
        border_contacts=contacts,
        colors_used=sorted(color_counts),
    )


def analyze_rois(
    out_img: PaletteImage,
    rois: list[tuple[str, np.ndarray]],
    baseline: dict[str, "ROIResult"] | None = None,
) -> list[ROIResult]:
    """rois: (name, polygon 输出坐标)。baseline 为源侧对照结果, 给出 changed 标记。"""
    h, w = out_img.indices.shape
    centers = pixel_centers(w, h).reshape(-1, 2)
    mask_full = out_img.opaque_mask()
    results = []
    for name, poly in rois:
        inside = point_in_polygon(centers, poly).reshape(h, w)
        sub_mask = inside & mask_full
        count = int(sub_mask.sum())
        sub_labels, n_comp = label_components(sub_mask)
        # 洞口: ROI 内部的背景连通块, 四周不能直接顶到 ROI 边界
        # (顶到边界说明它和关注区外的背景相连, 不是封闭洞)
        bg_labels, bg_n = label_components(inside & ~mask_full)
        hole_objs = []
        for lab in range(bg_n):
            ys_l, xs_l = np.nonzero(bg_labels == lab)
            # 收集四邻格(含块外), 若有邻格不在 ROI 内, 说明该背景块
            # 与关注区外的背景相连, 不是封闭洞
            ny = np.concatenate([ys_l - 1, ys_l + 1, ys_l, ys_l])
            nx = np.concatenate([xs_l, xs_l, xs_l - 1, xs_l + 1])
            in_canvas = (ny >= 0) & (ny < h) & (nx >= 0) & (nx < w)
            ny, nx = ny[in_canvas], nx[in_canvas]
            if not bool(inside[ny, nx].all()):
                continue
            cy = float(ys_l.mean()) + 0.5
            cx = float(xs_l.mean()) + 0.5
            hole_objs.append(Hole(size=int(len(ys_l)), centroid=(cx, cy)))
        colors = sorted(int(v) for v in np.unique(out_img.indices[sub_mask]))
        hole_sizes = [hole.size for hole in hole_objs]
        note = ""
        changed = False
        if baseline and name in baseline:
            before = baseline[name]
            diffs = []
            if before.pixels != count:
                diffs.append(f"像素 {before.pixels}->{count}")
            if before.components != n_comp:
                diffs.append(f"连通块 {before.components}->{n_comp}")
                if n_comp > before.components:
                    note = "疑似断线/分裂"
            if before.holes != len(hole_objs):
                diffs.append(f"孔洞 {before.holes}->{len(hole_objs)}")
                note = (note + ";" if note else "") + "洞口数量变化"
            elif before.hole_sizes != hole_sizes:
                diffs.append(
                    f"洞大小 {before.hole_sizes}->{hole_sizes}"
                )
                note = (note + ";" if note else "") + "洞口大小变化"
            if before.colors_used != colors:
                diffs.append("色号集合变化")
            changed = bool(diffs)
            if diffs and not note:
                note = "; ".join(diffs)
        results.append(
            ROIResult(
                name=name,
                polygon=[(float(x), float(y)) for x, y in poly],
                pixels=count,
                components=n_comp,
                holes=len(hole_objs),
                hole_sizes=hole_sizes,
                colors_used=colors,
                changed=changed,
                note=note,
            )
        )
    return results


def make_baseline(
    img: PaletteImage,
    rois_out: list[tuple[str, np.ndarray]],
    center: tuple[float, float],
    angle: float,
    origin: tuple[float, float],
) -> dict[str, ROIResult]:
    """把输出格网里的关注区逆变换回源格网, 在源图上计算对照基准。

    这样基准与结果用的是同一块区域(只是跟着旋转), 比较才有意义。
    """
    back = []
    for name, poly in rois_out:
        src_poly = rotate_points(np.asarray(poly) + np.array(origin), center, -angle)
        back.append((name, src_poly))
    return {r.name: r for r in analyze_rois(img, back, None)}


def _build_result(
    method: str,
    angle: float,
    center: tuple[float, float],
    canvas_mode: str,
    src: PaletteImage,
    indices: np.ndarray,
    origin: tuple[float, float],
    outside_pixels: int,
    collisions: int,
    rois_out: list[tuple[str, np.ndarray]],
    params: dict,
) -> RotationResult:
    out_img = PaletteImage(indices, list(src.palette), source_mode=src.source_mode)
    stats = compute_stats(out_img)
    baseline = make_baseline(src, rois_out, center, angle, origin)
    roi_results = analyze_rois(out_img, rois_out, baseline)
    quad = rotate_points(frame_corners(src.width, src.height), center, angle) - np.array(
        origin
    )
    h, w = indices.shape
    centers = pixel_centers(w, h).reshape(-1, 2)
    in_frame = point_in_polygon(centers, quad).reshape(h, w)
    outside_frame = out_img.opaque_mask() & ~in_frame
    border = np.zeros((h, w), dtype=bool)
    if h > 0 and w > 0:
        border[0, :] |= out_img.opaque_mask()[0, :]
        border[h - 1, :] |= out_img.opaque_mask()[h - 1, :]
        border[:, 0] |= out_img.opaque_mask()[:, 0]
        border[:, w - 1] |= out_img.opaque_mask()[:, w - 1]
    center_out = (center[0] - origin[0], center[1] - origin[1])
    return RotationResult(
        method=method,
        angle=angle,
        center=center,
        center_out=center_out,
        canvas_mode=canvas_mode,
        image=out_img,
        origin=origin,
        frame_quad=quad,
        outside_pixels=outside_pixels,
        collisions=collisions,
        stats=stats,
        roi_results=roi_results,
        outside_frame_mask=outside_frame,
        border_mask=border,
        params=dict(params),
    )


# ---------------------------------------------------------------------------
# 引擎 1: 正向最近像素
# ---------------------------------------------------------------------------


def rotate_forward_nn(
    img: PaletteImage,
    center: tuple[float, float],
    theta_deg: float,
    canvas_mode: str = EXPAND,
    fixed_size: tuple[int, int] | None = None,
    rois: list[tuple[str, np.ndarray]] | None = None,
) -> RotationResult:
    rois = rois or []
    out_w, out_h, ox, oy = _output_geometry(
        img, center, theta_deg, canvas_mode, fixed_size
    )
    out = np.full((out_h, out_w), TRANSPARENT, dtype=np.int16)
    ys, xs = np.nonzero(img.opaque_mask())
    centers_in = np.stack([xs + 0.5, ys + 0.5], axis=-1)
    rotated = rotate_points(centers_in, center, theta_deg)
    tc = np.floor(rotated[:, 0] - ox).astype(np.int64)
    tr = np.floor(rotated[:, 1] - oy).astype(np.int64)
    valid = (tc >= 0) & (tc < out_w) & (tr >= 0) & (tr < out_h)
    outside_pixels = int((~valid).sum())
    tc, tr, src_idx = tc[valid], tr[valid], img.indices[ys[valid], xs[valid]]
    # 碰撞统计: 同一目标格被多个源像素命中
    if len(tc):
        flat = tr * out_w + tc
        _, counts = np.unique(flat, return_counts=True)
        collisions = int((counts - 1).sum())
        out.flat[flat] = src_idx.astype(np.int16)  # 后写覆盖先写
    else:
        collisions = 0
    rois_out = [
        (name, rotate_points(poly, center, theta_deg) - np.array([ox, oy]))
        for name, poly in rois
    ]
    return _build_result(
        FORWARD_NN, theta_deg, center, canvas_mode, img, out, (ox, oy),
        outside_pixels, collisions, rois_out,
        {"note": "源像素整格搬运, 一格宽线可能被相邻映射切断"},
    )


# ---------------------------------------------------------------------------
# 引擎 2: 反向最近像素
# ---------------------------------------------------------------------------


def rotate_inverse_nn(
    img: PaletteImage,
    center: tuple[float, float],
    theta_deg: float,
    canvas_mode: str = EXPAND,
    fixed_size: tuple[int, int] | None = None,
    rois: list[tuple[str, np.ndarray]] | None = None,
) -> RotationResult:
    rois = rois or []
    out_w, out_h, ox, oy = _output_geometry(
        img, center, theta_deg, canvas_mode, fixed_size
    )
    out = np.full((out_h, out_w), TRANSPARENT, dtype=np.int16)
    t_centers = pixel_centers(out_w, out_h).reshape(-1, 2) + np.array([ox, oy])
    src_points = rotate_points(t_centers, center, -theta_deg)
    sc = np.floor(src_points[:, 0]).astype(np.int64)
    sr = np.floor(src_points[:, 1]).astype(np.int64)
    valid = (sc >= 0) & (sc < img.width) & (sr >= 0) & (sr < img.height)
    flat_out = np.arange(out_w * out_h)
    v_sc, v_sr, v_flat = sc[valid], sr[valid], flat_out[valid]
    sampled = img.indices[v_sr, v_sc]
    keep = sampled != TRANSPARENT
    out.flat[v_flat[keep]] = sampled[keep].astype(np.int16)
    # 未被采样到的源像素(固定画布下即离开画布的部分)
    ys, xs = np.nonzero(img.opaque_mask())
    rotated = rotate_points(np.stack([xs + 0.5, ys + 0.5], axis=-1), center, theta_deg)
    tc = rotated[:, 0] - ox
    tr = rotated[:, 1] - oy
    outside_pixels = int(
        ((tc < 0) | (tc >= out_w) | (tr < 0) | (tr >= out_h)).sum()
    )
    rois_out = [
        (name, rotate_points(poly, center, theta_deg) - np.array([ox, oy]))
        for name, poly in rois
    ]
    return _build_result(
        INVERSE_NN, theta_deg, center, canvas_mode, img, out, (ox, oy),
        outside_pixels, 0, rois_out,
        {"note": "每格回查一个源像素, 不产生碰撞但可能丢细腰"},
    )


# ---------------------------------------------------------------------------
# 引擎 3: 保轮廓超采样 (面积占优, 只选原色号)
# ---------------------------------------------------------------------------


def rotate_ssaa(
    img: PaletteImage,
    center: tuple[float, float],
    theta_deg: float,
    canvas_mode: str = EXPAND,
    fixed_size: tuple[int, int] | None = None,
    rois: list[tuple[str, np.ndarray]] | None = None,
    supersample: int = 4,
    coverage_threshold: float = 0.5,
) -> RotationResult:
    """把每格细分为 ss×ss 个子像素做最近邻旋转, 再按面积占优回落。

    - 目标格内不透明子像素占比 >= coverage_threshold 才落色, 颜色取出现最多的原色号
    - 不引入任何新颜色, 透明背景保持透明
    - 90° 倍数时子像素完全对齐, 结果与数学旋转逐格一致
    """
    rois = rois or []
    ss = max(1, int(supersample))
    out_w, out_h, ox, oy = _output_geometry(
        img, center, theta_deg, canvas_mode, fixed_size
    )
    # 源侧超采样格网
    src_super = np.repeat(np.repeat(img.indices, ss, axis=0), ss, axis=1)
    sy, sx = np.nonzero(src_super != TRANSPARENT)
    # 子像素中心在源连续坐标系中的位置
    pts = np.stack([(sx + 0.5) / ss, (sy + 0.5) / ss], axis=-1)
    rot = rotate_points(pts, center, theta_deg)
    # 目标超采样格网 (原点与普通格网相同, 尺度 ×ss)
    tcx = np.floor(rot[:, 0] * ss - ox * ss).astype(np.int64)
    tcy = np.floor(rot[:, 1] * ss - oy * ss).astype(np.int64)
    SW, SH = out_w * ss, out_h * ss
    valid = (tcx >= 0) & (tcx < SW) & (tcy >= 0) & (tcy < SH)
    outside_super = int((~valid).sum())
    tcx, tcy = tcx[valid], tcy[valid]
    vals = src_super[sy[valid], sx[valid]]
    flat = tcy * SW + tcx
    _, counts = np.unique(flat, return_counts=True)
    collisions = int((counts - 1).sum())
    super_out = np.full(SH * SW, TRANSPARENT, dtype=np.int16)
    super_out.flat[flat] = vals.astype(np.int16)
    super_out = super_out.reshape(SH, SW)
    # 回落: 每个 ss×ss 块统计各色号与透明占比
    blocks = super_out.reshape(out_h, ss, out_w, ss).transpose(0, 2, 1, 3)
    blocks = blocks.reshape(out_h, out_w, ss * ss)
    out = np.full((out_h, out_w), TRANSPARENT, dtype=np.int16)
    n_colors = len(img.palette)
    for r in range(out_h):
        for c in range(out_w):
            blk = blocks[r, c]
            opaque = blk[blk != TRANSPARENT]
            if opaque.size == 0:
                continue
            coverage = opaque.size / (ss * ss)
            if coverage < coverage_threshold:
                continue
            # 原色号中出现频次最高者 (并列取色号小的, 保证确定性)
            bc = np.bincount(opaque.astype(np.int64), minlength=n_colors)
            out[r, c] = int(np.argmax(bc))
    # 固定画布下按整像素统计丢失
    ys, xs = np.nonzero(img.opaque_mask())
    rotated = rotate_points(np.stack([xs + 0.5, ys + 0.5], axis=-1), center, theta_deg)
    outside_pixels = int(
        (
            (rotated[:, 0] - ox < 0)
            | (rotated[:, 0] - ox >= out_w)
            | (rotated[:, 1] - oy < 0)
            | (rotated[:, 1] - oy >= out_h)
        ).sum()
    )
    rois_out = [
        (name, rotate_points(poly, center, theta_deg) - np.array([ox, oy]))
        for name, poly in rois
    ]
    return _build_result(
        SSAA, theta_deg, center, canvas_mode, img, out, (ox, oy),
        outside_pixels, collisions, rois_out,
        {"supersample": ss, "coverage_threshold": coverage_threshold,
         "outside_superpixels": outside_super,
         "note": "子像素面积占优, 保轮廓且不新增颜色"},
    )


def rotate(
    method: str,
    img: PaletteImage,
    center: tuple[float, float],
    theta_deg: float,
    canvas_mode: str = EXPAND,
    fixed_size: tuple[int, int] | None = None,
    rois: list[tuple[str, np.ndarray]] | None = None,
    supersample: int = 4,
    coverage_threshold: float = 0.5,
) -> RotationResult:
    if method == FORWARD_NN:
        return rotate_forward_nn(img, center, theta_deg, canvas_mode, fixed_size, rois)
    if method == INVERSE_NN:
        return rotate_inverse_nn(img, center, theta_deg, canvas_mode, fixed_size, rois)
    if method == SSAA:
        return rotate_ssaa(
            img, center, theta_deg, canvas_mode, fixed_size, rois,
            supersample, coverage_threshold,
        )
    raise ValueError(f"未知方法: {method}")


# ---------------------------------------------------------------------------
# 中心预设与往返自检
# ---------------------------------------------------------------------------


def preset_center(img: PaletteImage, kind: str) -> tuple[float, float]:
    """常用旋转中心。坐标为连续格网坐标。"""
    w, h = img.width, img.height
    if kind == "pixel_center":  # 中心落在一个像素的中心 (奇数尺寸时)
        return (w // 2 + 0.5, h // 2 + 0.5)
    if kind == "corner":  # 像素之间的角点(图框正中, 偶数尺寸时正好在四像素之间)
        return (w / 2.0, h / 2.0)
    if kind == "top_left":
        return (0.0, 0.0)
    raise ValueError(kind)


@dataclass
class RoundtripReport:
    method: str
    center: tuple[float, float]
    step: float
    ok: bool
    max_diff: int
    pixel_diffs: int
    center_error: float
    detail: str


def roundtrip_check(
    img: PaletteImage,
    method: str,
    center: tuple[float, float],
    step: float = 90.0,
    supersample: int = 4,
) -> RoundtripReport:
    """在固定画布上连续转 4 次 step(默认 90°), 复查像素与中心回到起点。

    要求 step 是 90 的整数倍且中心落在像素中心或格点上, 才能逐格无损。
    """
    fw = img.width + 4
    fh = img.height + 4
    # 把原图放进大画布中央, 留出边距避免任何裁切
    pad = 2
    canvas = np.full((fh, fw), TRANSPARENT, dtype=np.int16)
    canvas[pad : pad + img.height, pad : pad + img.width] = img.indices
    base = PaletteImage(canvas, list(img.palette), source_mode=img.source_mode)
    center = (center[0] + pad, center[1] + pad)
    cur = base
    center_now = center
    for _ in range(4):
        res = rotate(
            method, cur, center_now, step, FIXED, (fw, fh),
            supersample=supersample,
        )
        cur = res.image
        center_now = res.center_out
    diff = cur.indices != base.indices
    n_diff = int(diff.sum())
    center_err = math.hypot(
        center_now[0] - center[0], center_now[1] - center[1]
    )
    ok = n_diff == 0 and center_err < 1e-9
    if ok:
        detail = "4 次旋转后像素与中心完全回到起点"
    else:
        detail = f"差异像素 {n_diff} 个, 中心漂移 {center_err:.3e}"
    return RoundtripReport(
        method=method,
        center=center,
        step=step,
        ok=ok,
        max_diff=int(np.abs(cur.indices.astype(np.int32) - base.indices.astype(np.int32)).max())
        if n_diff
        else 0,
        pixel_diffs=n_diff,
        center_error=center_err,
        detail=detail,
    )
