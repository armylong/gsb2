"""内置低光静物样例：干净参考 + 两种合成噪声。

样例全部在程序内生成，包含平坦块、细线、规律纹理（棋盘/条纹/点阵）、
低亮度梯度带以及一块低饱和彩色细节，用于抽查低光色度细节。

噪声两种模式：
- fixed:        sigma 与亮度无关，整图恒定；
- luminance:    sigma(y) = sigma_read + k * sqrt(y)（泊松-高斯，低光更明显），
                亮度用干净参考计算，但该函数返回的 sigma_map 只允许评估模块使用，
                处理管线（processing.py）从不接收干净参考。
"""
from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

IMG_H, IMG_W = 520, 660

# 语义区域（坐标均为整图像素坐标，[y0, y1, x0, x1)），供评估与默认采样框使用
ZONES: dict[str, tuple[int, int, int, int]] = {
    # 多级亮度平坦块（噪声估计的手选平坦区默认就落在这几块里）
    "flat_dark": (30, 110, 30, 150),
    "flat_mid": (30, 110, 170, 290),
    "flat_bright": (30, 110, 310, 430),
    # 低亮度缓变梯度带：亮度相关噪声在同一区域内逐级变化
    "gradient": (30, 110, 450, 630),
    # 细线：横竖交替的暗底亮线 / 亮底暗线
    "lines": (140, 240, 30, 300),
    # 点阵纹理
    "dots": (140, 240, 330, 630),
    # 棋盘纹理
    "checker": (270, 370, 30, 300),
    # 正弦条纹纹理
    "stripes": (270, 370, 330, 630),
    # 低饱和彩色细节（色度抽查专用：细彩条 + 色块）
    "chroma": (400, 490, 30, 330),
    # 额外大平坦区（暗），方便手动框选
    "flat_dark2": (400, 490, 360, 630),
}


@dataclass
class Sample:
    """一次合成的全部产物。

    clean 是已知干净参考，UI 评估面板和 metrics 才允许读取；
    sigma_map 是逐像素真实噪声标准差（仅评估用）。
    """

    clean: np.ndarray          # float32 RGB, 0..1
    noisy: np.ndarray          # float32 RGB, 0..1（已 clip）
    sigma_map: np.ndarray      # float32, HxW，luma 域真实 sigma（0..1 尺度）
    mode: str                  # "fixed" | "luminance"
    sigma_base: float          # fixed: 全局 sigma；luminance: 读出噪声项
    k_signal: float            # luminance: 信号相关系数；fixed 时为 0
    rng_seed: int
    zones: dict[str, tuple[int, int, int, int]]


