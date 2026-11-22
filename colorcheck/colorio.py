"""色彩空间转换与色差 / 亮度指标。

纯 numpy 实现, 不依赖 Qt, 方便单元测试与离线脚本复用。
所有 RGB 输入除特别说明外均为 0-255 的 sRGB 值。
"""
from __future__ import annotations

import numpy as np

# ---- sRGB <-> linear -------------------------------------------------------

def srgb_to_linear(c):
    c = np.asarray(c, dtype=float)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(c):
    c = np.asarray(c, dtype=float)
    return np.where(c <= 0.0031308, 12.92 * c,
                    1.055 * np.power(np.maximum(c, 0.0), 1.0 / 2.4) - 0.055)


# ---- 亮度与 WCAG 反差 -------------------------------------------------------

_LUMA_COEF = np.array([0.2126, 0.7152, 0.0722])


def relative_luminance(rgb):
    """Rec.709 相对亮度, 黑=0 白=1。支持任意前缀形状 (...,3)。"""
    lin = srgb_to_linear(np.asarray(rgb, dtype=float) / 255.0)
    return lin @ _LUMA_COEF


def contrast_ratio(rgb1, rgb2):
    """WCAG 亮度反差比, 取值 1-21。两个输入形状需可广播。"""
    l1 = relative_luminance(rgb1)
    l2 = relative_luminance(rgb2)
    lighter = np.maximum(l1, l2)
    darker = np.minimum(l1, l2)
    return (lighter + 0.05) / (darker + 0.05)


def composite_over(rgb, alpha, bg):
    """把带透明度的 rgb 合成到 bg 上。alpha 为 0-1, 形状需可广播。"""
    a = np.asarray(alpha, dtype=float)[..., None]
    return np.asarray(rgb, dtype=float) * a + np.asarray(bg, dtype=float) * (1.0 - a)


# ---- CIE Lab / CIEDE2000 ----------------------------------------------------

_SRGB2XYZ = np.array([
    [0.4124564, 0.3575761, 0.1804375],
    [0.2126729, 0.7151522, 0.0721750],
    [0.0193339, 0.1191920, 0.9503041],
])
_D65 = np.array([0.95047, 1.0, 1.08883])
_CIE_EPS = 216.0 / 24389.0
_CIE_KAPPA = 24389.0 / 27.0


def rgb_to_lab(rgb):
    """sRGB(0-255) -> CIE Lab(D65), 输出形状 (...,3)。"""
    lin = srgb_to_linear(np.asarray(rgb, dtype=float) / 255.0)
    xyz = lin @ _SRGB2XYZ.T
    xyz = xyz / _D65
    f = np.where(xyz > _CIE_EPS, np.cbrt(np.maximum(xyz, 0.0)),
                 xyz / (3.0 * _CIE_EPS ** 2) + 4.0 / 29.0)
    L = 116.0 * f[..., 1] - 16.0
    a = 500.0 * (f[..., 0] - f[..., 1])
    b = 200.0 * (f[..., 1] - f[..., 2])
    return np.stack([L, a, b], axis=-1)


def _de2000_elementwise(lab1, lab2):
    """CIEDE2000 核心, 输入为可逐元素广播的 Lab 分量。"""
    L1, a1, b1 = lab1[..., 0], lab1[..., 1], lab1[..., 2]
    L2, a2, b2 = lab2[..., 0], lab2[..., 1], lab2[..., 2]

    C1 = np.hypot(a1, b1)
    C2 = np.hypot(a2, b2)
    C_bar = (C1 + C2) / 2.0
    G = 0.5 * (1.0 - np.sqrt(C_bar ** 7 / (C_bar ** 7 + 25.0 ** 7)))
    ap1 = (1.0 + G) * a1
    ap2 = (1.0 + G) * a2
    Cp1 = np.hypot(ap1, b1)
    Cp2 = np.hypot(ap2, b2)

    hp1 = np.degrees(np.arctan2(b1, ap1)) % 360.0
    hp2 = np.degrees(np.arctan2(b2, ap2)) % 360.0

    dLp = L2 - L1
    dCp = Cp2 - Cp1

    dh = np.zeros_like(dLp)
    both = (Cp1 * Cp2) > 0
    diff = hp2 - hp1
    dh = np.where(both & (diff > 180.0), diff - 360.0, dh)
    dh = np.where(both & (diff < -180.0), diff + 360.0, dh)
    dh = np.where(both & (np.abs(diff) <= 180.0), diff, dh)
    # 仅一侧色度为 0 时, 色差角取另一侧的色相
    dh = np.where(~both, hp2 + hp1, dh)

    dHp = 2.0 * np.sqrt(Cp1 * Cp2) * np.sin(np.radians(dh) / 2.0)

    Lbp = (L1 + L2) / 2.0
    Cbp = (Cp1 + Cp2) / 2.0

    h_sum = hp1 + hp2
    hbp = np.where(~both, h_sum,
                   np.where(np.abs(hp1 - hp2) <= 180.0, h_sum / 2.0,
                            np.where(h_sum < 360.0, (h_sum + 360.0) / 2.0,
                                     (h_sum - 360.0) / 2.0)))

    T = (1.0
         - 0.17 * np.cos(np.radians(hbp - 30.0))
         + 0.24 * np.cos(np.radians(2.0 * hbp))
         + 0.32 * np.cos(np.radians(3.0 * hbp + 6.0))
         - 0.20 * np.cos(np.radians(4.0 * hbp - 63.0)))

    dtheta = 30.0 * np.exp(-(((hbp - 275.0) / 25.0) ** 2))
    Rc = 2.0 * np.sqrt(Cbp ** 7 / (Cbp ** 7 + 25.0 ** 7))
    Sl = 1.0 + (0.015 * (Lbp - 50.0) ** 2) / np.sqrt(20.0 + (Lbp - 50.0) ** 2)
    Sc = 1.0 + 0.045 * Cbp
    Sh = 1.0 + 0.015 * Cbp * T
    Rt = -np.sin(np.radians(2.0 * dtheta)) * Rc

    term = ((dLp / Sl) ** 2
            + (dCp / Sc) ** 2
            + (dHp / Sh) ** 2
            + Rt * (dCp / Sc) * (dHp / Sh))
    return np.sqrt(np.maximum(term, 0.0))


