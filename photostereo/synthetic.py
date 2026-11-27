"""程序生成的已知表面与 Lambertian 渲染器.

用于演示和验证: 真值法线/反照率已知, 可以定量核对求解结果.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass
class Scene:
    """一个已知表面.

    height:  (H, W) 高度场, z 朝相机方向为正
    normals: (H, W, 3) 真值单位法线, n_z > 0
    albedo:  (H, W) 真值反照率 (材料反射强度), 取值 0~1
    mask:    (H, W) 表面覆盖区域 (背景为 False)
    name:    场景名
    """

    name: str
    height: np.ndarray
    normals: np.ndarray
    albedo: np.ndarray
    mask: np.ndarray


def _normals_from_height(height: np.ndarray) -> np.ndarray:
    """高度场 -> 单位法线. 像素坐标 x 向右、y 向下, z 朝相机."""
    dh_dy, dh_dx = np.gradient(height)
    n = np.stack([-dh_dx, -dh_dy, np.ones_like(height)], axis=-1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    return n


def make_hemisphere_scene(size: int = 160, radius_frac: float = 0.42) -> Scene:
    """半球: 单一材料, 法线方向连续变化, 没有任何颜色纹理."""
    coords = np.arange(size) - (size - 1) / 2.0
    xx, yy = np.meshgrid(coords, coords)
    radius = radius_frac * size
    r2 = xx**2 + yy**2
    height = np.sqrt(np.maximum(radius**2 - r2, 0.0))
    mask = r2 <= radius**2
    normals = _normals_from_height(height)
    # 背景没有表面; 半球内部统一反照率, 突出"亮度变化只来自朝向"
    albedo = np.full((size, size), 0.85)
    albedo[~mask] = 0.0
    normals[~mask] = 0.0
    return Scene("半球 (单一材料)", height, normals, albedo, mask)


def make_bumpy_plate_scene(size: int = 160) -> Scene:
    """起伏板: 高斯凸包/凹坑 + 暗色贴纸, 用来区分颜色与朝向.

    贴纸区域几何不变、只改反照率; 凸包区域反照率不变、只改法线.
    """
    coords = np.arange(size) - (size - 1) / 2.0
    xx, yy = np.meshgrid(coords, coords)
    height = np.zeros((size, size))
    # (中心x, 中心y, 幅度, sigma): 正为凸包, 负为凹坑
    bumps = [
        (-38, -30, 18, 22),
        (20, -42, 14, 18),
        (44, 18, -16, 24),
        (-18, 30, 12, 20),
        (-48, 46, -10, 16),
        (10, 8, 8, 14),
    ]
    for cx, cy, amp, sigma in bumps:
        height += amp * np.exp(-((xx - cx) ** 2 + (yy - cy) ** 2) / (2 * sigma**2))

    normals = _normals_from_height(height)
    albedo = np.full((size, size), 0.82)

    def disc(cx: float, cy: float, r: float) -> np.ndarray:
        return (xx - cx) ** 2 + (yy - cy) ** 2 <= r**2

    # 暗色贴纸: 一块压在凸包上, 一块压在平面上 —— 暗不等于凹
    albedo[disc(-38, -30, 12)] = 0.22
    albedo[disc(6, 40, 10)] = 0.28
    # 一块中等灰度贴纸, 同样只改材料颜色
    albedo[disc(40, -28, 8)] = 0.5
    return Scene(
        "起伏板 (含暗色贴纸)", height, normals, albedo, np.ones((size, size), bool)
    )


@dataclass
class RenderResult:
    images: np.ndarray      # (K, H, W) 观测灰度, 已裁剪到 [0, saturation]
    shadows: np.ndarray     # (K, H, W) 自遮挡阴影 (被挡住的灯)
    saturated: np.ndarray   # (K, H, W) 过亮裁剪
    directions: np.ndarray  # (K, 3)
    strengths: np.ndarray   # (K,)
    saturation: float


def _sample_bilinear(field: np.ndarray, x: np.ndarray, y: np.ndarray) -> np.ndarray:
    h, w = field.shape
    x0 = np.floor(x).astype(np.int64)
    y0 = np.floor(y).astype(np.int64)
    valid = (x0 >= 0) & (y0 >= 0) & (x0 < w - 1) & (y0 < h - 1)
    fx = x - x0
    fy = y - y0
    out = np.zeros_like(x)
    if not np.any(valid):
        return out
    x0c, y0c, fxc, fyc = x0[valid], y0[valid], fx[valid], fy[valid]
    v00 = field[y0c, x0c]
    v10 = field[y0c, x0c + 1]
    v01 = field[y0c + 1, x0c]
    v11 = field[y0c + 1, x0c + 1]
    out[valid] = (
        v00 * (1 - fxc) * (1 - fyc)
        + v10 * fxc * (1 - fyc)
        + v01 * (1 - fxc) * fyc
        + v11 * fxc * fyc
    )
    return out


def _cast_shadows(height: np.ndarray, directions: np.ndarray) -> np.ndarray:
    """沿高度场向光源方向步进, 返回 (K, H, W) 阴影掩膜.

    从表面点沿 l 方向走, 若途中高度场高于光线高度则该点被挡.
    """
    k = directions.shape[0]
    h, w = height.shape
    ii, jj = np.mgrid[0:h, 0:w]
    shadows = np.zeros((k, h, w), dtype=bool)
    max_t = int(np.hypot(h, w)) + 2
    for idx, light in enumerate(directions):
        horiz = np.hypot(light[0], light[1])
        if horiz < 1e-9:  # 头顶光, 无自遮挡
            continue
        ux, uy = light[0] / horiz, light[1] / horiz
        rise = light[2] / horiz  # 每横移 1 像素光线抬升的高度
        ray_z = height.copy()
        blocked = np.zeros((h, w), dtype=bool)
        x = jj.astype(np.float64)
        y = ii.astype(np.float64)
        for _ in range(max_t):
            x += ux
            y += uy
            ray_z += rise
            surface = _sample_bilinear(height, x, y)
            blocked |= surface >= ray_z + 1e-3
        shadows[idx] = blocked
    return shadows


def render(
    scene: Scene,
    directions: np.ndarray,
    strengths: np.ndarray | None = None,
    *,
    noise_sigma: float = 0.004,
    saturation: float = 0.95,
    cast_shadows: bool = True,
    rng: np.random.Generator | None = None,
) -> RenderResult:
    """按 Lambertian 模型渲染灰度图, 含阴影、过曝裁剪和传感器噪声."""
    directions = np.asarray(directions, dtype=np.float64)
    k = directions.shape[0]
    if strengths is None:
        strengths = np.ones(k)
    strengths = np.asarray(strengths, dtype=np.float64)
    rng = rng or np.random.default_rng(0)

    cos = np.einsum("hwc,kc->hwk", scene.normals, directions)
    np.maximum(cos, 0.0, out=cos)
    clean = scene.albedo[..., None] * strengths * cos  # (H, W, K)
    clean[~scene.mask] = 0.0

    if cast_shadows:
        shadows = _cast_shadows(scene.height, directions)  # (K,H,W)
        clean *= ~np.moveaxis(shadows, 0, -1)
    else:
        shadows = np.zeros((k, *scene.height.shape), dtype=bool)

    observed = clean + rng.normal(0.0, noise_sigma, clean.shape)
    saturated = observed >= saturation
    images = np.clip(observed, 0.0, saturation)
    return RenderResult(
        images=np.moveaxis(images, -1, 0),
        shadows=shadows,
        saturated=np.moveaxis(saturated, -1, 0),
        directions=directions,
        strengths=strengths,
        saturation=saturation,
    )