def _build_clean() -> np.ndarray:
    """构造干净静物底图，float32 RGB, 0..1。"""
    img = np.full((IMG_H, IMG_W, 3), 0.10, np.float32)  # 整体低光暗背景
    yy, xx = np.mgrid[0:IMG_H, 0:IMG_W].astype(np.float32)

    def fill(rect, value):
        y0, y1, x0, x1 = rect
        img[y0:y1, x0:x1] = value

    # 三个不同亮度的平坦块（低光范围：0.08 / 0.28 / 0.55）
    fill(ZONES["flat_dark"], (0.08, 0.08, 0.08))
    fill(ZONES["flat_mid"], (0.28, 0.28, 0.28))
    fill(ZONES["flat_bright"], (0.55, 0.55, 0.55))

    # 缓变梯度带 0.05 -> 0.45
    gy0, gy1, gx0, gx1 = ZONES["gradient"]
    ramp = np.linspace(0.05, 0.45, gx1 - gx0, dtype=np.float32)[None, :]
    grad = np.repeat(ramp, gy1 - gy0, axis=0)
    img[gy0:gy1, gx0:gx1] = grad[..., None]

    # 细线区：暗底上每 8px 一条 2px 亮线，横竖两组，再加亮底暗线
    ly0, ly1, lx0, lx1 = ZONES["lines"]
    line = np.full((ly1 - ly0, lx1 - lx0, 3), 0.06, np.float32)
    h = ly1 - ly0
    line[:, (np.arange(lx1 - lx0) % 8 < 2)] = 0.62
    line[(np.arange(h) % 8 < 2), :] = 0.62
    line[h // 2:, :] = 0.5  # 下半段换成亮底暗线
    line[h // 2:, :][(np.arange(h - h // 2) % 8 < 2), :] = 0.05
    img[ly0:ly1, lx0:lx1] = line

    # 点阵：规则圆点
    dy0, dy1, dx0, dx1 = ZONES["dots"]
    dots = np.full((dy1 - dy0, dx1 - dx0, 3), 0.12, np.float32)
    cy = (np.arange(dy1 - dy0)[:, None] - 7) ** 2
    cx = (np.arange(dx1 - dx0)[None, :] - 7) ** 2
    period = 16
    disc = (((cy % (period ** 2)) + (cx % (period ** 2))) <= 16.0)
    dots[disc] = 0.5
    img[dy0:dy1, dx0:dx1] = dots

    # 棋盘：8px 格子，低对比（0.18 vs 0.34），考验“纹理被抹掉”
    qy0, qy1, qx0, qx1 = ZONES["checker"]
    qh, qw = qy1 - qy0, qx1 - qx0
    checker = (((np.arange(qh)[:, None] // 8) + (np.arange(qw)[None, :] // 8)) % 2)
    checker = np.where(checker == 0, 0.18, 0.34).astype(np.float32)
    img[qy0:qy1, qx0:qx1] = checker[..., None]

    # 正弦条纹
    sy0, sy1, sx0, sx1 = ZONES["stripes"]
    sw = sx1 - sx0
    stripe_v = 0.25 + 0.12 * np.sin(2 * np.pi * np.arange(sw) / 10.0)
    stripes = np.repeat(stripe_v[None, :], sy1 - sy0, axis=0).astype(np.float32)
    img[sy0:sy1, sx0:sx1] = stripes[..., None]

    # 低饱和彩色细节：暗色底上的细彩条与小色块（饱和度低，模拟低光色度）
    ay0, ay1, ax0, ax1 = ZONES["chroma"]
    chroma = np.full((ay1 - ay0, ax1 - ax0, 3), 0.10, np.float32)
    cw = ax1 - ax0
    for i in range(0, cw, 24):
        band = (i // 24) % 3
        col = [(0.22, 0.12, 0.12), (0.12, 0.20, 0.14), (0.13, 0.13, 0.24)][band]
        chroma[:, i:min(i + 6, cw)] = col
    chroma[10:40, 200:260] = (0.20, 0.16, 0.10)
    chroma[50:80, 240:300] = (0.11, 0.18, 0.21)
    img[ay0:ay1, ax0:ax1] = chroma

    # 第二块暗平坦区
    fill(ZONES["flat_dark2"], (0.06, 0.06, 0.06))

    # 轻微整体光晕，让画面不那么“数字化”（确定性，不含随机）
    glow = 0.015 * np.exp(-(((yy - 260) / 260) ** 2 + ((xx - 330) / 360) ** 2))
    img = np.clip(img + glow[..., None], 0.0, 1.0)
    return img


def clean_luma(clean: np.ndarray) -> np.ndarray:
    """RGB(0..1) -> luma(0..1)，与 processing/metrics 保持同一口径。"""
    ycrcb = cv2.cvtColor(clean, cv2.COLOR_RGB2YCrCb)
    return ycrcb[..., 0]


def make_sample(
    mode: str = "luminance",
    sigma_base: float = 0.03,
    k_signal: float = 0.05,
    rng_seed: int = 42,
) -> Sample:
    """生成一份带噪样例。

    参数
    ----
    mode: "fixed" 时 sigma 恒为 sigma_base；
          "luminance" 时 sigma(y) = sigma_base + k_signal * sqrt(max(y,0))。
    sigma_base: 0.005..0.08 量级（UI 滑块映射后传入）。
    k_signal: 仅 luminance 模式生效。
    """
    if mode not in ("fixed", "luminance"):
        raise ValueError(f"unknown noise mode: {mode}")
    clean = _build_clean()
    luma = clean_luma(clean)

    if mode == "fixed":
        sigma_map = np.full(luma.shape, sigma_base, np.float32)
    else:
        sigma_map = sigma_base + k_signal * np.sqrt(np.maximum(luma, 0.0))

    rng = np.random.default_rng(rng_seed)
    # 三通道独立加噪（低光色度噪声同样存在），同一张 luma sigma 图
    noise = rng.standard_normal(clean.shape).astype(np.float32) * sigma_map[..., None]
    noisy = np.clip(clean + noise, 0.0, 1.0)
    return Sample(
        clean=clean,
        noisy=noisy,
        sigma_map=sigma_map.astype(np.float32),
        mode=mode,
        sigma_base=float(sigma_base),
        k_signal=float(k_signal) if mode == "luminance" else 0.0,
        rng_seed=rng_seed,
        zones=dict(ZONES),
    )


def default_estimation_rects() -> list[tuple[int, int, int, int]]:
    """噪声估计默认手选平坦区：三块不同亮度的平坦块。"""
    return [ZONES["flat_dark"], ZONES["flat_mid"], ZONES["flat_bright"]]
