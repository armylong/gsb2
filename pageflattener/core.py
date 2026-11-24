"""核心几何:页面四边形矫正 + 引导曲线位移场展平。

坐标约定:
  - 源图坐标: 原始照片像素坐标。
  - 工作坐标: 四边形透视矫正后的矩形坐标 (out_w x out_h), 输出图与之同尺寸。
引导曲线由用户按顺序点出的点确定, 用弧长参数化的自然三次样条插值,
因此点的顺序有意义(可在界面上调整)。
"""
from __future__ import annotations

import numpy as np
import cv2


# ---------------------------------------------------------------- 样条

def natural_spline_eval(t, v, tt):
    """自然三次样条: 过 (t[i], v[i]) 求 tt 处的值。n<3 或参数非递增时退化为线性。"""
    t = np.asarray(t, dtype=np.float64)
    v = np.asarray(v, dtype=np.float64)
    tt = np.asarray(tt, dtype=np.float64)
    n = len(t)
    if n == 1:
        return np.full(tt.shape, v[0], dtype=np.float64)
    if n == 2 or np.any(np.diff(t) <= 0):
        return np.interp(tt, t, v)
    h = np.diff(t)
    A = np.zeros((n, n))
    b = np.zeros(n)
    A[0, 0] = 1.0
    A[-1, -1] = 1.0
    for i in range(1, n - 1):
        A[i, i - 1] = h[i - 1]
        A[i, i] = 2.0 * (h[i - 1] + h[i])
        A[i, i + 1] = h[i]
        b[i] = 6.0 * ((v[i + 1] - v[i]) / h[i] - (v[i] - v[i - 1]) / h[i - 1])
    m = np.linalg.solve(A, b)
    idx = np.clip(np.searchsorted(t, tt) - 1, 0, n - 2)
    hi = h[idx]
    t0 = t[idx]
    a = (t[idx + 1] - tt) / hi
    bb = (tt - t0) / hi
    return (a * v[idx] + bb * v[idx + 1]
            + ((a ** 3 - a) * m[idx] + (bb ** 3 - bb) * m[idx + 1]) * hi ** 2 / 6.0)


def sample_curve(points, num=400):
    """把用户点列(按给定顺序)采样成致密折线。返回 (num,2)。"""
    pts = np.asarray(points, dtype=np.float64).reshape(-1, 2)
    if len(pts) < 2:
        return pts.copy()
    d = np.hypot(np.diff(pts[:, 0]), np.diff(pts[:, 1]))
    t = np.concatenate([[0.0], np.cumsum(d)])
    if t[-1] <= 0:
        return pts[:1].copy()
    tt = np.linspace(0.0, t[-1], num)
    x = natural_spline_eval(t, pts[:, 0], tt)
    y = natural_spline_eval(t, pts[:, 1], tt)
    return np.column_stack([x, y])


def interp_extrap(x, xp, fp):
    """一维插值, 区间外按端点斜率线性外推。支持标量或数组输入。"""
    scalar = np.ndim(x) == 0
    x = np.atleast_1d(np.asarray(x, dtype=np.float64))
    xp = np.asarray(xp, dtype=np.float64)
    fp = np.asarray(fp, dtype=np.float64)
    y = np.interp(x, xp, fp)
    if len(xp) >= 2:
        s_lo = (fp[1] - fp[0]) / max(xp[1] - xp[0], 1e-9)
        s_hi = (fp[-1] - fp[-2]) / max(xp[-1] - xp[-2], 1e-9)
        lo = x < xp[0]
        hi = x > xp[-1]
        y[lo] = fp[0] + (x[lo] - xp[0]) * s_lo
        y[hi] = fp[-1] + (x[hi] - xp[-1]) * s_hi
    return y[0] if scalar else y


# ---------------------------------------------------------------- 位移场

