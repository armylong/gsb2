"""色彩科学工具：sRGB、CIE XYZ(Lab、CIEDE2000，全部 numpy 向量化。

所有内部计算使用线性 sRGB（光域 0..1）。
约定：
  * rgb  = 线性 RGB，形状 (..., 3)，浮点 0..1
  * srgb = 伽马编码后的 sRGB，形状 (..., 3)，浮点 0..1
  * XYZ  = CIE XYZ，D65 白点
"""

from __future__ import annotations

import numpy as np

# sRGB -> 线性 RGB 的 D65 矩阵
_M = np.array(
    [
        [0.4124564, 0.3575761, 0.1804375],
        [0.2126729, 0.7151522, 0.0721750],
        [0.0193339, 0.1191920, 0.9503041],
    ],
    dtype=np.float64,
)
# 白点 D65
_XN, _YN, _ZN = 0.95047, 1.0, 1.08883


def hex_to_srgb(hexstr: str) -> np.ndarray:
    """'#rrggbb' -> sRGB 浮点 (3,) 0..1。"""
    s = hexstr.lstrip("#")
    if len(s) != 6:
        raise ValueError(f"需要 #rrggbb 形式，收到: {hexstr!r}")
    return np.array([int(s[i : i + 2], 16) for i in (0, 2, 4)], dtype=np.float64) / 255.0


def srgb_to_hex(srgb: np.ndarray) -> str:
    a = np.clip(np.asarray(srgb, dtype=np.float64), 0.0, 1.0) * 255.0 + 0.5
    r, g, b = a.astype(np.uint8)
    return f"#{r:02x}{g:02x}{b:02x}"


def srgb_to_rgb(srgb: np.ndarray) -> np.ndarray:
    """伽马编码 sRGB -> 线性 RGB。"""
    c = np.clip(np.asarray(srgb, dtype=np.float64), 0.0, 1.0)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def rgb_to_srgb(rgb: np.ndarray) -> np.ndarray:
    """线性 RGB -> 伽马编码 sRGB。"""
    c = np.clip(np.asarray(rgb, dtype=np.float64), 0.0, 1.0)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1.0 / 2.4) - 0.055)


def hex_to_rgb(hexstr: str) -> np.ndarray:
    return srgb_to_rgb(hex_to_srgb(hexstr))


def rgb_to_hex(rgb: np.ndarray) -> str:
    return srgb_to_hex(rgb_to_srgb(rgb))


def rgb_to_xyz(rgb: np.ndarray) -> np.ndarray:
    return np.einsum("ij,...j->...i", _M, np.asarray(rgb, dtype=np.float64))


def xyz_to_lab(xyz: np.ndarray) -> np.ndarray:
    xyz = np.asarray(xyz, dtype=np.float64)
    eps = 216.0 / 24389.0  # (6/29)^3
    kappa = 24389.0 / 27.0  # (29/3)^3

    def f(t):
        return np.where(t > eps, np.cbrt(np.maximum(t, 0.0)), (kappa * t + 16.0) / 116.0)

    fx = f(xyz[..., 0] / _XN)
    fy = f(xyz[..., 1] / _YN)
    fz = f(xyz[..., 2] / _ZN)
    L = 116.0 * fy - 16.0
    a = 500.0 * (fx - fy)
    b = 200.0 * (fy - fz)
    return np.stack([L, a, b], axis=-1)


def rgb_to_lab(rgb: np.ndarray) -> np.ndarray:
    return xyz_to_lab(rgb_to_xyz(rgb))


def srgb_to_lab(srgb: np.ndarray) -> np.ndarray:
    return rgb_to_lab(srgb_to_rgb(srgb))


def deltaE00(lab1: np.ndarray, lab2: np.ndarray) -> np.ndarray:
    """CIEDE2000 色差（向量化，输入形状需可广播）。

    参考: Sharma, Wu, Dalal (2005), "The CIEDE2000 Color-Difference Formula"。
    """
    lab1 = np.asarray(lab1, dtype=np.float64)
    lab2 = np.asarray(lab2, dtype=np.float64)
    L1, a1, b1 = lab1[..., 0], lab1[..., 1], lab1[..., 2]
    L2, a2, b2 = lab2[..., 0], lab2[..., 1], lab2[..., 2]

    C1 = np.hypot(a1, b1)
    C2 = np.hypot(a2, b2)
    Cbar = (C1 + C2) / 2.0
    Cbar7 = Cbar**7
    # G = 0.5(1 - sqrt(C̄^7 / (C̄^7 + 25^7)))，Sharma(2005) 式(3)
    G = 0.5 * (1.0 - np.sqrt(Cbar7 / (Cbar7 + 25.0**7)))

    ap1 = (1.0 + G) * a1
    ap2 = (1.0 + G) * a2
    Cp1 = np.hypot(ap1, b1)
    Cp2 = np.hypot(ap2, b2)

    hp1 = np.degrees(np.arctan2(b1, ap1)) % 360.0
    hp2 = np.degrees(np.arctan2(b2, ap2)) % 360.0

    dLp = L2 - L1
    dCp = Cp2 - Cp1
    dhp = np.where(
        Cp1 * Cp2 == 0.0,
        0.0,
        np.where(
            hp2 - hp1 > 180.0,
            hp2 - hp1 - 360.0,
            np.where(hp2 - hp1 < -180.0, hp2 - hp1 + 360.0, hp2 - hp1),
        ),
    )
    dHp = 2.0 * np.sqrt(Cp1 * Cp2) * np.sin(np.radians(dhp / 2.0))

    Lbp = (L1 + L2) / 2.0
    Cbp = (Cp1 + Cp2) / 2.0
    hbp = np.where(
        Cp1 * Cp2 == 0.0,
        hp1 + hp2,
        np.where(
            np.abs(hp1 - hp2) <= 180.0,
            (hp1 + hp2) / 2.0,
            np.where(
                hp1 + hp2 < 360.0,
                (hp1 + hp2 + 360.0) / 2.0,
                (hp1 + hp2 - 360.0) / 2.0,
            ),
        ),
    )

    T = (
        1.0
        - 0.17 * np.cos(np.radians(hbp - 30.0))
        + 0.24 * np.cos(np.radians(2.0 * hbp))
        + 0.32 * np.cos(np.radians(3.0 * hbp + 6.0))
        - 0.20 * np.cos(np.radians(4.0 * hbp - 63.0))
    )
    dtheta = 30.0 * np.exp(-(((hbp - 275.0) / 25.0) ** 2))
    Cbp7 = Cbp**7
    # R_C = 2 sqrt(C̄'^7 / (C̄'^7 + 25^7))
    Rc = 2.0 * np.sqrt(Cbp7 / (Cbp7 + 25.0**7))
    Sl = 1.0 + (0.015 * (Lbp - 50.0) ** 2) / np.sqrt(20.0 + (Lbp - 50.0) ** 2)
    Sc = 1.0 + 0.045 * Cbp
    Sh = 1.0 + 0.015 * Cbp * T
    Rt = -np.sin(np.radians(2.0 * dtheta)) * Rc

    kL = kC = kH = 1.0
    term = (dLp / (kL * Sl)) ** 2
    term += (dCp / (kC * Sc)) ** 2
    term += (dHp / (kH * Sh)) ** 2
    term += Rt * (dCp / (kC * Sc)) * (dHp / (kH * Sh))
    return np.sqrt(np.maximum(term, 0.0))


def mean_rgb(rgb: np.ndarray) -> np.ndarray:
    """图像 (H,W,3) 的平均线性 RGB。"""
    return np.asarray(rgb, dtype=np.float64).reshape(-1, 3).mean(axis=0)
