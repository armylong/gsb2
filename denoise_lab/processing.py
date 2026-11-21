"""降噪处理管线。

设计约束（对应需求 4/7）：
- process() 是纯函数：输出只取决于 (带噪图, 算法, 两个区域的完整参数, 优先级)，
  与用户调整参数的先后顺序无关。因此“先编辑范围后切换算法”和“先切换算法后编辑
  范围”，只要最终设置相同，输出逐像素一致（由 tests 验证）。
- 只接收带噪图，签名中不存在干净参考。
- 区域外像素原样返回；区域边缘用 smoothstep 羽化过渡，过渡带在 UI 上可见。
- 两个区域可重叠，重叠处按显式优先级做 alpha 分配：
  高优先级区域 alpha 保持原值，低优先级 alpha 乘以 (1 - a_high)。
"""
from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

Rect = tuple[int, int, int, int]

ALGO_SMOOTH = "smooth"      # 普通平滑：高斯
ALGO_EDGE = "edge"          # 保边降噪：双边
ALGORITHMS = (ALGO_SMOOTH, ALGO_EDGE)
ALGO_LABELS = {ALGO_SMOOTH: "普通平滑 (高斯)", ALGO_EDGE: "保边降噪 (双边)"}


@dataclass(frozen=True)
class RegionParams:
    """一个降噪范围的完整参数。"""

    rect: Rect = (0, 0, 0, 0)   # (y0, y1, x0, x1)
    strength: int = 50          # 0..100
    feather: int = 12           # 边缘过渡宽度 px
    enabled: bool = True


def _smoothstep(t: np.ndarray) -> np.ndarray:
    return t * t * (3.0 - 2.0 * t)


def feather_alpha(rect: Rect, feather: int, shape: tuple[int, int]) -> np.ndarray:
    """矩形选区 -> 0..1 alpha 图；feather=0 时为硬边。"""
    h, w = shape
    y0, y1, x0, x1 = rect
    y0, y1 = max(0, y0), min(h, y1)
    x0, x1 = max(0, x0), min(w, x1)
    if y1 <= y0 or x1 <= x0:
        return np.zeros((h, w), np.float32)
    binary = np.zeros((h, w), np.uint8)
    binary[y0:y1, x0:x1] = 1
    if feather <= 0:
        return binary.astype(np.float32)
    # 到选区外部的距离（内部为正）
    dist = cv2.distanceTransform(binary, cv2.DIST_L2, 5)
    alpha = np.clip(dist / float(feather), 0.0, 1.0)
    return _smoothstep(alpha).astype(np.float32)


def _gaussian_denoise(img: np.ndarray, strength: int) -> np.ndarray:
    """普通平滑。strength 0..100 映射到 ksize 3..21。"""
    if strength <= 0:
        return img.copy()
    ksize = 3 + int(round(strength / 100.0 * 18))  # 3..21
    if ksize % 2 == 0:
        ksize += 1
    sigma = 0.3 * (ksize / 2.0 - 1.0) + 0.5
    return cv2.GaussianBlur(img, (ksize, ksize), sigmaX=sigma, sigmaY=sigma)


def _bilateral_denoise(img: np.ndarray, strength: int) -> np.ndarray:
    """保边降噪。strength 映射到颜色/空间 sigma，d 固定 9。"""
    if strength <= 0:
        return img.copy()
    s = strength / 100.0
    sigma_color = 0.02 + 0.28 * s     # 0..1 尺度
    sigma_space = 3.0 + 12.0 * s
    return cv2.bilateralFilter(img, d=9, sigmaColor=sigma_color,
                               sigmaSpace=sigma_space)


def denoise_full(img: np.ndarray, algo: str, strength: int) -> np.ndarray:
    """整图降噪（区域强度各不相同时，按强度分别计算再混合）。"""
    if strength <= 0:
        return img.copy()
    if algo == ALGO_SMOOTH:
        return _gaussian_denoise(img, strength)
    if algo == ALGO_EDGE:
        return _bilateral_denoise(img, strength)
    raise ValueError(f"unknown algo: {algo}")


def _effective_alphas(
    alphas: list[np.ndarray], winner: int
) -> list[np.ndarray]:
    """按重叠优先级分配 alpha。

    winner: 高优先级区域下标。高优先级 alpha 不变，
    其余区域 alpha 乘上所有更高优先级区域的 (1 - a)。
    """
    out = list(alphas)
    for i in range(len(alphas)):
        if i == winner:
            continue
        out[i] = alphas[i] * (1.0 - alphas[winner])
    return out


