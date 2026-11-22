"""生成一组带透明抗锯齿边缘的小地图标记样例。

故意选用普通视觉可分、但红/绿模拟下会靠近的配色 (典型的红-绿、
橙-黄绿问题对), 供应用与 tests/ 验证读数、热点和调色流程。

运行: python -m samples.make_samples
"""
from __future__ import annotations

import json
import os

import numpy as np

from colorcheck.pngio import write_png

# (名称, RGB, 形状) — 红 E53935 与绿 43A047 在 deutan/protan 下会明显靠拢;
# 橙 FB8C00 与黄绿 C0CA33 是第二组易冲突对。
MARKERS = [
    ("enemy",    (229, 57, 53),   "circle"),
    ("ally",     (67, 160, 71),   "square"),
    ("danger",   (251, 140, 0),   "triangle"),
    ("poison",   (192, 202, 51),  "diamond"),
    ("quest",    (30, 136, 229),  "pentagon"),
    ("neutral",  (240, 240, 240), "cross"),
]

SIZE = 64
SS = 4  # supersampling


def _grid(ss=SS):
    n = SIZE * ss
    ys, xs = np.mgrid[0:n, 0:n]
    cx = cy = (n - 1) / 2.0
    return xs, ys, cx, cy, n


def _mask_circle():
    xs, ys, cx, cy, n = _grid()
    r = n * 0.34
    return np.clip(r - np.hypot(xs - cx, ys - cy) + 0.5, 0, 1)


def _mask_square():
    xs, ys, cx, cy, n = _grid()
    half = n * 0.30
    d = np.maximum(np.abs(xs - cx), np.abs(ys - cy))
    return np.clip(half - d + 0.5, 0, 1)


def _mask_triangle():
    xs, ys, cx, cy, n = _grid()
    x = (xs - cx) / n
    y = (ys - cy) / n
    # 指向上方的等边三角
    d1 = 0.30 - y * 0.9 - 0.06            # 底边
    d2 = 0.30 - (y * 0.9 + np.abs(x) * 1.7)  # 两条斜边
    d = np.minimum(d1, d2)
    return np.clip(d * n + 0.5, 0, 1)


def _mask_diamond():
    xs, ys, cx, cy, n = _grid()
    d = 0.34 * n - (np.abs(xs - cx) + np.abs(ys - cy))
    return np.clip(d + 0.5, 0, 1)


def _mask_pentagon():
    xs, ys, cx, cy, n = _grid()
    x = (xs - cx) / n
    y = -(ys - cy) / n
    # 正五边形有向距离场 (顶点朝上)
    vert = np.pi / 2 + np.arange(5) * 2 * np.pi / 5
    r = 0.32
    d = np.full_like(x, -np.inf)
    for k in range(5):
        nx = np.cos(vert[k])
        ny = np.sin(vert[k])
        d = np.maximum(d, x * nx + y * ny - r * np.cos(np.pi / 5))
    return np.clip(-d * n + 0.5, 0, 1)


def _box_blur(a, radius):
    """纯 numpy 均值模糊, 用于给硬边十字生成半透明轮廓。"""
    out = a.copy()
    for _ in range(3):
        acc = np.zeros_like(out)
        cnt = np.zeros_like(out)
        for dy in range(-radius, radius + 1):
            for dx in range(-radius, radius + 1):
                shifted = np.roll(np.roll(out, dy, axis=0), dx, axis=1)
                # roll 会把边界卷回来, 用掩码剔除
                mask = np.ones_like(out, dtype=bool)
                if dy > 0:
                    mask[:dy, :] = False
                elif dy < 0:
                    mask[dy:, :] = False
                if dx > 0:
                    mask[:, :dx] = False
                elif dx < 0:
                    mask[:, dx:] = False
                acc += shifted * mask
                cnt += mask
        out = acc / np.maximum(cnt, 1)
    return out


def _mask_cross():
    xs, ys, cx, cy, n = _grid()
    arm_w = n * 0.11
    arm_l = n * 0.32
    horiz = (np.abs(xs - cx) <= arm_l) & (np.abs(ys - cy) <= arm_w)
    verti = (np.abs(ys - cy) <= arm_l) & (np.abs(xs - cx) <= arm_w)
    shape = (horiz | verti).astype(float)
    return np.clip(_box_blur(shape, radius=2), 0, 1)


_SHAPES = {
    "circle": _mask_circle,
    "square": _mask_square,
    "triangle": _mask_triangle,
    "diamond": _mask_diamond,
    "pentagon": _mask_pentagon,
    "cross": _mask_cross,
}


def render_marker(rgb, shape):
    """渲染单个 64x64 RGBA 标记, 边缘 alpha 渐变。"""
    hi = _SHAPES[shape]()
    # 下采样并得到平滑 alpha
    alpha = hi.reshape(SIZE, SS, SIZE, SS).mean(axis=(1, 3))
    # 内部压暗做一个小圆点细节 (同样带半透明, 模拟图标内部层次)
    xs, ys, cx, cy, _ = _grid(ss=1)
    dot = np.clip(SIZE * 0.10 - np.hypot(xs - cx, ys - cy) + 0.5, 0, 1)
    shade = 1.0 - 0.35 * dot
    rgba = np.zeros((SIZE, SIZE, 4), dtype=np.uint8)
    base = np.asarray(rgb, dtype=float)
    rgba[..., :3] = np.clip(base[None, None, :] * shade[..., None], 0, 255)
    rgba[..., 3] = np.clip(np.round(alpha * 255), 0, 255)
    return rgba


def make_all(out_dir):
    os.makedirs(out_dir, exist_ok=True)
    singles = []
    for name, rgb, shape in MARKERS:
        img = render_marker(rgb, shape)
        path = os.path.join(out_dir, f"marker_{name}.png")
        write_png(path, img)
        singles.append(path)

    # 2x3 精灵表: 透明间隔, 模拟真实小地图一组标记同时出现
    sheet = np.zeros((SIZE * 2 + 16, SIZE * 3 + 16, 4), dtype=np.uint8)
    for idx, (name, rgb, shape) in enumerate(MARKERS):
        tile = render_marker(rgb, shape)
        row, col = divmod(idx, 3)
        y = row * (SIZE + 8)
        x = col * (SIZE + 8)
        sheet[y:y + SIZE, x:x + SIZE] = tile
    sheet_path = os.path.join(out_dir, "spritesheet.png")
    write_png(sheet_path, sheet)

    meta = {
        "markers": [{"name": n, "rgb": list(rgb), "shape": s}
                    for n, rgb, s in MARKERS],
        "light_bg": [245, 245, 245],
        "dark_bg": [30, 30, 30],
        "expected_conflict_pairs": [
            ["enemy", "ally"],
            ["danger", "poison"],
        ],
        "singles": [os.path.basename(p) for p in singles],
        "spritesheet": "spritesheet.png",
    }
    with open(os.path.join(out_dir, "palette.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    return sheet_path, singles


if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__))
    out = os.path.join(here, "data")
    sheet, singles = make_all(out)
    print(f"wrote {len(singles)} markers + {os.path.basename(sheet)} -> {out}")
