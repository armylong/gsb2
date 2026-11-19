"""生成失焦样例: 前/中/后三个纹理区域 + 低纹理区 + 轻微机位偏移。

输出:
- sample_1.png / sample_2.png / sample_3.png  三张不同对焦位置的照片
- ground_truth.json  校验用答案(区域定义、各区域应清晰的来源编号、
  生成时的几何变换及其逆变换=用户对齐设置)。正常合成流程不读取此文件。
- gt_labels.png      区域标签图 (0=背景 1=前 2=中 3=后 4=低纹理带)
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import cv2
import numpy as np

from focusstack.alignment import AlignParams

W, H = 1200, 800
CENTER = (W / 2.0, H / 2.0)

# 各区域深度: 前=0 中=1 后=2 (背景按后景处理)
FRONT_CENTER, FRONT_R = (300, 430), 175
MID_RECT = (500, 260, 260, 340)    # x, y, w, h
BACK_RECT = (850, 170, 280, 400)
LOWTEX_H = 150                     # 顶部低纹理带高度

# 每张照片的轻微机位偏移 (dx, dy, scale), 均在手动修正范围内
GEN_TRANSFORMS = [
    (0.0, 0.0, 1.0),
    (2.5, -1.5, 1.0),
    (-2.0, 1.0, 1.004),
]
DEFOCUS_SIGMA = 1.5  # 每级深度差的失焦模糊 sigma


def build_master(seed: int = 7) -> tuple[np.ndarray, np.ndarray]:
    """返回 (清晰主图 float32 BGR, 区域标签图 uint8)。"""
    rng = np.random.default_rng(seed)
    img = np.zeros((H, W, 3), np.float32)
    # 低纹理背景: 平缓垂直渐变 + 极弱噪声
    img[:] = np.linspace(70, 130, H, dtype=np.float32)[:, None, None]
    img += rng.normal(0, 1.2, img.shape).astype(np.float32)

    labels = np.zeros((H, W), np.uint8)
    labels[:LOWTEX_H, :] = 4

    # 后景区: 粗棋盘格
    bx, by, bw, bh = BACK_RECT
    yy, xx = np.mgrid[0:H, 0:W]
    checker = 90 + 80 * ((xx // 28 + yy // 28) % 2)
    back_mask = np.zeros((H, W), bool)
    back_mask[by : by + bh, bx : bx + bw] = True
    img[back_mask] = checker[back_mask, None] * np.array([0.9, 1.0, 1.05], np.float32)
    labels[back_mask] = 3

    # 中景区: 中频竖条纹 + 少量噪声
    mx, my, mw, mh = MID_RECT
    stripes = 128 + 60 * np.sin(2 * np.pi * xx / 9.0) + rng.normal(0, 6, (H, W))
    mid_mask = np.zeros((H, W), bool)
    mid_mask[my : my + mh, mx : mx + mw] = True
    img[mid_mask] = stripes[mid_mask, None].astype(np.float32) * np.array([1.0, 0.95, 0.9], np.float32)
    labels[mid_mask] = 2

    # 前景区: 圆形, 细颗粒纹理
    fine = 128 + rng.normal(0, 55, (H, W))
    fine = cv2.GaussianBlur(fine.astype(np.float32), (3, 3), 0)
    front_mask = np.zeros((H, W), bool)
    cv2.circle(front_mask.view(np.uint8), FRONT_CENTER, FRONT_R, 1, -1)
    front_mask = front_mask.astype(bool)
    img[front_mask] = fine[front_mask, None] * np.array([1.05, 1.0, 0.9], np.float32)
    labels[front_mask] = 1

    return np.clip(img, 0, 255), labels


def render_focus(master: np.ndarray, labels: np.ndarray, focus: int) -> np.ndarray:
    """按对焦位置 focus(0前/1中/2后) 渲染一张失焦照片。"""
    depth_of = {0: 2, 1: 0, 2: 1, 3: 2, 4: 2}  # 标签→深度
    out = np.zeros_like(master)
    for lab, depth in depth_of.items():
        sigma = DEFOCUS_SIGMA * abs(depth - focus)
        layer = master if sigma < 0.01 else cv2.GaussianBlur(master, (0, 0), sigma)
        out[labels == lab] = layer[labels == lab]
    return out


def align_params_for(M: np.ndarray, center: tuple[float, float]) -> dict:
    """生成变换 M 的逆变换, 转成 AlignParams(dx, dy, scale) 形式(即用户对齐设置)。"""
    A = cv2.invertAffineTransform(M)
    s = float(A[0, 0])
    cx, cy = center
    return {
        "dx": float((A[0, 2] - cx) / s + cx),
        "dy": float((A[1, 2] - cy) / s + cy),
        "scale": s,
    }


def generate(outdir: str | Path) -> Path:
    out = Path(outdir)
    out.mkdir(parents=True, exist_ok=True)
    master, labels = build_master()

    paths = []
    aligns = []
    for i, (dx, dy, s) in enumerate(GEN_TRANSFORMS):
        img = render_focus(master, labels, i)
        M = AlignParams(dx, dy, s).matrix(CENTER)
        warped = cv2.warpAffine(
            img, M, (W, H), flags=cv2.INTER_LINEAR,
            borderMode=cv2.BORDER_CONSTANT, borderValue=0,
        )
        p = out / f"sample_{i + 1}.png"
        cv2.imwrite(str(p), np.clip(warped + 0.5, 0, 255).astype(np.uint8))
        paths.append(p.name)
        aligns.append(align_params_for(M, CENTER))

    cv2.imwrite(str(out / "gt_labels.png"), labels)
    gt = {
        "size": [W, H],
        "images": paths,
        "reference": 0,
        "align": aligns,
        "regions": {
            "front": {"label": 1, "expected_sharpest": 0},
            "mid": {"label": 2, "expected_sharpest": 1},
            "back": {"label": 3, "expected_sharpest": 2},
        },
        "lowtex_label": 4,
        "note": "仅供校验脚本使用; 合成流程只读取图片与用户设置",
    }
    (out / "ground_truth.json").write_text(
        json.dumps(gt, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return out


def main():
    ap = argparse.ArgumentParser(description="生成失焦样例")
    ap.add_argument("--out", default="samples", help="输出目录")
    args = ap.parse_args()
    out = generate(args.out)
    print(f"样例已生成: {out}/sample_1..3.png, 真值: {out}/ground_truth.json")


if __name__ == "__main__":
    main()
