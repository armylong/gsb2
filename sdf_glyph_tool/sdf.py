"""有符号距离场 (SDF) 计算与采样。

约定:
- 源图像是 N x N 像素, 像素 (行 r, 列 c) 覆盖连续区域 [c, c+1) x [r, r+1),
  像素中心位于 (c+0.5, r+0.5), 坐标轴 x 向右、y 向下 (图像坐标)。
- 距离单位为源图像素; 字形内部为正, 外部为负; 孔洞内部属于字形外部(负)。
- 存储时按可调范围 [-R, +R] 截断, 超出范围的距离信息被明确丢弃。
"""
from __future__ import annotations

import numpy as np
from scipy.ndimage import map_coordinates

from .geometry import GLYPH_EM, Glyph

MARGIN_FRAC = 0.1  # 字形 em 方框放在源图中央 80% 区域


def glyph_to_source(contours: list[np.ndarray], n: int) -> list[np.ndarray]:
    """把 em 坐标 (y 向上) 的轮廓变换到源图像素坐标 (y 向下)。"""
    s = (1.0 - 2.0 * MARGIN_FRAC) * n / GLYPH_EM
    off = MARGIN_FRAC * n
    return [np.column_stack([off + c[:, 0] * s, n - off - c[:, 1] * s])
            for c in contours]


def source_to_glyph_matrix(n: int):
    """返回 (s, off): src_x = off + gx*s, src_y = n - off - gy*s。"""
    s = (1.0 - 2.0 * MARGIN_FRAC) * n / GLYPH_EM
    off = MARGIN_FRAC * n
    return s, off


def _segments(contours: list[np.ndarray]):
    for c in contours:
        m = len(c)
        for i in range(m):
            yield c[i], c[(i + 1) % m]


def _point_segment_dist(p: np.ndarray, a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """p: (M,2) 点集到线段 ab 的距离, 返回 (M,)。"""
    ab = b - a
    denom = float(ab @ ab)
    if denom == 0.0:
        return np.linalg.norm(p - a, axis=1)
    t = np.clip((p - a) @ ab / denom, 0.0, 1.0)
    proj = a + t[:, None] * ab
    return np.linalg.norm(p - proj, axis=1)


def _inside_mask(p: np.ndarray, contours: list[np.ndarray]) -> np.ndarray:
    """奇偶规则: 水平向右射线与所有轮廓的交点数是否为奇。孔洞自然成为外部。"""
    count = np.zeros(len(p), dtype=np.int64)
    x, y = p[:, 0], p[:, 1]
    for a, b in _segments(contours):
        x1, y1 = a
        x2, y2 = b
        if y1 == y2:
            continue
        cross = (y1 > y) != (y2 > y)
        xi = x1 + (y - y1) * (x2 - x1) / (y2 - y1)
        count += cross & (x < xi)
    return (count % 2) == 1


def compute_sdf(contours_src: list[np.ndarray], n: int) -> np.ndarray:
    """在 N x N 像素中心上计算精确有符号距离 (解析点到线段距离)。

    返回 float32 数组, 内部为正、外部为负, 单位: 源图像素。
    """
    c, r = np.meshgrid(np.arange(n) + 0.5, np.arange(n) + 0.5)
    pts = np.column_stack([c.ravel(), r.ravel()])
    dist = np.full(len(pts), np.inf)
    for a, b in _segments(contours_src):
        np.minimum(dist, _point_segment_dist(pts, a, b), out=dist)
    inside = _inside_mask(pts, contours_src)
    sdf = np.where(inside, dist, -dist)
    return sdf.reshape(n, n).astype(np.float32)


def clamp_sdf(sdf: np.ndarray, value_range: float) -> np.ndarray:
    """按存储范围截断: 超出 [-R, +R] 的距离被明确截断(信息丢弃)。"""
    return np.clip(sdf, -value_range, value_range).astype(np.float32)


def sample_sdf(sdf: np.ndarray, u: np.ndarray, v: np.ndarray) -> np.ndarray:
    """在连续源坐标 (u, v) (像素单位, 像素 i 覆盖 [i, i+1)) 上双线性采样。

    数组元素 sdf[r, c] 位于中心 (c+0.5, r+0.5), 故数组坐标 = 源坐标 - 0.5。
    图外按最近边缘值延拓。
    """
    return map_coordinates(sdf, [v - 0.5, u - 0.5], order=1, mode="nearest")


def rasterize_bitmap(contours_src: list[np.ndarray], n: int, ss: int = 4) -> np.ndarray:
    """生成源分辨率字形位图 (覆盖率 0..1), ss 为每维超采样倍数。"""
    g = np.arange(n * ss) + 0.5
    c, r = np.meshgrid(g / ss, g / ss)
    pts = np.column_stack([c.ravel(), r.ravel()])
    inside = _inside_mask(pts, contours_src).reshape(n * ss, n * ss)
    return inside.reshape(n, ss, n, ss).mean(axis=(1, 3)).astype(np.float32)


def zero_crossing_segments(sdf: np.ndarray) -> list[tuple]:
    """marching-squares 提取零等值线, 返回源坐标系下的线段列表 ((x0,y0),(x1,y1))。"""
    n = sdf.shape[0]
    segs = []
    # 角点取值: 数组元 (r, c) 位于 (c+0.5, r+0.5)
    for r in range(n - 1):
        for c in range(n - 1):
            pts = [(c + 0.5, r + 0.5, sdf[r, c]),
                   (c + 1.5, r + 0.5, sdf[r, c + 1]),
                   (c + 1.5, r + 1.5, sdf[r + 1, c + 1]),
                   (c + 0.5, r + 1.5, sdf[r + 1, c])]
            crossings = []
            for i in range(4):
                x0, y0, v0 = pts[i]
                x1, y1, v1 = pts[(i + 1) % 4]
                if (v0 < 0) == (v1 < 0):
                    continue
                t = 0.5 if v1 == v0 else v0 / (v0 - v1)
                crossings.append((x0 + t * (x1 - x0), y0 + t * (y1 - y0)))
            if len(crossings) == 2:
                segs.append((crossings[0], crossings[1]))
            elif len(crossings) == 4:  # 鞍点, 简单两两连接
                segs.append((crossings[0], crossings[1]))
                segs.append((crossings[2], crossings[3]))
    return segs
