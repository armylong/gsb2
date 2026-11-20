"""内置样例图生成: 带半透明边缘的前景 (RGBA) 与双色背景 (RGB)。

前景故意做成"问题样张":
  * 图形本体是平滑的径向渐变圆环 + 实心圆, alpha 边缘有高斯过渡带
  * A=0 区域的 RGB 可切换为 干净(黑) / 白污染 / 黑污染,
    用来复现"透明 PNG 叠深色底出现脏边"的经典场景
"""

from __future__ import annotations

import numpy as np

POLLUTION_MODES = ("clean", "white", "black")
POLLUTION_LABELS = {"clean": "干净 (A=0 处 RGB=黑)",
                    "white": "白污染 (A=0 处 RGB=白)",
                    "black": "黑污染 (A=0 处 RGB=黑, 彩色杂边)"}


def _radial(h: int, w: int, cx: float, cy: float) -> np.ndarray:
    y, x = np.mgrid[0:h, 0:w].astype(np.float32)
    return np.hypot(x - cx, y - cy)


def _smoothstep(edge0: float, edge1: float, x: np.ndarray) -> np.ndarray:
    t = np.clip((x - edge0) / (edge1 - edge0), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def make_foreground(size: int = 256, pollution: str = "clean") -> tuple[np.ndarray, np.ndarray]:
    """返回 (rgb, a): rgb (H,W,3) float32, a (H,W) float32。"""
    if pollution not in POLLUTION_MODES:
        raise ValueError(pollution)
    h = w = size
    cx = cy = (size - 1) / 2.0
    r = _radial(h, w, cx, cy)

    # 覆盖度: 实心圆盘 + 外侧一圈平滑衰减 (约 12px 的半透明过渡带)
    r_inner = size * 0.30
    r_outer = size * 0.42
    a_disc = 1.0 - _smoothstep(r_inner, r_outer, r)

    # 左上一个半透明的环, 让中间覆盖度更丰富
    ring_center = 1.0 - np.abs(r - size * 0.22) / (size * 0.05)
    a_ring = np.clip(ring_center, 0.0, 1.0) * 0.55
    a = np.clip(np.maximum(a_disc, a_ring * (a_disc < 1.0)), 0.0, 1.0).astype(np.float32)

    # 颜色: 角度渐变的饱和色盘, 便于观察不同色相的边缘
    theta = np.arctan2(np.mgrid[0:h, 0:w][0] - cy, np.mgrid[0:h, 0:w][1] - cx)
    t = (theta + np.pi) / (2 * np.pi)
    rgb = np.stack(
        [
            0.5 + 0.5 * np.sin(2 * np.pi * (t + 0.00)),
            0.5 + 0.5 * np.sin(2 * np.pi * (t + 0.33)),
            0.5 + 0.5 * np.sin(2 * np.pi * (t + 0.66)),
        ],
        axis=-1,
    ).astype(np.float32)

    # A=0 区域的"隐藏" RGB —— 直通 PNG 里这些数据仍然存在。
    # 色盘在全图都有定义, 所以 clean 模式天然无杂色; 污染模式则覆盖成纯色。
    transparent = a <= 0.0
    if pollution == "white":
        rgb[transparent] = 1.0            # 模拟白色 matte 残留 -> 深色底上的亮脏边
    elif pollution == "black":
        rgb[transparent] = 0.0            # 模拟黑色 matte 残留 -> 浅色底上的暗脏边
    return rgb, a


def make_background(size: int = 256) -> np.ndarray:
    """双色背景: 左半深色海军蓝, 右半浅暖灰, 中间 1px 分界线。返回 (H,W,3)。"""
    h = w = size
    bg = np.empty((h, w, 3), dtype=np.float32)
    dark = np.array([0.05, 0.06, 0.12], dtype=np.float32)    # 深色
    light = np.array([0.92, 0.90, 0.86], dtype=np.float32)   # 浅色
    bg[:, : w // 2] = dark
    bg[:, w // 2 :] = light
    return bg


def make_checker(size: int = 256, cell: int = 16) -> np.ndarray:
    """灰白棋盘格, 用于观察透明区域本身。"""
    y, x = np.mgrid[0:size, 0:size]
    parity = ((y // cell) + (x // cell)) % 2
    v = np.where(parity, 0.80, 0.55).astype(np.float32)
    return np.stack([v, v, v], axis=-1)
