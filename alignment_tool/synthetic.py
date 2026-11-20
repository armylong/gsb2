"""合成测试图与配对图。

位移约定（全项目统一）
----------------------
dx > 0 : moving 相对 ref 向右移；dy > 0 : 向下移。
使用 cv2.warpAffine 实现亚像素平移，移出画面的边缘用固定填充值 FILL_VALUE
（见 geometry 模块）补齐，填充区不参与残差统计。
"""

from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

from .geometry import FILL_VALUE, shift_to_warp


# 支持的程序化纹理类型
TEXTURE_TYPES = ("dots", "blobs", "stripes", "low_texture", "checker")


def make_texture(
    size: tuple[int, int] = (320, 256),
    kind: str = "blobs",
    seed: int = 0,
) -> np.ndarray:
    """生成一张 uint8 灰度纹理图。

    Parameters
    ----------
    size : (width, height)
    kind :
        - dots        随机亮点（高纹理，适合演示正常配准）
        - blobs       高斯斑点 + 模糊（自然纹理）
        - stripes     周期性竖条纹（重复纹理，多峰场景）
        - low_texture 平缓渐变 + 极少量特征（低纹理，不可信场景）
        - checker     棋盘格（强重复纹理）
    """
    if kind not in TEXTURE_TYPES:
        raise ValueError(f"未知纹理类型 {kind!r}，可选: {TEXTURE_TYPES}")
    w, h = size
    rng = np.random.default_rng(seed)
    img = np.full((h, w), 40, np.float32)

    if kind == "dots":
        n = max(120, (w * h) // 250)
        xs = rng.integers(0, w, n)
        ys = rng.integers(0, h, n)
        radii = rng.integers(1, 4, n)
        shades = rng.integers(120, 235, n)
        for x, y, r, s in zip(xs, ys, radii, shades):
            cv2.circle(img, (int(x), int(y)), int(r), float(s), -1, cv2.LINE_AA)
        img = cv2.GaussianBlur(img, (3, 3), 0.6)

    elif kind == "blobs":
        n = max(18, (w * h) // 2500)
        xs = rng.integers(-20, w + 20, n)
        ys = rng.integers(-20, h + 20, n)
        radii = rng.integers(12, 40, n)
        shades = rng.integers(-60, 90, n)
        for x, y, r, s in zip(xs, ys, radii, shades):
            cv2.circle(img, (int(x), int(y)), int(r), float(128 + s), -1, cv2.LINE_AA)
        img = cv2.GaussianBlur(img, (0, 0), 9.0)
        img += rng.normal(0, 4.0, img.shape)

    elif kind == "stripes":
        period = 14
        x = np.arange(w, dtype=np.float32)
        band = (np.sin(2 * np.pi * x / period) * 0.5 + 0.5) * 180 + 40
        img[:] = band[np.newaxis, :]
        # 加一点纵向调制与噪声，避免完全一维
        y = np.arange(h, dtype=np.float32)
        img += (0.2 * np.sin(2 * np.pi * y / (period * 3)))[:, np.newaxis] * 30
        img = cv2.GaussianBlur(img, (3, 3), 0.8)
        img += rng.normal(0, 3.0, img.shape)

    elif kind == "checker":
        period = 16
        yy, xx = np.mgrid[0:h, 0:w]
        block = ((xx // period) + (yy // period)) % 2
        img = np.where(block == 0, 55.0, 205.0).astype(np.float32)
        img = cv2.GaussianBlur(img, (3, 3), 0.7)
        img += rng.normal(0, 2.5, img.shape)

    elif kind == "low_texture":
        # 大尺度平缓渐变，只有两三个弱斑点
        yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
        img = 60 + 30 * (xx / w) + 20 * np.sin(2 * np.pi * yy / h)
        for _ in range(3):
            cx, cy = rng.integers(0, w), rng.integers(0, h)
            cv2.circle(img, (int(cx), int(cy)), 18, 110.0, -1, cv2.LINE_AA)
        img = cv2.GaussianBlur(img, (0, 0), 12.0)
        img += rng.normal(0, 2.0, img.shape)

    return np.clip(img, 0, 255).astype(np.uint8)


@dataclass
class PairResult:
    """一次合成配对的结果。"""

    ref: np.ndarray
    moving: np.ndarray
    dx: float  # 已知的真实位移（向右为正）
    dy: float  # 已知的真实位移（向下为正）
    brightness: float  # 实际施加的亮度增量
    noise_sigma: float


def make_pair(
    base: np.ndarray | None = None,
    size: tuple[int, int] = (320, 256),
    kind: str = "blobs",
    seed: int = 0,
    dx: float = 0.7,
    dy: float = -0.4,
    brightness: float = 10.0,
    contrast: float = 1.0,
    noise_sigma: float = 3.0,
    fill_value: int = FILL_VALUE,
) -> PairResult:
    """从一张基准图生成带亚像素平移、亮度扰动和噪声的配对图。

    ref    = 基准图（直接取纹理）
    moving = 将 ref 按 (dx, dy) 亚像素平移，再施加亮度/对比度与高斯噪声，
             边缘空白用 fill_value 填充。
    """
    if base is None:
        base = make_texture(size, kind=kind, seed=seed)
    ref = base.copy()

    h, w = ref.shape[:2]
    m = shift_to_warp(dx, dy)
    shifted = cv2.warpAffine(
        ref, m, (w, h),
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=(int(fill_value),),
    )

    rng = np.random.default_rng(seed + 7919)
    moved = shifted.astype(np.float32) * float(contrast) + float(brightness)
    if noise_sigma > 0:
        moved += rng.normal(0.0, float(noise_sigma), moved.shape).astype(np.float32)
    moving = np.clip(moved, 0, 255).astype(np.uint8)

    return PairResult(
        ref=ref,
        moving=moving,
        dx=float(dx),
        dy=float(dy),
        brightness=float(brightness),
        noise_sigma=float(noise_sigma),
    )
