"""单版调墨曲线：输入原覆盖率 x，输出调整后覆盖率 f(x)。

曲线由若干控制点（x 升序、x∈[0,1]，端点固定 (0,0)、(1,1)）做
分段单调三次插值（PCHIP 风格的单调 Hermite），保证 0..1 且不反转。
GUI 里拖动控制点即可改曲线；引擎只依赖查 LUT，保证可复算。
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

DEFAULT_KNOTS = ((0.0, 0.0), (1.0, 1.0))


def _monotone_slopes(xs: np.ndarray, ys: np.ndarray) -> np.ndarray:
    """Fritsch–Carlson 单调分段三次 Hermite 的节点切线。"""
    h = np.diff(xs)
    delta = np.diff(ys) / h
    m = np.zeros_like(xs)
    m[1:-1] = (delta[:-1] + delta[1:]) / 2.0
    m[0] = delta[0]
    m[-1] = delta[-1]
    # 抑制过冲，保持单调
    for k in range(len(delta)):
        if abs(delta[k]) < 1e-12:
            m[k] = 0.0
            m[k + 1] = 0.0
        else:
            alpha = m[k] / delta[k]
            beta = m[k + 1] / delta[k]
            s = alpha * alpha + beta * beta
            if s > 9.0:
                tau = 3.0 / np.sqrt(s)
                m[k] = tau * alpha * delta[k]
                m[k + 1] = tau * beta * delta[k]
    return m


def _pchip_eval(xs: np.ndarray, ys: np.ndarray, m: np.ndarray, q: np.ndarray) -> np.ndarray:
    q = np.clip(q, 0.0, 1.0)
    idx = np.searchsorted(xs, q, side="right") - 1
    idx = np.clip(idx, 0, len(xs) - 2)
    h = xs[idx + 1] - xs[idx]
    t = (q - xs[idx]) / h
    t2 = t * t
    t3 = t2 * t
    h00 = 2 * t3 - 3 * t2 + 1
    h10 = t3 - 2 * t2 + t
    h01 = -2 * t3 + 3 * t2
    h11 = t3 - t2
    return h00 * ys[idx] + h10 * h * m[idx] + h01 * ys[idx + 1] + h11 * h * m[idx + 1]


@dataclass
class ToneCurve:
    knots: tuple[tuple[float, float], ...] = DEFAULT_KNOTS

    def normalized(self) -> "ToneCurve":
        """强制端点为 (0,0)/(1,1)、x 升序。"""
        pts = sorted((float(x), float(y)) for x, y in self.knots)
        pts[0] = (0.0, 0.0)
        pts[-1] = (1.0, 1.0)
        return ToneCurve(tuple((x, np.clip(y, 0.0, 1.0)) for x, y in pts))

    def apply(self, x: np.ndarray, lut_size: int = 4096) -> np.ndarray:
        tc = self.normalized()
        xs = np.array([k[0] for k in tc.knots])
        ys = np.array([k[1] for k in tc.knots])
        m = _monotone_slopes(xs, ys)
        lut = _pchip_eval(xs, ys, m, np.linspace(0.0, 1.0, lut_size))
        lut = np.clip(lut, 0.0, 1.0)
        xi = np.clip(np.asarray(x, dtype=np.float64), 0.0, 1.0)
        idx = np.rint(xi * (lut_size - 1)).astype(np.int64)
        return lut[idx]

    def sample(self, n: int = 256) -> tuple[np.ndarray, np.ndarray]:
        q = np.linspace(0.0, 1.0, n)
        return q, self.apply(q, lut_size=max(n, 4096))

    @staticmethod
    def gamma(g: float) -> "ToneCurve":
        """整体伽马：f(x)=x^g。g>1 减墨，g<1 加墨。"""
        return ToneCurve(((0.0, 0.0), (1.0, 1.0))) if abs(g - 1.0) < 1e-12 else ToneCurve(
            ((0.0, 0.0), (0.25, 0.25**g), (0.5, 0.5**g), (0.75, 0.75**g), (1.0, 1.0))
        )

    @staticmethod
    def linear() -> "ToneCurve":
        return ToneCurve(DEFAULT_KNOTS)
