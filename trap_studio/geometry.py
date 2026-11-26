"""专色搭接(trapping)几何算法, 只依赖 numpy。

核心思路
--------
对两张二值墨版分别求带最近点坐标的欧氏距离变换(EDT): 每个空白像素
都知道离两版最近墨迹的距离和方位。搭接只允许发生在「两版都没盖住的
空白像素」上, 且同时满足:

1. 离扩出版与另一版都不超过 `width` (外边空白只靠近一版, 自动排除);
2. 两个最近点的方向大致相反(点积 < 0), 即该像素确实夹在两版之间——
   共享边外侧的角像素虽然离两版都近, 但两个最近点在同一侧, 不会被填。

因此:
* 外边空白、内洞空白不会长;
* 已经重合/相接的边界之间没有空白像素, 不会反复加大;
* 每次都从原始墨版重新计算, 调宽度、来回切换都不会累积。
"""

from __future__ import annotations

import numpy as np

__all__ = [
    "edt",
    "edt_nearest",
    "compute_trap",
    "shift_mask",
    "boundary_4",
    "nearest_pixel",
]


def _edt_1d(f: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """一维 Felzenszwalb 抛物线下包络。

    返回 (平方距离数组, 各点最近源点的下标数组)。
    """
    n = f.shape[0]
    d = np.empty(n, dtype=np.float64)
    site = np.empty(n, dtype=np.int64)
    v = np.empty(n, dtype=np.int64)
    z = np.empty(n + 1, dtype=np.float64)
    k = 0
    v[0] = 0
    z[0] = -np.inf
    z[1] = np.inf
    for q in range(1, n):
        s = -np.inf
        while k >= 0:
            vk = v[k]
            s = ((f[q] + q * q) - (f[vk] + vk * vk)) / (2.0 * (q - vk))
            if s <= z[k]:
                k -= 1
            else:
                break
        k += 1
        v[k] = q
        z[k] = s
        z[k + 1] = np.inf
    k = 0
    for q in range(n):
        while z[k + 1] < q:
            k += 1
        site[q] = v[k]
        d[q] = (q - v[k]) ** 2 + f[v[k]]
    return d, site


def _run_1d_lines(f: np.ndarray, axis: int) -> tuple[np.ndarray, np.ndarray]:
    """沿指定轴对每一条线跑一维 EDT, 返回平方距离与该轴上的最近源下标。"""
    d_out = np.empty_like(f, dtype=np.float64)
    s_out = np.empty(f.shape, dtype=np.int64)
    if axis == 0:
        for x in range(f.shape[1]):
            d_out[:, x], s_out[:, x] = _edt_1d(f[:, x])
    else:
        for y in range(f.shape[0]):
            d_out[y, :], s_out[y, :] = _edt_1d(f[y, :])
    return d_out, s_out


def edt_nearest(mask: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """带最近点坐标的欧氏距离变换。

    返回
    ----
    dist: 每个像素到最近 True 像素的欧氏距离, True 处为 0;
    ny, nx: 最近 True 像素的 y/x 坐标 (True 像素指向自己)。
    """
    m = np.asarray(mask, dtype=bool)
    h, w = m.shape
    big = float(h * h + w * w) + 1.0
    f = np.where(m, 0.0, big).astype(np.float64)

    # 第一遍: 沿列, 得到每列内的纵向距离与最近行号
    d1, row_site = _run_1d_lines(f, axis=0)
    # 第二遍: 沿行, 以 d1 为初始代价; 包络给出最近源所在的列 q,
    # 再从 row_site 取回行坐标。
    d2, col_site = _run_1d_lines(d1, axis=1)
    yy, xx = np.mgrid[:h, :w]
    nx = col_site
    ny = np.take_along_axis(row_site, nx, axis=1)
    return np.sqrt(np.maximum(d2, 0.0)), ny, nx


def edt(mask: np.ndarray) -> np.ndarray:
    """欧氏距离变换: 每个像素到最近 True 像素的欧氏距离。"""
    return edt_nearest(mask)[0]


def compute_trap(
    mask_a: np.ndarray,
    mask_b: np.ndarray,
    width: float,
    spread: str,
    fields_a: tuple[np.ndarray, np.ndarray, np.ndarray] | None = None,
    fields_b: tuple[np.ndarray, np.ndarray, np.ndarray] | None = None,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """计算搭接后的两张墨版(原坐标, 不含任何模拟偏移)。

    参数
    ----
    mask_a, mask_b:
        同尺寸二值墨版, True 表示有墨。
    width:
        搭接最大宽度(像素, 欧氏距离)。<= 0 时原样返回。
    spread:
        ``"A"`` 表示 A 版向 B 版扩(浅色/下印版); ``"B"`` 反之。
    fields_a/fields_b:
        可选的预计算 ``edt_nearest`` 结果, 调宽度时可复用, 避免重算。

    返回
    ----
    (out_a, out_b, added): 处理后的两张墨版与新增像素掩码。
    新增像素只会出现在两版之间的空白带上。
    """
    a = np.asarray(mask_a, dtype=bool)
    b = np.asarray(mask_b, dtype=bool)
    if a.shape != b.shape:
        raise ValueError(f"两版尺寸不一致: {a.shape} vs {b.shape}")
    if spread not in ("A", "B"):
        raise ValueError('spread 必须是 "A" 或 "B"')
    if width <= 0:
        return a.copy(), b.copy(), np.zeros_like(a)

    fa = fields_a or edt_nearest(a)
    fb = fields_b or edt_nearest(b)
    if spread == "A":
        d_src, ny_src, nx_src = fa
        d_other, ny_other, nx_other = fb
    else:
        d_src, ny_src, nx_src = fb
        d_other, ny_other, nx_other = fa

    free = ~(a | b)
    close = (d_src <= width) & (d_other <= width) & free

    # 方向相反判据: 两个最近墨迹分别位于该像素的两侧, 才是「夹在中间」。
    yy, xx = np.mgrid[: a.shape[0], : a.shape[1]]
    v_src_y = ny_src - yy
    v_src_x = nx_src - xx
    v_oth_y = ny_other - yy
    v_oth_x = nx_other - xx
    dot = v_src_y * v_oth_y + v_src_x * v_oth_x
    between = dot < 0

    added = close & between

    if spread == "A":
        return a | added, b.copy(), added
    return a.copy(), b | added, added


def shift_mask(mask: np.ndarray, dx: int, dy: int) -> np.ndarray:
    """整版平移, 移出画布的部分丢弃, 空出的位置填 False(模拟错版用)。"""
    m = np.asarray(mask, dtype=bool)
    h, w = m.shape
    out = np.zeros_like(m)
    sx0, sx1 = max(0, -dx), min(w, w - dx)
    sy0, sy1 = max(0, -dy), min(h, h - dy)
    if sx1 <= sx0 or sy1 <= sy0:
        return out
    out[max(0, dy):max(0, dy) + (sy1 - sy0),
        max(0, dx):max(0, dx) + (sx1 - sx0)] = m[sy0:sy1, sx0:sx1]
    return out


def boundary_4(mask: np.ndarray) -> np.ndarray:
    """四邻域外轮廓: 自身有墨且至少一个四邻格是空白的像素。"""
    m = np.asarray(mask, dtype=bool)
    b = np.zeros_like(m)
    b[:-1, :] |= m[:-1, :] & ~m[1:, :]
    b[1:, :] |= m[1:, :] & ~m[:-1, :]
    b[:, :-1] |= m[:, :-1] & ~m[:, 1:]
    b[:, 1:] |= m[:, 1:] & ~m[:, :-1]
    return b


def nearest_pixel(
    mask: np.ndarray, y: int, x: int, max_radius: int = 80
) -> tuple[tuple[int, int], float] | None:
    """在 (y, x) 周围 max_radius 像素内找最近的 True 像素。

    返回 ((y, x), 欧氏距离); 范围内没有则返回 None; 点本身在掩码上时
    距离为 0。
    """
    m = np.asarray(mask, dtype=bool)
    h, w = m.shape
    if not (0 <= y < h and 0 <= x < w):
        return None
    if m[y, x]:
        return (y, x), 0.0
    y0, y1 = max(0, y - max_radius), min(h, y + max_radius + 1)
    x0, x1 = max(0, x - max_radius), min(w, x + max_radius + 1)
    yy, xx = np.nonzero(m[y0:y1, x0:x1])
    if yy.size == 0:
        return None
    yy = yy.astype(np.int64) + y0
    xx = xx.astype(np.int64) + x0
    d2 = (yy - y) ** 2 + (xx - x) ** 2
    i = int(d2.argmin())
    return (int(yy[i]), int(xx[i])), float(np.sqrt(d2[i]))
