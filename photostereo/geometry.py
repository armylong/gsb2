"""光源方向几何与灯架配置.

方向约定见包 docstring: 向量从表面指向光源, z 分量为正表示灯在相机同侧.
"""
from __future__ import annotations

import numpy as np


def spherical_to_dir(azimuth_deg: float, elevation_deg: float) -> np.ndarray:
    """方位角/仰角 -> 单位方向向量.

    azimuth: 绕 z 轴角度, 0 度指向 +x, 90 度指向 +y (屏幕下方).
    elevation: 与 xy 平面的夹角, 90 度为头顶光 (沿 +z).
    """
    az = np.deg2rad(azimuth_deg)
    el = np.deg2rad(elevation_deg)
    vec = np.array(
        [np.cos(el) * np.cos(az), np.cos(el) * np.sin(az), np.sin(el)],
        dtype=np.float64,
    )
    norm = np.linalg.norm(vec)
    return vec / norm if norm > 0 else vec


def dir_to_spherical(vec: np.ndarray) -> tuple[float, float]:
    """单位方向向量 -> (azimuth_deg, elevation_deg)."""
    v = np.asarray(vec, dtype=np.float64)
    v = v / np.linalg.norm(v)
    el = np.rad2deg(np.arcsin(np.clip(v[2], -1.0, 1.0)))
    az = np.rad2deg(np.arctan2(v[1], v[0])) % 360.0
    return float(az), float(el)


def ring_rig(
    n: int = 8, elevation_deg: float = 45.0, start_azimuth_deg: float = 0.0
) -> np.ndarray:
    """环布灯架: n 盏灯等方位角分布、同一仰角, 返回 (n, 3) 单位向量."""
    az = start_azimuth_deg + np.arange(n) * (360.0 / n)
    return np.stack([spherical_to_dir(a, elevation_deg) for a in az])


def condition_number(directions: np.ndarray) -> float:
    """灯架矩阵 L (k,3) 的条件数; 越大说明灯方向越接近共面/平行."""
    directions = np.asarray(directions, dtype=np.float64)
    s = np.linalg.svd(directions, compute_uv=False)
    if s[-1] < 1e-12:
        return np.inf
    return float(s[0] / s[-1])