def ciede2000(rgb1, rgb2):
    """两组 sRGB 颜色逐元素的 CIEDE2000 色差。"""
    lab1 = rgb_to_lab(rgb1)
    lab2 = rgb_to_lab(rgb2)
    return _de2000_elementwise(lab1, lab2)


def ciede2000_matrix(rgbs_a, rgbs_b):
    """两两色差矩阵, 输出 shape (len(A), len(B))。"""
    lab_a = rgb_to_lab(rgbs_a)[:, None, :]
    lab_b = rgb_to_lab(rgbs_b)[None, :, :]
    return _de2000_elementwise(lab_a, lab_b)


# ---- OKLab / OKLCH (候选色生成用, 感知均匀) ---------------------------------

_OK_M1 = np.array([
    [0.4122214708, 0.5363325363, 0.0514459929],
    [0.2119034982, 0.6806995451, 0.1073969566],
    [0.0883024619, 0.2817188376, 0.6299787005],
])
_OK_M2 = np.array([
    [0.2104542553, 0.7936177850, -0.0040720468],
    [1.9779984951, -2.4285922050, 0.4505937099],
    [0.0259040371, 0.7827717662, -0.8086757660],
])


def rgb_to_oklch(rgb):
    """sRGB(0-255) -> OKLCH, 返回 (L in 0..1, C, h in degrees 0..360)。"""
    lin = srgb_to_linear(np.asarray(rgb, dtype=float) / 255.0)
    lms = np.cbrt(np.maximum(lin @ _OK_M1.T, 0.0))
    lab = lms @ _OK_M2.T
    L, a, b = lab[..., 0], lab[..., 1], lab[..., 2]
    C = np.hypot(a, b)
    h = np.degrees(np.arctan2(b, a)) % 360.0
    return np.stack([L, C, h], axis=-1)


def oklch_to_rgb(L, C, h):
    """OKLCH -> sRGB(0-255, 越界裁剪)。标量或数组均可。"""
    h_rad = np.radians(h)
    lab = np.stack([np.asarray(L, dtype=float),
                    np.asarray(C, dtype=float) * np.cos(h_rad),
                    np.asarray(C, dtype=float) * np.sin(h_rad)], axis=-1)
    lms = lab @ np.linalg.inv(_OK_M2).T
    lms = lms ** 3
    lin = lms @ np.linalg.inv(_OK_M1).T
    srgb = linear_to_srgb(np.clip(lin, 0.0, 1.0))
    return np.clip(srgb * 255.0, 0.0, 255.0)


# ---- HEX 工具 ---------------------------------------------------------------

def rgb_to_hex(rgb) -> str:
    r, g, b = (int(round(float(v))) for v in np.asarray(rgb).reshape(-1)[:3])
    return f"#{r:02X}{g:02X}{b:02X}"


def hex_to_rgb(text: str):
    text = text.strip().lstrip("#")
    if len(text) == 3:
        text = "".join(ch * 2 for ch in text)
    if len(text) != 6:
        raise ValueError(f"无法解析颜色: {text!r}")
    return tuple(int(text[i:i + 2], 16) for i in (0, 2, 4))