class FlattenField:
    """由页面四边形 + 若干引导曲线构建的展平映射。

    输出图像素 (X, Y) -> 源图像素 的逆映射用于 cv2.remap;
    同时提供逐点正映射 src_to_out 用于左右视图联动。
    """

    def __init__(self, quad, curves, out_w, out_h):
        """
        quad:   (4,2) 源图坐标, 顺序 左上/右上/右下/左下
        curves: [ (Ni,2) 源图坐标点列, ... ] 只使用点数>=2的曲线
        """
        self.out_w = int(out_w)
        self.out_h = int(out_h)
        self.quad = np.asarray(quad, dtype=np.float64).reshape(4, 2)
        dst = np.array([[0, 0], [self.out_w - 1, 0],
                        [self.out_w - 1, self.out_h - 1], [0, self.out_h - 1]],
                       dtype=np.float64)
        self.M = cv2.getPerspectiveTransform(self.quad.astype(np.float32),
                                             dst.astype(np.float32))
        self.Minv = cv2.getPerspectiveTransform(dst.astype(np.float32),
                                                self.quad.astype(np.float32))
        self.curves_src = [np.asarray(c, dtype=np.float64).reshape(-1, 2)
                           for c in curves if len(c) >= 2]
        self._build()

    # -- 构建 ----------------------------------------------------------

    def _to_work(self, pts):
        pts = np.asarray(pts, dtype=np.float64).reshape(-1, 1, 2).astype(np.float32)
        return cv2.perspectiveTransform(pts, self.M).reshape(-1, 2).astype(np.float64)

    def _to_src(self, pts):
        pts = np.asarray(pts, dtype=np.float64).reshape(-1, 1, 2).astype(np.float32)
        return cv2.perspectiveTransform(pts, self.Minv).reshape(-1, 2).astype(np.float64)

    def _build(self):
        W, H = self.out_w, self.out_h
        self.polylines_work = []   # 工作坐标下的致密折线(展示/求交用)
        self.polylines_src = []    # 源图坐标下的致密折线(展示用)
        col_ys = []                # 每条曲线在每列的 y (W,)
        for pts in self.curves_src:
            poly_w = sample_curve(self._to_work(pts))
            self.polylines_work.append(poly_w)
            self.polylines_src.append(sample_curve(pts))
            col_ys.append(self._column_profile(poly_w, W))

        self.n_curves = len(col_ys)
        if self.n_curves == 0:
            self.src_ys = np.zeros((0, W))
            self.dst_ys = np.zeros(0)
            return

        # 按平均高度排序, 目标行按源平均间距等比铺开(彼此隔开且水平)
        means = [float(np.mean(c)) for c in col_ys]
        order = np.argsort(means)
        self.order = order
        col_ys = [col_ys[i] for i in order]
        means = np.array(means)[order]
        span = means[-1] - means[0]
        if self.n_curves == 1 or span < 1e-6:
            dst = np.linspace(H * 0.15, H * 0.85, self.n_curves + 1)[:-1] + H * 0.5 / max(self.n_curves, 1)
            dst = dst[:self.n_curves]
            if self.n_curves == 1:
                dst = np.array([H * 0.5])
        else:
            margin = H * 0.08
            dst = margin + (means - means[0]) / span * (H - 2 * margin)
        self.dst_ys = np.asarray(dst, dtype=np.float64)
        self.src_ys = np.stack(col_ys)  # (n, W) 已按高度排序

    @staticmethod
    def _column_profile(poly, W):
        """致密折线 -> 每列一个 y (x 范围外取端点值)。"""
        xs = poly[:, 0]
        ys = poly[:, 1]
        order = np.argsort(xs, kind="stable")
        xs, ys = xs[order], ys[order]
        xi = np.round(xs).astype(int)
        # 同列取平均
        ux, inv, cnt = np.unique(xi, return_inverse=True, return_counts=True)
        sy = np.zeros_like(ux, dtype=np.float64)
        np.add.at(sy, inv, ys)
        uy = sy / np.maximum(cnt, 1)
        return np.interp(np.arange(W), ux, uy)

    # -- 映射 ----------------------------------------------------------

    def map_work_to_out(self, w):
        """工作坐标 -> 输出坐标。"""
        w = np.asarray(w, dtype=np.float64).reshape(-1, 2)
        out = np.empty_like(w)
        out[:, 0] = w[:, 0]
        if self.n_curves == 0:
            out[:, 1] = w[:, 1]
            return out
        cols = np.clip(np.round(w[:, 0]).astype(int), 0, self.out_w - 1)
        for k, c in enumerate(cols):
            if self.n_curves == 1:
                out[k, 1] = w[k, 1] - self.src_ys[0, c] + self.dst_ys[0]
            else:
                out[k, 1] = interp_extrap(w[k, 1], self.src_ys[:, c], self.dst_ys)
        return out

    def map_src_to_out(self, pts):
        """源图坐标 -> 输出坐标 (逐点, 用于视图联动)。"""
        pts = np.asarray(pts, dtype=np.float64).reshape(-1, 2)
        return self.map_work_to_out(self._to_work(pts))

    def map_out_to_src(self, pts):
        """输出坐标 -> 源图坐标 (逐点)。"""
        pts = np.asarray(pts, dtype=np.float64).reshape(-1, 2)
        work = np.empty_like(pts)
        work[:, 0] = pts[:, 0]
        if self.n_curves == 0:
            work[:, 1] = pts[:, 1]
        else:
            cols = np.clip(np.round(pts[:, 0]).astype(int), 0, self.out_w - 1)
            for k, c in enumerate(cols):
                if self.n_curves == 1:
                    work[k, 1] = pts[k, 1] + self.src_ys[0, c] - self.dst_ys[0]
                else:
                    work[k, 1] = interp_extrap(pts[k, 1], self.dst_ys, self.src_ys[:, c])
        return self._to_src(work)

    def inverse_maps(self):
        """返回 cv2.remap 用的 (map_x, map_y): 输出像素 -> 源图像素, float32。"""
        W, H = self.out_w, self.out_h
        xs = np.arange(W)
        rows = np.arange(H, dtype=np.float64)
        wy = np.empty((H, W), dtype=np.float64)
        if self.n_curves == 0:
            wy[:] = rows[:, None]
        elif self.n_curves == 1:
            wy[:] = rows[:, None] + self.src_ys[0][None, :] - self.dst_ys[0]
        else:
            for c in xs:
                wy[:, c] = interp_extrap(rows, self.dst_ys, self.src_ys[:, c])
        wx = np.broadcast_to(xs[None, :], (H, W)).astype(np.float64)
        pts = np.stack([wx, wy], axis=-1).reshape(-1, 1, 2).astype(np.float32)
        src = cv2.perspectiveTransform(pts, self.Minv).reshape(H, W, 2)
        return (src[..., 0].astype(np.float32), src[..., 1].astype(np.float32))

    def flatten(self, img):
        mx, my = self.inverse_maps()
        return cv2.remap(img, mx, my, cv2.INTER_LINEAR,
                         borderMode=cv2.BORDER_CONSTANT, borderValue=(255, 255, 255))

    # -- 诊断 ----------------------------------------------------------

    def extrapolated_rows(self):
        """输出图中靠外推得到的行范围: (上界行, 下界行)。无曲线时为整个图。"""
        if self.n_curves == 0:
            return (self.out_h - 1, 0)
        return (float(self.dst_ys[0]), float(self.dst_ys[-1]))

    def find_crossings(self, tol=3.0):
        """检测引导曲线互相接触/相交。返回 [(x_work, y_work, i, j, kind)]。

        kind: 'cross' 相交(上下顺序发生交换, 映射会在该处折叠)
              'touch' 间距小于 tol
        i, j 为排序前(用户)曲线编号。
        """
        res = []
        n = self.n_curves
        if n < 2:
            return res
        xs = np.arange(self.out_w)
        for a in range(n):
            for b in range(a + 1, n):
                d = self.src_ys[a] - self.src_ys[b]  # src_ys 已排序, 正常应 <= 0
                # 排序后的相邻/任意两条若 d>0 说明原始曲线交叉
                sign = np.sign(d)
                flip = np.where(np.diff(sign) != 0)[0]
                for k in flip:
                    x = xs[k]
                    y = float((self.src_ys[a, k] + self.src_ys[b, k]) / 2)
                    res.append((float(x), y, a, b, "cross"))
                close = np.where(np.abs(d) < tol)[0]
                if len(close) and not len(flip):
                    k = close[len(close) // 2]
                    res.append((float(xs[k]), float((self.src_ys[a, k] + self.src_ys[b, k]) / 2),
                                a, b, "touch"))
        # 还原用户编号: order 是 排序位置 -> 用户编号
        return [(x, y, int(self.order[i]), int(self.order[j]), kind)
                for (x, y, i, j, kind) in res]
