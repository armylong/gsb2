"""核心混合数学 —— 全部使用 float32、取值范围 [0, 1] 的 numpy 数组。

约定:
    straight (非预乘 / 直通):  RGB 通道存"纯颜色", A 单独存覆盖度
    premult  (预乘):           RGB 通道已经乘过 A

"脏边"的常见来源: 直通 PNG 里 A=0 区域的 RGB 是杂色 (常见为白),
缩放/滤波时这些杂色被插值进半透明边缘, 叠到深色底上就是一圈亮边。
"""

from __future__ import annotations

import numpy as np

# ---------------------------------------------------------------- sRGB <-> 线性


def srgb_to_linear(c: np.ndarray) -> np.ndarray:
    """IEC 61966-2-1 分段曲线, 输入输出均为 [0,1]。"""
    c = np.asarray(c, dtype=np.float32)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(c: np.ndarray) -> np.ndarray:
    c = np.asarray(c, dtype=np.float32)
    return np.where(
        c <= 0.0031308, c * 12.92, 1.055 * np.power(np.maximum(c, 0.0), 1 / 2.4) - 0.055
    )


# ------------------------------------------------------- 直通 <-> 预乘 格式转换


def straight_to_premult(rgb: np.ndarray, a: np.ndarray) -> np.ndarray:
    """rgb: (H,W,3), a: (H,W) -> 预乘 RGB。"""
    return rgb * a[..., None]


def premult_to_straight(rgb_p: np.ndarray, a: np.ndarray) -> np.ndarray:
    """预乘 -> 直通。A=0 处颜色不可恢复, 置 0 (调用方可选择保留原始数据)。"""
    out = np.zeros_like(rgb_p)
    np.divide(rgb_p, a[..., None], out=out, where=a[..., None] > 0)
    return np.clip(out, 0.0, 1.0)


# ------------------------------------------------------------------ over 混合


def over_premult(
    fg_rgb_p: np.ndarray, fg_a: np.ndarray, bg_rgb_p: np.ndarray, bg_a: np.ndarray
) -> tuple[np.ndarray, np.ndarray]:
    """Porter-Duff over, 预乘形式: out = fg + bg * (1 - fa)。"""
    inv = (1.0 - fg_a)[..., None]
    out_rgb = fg_rgb_p + bg_rgb_p * inv
    out_a = fg_a + bg_a * (1.0 - fg_a)
    return out_rgb, out_a


def composite_straight(
    fg_rgb: np.ndarray,
    fg_a: np.ndarray,
    bg_rgb: np.ndarray,
    space: str = "srgb",
) -> np.ndarray:
    """把直通 RGBA 前景合成到不透明背景上, 返回 RGB。

    space="srgb":   直接在 gamma 编码值上加权 (多数老软件的做法, 中间调偏暗)
    space="linear": 先解码到线性光, 加权后再编码回去 (物理正确, 中间调偏亮)
    """
    a = fg_a[..., None]
    if space == "linear":
        fg = srgb_to_linear(fg_rgb)
        bg = srgb_to_linear(bg_rgb)
        return linear_to_srgb(fg * a + bg * (1.0 - a))
    if space == "srgb":
        return fg_rgb * a + bg_rgb * (1.0 - a)
    raise ValueError(f"unknown space: {space!r}")


# ------------------------------------------------------------------ 工具函数


def to_u8(img: np.ndarray) -> np.ndarray:
    """[0,1] float -> uint8, 四舍五入。"""
    return np.round(np.clip(img, 0.0, 1.0) * 255.0).astype(np.uint8)


def from_u8(img: np.ndarray) -> np.ndarray:
    return img.astype(np.float32) / 255.0
