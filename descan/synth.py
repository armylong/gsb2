"""生成略错位的合成双面扫描图与无透印底稿。

输出(灰度 PNG, 同尺寸):
- front.png       正面扫描(含背透), 待修复对象
- back.png        背面扫描(相对正面镜像且有平移/小角度错位)
- front_clean.png 无透印底稿(真值): 同一张正面, 只是没有背面墨透过来
- meta.json       真实透印系数、错位参数、留白标定框、碰撞区等校对信息

用它可以量化两件事:
1. 纯背透的留白区域是否真的变干净(向 front_clean 收敛);
2. 正面自己的细线/细字在修复后是否还在(与 front_clean 比对)。
"""

from __future__ import annotations

import json
from dataclasses import dataclass

import cv2
import numpy as np


@dataclass
class SynthConfig:
    h: int = 1200
    w: int = 900
    bleed_k: float = 0.55          # 真实透印系数
    shift: tuple[float, float] = (16.0, -11.0)  # 镜像后背面相对正面的错位
    angle_deg: float = 0.45        # 小角度旋转
    bleed_blur_sigma: float = 2.2  # 透墨在纸纤维里的扩散
    back_inset: int = 46           # 背面内容离边距离 -> warp 后角上无参考
    noise_sigma: float = 3.2
    seed: int = 7


def _paper(h: int, w: int, rng: np.random.Generator, noise_sigma: float) -> np.ndarray:
    """带轻微光照不均与扫描噪声的纸白底图。"""
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    cx, cy = w / 2.0, h / 2.0
    r2 = ((xx - cx) / cx) ** 2 + ((yy - cy) / cy) ** 2
    vignette = 7.0 * r2                       # 页角略微发灰
    base = 252.0 - vignette
    noise = rng.normal(0.0, noise_sigma, (h, w))
    return np.clip(base + noise, 0, 255).astype(np.float32)


def _draw_front(img: np.ndarray) -> dict:
    """正面内容: 多行细字 + 细线/框/圆, 包含一条与背面重合的碰撞线。"""
    font = cv2.FONT_HERSHEY_SIMPLEX
    lines = [
        "DESCAN TEST PAGE — FRONT",
        "thin body text 0123456789",
        "quick brown fox jumps over",
        "the lazy dog; fine strokes",
        "alpha beta gamma delta epsilon",
        "line width one pixel sample",
    ]
    y = 90
    for i, text in enumerate(lines):
        cv2.putText(img, text, (70, y), font, 0.75, 60.0, 1, cv2.LINE_AA)
        y += 58
    # 细矩形与圆(1px), 修复后必须还在
    cv2.rectangle(img, (70, 470), (360, 760), 40.0, 1, cv2.LINE_AA)
    cv2.circle(img, (560, 610), 120, 45.0, 1, cv2.LINE_AA)
    cv2.line(img, (470, 470), (820, 760), 50.0, 1, cv2.LINE_AA)
    # 碰撞区: 正面一条横线, 背面同一位置也有笔画(见 _draw_back)
    collision = (420, 880, 300, 14)  # x,y,w,h
    cv2.line(img, (420, 887), (720, 887), 35.0, 1, cv2.LINE_AA)
    # 底部再放几行小字
    for i in range(4):
        cv2.putText(img, f"footer fine print {i} abcdefghij", (70, 960 + i * 44),
                    font, 0.6, 70.0, 1, cv2.LINE_AA)
    return {"collision_rect": collision}


def _draw_back(img: np.ndarray, inset: int) -> dict:
    """背面内容: 文字块、纯背透区, 以及与正面碰撞位置重合的粗笔画。"""
    font = cv2.FONT_HERSHEY_SIMPLEX
    h, w = img.shape
    y = inset + 80
    for i in range(12):
        cv2.putText(
            img, f"BACKSIDE BLOCK {i:02d} reversed print content",
            (inset, y + i * 62), font, 0.8, 45.0, 2, cv2.LINE_AA,
        )
    # 右侧一条竖粗线, 正面该位置是留白 -> 纯背透, 用于检查"空白变干净"
    cv2.line(img, (w - inset - 60, inset + 40),
             (w - inset - 60, h - inset - 40), 30.0, 4, cv2.LINE_AA)
    # 与正面碰撞横线在同一物理位置的背面笔画(镜像前坐标, 见 meta 说明)
    cv2.line(img, (w - 720, 880), (w - 420, 880), 25.0, 3, cv2.LINE_AA)
    # 一个灰色块模拟大面积淡背透
    cv2.rectangle(img, (inset + 40, 760), (inset + 300, 900), 150.0, -1)
    # 留白标定框(正面坐标): 正面无字、背面有文字透过来
    calib_rect = (520, 180, 260, 170)
    return {"calib_rect_front": calib_rect}


