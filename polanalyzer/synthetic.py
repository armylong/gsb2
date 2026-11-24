"""合成偏振测试图.

生成同机位、不同滤镜角度的一组图, 内置两类区域:
  * 强亮斑 (高斯圆斑): A 高、调制幅度 R 大, 方向由用户指定
  * 普通底色: 低 A、弱调制, 另带一块方向不同的普通斑块
并可注入极暗像素、过曝像素和噪声, 用于直接验证拟合方向与错误掩码.
"""

from __future__ import annotations

from dataclasses import dataclass
import numpy as np

from .physics import REC709


def _linear_to_srgb(x: np.ndarray) -> np.ndarray:
    """sRGB 传递函数正变换, 与 physics.srgb_to_linear 互逆."""
    x = np.clip(x, 0.0, 1.0)
    return np.where(x <= 0.0031308, 12.92 * x, 1.055 * np.power(x, 1 / 2.4) - 0.055)


@dataclass
class SyntheticConfig:
    width: int = 640
    height: int = 480
    blob_center: tuple[float, float] = (0.68, 0.38)   # 相对坐标
    blob_sigma: float = 0.07                           # 相对短边
    # 注意 A*(1+rho) 需 <= 1, 否则亮角会削顶 (削顶测试由独立的过曝方块负责)
    blob_A: float = 0.55
    blob_rho: float = 0.70
    blob_phi_deg: float = 30.0                         # 亮斑偏振方向
    patch_center: tuple[float, float] = (0.30, 0.66)
    patch_sigma: float = 0.10
    patch_A: float = 0.30
    patch_rho: float = 0.35
    patch_phi_deg: float = 110.0                       # 普通斑块方向
    bg_A: float = 0.12
    bg_rho: float = 0.05
    bg_phi_deg: float = 0.0
    noise_sigma: float = 0.012
    seed: int = 42
    add_dark_region: bool = True
    add_saturated_region: bool = True


def _gaussian(h: int, w: int, center: tuple[float, float], sigma_rel: float) -> np.ndarray:
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float64)
    cx, cy = center[0] * w, center[1] * h
    sigma = sigma_rel * min(h, w)
    return np.exp(-((xx - cx) ** 2 + (yy - cy) ** 2) / (2 * sigma ** 2))


def generate_synthetic(config: SyntheticConfig, angles_deg: list[float]) -> np.ndarray:
    """返回 (K,H,W,3) uint8 合成图栈."""
    rng = np.random.default_rng(config.seed)
    h, w = config.height, config.width
    blob = _gaussian(h, w, config.blob_center, config.blob_sigma)
    patch = _gaussian(h, w, config.patch_center, config.patch_sigma)

    # 逐像素 A / rho / phi 场: 亮斑与普通斑块叠加在底色上
    A = np.full((h, w), config.bg_A)
    A += (config.blob_A - config.bg_A) * blob
    A += (config.patch_A - config.bg_A) * patch * (1 - blob)
    rho = np.full((h, w), config.bg_rho)
    rho = np.maximum(rho, config.blob_rho * blob)
    rho = np.maximum(rho, config.patch_rho * patch * (1 - blob))
    phi_deg = np.full((h, w), config.bg_phi_deg)
    phi_deg = np.where(blob > 0.35, config.blob_phi_deg, phi_deg)
    phi_deg = np.where((patch > 0.35) & (blob <= 0.35), config.patch_phi_deg, phi_deg)
    R = A * rho

    B = R * np.cos(2 * np.deg2rad(phi_deg))
    C = R * np.sin(2 * np.deg2rad(phi_deg))

    frames = []
    for theta in angles_deg:
        t = np.deg2rad(theta)
        y = A + B * np.cos(2 * t) + C * np.sin(2 * t)
        y = np.clip(y, 0.0, None)
        if config.noise_sigma > 0:
            y = np.clip(y + rng.normal(0, config.noise_sigma, y.shape), 0, None)

        # 以中性灰为色调基底, 亮斑略偏暖; 基底先按自身 Rec.709 亮度归一化到 1,
        # 再乘以目标亮度 y, 严格保持线性亮度等于 y (避免单通道削顶破坏马吕斯关系)
        warmth = blob[..., None]
        base_rgb = np.array([1.04, 1.0, 0.92])[None, None, :] * (1 - 0.5 * warmth) + \
            np.array([1.08, 1.0, 0.88])[None, None, :] * (0.5 * warmth)
        base_lum = base_rgb @ REC709
        rgb = base_rgb / np.maximum(base_lum[..., None], 1e-12) * y[..., None]
        # 在线性光域构造, 再经 sRGB 编码, 与拟合端的 sRGB 线性化互逆
        rgb = _linear_to_srgb(np.clip(rgb, 0, 1))

        if config.add_dark_region:
            # 左下角极暗方块
            rgb[int(h * 0.06):int(h * 0.20), int(w * 0.06):int(w * 0.16), :] *= 0.02
        if config.add_saturated_region:
            # 右上角过曝方块 (恒定 255, 无角度信息)
            rgb[int(h * 0.06):int(h * 0.20), int(w * 0.84):int(w * 0.94), :] = 1.05

        rgb = np.clip(rgb, 0, 1)
        frames.append((rgb * 255).astype(np.uint8))
    return np.stack(frames, axis=0)
