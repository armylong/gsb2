"""纯 numpy 的双层辉光引擎。

设计原则
--------
1. 高光资格只由亮度决定 (Rec.709 luma)，颜色完全不参与资格判断，
   因此暗色物体上的红颜料不会因为 "红" 而发光。
2. 门槛用 smoothstep 软过渡，资格蒙版是连续值，可调 "出现过渡"。
3. 两层辉光各自独立调强度与范围：
   - 近场辉光 (near)：小 sigma，保留光源原色；
   - 红色长尾 (tail)：大 sigma，可染色的长距离衰减。
   两层是不同 sigma 的高斯，距离亮源不同位置的衰减差别可测量。
4. 所有卷积一律零填充 (画布外视为黑场)。边缘亮点贴到画布外的部分
   按真实高斯尾部截断；全图只算一次，分区放大预览只是对同一张全图
   结果做像素级切片，不存在 "裁小窗口重算导致亮晕变形" 的问题。
5. 大 sigma 用三次盒式滤波逼近高斯 (O(n)，与半径无关)，逐通道计算
   以限制内存峰值。
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

# Rec.709 亮度系数
LUMA_W = np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)

# 长尾染色在 tint=1 时的目标色 (暖红)
RED_TARGET = np.array([1.0, 0.12, 0.08], dtype=np.float32)


def to_float_rgb(image: np.ndarray) -> np.ndarray:
    """把 uint8/float、灰度/RGBA 输入统一成 float32 RGB，范围 [0, 1]。"""
    img = np.asarray(image)
    if img.ndim == 2:
        img = np.stack([img, img, img], axis=-1)
    if img.ndim != 3 or img.shape[2] < 3:
        raise ValueError(f"需要 HxWx3 或 HxW 的图像, 实际形状 {img.shape}")
    img = img[..., :3]
    if img.dtype == np.uint8:
        img = img.astype(np.float32) / 255.0
    else:
        img = img.astype(np.float32)
    return np.clip(img, 0.0, 1.0)


def luma(rgb: np.ndarray) -> np.ndarray:
    """Rec.709 亮度，与颜色无关的单通道标量。"""
    return rgb @ LUMA_W


def qualification_mask(lum: np.ndarray, threshold: float, softness: float) -> np.ndarray:
    """smoothstep 资格蒙版。

    threshold : 蒙版等于 0.5 的亮度位置 (门槛亮度)；
    softness  : 过渡带半宽，亮度在 [t-s, t+s] 之间从 0 平滑升到 1；
    返回 [0,1] 连续蒙版，1 表示完全有资格向外扩光。
    """
    t = float(np.clip(threshold, 0.0, 1.0))
    s = max(float(softness), 1e-4)
    x = np.clip((lum - (t - s)) / (2.0 * s), 0.0, 1.0)
    return x * x * (3.0 - 2.0 * x)


def _box_blur_1d(plane: np.ndarray, radius: int, axis: int) -> np.ndarray:
    """一维零填充盒式滤波 (2D 单通道)，基于前缀和，复杂度与半径无关。"""
    n = plane.shape[axis]
    padded = np.pad(plane, [(radius, radius) if ax == axis else (0, 0)
                            for ax in range(plane.ndim)], mode="constant")
    cum = np.cumsum(padded, axis=axis, dtype=np.float64)
    # 前面补一个 0，使窗口和 = pref[k+2r+1] - pref[k]，统一处理 k=0
    zero_shape = list(cum.shape)
    zero_shape[axis] = 1
    pref = np.concatenate([np.zeros(zero_shape, dtype=np.float64), cum], axis=axis)
    hi = [slice(None)] * plane.ndim
    lo = [slice(None)] * plane.ndim
    hi[axis] = slice(2 * radius + 1, 2 * radius + 1 + n)
    lo[axis] = slice(0, n)
    window_sum = pref[tuple(hi)] - pref[tuple(lo)]
    return (window_sum / (2.0 * radius + 1.0)).astype(np.float32)


def gaussian_blur(rgb: np.ndarray, sigma: float, passes: int = 3) -> np.ndarray:
    """三次盒式滤波逼近高斯；零填充，逐通道以限制内存。"""
    sigma = float(sigma)
    if sigma < 0.5:
        return rgb.astype(np.float32, copy=True)
    radius = max(1, int(round(sigma)))  # 三次盒式时 sigma ≈ radius
    out = np.empty_like(rgb, dtype=np.float32)
    for c in range(rgb.shape[2]):
        x = rgb[..., c]
        for _ in range(passes):
            x = _box_blur_1d(x, radius, axis=0)
            x = _box_blur_1d(x, radius, axis=1)
        out[..., c] = x
    return out


@dataclass
class GlowParams:
    """全部可调参数。sigma 单位为像素，强度为线性倍数。"""

    threshold: float = 0.70      # 门槛亮度 (蒙版 0.5 处)
    softness: float = 0.10       # 出现过渡半宽
    near_sigma: float = 8.0      # 近场辉光范围
    near_strength: float = 0.60  # 近场辉光强度
    tail_sigma: float = 32.0     # 红色长尾范围
    tail_strength: float = 0.45  # 红色长尾强度
    red_tint: float = 0.80       # 长尾染红程度 0=中性 1=全红


@dataclass
class RenderResult:
    composite: np.ndarray   # HxWx3 合成结果 float32 [0,1]
    glow: np.ndarray        # 两层之和
    near: np.ndarray        # 近场层
    tail: np.ndarray        # 红色长尾层
    mask: np.ndarray        # 资格蒙版 HxW
    lum: np.ndarray         # 亮度图 HxW
    params: GlowParams


def render(rgb: np.ndarray, params: GlowParams) -> RenderResult:
    """全图一次性渲染。放大预览请直接切片本结果，不要对子图重算。"""
    base = to_float_rgb(rgb)
    lum = luma(base)
    mask = qualification_mask(lum, params.threshold, params.softness)

    # 资格像素才贡献能量：源 = 原色 × 蒙版
    source = base * mask[..., None]

    # 近场：原色小范围辉光
    near = gaussian_blur(source, params.near_sigma) * params.near_strength

    # 长尾：大范围高斯 + 可调染红
    blurred = gaussian_blur(source, params.tail_sigma)
    tint_color = params.red_tint * RED_TARGET + (1.0 - params.red_tint)
    tail = blurred * tint_color * params.tail_strength

    glow = near + tail
    composite = np.clip(base + glow, 0.0, 1.0)
    return RenderResult(composite, glow, near, tail, mask.astype(np.float32),
                        lum.astype(np.float32), params)


def to_uint8(rgb_float: np.ndarray) -> np.ndarray:
    return (np.clip(rgb_float, 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8)


def mask_to_rgb(mask: np.ndarray) -> np.ndarray:
    m = np.clip(mask, 0.0, 1.0)
    return np.stack([m, m, m], axis=-1)


def contribution_tiles(result: RenderResult, gap: int = 8) -> np.ndarray:
    """贡献对照图：黑底上左右并排 近场层 | 红色长尾层。"""
    h = result.near.shape[0]
    left = np.clip(result.near, 0.0, 1.0)
    right = np.clip(result.tail, 0.0, 1.0)
    divider = np.zeros((h, gap, 3), dtype=np.float32)
    return np.concatenate([left, divider, right], axis=1)


def crop_region(height: int, width: int, cx: int, cy: int, size: int):
    """以 (cx, cy) 为中心裁 size×size，返回 (y0, y1, x0, x1)，贴边自动夹紧。"""
    half = size // 2
    x0 = int(np.clip(cx - half, 0, max(width - size, 0)))
    y0 = int(np.clip(cy - half, 0, max(height - size, 0)))
    return y0, y0 + min(size, height), x0, x0 + min(size, width)


def extract(arr: np.ndarray, rect) -> np.ndarray:
    """对全图结果做像素级切片——放大预览与全图严格一致的保证所在。"""
    y0, y1, x0, x1 = rect
    return arr[y0:y1, x0:x1]