def process(
    noisy: np.ndarray,
    algo: str,
    regions: list[RegionParams],
    winner: int = 1,
) -> np.ndarray:
    """对带噪图执行分区降噪，返回 0..1 float32 结果。

    regions : 至多两个区域（下标 0/1），winner 指定重叠时谁在上面。
    区外像素保证与输入逐像素相同。
    """
    if algo not in ALGORITHMS:
        raise ValueError(f"unknown algo: {algo}")
    h, w = noisy.shape[:2]
    active = [r for r in regions if r.enabled and r.strength > 0]
    if not active:
        return noisy.copy()

    alphas_raw: list[np.ndarray] = []
    for r in active:
        alphas_raw.append(feather_alpha(r.rect, r.feather, (h, w)))

    # winner 是 regions 原始下标；映射到 active 列表下标
    active_idx = [i for i, r in enumerate(regions)
                  if r.enabled and r.strength > 0]
    if winner in active_idx:
        win_active = active_idx.index(winner)
    else:
        win_active = len(active) - 1
    alphas = _effective_alphas(alphas_raw, win_active)

    # 相同强度复用同一份降噪结果
    cache: dict[int, np.ndarray] = {}
    out = noisy.copy()
    remain = np.ones((h, w), np.float32)  # 尚未被任何区域占用的权重
    for r, a in zip(active, alphas):
        if r.strength not in cache:
            cache[r.strength] = denoise_full(noisy, algo, r.strength)
        d = cache[r.strength]
        out = out + a[..., None] * (d - noisy)
        remain -= a
    # 数值保护：区外 remain==1 时 out 自然等于 noisy
    return np.clip(out, 0.0, 1.0).astype(np.float32)


def diff_map(noisy: np.ndarray, processed: np.ndarray, gain: float = 6.0) -> np.ndarray:
    """|带噪 - 处理结果| 放大显示用差值图（0..1 灰度 RGB）。"""
    d = np.mean(np.abs(processed - noisy), axis=2)
    d = np.clip(d * gain, 0.0, 1.0)
    return np.repeat(d[..., None], 3, axis=2).astype(np.float32)


def texture_erasure_mask(
    noisy: np.ndarray, processed: np.ndarray, block: int = 16
) -> np.ndarray:
    """仅用带噪图与处理结果检测“疑似纹理被抹掉”的图块（不读干净参考）。

    判据（每个 block 单独计算）：
    1. 带噪图自身必须有高于噪声基底的高频结构（梯度能量门槛），
       纯平坦块即使噪声被完全去除也不标记；
    2. 该结构的高频能量在处理后保留率 keep = E_hp(processed)/E_hp(noisy)
       明显偏低。随机噪声被去除时块内没有相干结构，过不了第 1 关；
       棋盘/条纹/细线被抹掉时两关同时成立。
    返回 0..1 的图块热图（上采样到整图尺寸），供 UI 叠加红框。
    """
    gray_n = np.mean(noisy, axis=2).astype(np.float32)
    gray_p = np.mean(processed, axis=2).astype(np.float32)

    def hp(x: np.ndarray) -> np.ndarray:
        return x - cv2.GaussianBlur(x, (0, 0), sigmaX=2.5)

    hp_n, hp_p = hp(gray_n), hp(gray_p)
    gx = cv2.Sobel(gray_n, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(gray_n, cv2.CV_32F, 0, 1, ksize=3)
    struct = gx * gx + gy * gy  # 带噪图结构强度

    h, w = gray_n.shape
    gy_n, gx_n = h // block, w // block
    heat = np.zeros((gy_n, gx_n), np.float32)
    # 结构门槛：噪声本身的梯度能量约 1e-2~4e-2，真实纹理从 5e-2 起跳
    struct_floor = 5.0e-2
    for iy in range(gy_n):
        for ix in range(gx_n):
            y0, y1 = iy * block, (iy + 1) * block
            x0, x1 = ix * block, (ix + 1) * block
            s = float(np.mean(struct[y0:y1, x0:x1]))
            if s < struct_floor:
                continue
            en = float(np.mean(hp_n[y0:y1, x0:x1] ** 2))
            ep = float(np.mean(hp_p[y0:y1, x0:x1] ** 2))
            keep = ep / (en + 1e-12)
            if keep < 0.25:
                # 结构越强、保留越少，热度越高
                heat[iy, ix] = min(1.0, (s / (s + 5e-3)) * (1.0 - keep / 0.25))
    heat_full = cv2.resize(heat, (gx_n * block, gy_n * block),
                           interpolation=cv2.INTER_NEAREST)
    out = np.zeros((h, w), np.float32)
    out[: gy_n * block, : gx_n * block] = heat_full
    return out
