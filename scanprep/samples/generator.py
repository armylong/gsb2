"""合成扫描样例生成器。

生成内容 (无需外部字体/素材):
- 多行几何笔画 (矩形/折线/椭圆模拟文字行, 提供强水平方向性)
- 表格网格、1px 细线、大块黑色图形
- 平滑低频阴影 (梯度 + 正弦 + 平滑随机场) 与轻噪声
- 按已知角度整体旋转 (白底填充)

参考数据 (真实倾角、细线端点等) 单独写入 reference.json, 仅供验证脚本使用;
处理流水线任何时候都不读取它。
"""

from __future__ import annotations

import json
from pathlib import Path

import cv2
import numpy as np
from scipy.ndimage import gaussian_filter

from ..core.geometry import rotate_image, map_points

PAGE_W, PAGE_H = 1200, 1600      # 长边 1600 <= 1800
PAPER = 245


def _draw_text_lines(img, rng, x0=90, x1=None, y0=120, y1=None, line_h=46):
    """画多行类文字几何笔画 (随机小图形组成的"行")。"""
    h, w = img.shape
    x1 = w - 90 if x1 is None else x1
    y1 = h - 120 if y1 is None else y1
    y = y0
    while y < y1:
        x = x0 + int(rng.integers(0, 24))
        while x < x1 - 16:
            gw = int(rng.integers(7, 15))
            gh = int(rng.integers(10, 16))
            color = int(rng.integers(20, 90))
            thick = 1 if rng.random() < 0.6 else 2
            x2 = min(x + gw, x1)
            kind = int(rng.integers(0, 4))
            if kind == 0:
                cv2.rectangle(img, (x, y - gh), (x2, y), color, thick)
            elif kind == 1:
                cv2.line(img, (x, y), (x2, y - gh), color, thick)
                cv2.line(img, (x, y - gh // 2), (x2, y - gh // 2), color, thick)
            elif kind == 2:
                cv2.ellipse(img, ((x + x2) // 2, y - gh // 2),
                            (max(gw // 2, 2), max(gh // 2, 2)), 0, 0, 360, color, thick)
            else:
                cv2.line(img, (x, y - gh), (x, y), color, thick)
                cv2.line(img, (x2, y - gh), (x2, y), color, thick)
                cv2.line(img, (x, y - gh), (x2, y - gh), color, thick)
            x = x2 + int(rng.integers(3, 9))
            if rng.random() < 0.12:
                x += int(rng.integers(10, 30))     # 词间空隙
        y += line_h


def _draw_table(img, x, y, cols, rows, cw, rh, thick=1, color=60):
    for r in range(rows + 1):
        yy = y + r * rh
        cv2.line(img, (x, yy), (x + cols * cw, yy), color, thick)
    for c in range(cols + 1):
        xx = x + c * cw
        cv2.line(img, (xx, y), (xx, y + rows * rh), color, thick)


def _shading_field(h, w, rng):
    """平滑低频照明场, 均值约 1, 缓慢变化。"""
    xx, yy = np.meshgrid(np.linspace(0, 1, w), np.linspace(0, 1, h))
    field = (1.0
             - 0.30 * (xx - 0.42) ** 2
             - 0.20 * (yy - 0.55) ** 2
             + 0.10 * np.sin(2 * np.pi * (0.8 * xx + 0.3 * yy)))
    rnd = rng.normal(0.0, 1.0, (h // 40 + 2, w // 40 + 2))
    rnd = cv2.resize(rnd, (w, h), interpolation=cv2.INTER_CUBIC)
    rnd = gaussian_filter(rnd, sigma=25)
    if np.abs(rnd).max() > 1e-9:
        field += 0.08 * rnd / np.abs(rnd).max()
    return field


def _apply_scan_effects(img, theta, rng):
    """加阴影、噪声, 再按 theta 整体旋转 (白底填充)。返回 (图, 掩膜, 矩阵)。"""
    h, w = img.shape
    field = _shading_field(h, w, rng)
    out = np.clip(img.astype(np.float32) * field, 0, 255)
    out += rng.normal(0.0, 1.2, out.shape).astype(np.float32)
    out = np.clip(out, 0, 255).astype(np.uint8)
    return rotate_image(out, theta, fill_value=int(round(PAPER * float(np.median(field)))))


def _content_page(seed):
    """含文字行/表格/细线/黑块的页面 (未加扫描效果)。返回 (img, thin_lines)。"""
    rng = np.random.default_rng(seed)
    img = np.full((PAGE_H, PAGE_W), PAPER, np.uint8)
    _draw_text_lines(img, rng, y0=110, y1=640)
    _draw_table(img, 120, 720, cols=6, rows=8, cw=160, rh=42, thick=1)
    _draw_text_lines(img, rng, y0=1120, y1=PAGE_H - 130)
    # 1px 细线 (记录端点供验证)
    thin_lines = []
    for yy in (680, 700, 1080):
        cv2.line(img, (80, yy), (PAGE_W - 80, yy), 40, 1)
        thin_lines.append([[80, yy], [PAGE_W - 80, yy]])
    # 大块黑色图形
    cv2.rectangle(img, (760, 860), (1000, 1030), 25, -1)
    return img, thin_lines


def _crosshatch_page(seed):
    """交叉方向样例: 两组 ±6° 平行线, 方向相互矛盾。"""
    rng = np.random.default_rng(seed)
    img = np.full((PAGE_H, PAGE_W), PAPER, np.uint8)
    for sign in (+6.0, -6.0):
        layer = np.zeros_like(img)
        for y in range(40, PAGE_H, 34):
            cv2.line(layer, (0, y), (PAGE_W, y), 50, 1)
        layer, m, _ = rotate_image(layer, sign, fill_value=0)
        layer = cv2.resize(layer, (PAGE_W, PAGE_H)) if layer.shape != img.shape else layer
        img = np.minimum(img, np.where(m > 0, layer, PAPER).astype(np.uint8))
    _draw_text_lines(img, rng, y0=1400, y1=PAGE_H - 60, line_h=40)
    return img, []


def generate_samples(out_dir: str | Path) -> dict:
    """生成全部样例, 返回参考数据字典 (同时写入 reference.json)。"""
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(20240101)
    reference = {}

    specs = [
        ("text_tilt_m7",  -7.0, "text"),
        ("text_tilt_m25", -2.5, "text"),
        ("text_tilt_p32",  3.2, "text"),
        ("text_tilt_p8",   8.0, "text"),
        ("text_tilt_p08",  0.8, "text"),
    ]
    for i, (name, theta, kind) in enumerate(specs):
        img, thin = _content_page(seed=1000 + i)
        scanned, mask, M = _apply_scan_effects(img, theta, rng)
        cv2.imwrite(str(out / f"{name}.png"), scanned)
        thin_mapped = [map_points(M, np.array(pts, float)).tolist() for pts in thin]
        reference[name] = {
            "file": f"{name}.png",
            "kind": kind,
            "applied_rotation_deg": theta,          # 生成时施加的旋转
            "expected_correction_deg": -theta,      # 处理应估计出的校正角
            "thin_lines": thin_mapped,              # 旋转后细线端点 (验证用)
            "black_block_src": [760, 860, 1000, 1030],
        }

    # 空白页 (只有阴影和噪声, 也带一点倾角 — 仍应判为空白)
    blank = np.full((PAGE_H, PAGE_W), PAPER, np.uint8)
    scanned, _, _ = _apply_scan_effects(blank, 1.5, rng)
    cv2.imwrite(str(out / "blank.png"), scanned)
    reference["blank"] = {"file": "blank.png", "kind": "blank",
                          "applied_rotation_deg": 1.5}

    # 交叉方向样例
    cross, _ = _crosshatch_page(seed=77)
    scanned, _, _ = _apply_scan_effects(cross, -2.0, rng)
    cv2.imwrite(str(out / "cross.png"), scanned)
    reference["cross"] = {"file": "cross.png", "kind": "cross",
                          "applied_rotation_deg": -2.0}

    with open(out / "reference.json", "w", encoding="utf-8") as f:
        json.dump(reference, f, ensure_ascii=False, indent=2)
    return reference


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser(description="生成合成扫描样例")
    ap.add_argument("--out", default="samples_generated", help="输出目录")
    args = ap.parse_args()
    ref = generate_samples(args.out)
    print(f"已生成 {len(ref)} 个样例到 {args.out}/ (参考数据: reference.json)")
