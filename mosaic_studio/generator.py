"""程序化生成样块、示例底图与“配额冲突”例子。

设计目标：
- 几十种覆盖主要色相/明度的样块，拼出来的马赛克能接近照片大效果；
- 专门提供几组“平均颜色几乎相同、纹理完全不同”的样块，
  用来验证特征/预览是否真的能区分纹理；
- 生成一个目录自包含的配额冲突例子（底图 + 5 块样块 + scenario.json）。
"""
from __future__ import annotations

import json
import math
import random
from pathlib import Path

from PIL import Image, ImageDraw

TILE_PX = 160

# 30 个覆盖明度/色相的底色，每个再派生不同纹理 -> 默认 60 块样块。
PALETTE: list[tuple[str, tuple[int, int, int]]] = [
    ("ink",        (20, 20, 24)),
    ("charcoal",   (52, 52, 58)),
    ("slate",      (92, 94, 102)),
    ("gray",       (140, 142, 150)),
    ("silver",     (192, 194, 200)),
    ("paper",      (238, 238, 242)),
    ("wine",       (122, 30, 36)),
    ("red",        (182, 46, 48)),
    ("coral",      (224, 92, 78)),
    ("rust",       (150, 74, 32)),
    ("orange",     (216, 122, 44)),
    ("sand",       (232, 172, 96)),
    ("coffee",     (96, 62, 38)),
    ("brown",      (142, 98, 58)),
    ("gold",       (224, 190, 60)),
    ("creamyellow", (242, 216, 122)),
    ("pine",       (32, 82, 52)),
    ("green",      (58, 130, 72)),
    ("leaf",       (106, 170, 98)),
    ("sage",       (178, 202, 122)),
    ("teal",       (30, 120, 118)),
    ("aqua",       (98, 182, 178)),
    ("navy",       (26, 56, 118)),
    ("blue",       (44, 98, 180)),
    ("sky",        (98, 158, 216)),
    ("ice",        (178, 208, 234)),
    ("plum",       (96, 52, 130)),
    ("violet",     (160, 94, 170)),
    ("pink",       (216, 132, 162)),
    ("blush",      (242, 192, 202)),
]

PATTERN_STYLES = [
    "flat", "hstripes", "vstripes", "checker", "dots",
    "diagonal", "waves", "grid", "crosshatch", "rings",
]


