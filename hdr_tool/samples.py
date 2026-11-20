"""hdr_tool.samples — 内置演示样例生成器。

生成一组 5 张多曝光 PNG(含轻微位移)、shots.json(曝光档数/位移)以及
reference_linear.npy —— 独立的线性相对亮度参考, 仅供 verify.py 核对,
合成流程( core.merge_exposures )从不读取它。

场景内容:
  * 暗部纹理区   DARK_TEX   —— 低亮度纹理, 短曝光下截断
  * 中性灰阶     GRAY_ROW   —— 7 个灰块, 检验亮度比例与中性灰
  * 彩色亮部     COLOR_SPOTS —— 饱和色高亮, 长曝光下截断
  * 全组过曝块   WHITE_HOLE —— 所有曝光都截断(无法恢复)
  * 全组欠曝块   BLACK_HOLE —— 所有曝光都截断(无法恢复)
"""
from __future__ import annotations

import json
from pathlib import Path

import cv2
import numpy as np

from .core import linear_to_srgb

W, H = 1200, 800
SAMPLE_EVS = [-4.0, -2.0, 0.0, 2.0, 4.0]
SAMPLE_SHIFTS = [(0, 0), (2, -1), (-1, 2), (1, 1), (-2, -2)]  # 轻微位移样例

GRAY_PATCHES = [0.002, 0.008, 0.032, 0.128, 0.5, 2.0, 6.0]
GRAY_ROW = (40, 40, 1120, 130)          # x, y, w, h (7 块横向排列)
DARK_TEX = (40, 500, 420, 260)
COLOR_SPOTS = [
    (950, 330, 70, (6.0, 0.8, 0.5)),
    (780, 260, 55, (0.6, 5.0, 0.9)),
    (1080, 430, 45, (0.5, 0.9, 5.5)),
]
WHITE_HOLE = (700, 600, 160, 120)       # 线性亮度 4000, 全组过曝截断
BLACK_HOLE = (900, 600, 160, 120)       # 线性亮度 1e-7, 全组欠曝截断


def build_scene():
    """构造线性相对亮度场景 (H, W, 3) float64。"""
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float64)
    # 背景: 柔和渐变, 略暖
    base = 0.03 + 0.12 * (yy / H) + 0.05 * (xx / W)
    scene = np.stack([base * 1.05, base, base * 0.90], axis=-1)
    # 彩色亮部(先画, 避免覆盖灰阶)
    for cx, cy, r, rgb in COLOR_SPOTS:
        mask = (xx - cx) ** 2 + (yy - cy) ** 2 <= r * r
        scene[mask] = rgb
    # 暗部纹理
    rng = np.random.default_rng(42)
    tex = rng.random((38, 64))
    x, y, w, h = DARK_TEX
    tex = cv2.resize(tex, (w, h), interpolation=cv2.INTER_CUBIC)
    tex = 0.0006 + 0.008 * tex
    scene[y:y + h, x:x + w, :] = tex[..., None] * np.array([1.0, 0.95, 0.9])
    # 中性灰阶
    x, y, w, h = GRAY_ROW
    pw = w // len(GRAY_PATCHES)
    for k, g in enumerate(GRAY_PATCHES):
        scene[y:y + h, x + k * pw:x + (k + 1) * pw, :] = g
    # 全组截断区
    x, y, w, h = WHITE_HOLE
    scene[y:y + h, x:x + w, :] = 4000.0
    x, y, w, h = BLACK_HOLE
    scene[y:y + h, x:x + w, :] = 1e-7
    return scene


def expose(scene, ev, shift, pad=25):
    """对场景按 EV 曝光并按 (dx, dy) 位移采样 → RGB uint8。

    img(x, y) = encode(scene(x + dx, y + dy) * 2**EV),
    与 core.merge_exposures 的画布坐标约定一致。
    """
    sp = np.pad(scene, ((pad, pad), (pad, pad), (0, 0)), mode="edge")
    dx, dy = shift
    sub = sp[pad + dy:pad + dy + H, pad + dx:pad + dx + W]
    enc = linear_to_srgb(sub * (2.0 ** float(ev)))
    return np.clip(enc * 255.0 + 0.5, 0, 255).astype(np.uint8)


def generate(out_dir):
    """生成全部样例文件, 返回元数据 dict。"""
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    scene = build_scene()
    files = []
    for ev, sh in zip(SAMPLE_EVS, SAMPLE_SHIFTS):
        img = expose(scene, ev, sh)
        name = f"sample_ev{ev:+.0f}.png"
        cv2.imwrite(str(out / name), img[:, :, ::-1])  # RGB → BGR
        files.append(name)
    np.save(out / "reference_linear.npy", scene)
    meta = {
        "files": files,
        "evs": list(SAMPLE_EVS),
        "shifts": [list(s) for s in SAMPLE_SHIFTS],
        "reference": "reference_linear.npy",
        "note": "reference_linear.npy 仅供验证核对, 合成流程不读取",
    }
    (out / "shots.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    return meta
