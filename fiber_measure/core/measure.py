"""长度计算:支持横竖不同刻度,按实际走过的折线逐步累加。

骨架是 8 连通数字曲线,直接逐步累加会把斜线算长(阶梯效应)。
因此测长前默认用 Douglas-Peucker 以 1 px 容差简化折线:
直线被拉直、折弯线的拐角保留、曲线用弦逼近(误差远小于 1 px)。
"""
from __future__ import annotations

import math

import cv2
import numpy as np

DEFAULT_SIMPLIFY_EPS = 1.0
SHARPEN_MIN_ANGLE_DEG = 45.0   # 方向变化超过该角度才视为拐角
SHARPEN_MAX_SHIFT = 4.0        # 角点允许的最大位移(px)
SHARPEN_TRIM = 2               # 拟合时每端去掉的过渡区点数


def simplify_points(points: list, epsilon: float = DEFAULT_SIMPLIFY_EPS) -> list:
    """Douglas-Peucker 简化,去掉像素化抖动。epsilon<=0 时原样返回。"""
    if epsilon <= 0 or len(points) < 3:
        return list(points)
    pts = np.asarray(points, dtype=np.float32).reshape(-1, 1, 2)
    approx = cv2.approxPolyDP(pts, float(epsilon), False)
    return [(float(p[0][0]), float(p[0][1])) for p in approx]


def _fit_line(pts: np.ndarray):
    """PCA 直线拟合,返回 (中心点, 单位方向)。"""
    c = pts.mean(axis=0)
    if len(pts) < 2:
        return c, np.array([1.0, 0.0])
    cov = np.cov((pts - c).T)
    vals, vecs = np.linalg.eigh(cov)
    d = vecs[:, int(np.argmax(vals))]
    n = math.hypot(d[0], d[1])
    return c, d / n if n > 0 else np.array([1.0, 0.0])


def _intersect(c1, d1, c2, d2):
    A = np.column_stack([d1, -d2])
    if abs(np.linalg.det(A)) < 1e-9:
        return None
    t, _ = np.linalg.solve(A, c2 - c1)
    return c1 + t * d1


def sharpen_corners(raw_points: list, simplified: list) -> list:
    """把简化折线的尖锐拐角替换为两侧线段拟合直线的交点。

    骨架在 90° 肘部会被磨圆(每角少算 1~2 px);对方向突变 >=45° 的顶点,
    用两侧原始点各拟合一条直线求交,恢复真实角点。平缓曲线不受影响。
    """
    if len(simplified) < 3 or len(raw_points) < 3:
        return list(simplified)
    # DP 顶点是原始点的子集且保序,找回每个顶点对应的原始下标
    idx, j = [], 0
    for v in simplified:
        while j < len(raw_points) and \
                (abs(raw_points[j][0] - v[0]) > 1e-3 or abs(raw_points[j][1] - v[1]) > 1e-3):
            j += 1
        if j >= len(raw_points):
            return list(simplified)  # 对不上,放弃锐化
        idx.append(j)
        j += 1
    raw = np.asarray(raw_points, dtype=float)
    out = [simplified[0]]
    for i in range(1, len(simplified) - 1):
        v = np.asarray(simplified[i], dtype=float)
        seg1 = raw[idx[i - 1]:idx[i] + 1]
        seg2 = raw[idx[i]:idx[i + 1] + 1]
        # 去掉两端拐角附近的过渡区像素(骨架磨圆区),只用直线段部分拟合
        if len(seg1) >= 2 * SHARPEN_TRIM + 3:
            seg1 = seg1[SHARPEN_TRIM:-SHARPEN_TRIM]
        if len(seg2) >= 2 * SHARPEN_TRIM + 3:
            seg2 = seg2[SHARPEN_TRIM:-SHARPEN_TRIM]
        if len(seg1) < 3 or len(seg2) < 3:
            out.append(simplified[i])
            continue
        c1, d1 = _fit_line(seg1)
        c2, d2 = _fit_line(seg2)
        cosang = abs(float(np.dot(d1, d2)))
        ang = math.degrees(math.acos(min(1.0, cosang)))
        if ang < SHARPEN_MIN_ANGLE_DEG:
            out.append(simplified[i])
            continue
        inter = _intersect(c1, d1, c2, d2)
        if inter is not None and math.hypot(*(inter - v)) <= SHARPEN_MAX_SHIFT:
            out.append((float(inter[0]), float(inter[1])))
        else:
            out.append(simplified[i])
    out.append(simplified[-1])
    return out


def polyline_length(points: list, sx: float = 1.0, sy: float = 1.0) -> float:
    """points: [(x, y), ...];sx/sy 为横向/纵向每像素实际尺寸。

    斜向步长 = hypot(dx*sx, dy*sy),因此斜线与折弯线各算各的实际路径。
    """
    total = 0.0
    for (x1, y1), (x2, y2) in zip(points, points[1:]):
        total += math.hypot((x2 - x1) * sx, (y2 - y1) * sy)
    return total


def path_length(points: list, sx: float = 1.0, sy: float = 1.0,
                simplify_eps: float = DEFAULT_SIMPLIFY_EPS,
                sharpen: bool = True) -> float:
    """测长入口:简化去像素噪声 → 尖角恢复 → 按各向异性刻度累加。"""
    pts = simplify_points(points, simplify_eps)
    if sharpen:
        pts = sharpen_corners(points, pts)
    return polyline_length(pts, sx, sy)