def _raw_mask(style: str, x: int, y: int, size: int, rng: random.Random) -> float:
    s = size
    if style == "flat":
        return rng.uniform(-0.06, 0.06)  # 一点点纸感，避免死平
    if style == "hstripes":
        w = max(6, s // 12)
        return 1.0 if (y // w) % 2 == 0 else -1.0
    if style == "vstripes":
        w = max(6, s // 12)
        return 1.0 if (x // w) % 2 == 0 else -1.0
    if style == "checker":
        w = max(8, s // 8)
        return 1.0 if ((x // w) + (y // w)) % 2 == 0 else -1.0
    if style == "dots":
        gap = s / 5.0
        rad = s / 11.0
        gx = (x + gap / 2) % gap - gap / 2
        gy = (y + gap / 2) % gap - gap / 2
        return 1.0 if gx * gx + gy * gy <= rad * rad else -0.55
    if style == "diagonal":
        w = max(8, s // 10)
        return 1.0 if ((x + y) // w) % 2 == 0 else -1.0
    if style == "waves":
        v = math.sin((y / s) * math.tau * 3.0
                     + math.sin((x / s) * math.tau * 2.0) * 1.4)
        return v
    if style == "grid":
        w = max(10, s // 7)
        line = max(2, s // 60)
        if (x % w) < line or (y % w) < line:
            return -1.0
        return 0.35
    if style == "crosshatch":
        w = max(10, s // 7)
        line = max(2, s // 70)
        if ((x + y) % w) < line or ((x - y) % w) < line:
            return -1.0
        return 0.25
    if style == "rings":
        cx = cy = s / 2
        d = math.hypot(x - cx, y - cy)
        w = s / 9.0
        return 1.0 if (d // w) % 2 == 0 else -1.0
    return 0.0


def make_pattern_tile(base: tuple[int, int, int], style: str,
                      size: int = TILE_PX, amp: float = 58.0,
                      seed: int = 0) -> Image.Image:
    """生成“平均色≈base”的纹理样块。

    先算原始调制掩膜，再减去掩膜均值，保证纹理不改变平均颜色，
    这样同 base 不同 style 的块就是严格意义上的“颜色相近、纹理不同”。
    """
    rng = random.Random(seed)
    raw = [[_raw_mask(style, x, y, size, rng) for x in range(size)]
           for y in range(size)]
    mean_mask = sum(sum(row) for row in raw) / (size * size)
    # 只去均值、不按 max_abs 拉伸：否则 flat 里的微小纸感噪声会被放大成
    # 满对比噪点。结构化纹理本身已在 [-1,1] 附近，轻微越界由像素 clamp 处理。
    centered = [[v - mean_mask for v in row] for row in raw]

    img = Image.new("RGB", (size, size), base)
    px = img.load()
    br, bg, bb = base
    for y in range(size):
        for x in range(size):
            d = amp * centered[y][x]
            px[x, y] = (
                max(0, min(255, int(round(br + d)))),
                max(0, min(255, int(round(bg + d)))),
                max(0, min(255, int(round(bb + d)))),
            )
    return img


def _save_png(img: Image.Image, folder: Path, filename: str) -> Path:
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / filename
    img.save(path, format="PNG", optimize=False)
    return path


def generate_similarity_pairs(out_dir: str | Path,
                              size: int = TILE_PX) -> list[Path]:
    """3 组同色异纹样块（每组 3 种纹理），共 9 块。"""
    out = Path(out_dir) / "01_同色异纹"
    specs = [
        # (文件名前缀, 底色, 三种纹理)
        ("pair_gray",  (128, 128, 128), ("flat", "hstripes", "dots")),
        ("pair_blue",   (74, 110, 160),  ("flat", "checker", "waves")),
        ("pair_ochre",  (186, 128, 52),  ("flat", "diagonal", "crosshatch")),
    ]
    paths: list[Path] = []
    for group, color, styles in specs:
        for tag, style in zip(("a_flat", "b_texture1", "c_texture2"), styles):
            img = make_pattern_tile(color, style, size=size, amp=64,
                                    seed=hash((group, style)) & 0xFFFF)
            paths.append(_save_png(img, out, f"{group}_{tag}.png"))
    return paths


def _category_for_palette_index(ci: int) -> str:
    if ci < 6:
        return "02_中性灰黑"
    if ci < 16:
        return "03_暖色大地"
    if ci < 22:
        return "04_绿色自然"
    return "05_蓝紫冷色"


def generate_tiles(out_dir: str | Path, count: int = 60,
                   seed: int = 20261126) -> list[Path]:
    """生成一整套样块：同色异纹对照组 + 色板派生样块，总数约 count。

    count 小于 9 时仍会生成 9 块对照样块（它们是需求明确要求的自带例子）。
    样块按色系放在子目录里，子目录名就是预览中的“样块来源”。
    """
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    paths = generate_similarity_pairs(out)

    rng = random.Random(seed)
    rest = max(0, count - len(paths))
    # 每个颜色先出两种纹理，保证几十块里有充分的颜色覆盖。
    plan: list[tuple[int, str]] = []
    for ci in range(len(PALETTE)):
        plan.append((ci, PATTERN_STYLES[(ci * 3) % len(PATTERN_STYLES)]))
        plan.append((ci, PATTERN_STYLES[(ci * 3 + 4) % len(PATTERN_STYLES)]))
    while len(plan) < rest:
        ci = rng.randrange(len(PALETTE))
        style = PATTERN_STYLES[rng.randrange(len(PATTERN_STYLES))]
        plan.append((ci, style))

    for k in range(rest):
        ci, style = plan[k % len(plan)]
        cname, color = PALETTE[ci]
        category = _category_for_palette_index(ci)
        img = make_pattern_tile(
            color, style, amp=52 + (ci % 5) * 6,
            seed=seed + k * 17,
        )
        paths.append(_save_png(
            img, out / category, f"{k + 10:03d}_{cname}_{style}.png"))
    return paths


# ---------------------------------------------------------------------
# 示例海报底图
# ---------------------------------------------------------------------
def _vertical_gradient(size: tuple[int, int], top: tuple[int, int, int],
                       bottom: tuple[int, int, int]) -> Image.Image:
    w, h = size
    img = Image.new("RGB", size, top)
    draw = ImageDraw.Draw(img)
    for y in range(h):
        t = y / max(1, h - 1)
        color = tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
        draw.line([(0, y), (w, y)], fill=color)
    return img


def generate_demo_base(path: str | Path | None = None,
                       w: int = 900, h: int = 1200) -> Image.Image | Path:
    """生成一张色块明确、适合马赛克化的“日落山湖”海报底图。"""
    img = _vertical_gradient((w, int(h * 0.62)),
                             (74, 66, 138), (244, 178, 116))
    canvas = Image.new("RGB", (w, h))
    canvas.paste(img, (0, 0))

    # 湖面（下半部，深青蓝渐变）
    lake = _vertical_gradient((w, int(h * 0.45)),
                              (58, 86, 128), (24, 40, 74))
    canvas.paste(lake, (0, int(h * 0.60)))

    draw = ImageDraw.Draw(canvas)
    # 太阳
    sx, sy, sr = int(w * 0.62), int(h * 0.36), int(w * 0.16)
    draw.ellipse((sx - sr, sy - sr, sx + sr, sy + sr),
                 fill=(255, 236, 190))
    # 太阳在湖面的反光
    for i in range(14):
        yy = int(h * 0.66) + i * 26
        ww = int(sr * (1.2 - i * 0.05))
        alpha_color = (230 - i * 6, 190 - i * 8, 150 - i * 6)
        draw.rectangle((sx - ww // 2, yy, sx + ww // 2, yy + 12),
                       fill=alpha_color)

    # 远山
    far = [(0, int(h * 0.60)), (int(w * 0.18), int(h * 0.44)),
           (int(w * 0.34), int(h * 0.58)), (int(w * 0.52), int(h * 0.40)),
           (int(w * 0.72), int(h * 0.59)), (int(w * 0.88), int(h * 0.47)),
           (w, int(h * 0.58)), (w, int(h * 0.66)), (0, int(h * 0.66))]
    draw.polygon(far, fill=(96, 92, 140))
    # 近山
    near = [(0, int(h * 0.66)), (int(w * 0.16), int(h * 0.52)),
            (int(w * 0.30), int(h * 0.64)), (int(w * 0.46), int(h * 0.50)),
            (int(w * 0.64), int(h * 0.65)), (int(w * 0.82), int(h * 0.54)),
            (w, int(h * 0.64)), (w, int(h * 0.70)), (0, int(h * 0.70))]
    draw.polygon(near, fill=(40, 52, 78))

    # 前景岸线
    draw.rectangle((0, int(h * 0.90), w, h), fill=(24, 34, 48))
    rng = random.Random(5)
    for _ in range(26):  # 一些树尖
        tx = rng.randrange(0, w)
        th = rng.randrange(40, 110)
        ty = int(h * 0.90)
        draw.polygon([(tx, ty - th), (tx - 16, ty), (tx + 16, ty)],
                     fill=(18, 28, 40))

    if path is not None:
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        canvas.save(path, format="PNG")
        return path
    return canvas


# ---------------------------------------------------------------------
# 配额冲突例子
# ---------------------------------------------------------------------
QC_TILES: list[tuple[str, tuple[int, int, int], str]] = [
    ("qc_01_red",    (196, 64, 58),  "flat"),
    ("qc_02_green",  (72, 150, 92),  "hstripes"),
    ("qc_03_blue",   (66, 116, 196), "dots"),
    ("qc_04_gold",   (222, 180, 66), "checker"),
    ("qc_05_purple", (148, 92, 196), "diagonal"),
]


def generate_quota_conflict_example(root: str | Path) -> dict:
    """生成自包含的配额冲突例子，返回 scenario 字典。

    底图是 5 条竖色带，cell_size=80 时恰好 5 列 × 4 行 = 20 格，
    每一列的 4 格都最像对应的那一块样块；但每块配额只有 2 次，
    总容量 10 < 20，必然有 10 格以上无法按配额匹配，
    再叠加八邻域限制，未匹配格会在报告/问题面板里逐格列出。
    """
    root = Path(root)
    tile_dir = root / "tiles"
    tile_dir.mkdir(parents=True, exist_ok=True)

    cell = 80
    cols, rows = 5, 4
    base = Image.new("RGB", (cols * cell, rows * cell))
    draw = ImageDraw.Draw(base)
    for c, (_name, color, _style) in enumerate(QC_TILES):
        draw.rectangle((c * cell, 0, (c + 1) * cell, rows * cell), fill=color)
    base_path = root / "base.png"
    base.save(base_path)

    for i, (name, color, style) in enumerate(QC_TILES):
        img = make_pattern_tile(color, style, amp=46, seed=100 + i)
        img.save(tile_dir / f"{name}.png")

    scenario = {
        "app": "mosaic-studio-scenario",
        "schema_version": 1,
        "name": "配额冲突例子：5×4 色带 vs 每块 2 次配额",
        "description": (
            "底图 400×320，格子 80px -> 5 列 × 4 行共 20 格；"
            "只有 5 块样块且每块最多用 2 次，总容量 10 格，"
            "另有八邻域同块限制和一个固定格。运行后问题面板会逐格列出"
            "哪些格未匹配以及是配额还是邻接原因。"
        ),
        "base_image": "base.png",
        "tile_folder": "tiles",
        "params": {
            "cell_size": cell,
            "max_uses": 2,
            "adjacency_radius": 1,
            "seed": 42,
        },
        "quota_overrides": {},
        "fixed": [{"row": 0, "col": 0, "tile_id": "qc_01_red"}],
    }
    with open(root / "scenario.json", "w", encoding="utf-8") as f:
        json.dump(scenario, f, ensure_ascii=False, indent=2)
    return scenario


def ensure_bundled_assets(repo_root: str | Path) -> dict[str, Path]:
    """生成仓库自带素材（若已存在则直接复用）。"""
    repo_root = Path(repo_root)
    tile_dir = repo_root / "sample_assets" / "tiles"
    base_path = repo_root / "sample_assets" / "base" / "poster_demo.png"
    if not tile_dir.exists() or len(list(tile_dir.glob("*.png"))) < 30:
        generate_tiles(tile_dir, count=60)
    if not base_path.exists():
        generate_demo_base(base_path)
    qc_root = repo_root / "examples" / "quota_conflict"
    if not (qc_root / "scenario.json").exists():
        generate_quota_conflict_example(qc_root)
    return {"tiles": tile_dir, "base": base_path, "quota_conflict": qc_root}
