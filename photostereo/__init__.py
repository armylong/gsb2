"""本地光度立体 (photometric stereo) 小工具.

约定 (整个项目统一):
  - 相机沿 -Z 方向观察, 表面法线朝向相机, 即合法法线 n_z > 0.
  - 光源方向向量 l 从表面指向光源 (入射方向), 与法线同系坐标.
  - 图像坐标 x 向右、y 向下, 与屏幕像素坐标一致.
  - Lambertian 模型: 观测灰度 I = rho * s * max(n . l, 0),
    rho 为反照率 (材料颜色/反射强度), s 为灯光相对亮度.
"""

from .geometry import spherical_to_dir, dir_to_spherical, ring_rig
from .solver import (
    solve_photometric,
    relight,
    PSResult,
    UNDERDETERMINED,
    NEAR_PARALLEL,
    POOR_FIT,
    NON_FRONT_FACING,
    DARK_PIXEL,
    SATURATED_MAJORITY,
    reason_text,
)
from .synthetic import make_hemisphere_scene, make_bumpy_plate_scene, render
from . import encoding

__all__ = [
    "spherical_to_dir",
    "dir_to_spherical",
    "ring_rig",
    "solve_photometric",
    "relight",
    "PSResult",
    "UNDERDETERMINED",
    "NEAR_PARALLEL",
    "POOR_FIT",
    "NON_FRONT_FACING",
    "DARK_PIXEL",
    "SATURATED_MAJORITY",
    "reason_text",
    "make_hemisphere_scene",
    "make_bumpy_plate_scene",
    "render",
    "encoding",
]
