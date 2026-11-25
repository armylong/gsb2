"""内置几何示例场景 (纯 numpy 程序化生成, 无外部资源)。

设计要点, 每一路都有能清楚辨认的几何贡献:
  base      灰色背景 + 青色矩形板 + 洋红色圆片 (材质底色, 值域 [0,1])
  emission  暖黄霓虹条 (自发光, 带 >1 的高光)
  diffuse   两盏漫反射光: 左上冷蓝光斑、右侧暖红光斑 (可 >1)
  specular  两束镜面高光: 青色板上的强白热点、圆片上的锐利小热点 (显著 >1)

特意保留两个核对点:
  * 霓虹条左端落在底色为 0 的背景上 -> 底色为零时灯光/自发光仍可核对
  * 镜面热点峰值 > 4.0 -> 验证中间线性阶段不被提前截断
"""

from __future__ import annotations

import numpy as np

from .channels import CHANNEL_ORDER

EXAMPLE_WIDTH = 256
EXAMPLE_HEIGHT = 256

# 供测试与界面快速定位的核对点 (x, y)
PROBE_ZERO_BASE = (24, 128)     # 霓虹条左端, base==0
PROBE_SPEC_HOT = (108, 92)      # 强镜面热点, specular > 1
PROBE_DIFFUSE_ONLY = (40, 30)    # 只有漫反射蓝灯的区域


def _mesh(h: int, w: int) -> tuple[np.ndarray, np.ndarray]:
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    return xx, yy


def _disk(xx: np.ndarray, yy: np.ndarray, cx: float, cy: float,
          r: float, softness: float = 1.5) -> np.ndarray:
    d = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2)
    return np.clip((r - d) / softness + 0.5, 0.0, 1.0).astype(np.float32)


def _rect(xx: np.ndarray, yy: np.ndarray, x0: float, y0: float,
          x1: float, y1: float, softness: float = 1.5) -> np.ndarray:
    mx = np.clip(np.minimum(xx - x0, x1 - xx) / softness + 0.5, 0.0, 1.0)
    my = np.clip(np.minimum(yy - y0, y1 - yy) / softness + 0.5, 0.0, 1.0)
    return np.minimum(mx, my)


def _color(mask: np.ndarray, rgb: tuple[float, float, float]
           ) -> np.ndarray:
    return mask[:, :, None] * np.array(rgb, np.float32)[None, None, :]


def build_example_scene(
    h: int = EXAMPLE_HEIGHT, w: int = EXAMPLE_WIDTH
) -> dict[str, np.ndarray]:
    """返回四路 HxWx3 float32 通道, 值域刻意允许超过 1.0。"""
    xx, yy = _mesh(h, w)

    # ---- base: 材质底色, 严格 [0,1], 大片区域为 0 ----
    base = np.zeros((h, w, 3), np.float32)
    base += _color(_rect(xx, yy, 60, 70, 170, 180), (0.08, 0.45, 0.42))
    base += _color(_disk(xx, yy, 180, 175, 38), (0.5, 0.12, 0.4))
    base = np.clip(base, 0.0, 1.0)

    # ---- emission: 横向暖黄霓虹条, 中心亮度 3.0 ----
    bar = _rect(xx, yy, 20, 122, 236, 134, softness=1.2)
    bar *= (0.75 + 0.25 * np.sin(xx / 18.0)).astype(np.float32)
    emission = _color(bar, (3.0, 1.7, 0.45))

    # ---- diffuse: 左上冷蓝 + 右侧暖红, 两个大范围软光斑 ----
    blue = _disk(xx, yy, 55, 50, 78, softness=6.0) * 1.6
    red = _disk(xx, yy, 215, 150, 70, softness=6.0) * 1.3
    diffuse = np.zeros((h, w, 3), np.float32)
    diffuse += _color(blue, (0.35, 0.55, 1.0))
    diffuse += _color(red, (1.0, 0.4, 0.2))

    # ---- specular: 两个锐利热点, 峰值显著 >1 ----
    hot1 = _disk(xx, yy, 108, 92, 10, softness=1.0) ** 3 * 4.5
    hot2 = _disk(xx, yy, 190, 160, 6, softness=0.8) ** 3 * 3.2
    specular = np.zeros((h, w, 3), np.float32)
    specular += _color(hot1, (1.0, 0.98, 0.95))
    specular += _color(hot2, (1.0, 0.9, 0.85))

    scene = {
        "base": base,
        "emission": emission,
        "diffuse": diffuse,
        "specular": specular,
    }
    for name in CHANNEL_ORDER:
        scene[name] = np.ascontiguousarray(scene[name], dtype=np.float32)
    return scene
