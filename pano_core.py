"""等距柱状(2:1)全景图的朝向重投影核心算法.

坐标约定:
  经度 lon ∈ [-180°, 180°], 图像左缘为 -180°, 右缘为 +180°(同一根经线, 即接缝).
  纬度 lat ∈ [-90°, 90°], 图像顶行为 +90°(天顶), 底行为 -90°(天底).
  方向向量: d = (cos lat·cos lon, cos lat·sin lon, sin lat)
  即 +x = 正前方, +y = 经度增大方向, +z = 天顶.

旋转: R = Rz(yaw) @ Ry(pitch) @ Rx(roll)
  yaw   > 0 视角向经度增大方向转(绕天顶轴)
  pitch > 0 抬头(绕 +y 轴)
  roll  > 0 绕视线轴侧倾
输出像素方向 d_out 在世界中的朝向为 R @ d_out,
因此取样时用原图方向 d_src = R.T @ d_out(行向量写法: d_out @ R).
"""
import numpy as np

TWO_PI = 2.0 * np.pi


def rotation_matrix(yaw_deg, pitch_deg, roll_deg):
    """由偏航/俯仰/侧倾(度)构造 3x3 旋转矩阵."""
    y, p, r = (np.deg2rad(a) for a in (yaw_deg, pitch_deg, roll_deg))
    cy, sy = np.cos(y), np.sin(y)
    cp, sp = np.cos(p), np.sin(p)
    cr, sr = np.cos(r), np.sin(r)
    Rz = np.array([[cy, -sy, 0.0], [sy, cy, 0.0], [0.0, 0.0, 1.0]])
    Ry = np.array([[cp, 0.0, -sp], [0.0, 1.0, 0.0], [sp, 0.0, cp]])
    Rx = np.array([[1.0, 0.0, 0.0], [0.0, cr, -sr], [0.0, sr, cr]])
    return Rz @ Ry @ Rx


def equirect_grid(h, w):
    """返回每个像素中心的 (lon, lat) 网格, 单位弧度, 形状均为 (h, w)."""
    xs = (np.arange(w) + 0.5) / w
    ys = (np.arange(h) + 0.5) / h
    lon = xs * TWO_PI - np.pi
    lat = np.pi / 2.0 - ys * np.pi
    return np.meshgrid(lon, lat)


def lonlat_to_dir(lon, lat):
    """(lon, lat) 弧度 -> 单位方向向量, 最后一维为 3."""
    c = np.cos(lat)
    return np.stack([c * np.cos(lon), c * np.sin(lon), np.sin(lat)], axis=-1)


def dir_to_lonlat(d):
    """单位方向向量 -> (lon, lat) 弧度. lat 由 asin 给出, 天然落在 [-90°, 90°],
    靠近两极时经度退化但纬度绝不会绕到球的另一侧."""
    lon = np.arctan2(d[..., 1], d[..., 0])
    lat = np.arcsin(np.clip(d[..., 2], -1.0, 1.0))
    return lon, lat


def lonlat_to_uv(lon, lat, h, w):
    """(lon, lat) 弧度 -> 连续像素坐标 (u, v). u 可超出 [0, w), 由取样处取模."""
    u = (lon + np.pi) / TWO_PI * w - 0.5
    v = (np.pi / 2.0 - lat) / np.pi * h - 0.5
    return u, v


def bilinear_sample(img, u, v):
    """对 img 在浮点坐标 (u, v) 处双线性取样.
    u 方向取模回绕(360° 水平连续), v 方向截断(两极不绕回)."""
    H, W = img.shape[:2]
    u = np.mod(u, W)
    v = np.clip(v, 0.0, H - 1.0)
    fu = np.floor(u)
    x0 = fu.astype(np.int64) % W  # u 可能因舍入恰好等于 W, 取模回到 0
    du = (u - fu)[..., None]
    y0 = np.floor(v).astype(np.int64)
    x1 = (x0 + 1) % W
    y1 = np.minimum(y0 + 1, H - 1)
    dv = (v - y0)[..., None]
    src = img.astype(np.float64)
    c00 = src[y0, x0]
    c01 = src[y0, x1]
    c10 = src[y1, x0]
    c11 = src[y1, x1]
    return (c00 * (1 - du) * (1 - dv) + c01 * du * (1 - dv)
            + c10 * (1 - du) * dv + c11 * du * dv)


def output_to_source_map(yaw, pitch, roll, out_h, out_w, src_h, src_w):
    """返回输出图每个像素对应原图的连续取样坐标 (u, v)."""
    lon, lat = equirect_grid(out_h, out_w)
    d = lonlat_to_dir(lon, lat)
    R = rotation_matrix(yaw, pitch, roll)
    src = d @ R  # 行向量右乘 R 等价于 R.T @ d
    slon, slat = dir_to_lonlat(src)
    return lonlat_to_uv(slon, slat, src_h, src_w)


def reorient(img, yaw=0.0, pitch=0.0, roll=0.0, out_shape=None):
    """按 (yaw, pitch, roll) 重定向全景图, 输出仍为等距柱状 2:1 全图.

    始终从传入的 img 取样; 调用方应一直传原图, 避免多次重采样累积损失.
    """
    H, W = img.shape[:2]
    oh, ow = out_shape or (H, W)
    u, v = output_to_source_map(yaw, pitch, roll, oh, ow, H, W)
    out = bilinear_sample(img, u, v)
    if img.dtype == np.uint8:
        out = np.clip(out + 0.5, 0, 255).astype(np.uint8)
    return out


def output_pixel_to_source(yaw, pitch, roll, x, y, out_w, out_h, src_w, src_h):
    """输出图像素 (x, y) -> 原图取样位置 (u, v) 及 (lon°, lat°)."""
    lon = (x + 0.5) / out_w * TWO_PI - np.pi
    lat = np.pi / 2.0 - (y + 0.5) / out_h * np.pi
    d = lonlat_to_dir(lon, lat)
    R = rotation_matrix(yaw, pitch, roll)
    s = R.T @ d
    slon, slat = dir_to_lonlat(s)
    u, v = lonlat_to_uv(slon, slat, src_h, src_w)
    return float(u), float(v), float(np.rad2deg(slon)), float(np.rad2deg(slat))


def forward_map_points(lon_deg, lat_deg, yaw, pitch, roll):
    """原图上的 (lon°, lat°) 地标 -> 重定向后输出图上的 (lon°, lat°)."""
    R = rotation_matrix(yaw, pitch, roll)
    d = lonlat_to_dir(np.deg2rad(lon_deg), np.deg2rad(lat_deg))
    world = d @ R.T
    lon, lat = dir_to_lonlat(world)
    return np.rad2deg(lon), np.rad2deg(lat)


def inverse_map_points(lon_deg, lat_deg, yaw, pitch, roll):
    """输出图上的 (lon°, lat°) -> 原图上的 (lon°, lat°)."""
    R = rotation_matrix(yaw, pitch, roll)
    d = lonlat_to_dir(np.deg2rad(lon_deg), np.deg2rad(lat_deg))
    src = d @ R
    lon, lat = dir_to_lonlat(src)
    return np.rad2deg(lon), np.rad2deg(lat)
