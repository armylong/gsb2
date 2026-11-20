"""生成带公共色块的样例图，并写好一个预填采样矩形的工程文件。

三张图共用同一套 4x3 色块布局（矩形坐标完全一致，方便对照）：
  reference.png  干净的参考图
  source_a.png   经已知仿射变换 A 偏色 + 噪声
  source_b.png   经另一组仿射变换 B 偏色 + 噪声
工程 project.json 里记录了每个色块在三张图上的采样位置，并标记白块。
"""
from __future__ import annotations

import os

import numpy as np
from PIL import Image, ImageDraw, ImageFont

from .core import Project, ImageEntry, Sample, Rect, file_sha256, save_image_rgb

# 布局参数（三张图完全一致）
COLS, ROWS = 4, 3
MARGIN_X, MARGIN_Y = 40, 80
PATCH, GAP = 110, 20
IMG_W = MARGIN_X * 2 + COLS * PATCH + (COLS - 1) * GAP   # 580
IMG_H = MARGIN_Y + ROWS * PATCH + (ROWS - 1) * GAP + 40  # 490

# 12 个公共色块（sRGB 0..255），第一个是近白块
PATCH_COLORS_255 = [
    (238, 236, 232),  # 0  近白（白点采样）
    (24, 24, 26),     # 1  近黑
    (205, 48, 41),    # 2  红
    (46, 139, 87),    # 3  绿
    (32, 96, 180),    # 4  蓝
    (230, 178, 41),   # 5  黄
    (214, 96, 38),    # 6  橙
    (128, 61, 137),   # 7  紫
    (38, 166, 154),   # 8  青
    (222, 122, 162),  # 9  粉
    (110, 110, 110),  # 10 中灰
    (178, 178, 172),  # 11 浅灰
]


def _grid_rects() -> list[Rect]:
    rects = []
    for r in range(ROWS):
        for c in range(COLS):
            x = MARGIN_X + c * (PATCH + GAP)
            y = MARGIN_Y + r * (PATCH + GAP)
            rects.append(Rect(x, y, PATCH, PATCH))
    return rects


def _render(colors_f: np.ndarray, noise_sigma: float, rng: np.random.Generator) -> np.ndarray:
    img = np.zeros((IMG_H, IMG_W, 3), dtype=np.float64)
    for color, rect in zip(colors_f, _grid_rects()):
        img[rect.y : rect.y + rect.h, rect.x : rect.x + rect.w, :] = color
    img += rng.normal(0.0, noise_sigma, size=img.shape)
    return np.clip(img, 0.0, 1.0)


def _annotate(img_f: np.ndarray, labels: list[str], title: str) -> Image.Image:
    """在图上写色块编号和标题，仅用于人眼辨识。

    编号画在色块上方的间隙里，不进入采样矩形，避免污染采样均值。
    """
    im = Image.fromarray(np.rint(img_f * 255).astype(np.uint8), mode="RGB")
    draw = ImageDraw.Draw(im)
    try:
        font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 14)
        font_big = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial Bold.ttf", 22)
    except OSError:
        font = font_big = ImageFont.load_default()
    draw.text((MARGIN_X, 24), title, fill=(0, 0, 0), font=font_big)
    for label, rect in zip(labels, _grid_rects()):
        # 色块顶部与上边缘之间有 MARGIN_Y=80 的空白，文字放在色块内左上角会污染采样，
        # 因此画在色块上方 20px 处
        draw.text((rect.x + 2, rect.y - 20), label, fill=(0, 0, 0), font=font)
    return im


# 两张源图各自的“真实”变换（源 = 参考经此变换 + 噪声），拟合时求其逆
TRUE_M_A = np.array([[1.08, 0.05, -0.06], [-0.04, 0.96, 0.03], [0.02, 0.07, 0.92]])
TRUE_T_A = np.array([0.03, 0.01, 0.06])
TRUE_M_B = np.array([[0.92, -0.03, 0.05], [0.04, 1.02, 0.02], [-0.05, 0.06, 1.10]])
TRUE_T_B = np.array([0.05, -0.02, -0.04])


def generate_sample_project(out_dir: str, seed: int = 14385) -> str:
    """在 out_dir 下生成三张样例图和 project.json，返回工程文件绝对路径。"""
    os.makedirs(out_dir, exist_ok=True)
    if os.listdir(out_dir):
        raise FileExistsError(f"样例目录必须为空: {out_dir}")

    rng = np.random.default_rng(seed)
    ref_colors = np.array(PATCH_COLORS_255, dtype=np.float64) / 255.0
    src_a_colors = np.clip(ref_colors @ TRUE_M_A.T + TRUE_T_A, 0.0, 1.0)
    src_b_colors = np.clip(ref_colors @ TRUE_M_B.T + TRUE_T_B, 0.0, 1.0)

    ref_img = _render(ref_colors, 1.2 / 255.0, rng)
    a_img = _render(src_a_colors, 1.6 / 255.0, rng)
    b_img = _render(src_b_colors, 2.0 / 255.0, rng)

    labels = [f"#{i}" + (" W" if i == 0 else "") for i in range(len(PATCH_COLORS_255))]
    names = [
        "近白", "近黑", "红", "绿", "蓝", "黄",
        "橙", "紫", "青", "粉", "中灰", "浅灰",
    ]
    files = {
        "reference.png": _annotate(ref_img, labels, "reference"),
        "source_a.png": _annotate(a_img, labels, "source A (偏色)"),
        "source_b.png": _annotate(b_img, labels, "source B (偏色)"),
    }
    for name, im in files.items():
        im.save(os.path.join(out_dir, name))

    entries = [
        ImageEntry("img_ref", "reference.png", "reference", file_sha256(os.path.join(out_dir, "reference.png")), IMG_W, IMG_H, True),
        ImageEntry("img_a", "source_a.png", "source", file_sha256(os.path.join(out_dir, "source_a.png")), IMG_W, IMG_H, True),
        ImageEntry("img_b", "source_b.png", "source", file_sha256(os.path.join(out_dir, "source_b.png")), IMG_W, IMG_H, True),
    ]
    rects = _grid_rects()
    samples = []
    for i, rect in enumerate(rects):
        samples.append(
            Sample(
                id=f"s{i:02d}",
                name=names[i],
                is_white=(i == 0),
                rects={entry.id: Rect(rect.x, rect.y, rect.w, rect.h) for entry in entries},
            )
        )

    project = Project(
        images=entries,
        samples=samples,
        fits={},
        settings={"method": "affine", "lock_white": True, "white_sample_id": "s00"},
    )
    project_path = os.path.join(out_dir, "project.json")
    project.save(project_path)
    return os.path.abspath(project_path)