def _mirror_warp(ink: np.ndarray, cfg: SynthConfig) -> np.ndarray:
    """镜像 + 错位(平移+小角度), 模拟背透在正面上的几何位置。"""
    h, w = ink.shape
    mir = cv2.flip(ink, 1)
    m = cv2.getRotationMatrix2D((w / 2.0, h / 2.0), cfg.angle_deg, 1.0)
    m[0, 2] += cfg.shift[0]
    m[1, 2] += cfg.shift[1]
    return cv2.warpAffine(mir, m, (w, h), flags=cv2.INTER_LINEAR,
                          borderMode=cv2.BORDER_CONSTANT, borderValue=0.0)


def generate_pair(cfg: SynthConfig | None = None) -> dict:
    """生成合成数据并返回各数组与元信息(不落盘)。"""
    cfg = cfg or SynthConfig()
    rng = np.random.default_rng(cfg.seed)
    h, w = cfg.h, cfg.w

    paper_f = _paper(h, w, rng, cfg.noise_sigma)
    paper_b = _paper(h, w, rng, cfg.noise_sigma + 0.6)

    # 绘制需要 uint8 图层, 再与 float 纸底取 min 合成墨色
    front_layer = np.full((h, w), 255, np.uint8)
    front_info = _draw_front(front_layer)
    front_canvas = np.minimum(paper_f, front_layer.astype(np.float32))
    front_clean = np.clip(front_canvas, 0, 255).astype(np.uint8)

    back_layer = np.full((h, w), 255, np.uint8)
    back_info = _draw_back(back_layer, cfg.back_inset)
    back_canvas = np.minimum(paper_b, back_layer.astype(np.float32))
    # 背面扫描图: 内容之外保持纸张, 整体略糊一点
    back_obs = cv2.GaussianBlur(
        np.clip(back_canvas, 0, 255).astype(np.uint8), (0, 0), 0.8
    )

    # 从背面印品提取墨深, 镜像错位并扩散, 按真实 k 叠加到正面
    back_ink = np.clip(paper_b - back_canvas, 0, None)
    bleed_geo = _mirror_warp(back_ink, cfg)
    bleed_spread = cv2.GaussianBlur(bleed_geo, (0, 0), cfg.bleed_blur_sigma)
    front_obs = front_canvas - cfg.bleed_k * bleed_spread
    front_obs = np.clip(
        front_obs + rng.normal(0, 1.2, (h, w)), 0, 255
    ).astype(np.uint8)

    meta = {
        "size": [h, w],
        "true_bleed_k": cfg.bleed_k,
        "shift_px": list(cfg.shift),
        "angle_deg": cfg.angle_deg,
        "back_inset": cfg.back_inset,
        "calib_rect": list(back_info["calib_rect_front"]),
        "collision_rect": list(front_info["collision_rect"]),
        "note": "背面内容整体内缩 back_inset 像素, 对齐后页角无背面参考; "
                "collision_rect 内正背面笔画重合, 应弱处理保留正面线",
    }
    return {
        "front": front_obs,
        "back": back_obs,
        "front_clean": front_clean,
        "meta": meta,
    }


def write_pair(out_dir: str, cfg: SynthConfig | None = None) -> dict:
    import os
    os.makedirs(out_dir, exist_ok=True)
    data = generate_pair(cfg)
    paths = {
        "front": os.path.join(out_dir, "front.png"),
        "back": os.path.join(out_dir, "back.png"),
        "front_clean": os.path.join(out_dir, "front_clean.png"),
        "meta": os.path.join(out_dir, "meta.json"),
    }
    cv2.imwrite(paths["front"], data["front"])
    cv2.imwrite(paths["back"], data["back"])
    cv2.imwrite(paths["front_clean"], data["front_clean"])
    with open(paths["meta"], "w", encoding="utf-8") as f:
        json.dump(data["meta"], f, ensure_ascii=False, indent=2)
    data["paths"] = paths
    return data


if __name__ == "__main__":
    import sys
    out = sys.argv[1] if len(sys.argv) > 1 else "demo_data/sample"
    d = write_pair(out)
    print("written:", d["paths"])
