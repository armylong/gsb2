"""从一块区域里估计两个重复方向和步长。

做法
----
1. 对彩色区域做自相关 (FFT, 每通道去均值归一化), 得到"平移 (dx, dy) 后与自身
   有多像"的 NCC 图; 找局部极大值, 用抛物线插值细化到小数像素。
2. 用高分峰两两组合出候选基矢, 再给每组候选算"点阵一致分": 在
   ``n1*t1 + n2*t2`` 这些格点上直接算 NCC 取平均。真正的周期点阵处处重复;
   误取半步时, 它自己还行, 但 2*半步、半步+v 就会掉分。
3. 选点阵一致分高、面积小的一组; 再尝试把它按整数倍"缩短" (2 倍、3 倍…),
   如果缩短后一致分不降, 就采用更短的周期 —— 这正是"半步/整步都像重复"的判定。
4. 保留两组候选 (最小周期 / 整步), 并在 :func:`assess_basis` 里给出建议。

所有平移都以原图像素为单位, 允许小数。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

import numpy as np

from .geometry import Vec, det2, snap_vectors_to_lattice, solve_basis


# ---------------------------------------------------------------------------
# 基础工具
# ---------------------------------------------------------------------------

def _zscore_patch(patch: np.ndarray) -> np.ndarray:
    p = np.asarray(patch, dtype=np.float64)
    if p.ndim == 2:
        p = p[..., None]
    mu = p.mean(axis=(0, 1), keepdims=True)
    sd = p.std(axis=(0, 1), keepdims=True)
    return (p - mu) / np.maximum(sd, 1e-9)


def _integral(x: np.ndarray) -> np.ndarray:
    return np.pad(
        x.cumsum(0).cumsum(1),
        ((1, 0), (1, 0)) + ((0, 0),) * (x.ndim - 2),
    )


def _rect_sum(I: np.ndarray, y0, y1, x0, x1) -> np.ndarray:
    return I[y1, x1] - I[y0, x1] - I[y1, x0] + I[y0, x0]


def _ncc_flatten(a: np.ndarray, b: np.ndarray) -> float:
    a = a.reshape(-1)
    b = b.reshape(-1)
    if a.size < 64:
        return 0.0
    am = a - a.mean()
    bm = b - b.mean()
    den = float(np.sqrt(np.dot(am, am) * np.dot(bm, bm)))
    if den < 1e-12:
        return 0.0
    return float(np.dot(am, bm) / den)


# ---------------------------------------------------------------------------
# 自相关 NCC 图
# ---------------------------------------------------------------------------

def ncc_map(z: np.ndarray, max_dy: int, max_dx: int,
            min_overlap_frac: float = 0.18) -> Tuple[np.ndarray, np.ndarray]:
    """返回 (score[dy, dx], valid[dy, dx])。

    ``dy`` 从 0 到 ``max_dy``, ``dx`` 从 ``-max_dx`` 到 ``max_dx``。
    score 为各通道 NCC 的平均值; 重叠面积不足的格子置 0。
    """
    h, w, _c = z.shape
    H2, W2 = 2 * h, 2 * w
    F = np.fft.rfft2(z, s=(H2, W2), axes=(0, 1))
    cross = np.fft.irfft2(F * np.conj(F), s=(H2, W2), axes=(0, 1))
    I1 = _integral(z)
    I2 = _integral(z * z)

    dys = np.arange(0, max_dy + 1)
    dxs = np.arange(-max_dx, max_dx + 1)
    DY, DX = np.meshgrid(dys, dxs, indexing="ij")

    ya = np.maximum(0, -DY)
    yb = np.minimum(h, h - DY)
    xa = np.maximum(0, -DX)
    xb = np.minimum(w, w - DX)
    n = (yb - ya) * (xb - xa)
    valid = n >= min_overlap_frac * h * w
    nz = np.maximum(n, 1)[..., None]

    Sa = _rect_sum(I1, ya, yb, xa, xb)
    Sb = _rect_sum(I1, ya + DY, yb + DY, xa + DX, xb + DX)
    Sa2 = _rect_sum(I2, ya, yb, xa, xb)
    Sb2 = _rect_sum(I2, ya + DY, yb + DY, xa + DX, xb + DX)

    Cab = cross[DY % H2, DX % W2]
    num = Cab - Sa * Sb / nz
    var_a = np.maximum(Sa2 - Sa * Sa / nz, 0.0)
    var_b = np.maximum(Sb2 - Sb * Sb / nz, 0.0)
    den = np.sqrt(var_a * var_b)
    with np.errstate(divide="ignore", invalid="ignore"):
        score = np.where(den > 1e-9 * nz, num / np.maximum(den, 1e-12),
                         np.where((var_a < 1e-9) & (var_b < 1e-9), 1.0, 0.0))
    score = score.mean(axis=-1)
    score = np.clip(score, -1.0, 1.0)
    score[~valid] = 0.0
    return score.astype(np.float64), valid


def _ncc_at(z: np.ndarray, step: int, t: Vec,
            min_overlap_frac: float = 0.15) -> Optional[float]:
    """任意 (小数) 平移的 NCC, 直接在 zscore 区域上算。

    只取对两块区域都完全有效的矩形窗口, 用整数平移 + 双线性混合, 避免逐点
    构造浮点网格 (候选很多时这里是热点)。
    """
    h, w = z.shape[:2]
    dx = float(t[0]) / step
    dy = float(t[1]) / step
    iy = int(np.floor(dy))
    ix = int(np.floor(dx))
    fy = dy - iy
    fx = dx - ix
    y0 = max(0, -iy)
    y1 = min(h - 1, h - 2 - iy)
    x0 = max(0, -ix)
    x1 = min(w - 1, w - 2 - ix)
    if y1 - y0 + 1 < 8 or x1 - x0 + 1 < 8:
        return None
    if ((y1 - y0 + 1) * (x1 - x0 + 1)) / float(h * w) < min_overlap_frac:
        return None
    A = z[y0:y1 + 1, x0:x1 + 1]
    za0 = z[y0 + iy:y1 + iy + 1, x0 + ix:x1 + ix + 1]
    za1 = z[y0 + iy:y1 + iy + 1, x0 + ix + 1:x1 + ix + 2]
    zb0 = z[y0 + iy + 1:y1 + iy + 2, x0 + ix:x1 + ix + 1]
    zb1 = z[y0 + iy + 1:y1 + iy + 2, x0 + ix + 1:x1 + ix + 2]
    top = za0 * (1.0 - fx) + za1 * fx
    bot = zb0 * (1.0 - fx) + zb1 * fx
    B = top * (1.0 - fy) + bot * fy
    return _ncc_flatten(A, B)


def _local_maxima(score: np.ndarray, radius: int = 2) -> np.ndarray:
    mx = score.copy()
    for dy in range(-radius, radius + 1):
        for dx in range(-radius, radius + 1):
            if dy == 0 and dx == 0:
                continue
            shifted = np.full_like(score, -2.0)
            sy0, sy1 = max(0, dy), min(score.shape[0], score.shape[0] + dy)
            sx0, sx1 = max(0, dx), min(score.shape[1], score.shape[1] + dx)
            shifted[sy0:sy1, sx0:sx1] = score[sy0 - dy:sy1 - dy, sx0 - dx:sx1 - dx]
            mx = np.maximum(mx, shifted)
    return score >= mx - 1e-12


def _parabola_offset(s_prev: float, s0: float, s_next: float) -> float:
    den = s_prev - 2.0 * s0 + s_next
    if abs(den) < 1e-12:
        return 0.0
    return float(np.clip(0.5 * (s_prev - s_next) / den, -0.5, 0.5))


# ---------------------------------------------------------------------------
# 数据结构
# ---------------------------------------------------------------------------

@dataclass
class Peak:
    t: Vec                    # 小数像素平移
    score: float
    index: Tuple[int, int] = (0, 0)

    @property
    def length(self) -> float:
        return float(np.hypot(self.t[0], self.t[1]))


@dataclass
class BasisCandidate:
    t1: Vec
    t2: Vec
    score: float                   # 组成它的两个峰的平均相关
    kind: str = "other"            # primitive / multiple / alternative
    note: str = ""
    lattice_score: float = 0.0     # 整张点阵上的平均相关 (主判据)

    @property
    def area(self) -> float:
        return abs(det2(self.t1, self.t2))

    @property
    def label(self) -> str:
        return (f"t1=({self.t1[0]:.2f}, {self.t1[1]:.2f})  "
                f"t2=({self.t2[0]:.2f}, {self.t2[1]:.2f})")

    def copy_with(self, t1: Vec, t2: Vec, *, kind: Optional[str] = None,
                  note: Optional[str] = None,
                  lattice_score: Optional[float] = None) -> "BasisCandidate":
        return BasisCandidate(
            t1, t2, self.score,
            self.kind if kind is None else kind,
            self.note if note is None else note,
            self.lattice_score if lattice_score is None else lattice_score,
        )


_LATTICE_COMBOS: Tuple[Tuple[int, int], ...] = (
    (1, 0), (0, 1), (-1, 0), (0, -1),
    (1, 1), (1, -1), (-1, 1), (-1, -1),
    (2, 0), (0, 2), (2, 1), (1, 2), (2, -1), (1, -2),
)


def _lattice_score(t1: Vec, t2: Vec, z: np.ndarray, step: int,
                   max_shift: float, min_overlap_frac: float,
                   cache: Optional[Dict[Tuple[float, float], Optional[float]]] = None
                   ) -> float:
    """整张点阵上的平均相关值。

    在 ``n1*t1 + n2*t2`` 这些格点上直接算 NCC 取平均。真实的周期点阵处处
    重复; 误取的半步会让 2*半步、半步+v 这类位置掉分。直接算而不是查 score
    图, 才能正确处理小数周期的点阵。
    """
    vals = []
    for i, j in _LATTICE_COMBOS:
        t = (i * t1[0] + j * t2[0], i * t1[1] + j * t2[1])
        if np.hypot(*t) > max_shift:
            continue
        if cache is not None:
            # 只缓存完全相同的平移; 四舍五入的键会把不同平移的结果张冠李戴
            key = (round(t[0], 6), round(t[1], 6))
            if key in cache:
                v = cache[key]
            else:
                v = _ncc_at(z, step, t, min_overlap_frac)
                cache[key] = v
        else:
            v = _ncc_at(z, step, t, min_overlap_frac)
        if v is not None:
            vals.append(v)
    if not vals:
        return 0.0
    return float(np.mean(vals))


@dataclass
class PeriodicityAnalysis:
    """一次估算的完整结果; 保留区域数据, 供后续半步/整步二次判断。"""
    peak: np.ndarray                 # 分析用的 zscore 区域 (可能降采样)
    step: int                        # 降采样步长 (原图像素/格)
    peaks: List[Peak]
    candidates: List[BasisCandidate]
    groups: List[BasisCandidate]     # 界面上的"候选组 A/B"
    min_overlap_frac: float
    score_map: Optional[np.ndarray] = None
    score_dys: Optional[np.ndarray] = None
    score_dxs: Optional[np.ndarray] = None

    def ncc_at_shift(self, t: Vec,
                     min_overlap_frac: Optional[float] = None) -> Optional[float]:
        mo = self.min_overlap_frac if min_overlap_frac is None else min_overlap_frac
        return _ncc_at(self.peak, self.step, t, mo)

    def score_of(self, t: Vec) -> float:
        s = self.ncc_at_shift(t)
        return 0.0 if s is None else s

    def lattice_of(self, t1: Vec, t2: Vec,
                   cache: Optional[Dict[Tuple[float, float], Optional[float]]] = None
                   ) -> float:
        return _lattice_score(
            t1, t2, self.peak, self.step,
            self.peak.shape[1] * self.step, self.min_overlap_frac, cache)

    def support(self, t: Vec) -> float:
        """平移在区域内仍有足够重叠的比例 (0..1)。"""
        dx = abs(float(t[0])) / self.step
        dy = abs(float(t[1])) / self.step
        h, w = self.peak.shape[:2]
        ox = max(0.0, 1.0 - dx / w)
        oy = max(0.0, 1.0 - dy / h)
        return float(ox * oy)


# ---------------------------------------------------------------------------
# 半步 / 整步判断
# ---------------------------------------------------------------------------

@dataclass
class DirectionAdvice:
    t: Vec
    full_lattice: Optional[float]      # 当前基矢下, 整张点阵的平均相关
    half: Optional[Vec]                # 缩短一半后的基矢
    half_lattice: Optional[float]
    verdict: str                       # shorter / longer / fuller / ambiguous / unknown
    message: str


@dataclass
class BasisAdvice:
    lattice: Optional[float]
    directions: List[DirectionAdvice]
    preferred: str                     # "shorter" | "longer" | "selected" | "ambiguous" | "unknown"
    suggested_basis: Optional[Tuple[Vec, Vec]]
    message: str


def assess_basis(analysis: PeriodicityAnalysis, t1: Vec, t2: Vec,
                 lattice_tol: float = 0.018,
                 min_credible: float = 0.50,
                 min_half_length: float = 4.0) -> BasisAdvice:
    """判断当前两组基矢该取半步还是整步。

    判据是"整张点阵是否都重复", 而不只是单根向量: 把某根基矢缩短一半后,
    如果整张点阵的平均相关仍与现在相当, 说明半步也能解释同样的花纹;
    如果明显下降, 说明半步只是局部相似, 当前的整步才可信。
    两者差不多时给出"无法区分", 提示用户对照两组候选的叠图自行判断 ——
    样本之间的磨损和色差也可能让真正的半步看起来对不上。
    """
    L = analysis.lattice_of(t1, t2)
    valid = L is not None and L >= min_credible
    if not valid:
        # 当前基矢本身不重复时, 先看是不是"取短了": 某根向量放大一倍后
        # 整张点阵才成立 —— 说明用户取的是半步/三分之一处。
        for which in (0, 1):
            for k in (2, 3, 4):
                base = t1 if which == 0 else t2
                other = t2 if which == 0 else t1
                scaled = (base[0] * k, base[1] * k)
                cand = (scaled, other) if which == 0 else (other, scaled)
                lat_k = analysis.lattice_of(*cand)
                if lat_k is not None and lat_k >= min_credible:
                    frac = {2: "半步", 3: "三分之一", 4: "四分之一"}.get(
                        k, f"1/{k}")
                    dirs = [
                        DirectionAdvice(t1, L, t1, None, "longer",
                                        "这一根向量单独看并不是完整周期。"),
                        DirectionAdvice(t2, L, t2, None, "longer",
                                        "这一根向量单独看并不是完整周期。"),
                    ]
                    head = (f"当前基矢本身并不重复 (点阵相关 {L:.3f}), "
                            f"但把{'第一' if which == 0 else '第二'}根向量放大 "
                            f"{k} 倍后整张点阵相关达到 {lat_k:.3f}。"
                            f"这说明现在取的是{frac}, 真正的周期更长。")
                    msg = head + "\n" + "建议: " + (
                        f"t1 改为 ({scaled[0]:.2f}, {scaled[1]:.2f})"
                        if which == 0 else
                        f"t2 改为 ({scaled[0]:.2f}, {scaled[1]:.2f})")
                    return BasisAdvice(L, dirs, "longer", cand, msg)
    dirs: List[DirectionAdvice] = []
    for which, t in ((0, t1), (1, t2)):
        h = (t[0] / 2.0, t[1] / 2.0)
        d = (t[0] * 2.0, t[1] * 2.0)
        other = t2 if which == 0 else t1
        lat_h = analysis.lattice_of(h, other)
        lat_d = analysis.lattice_of(d, other)
        if not valid:
            verdict = "unknown"
            msg = (f"当前基矢在图像里并不重复 (点阵相关 "
                   f"{0.0 if L is None else L:.3f}); 先确认方向和步长是否取错。")
            dirs.append(DirectionAdvice(t, L, h, lat_h, verdict, msg))
            continue
        opts = {
            "shorter": (h, lat_h),
            "current": (t, L),
            "longer": (d, lat_d),
        }
        valid_opts = {k: v for k, v in opts.items()
                      if v[1] is not None and np.hypot(*v[0]) >= min_half_length}
        if not valid_opts:
            verdict = "unknown"
            msg = "缩短/加长后重叠不足, 这一步无法判断。"
        else:
            best_kind = max(valid_opts, key=lambda k: valid_opts[k][1])
            if (best_kind == "shorter" and lat_h is not None
                    and lat_h >= min_credible and lat_h > L + lattice_tol):
                verdict = "shorter"
                msg = (f"半步 (t=({h[0]:.2f}, {h[1]:.2f})) 的整张点阵相关 "
                       f"{lat_h:.3f}, 高于当前的 {L:.3f}; 更短的周期能解释同样"
                       f"内容, 所以半步更可信。")
            elif (best_kind == "longer" and lat_d is not None
                  and lat_d > L + 0.03 and lat_d >= min_credible):
                verdict = "longer"
                msg = (f"把这一根放大一倍 (t=({d[0]:.2f}, {d[1]:.2f})) 后整张"
                       f"点阵相关升到 {lat_d:.3f} (现在是 {L:.3f}); "
                       f"说明当前取到了半步/半格, 真正的周期更长。")
            elif lat_h is not None and lat_h <= L - 0.06:
                verdict = "fuller"
                msg = (f"半步 (t=({h[0]:.2f}, {h[1]:.2f})) 的整张点阵相关只有 "
                       f"{lat_h:.3f}, 明显低于当前 {L:.3f}: 半步处内容对不上, "
                       f"当前整步更可信。")
            elif lat_h is not None and lat_h >= L - lattice_tol:
                verdict = "shorter"
                msg = (f"半步 (t=({h[0]:.2f}, {h[1]:.2f})) 的整张点阵相关 "
                       f"{lat_h:.3f}, 与当前 {L:.3f} 相当; 更短的周期能解释同样"
                       f"内容, 所以半步更可信。")
            else:
                verdict = "ambiguous"
                msg = (f"半步 (t=({h[0]:.2f}, {h[1]:.2f})) 的点阵相关 "
                       f"{lat_h:.3f} 与当前 {L:.3f} 接近, 两者都说得通 "
                       f"(整步略更可信); 请对照两组候选的单元预览。")
        dirs.append(DirectionAdvice(t, L, h, lat_h, verdict, msg))

    verdicts = [d.verdict for d in dirs]
    if not valid:
        head = ("当前基矢没有形成重复: 图像在这些平移下几乎不相似。"
                "请调整初始点和两根向量, 或重新框选区域估算。")
        message = head + "\n" + "\n".join(d.message for d in dirs)
        return BasisAdvice(L, dirs, "unknown", None, message)

    def longer_of(t: Vec) -> Vec:
        return (t[0] * 2.0, t[1] * 2.0)

    if any(v == "longer" for v in verdicts):
        preferred = "longer"
        idx = verdicts.index("longer")
        shorter = ((longer_of(t1), t2) if idx == 0 else (t1, longer_of(t2)))
        if all(v == "longer" for v in verdicts):
            head = "两个方向都取短了: 真正的周期是现在的两倍。"
        else:
            head = f"{'第一' if idx == 0 else '第二'}个方向取短了, 真正的周期更长。"
    elif all(v == "shorter" for v in verdicts):
        preferred, shorter = "shorter", ((t1[0] / 2, t1[1] / 2), (t2[0] / 2, t2[1] / 2))
        head = "两个方向都在半步处重复: 更短的半边步长更可信。"
    elif all(v == "fuller" for v in verdicts):
        preferred, shorter = "selected", None
        head = "两个方向都是整步更可信 (半步处内容对不上)。"
    elif "shorter" in verdicts and "fuller" in verdicts:
        idx = verdicts.index("shorter")
        preferred = "shorter"
        shorter = (((t1[0] / 2, t1[1] / 2), t2) if idx == 0
                   else (t1, (t2[0] / 2, t2[1] / 2)))
        head = f"{'第一' if idx == 0 else '第二'}个方向半步更可信, 另一个方向整步更可信。"
    elif "shorter" in verdicts:
        idx = verdicts.index("shorter")
        preferred = "shorter"
        shorter = (((t1[0] / 2, t1[1] / 2), t2) if idx == 0
                   else (t1, (t2[0] / 2, t2[1] / 2)))
        head = f"{'第一' if idx == 0 else '第二'}个方向可以缩短一半, 另一个方向无法判断。"
    elif "ambiguous" in verdicts:
        preferred, shorter = "ambiguous", None
        head = "半步与整步都像重复, 无法用像素相关区分; 请看两组候选的单元。"
    elif all(v == "unknown" for v in verdicts):
        preferred, shorter = "unknown", None
        head = "当前基矢在图像内重叠不足, 无法核验。"
    else:
        preferred, shorter = "selected", None
        head = "当前步长更可信 (半步处内容对不上)。"

    message = head + "\n" + "\n".join(d.message for d in dirs)
    if preferred == "ambiguous":
        message += ("\n提示: 若两组候选的单元图只有磨损/色差不同, 取较短的一侧; "
                    "若花纹本身有明显对齐差异, 取对齐的那一侧。")
    return BasisAdvice(L, dirs, preferred, shorter, message)


# ---------------------------------------------------------------------------
# 基矢挑选
# ---------------------------------------------------------------------------

def _bases_equivalent(a: BasisCandidate, b: BasisCandidate,
                      tol: float = 0.10) -> bool:
    """两组基矢是否张成同一个点阵 (互为幺模整数变换, det = ±1)。"""
    try:
        Ba = solve_basis(a.t1, a.t2)
        Bb = solve_basis(b.t1, b.t2)
        M = np.linalg.inv(Ba) @ Bb
    except ValueError:
        return False
    R = np.round(M)
    return bool(np.all(np.abs(M - R) <= tol)
                and abs(abs(float(np.linalg.det(R))) - 1.0) <= tol * 2)


def _is_superlattice(small: BasisCandidate, big: BasisCandidate,
                     tol: float = 0.12) -> bool:
    """big 是否是 small 的整数倍 (整步关系), 且不是同一个点阵。"""
    try:
        Bs = solve_basis(small.t1, small.t2)
        Bb = solve_basis(big.t1, big.t2)
        M = np.linalg.inv(Bs) @ Bb
    except ValueError:
        return False
    R = np.round(M)
    if not np.all(np.abs(M - R) <= tol):
        return False
    return abs(float(round(np.linalg.det(R)))) >= 2


def _refine_basis(analysis: PeriodicityAnalysis, t1: Vec, t2: Vec,
                  cache: Optional[Dict[Tuple[float, float], Optional[float]]] = None,
                  steps: Tuple[float, ...] = (0.2, 0.1, 0.05),
                  max_drift: float = 0.4,
                  min_gain: float = 0.008) -> Tuple[Vec, Vec, float]:
    """用点阵一致分把两根基矢微调到小数像素。

    峰值上的抛物线插值只有一阶精度, 周期落在小数像素时 (例如 13.7) 容易
    偏到最近的整数附近; 这里在点阵一致分上做坐标下降, 能恢复到更准的值。
    为避免在扁平的相关峰上"滑走", 每根基矢的总位移限制在 ``max_drift`` 内。
    """
    start = [tuple(map(float, t1)), tuple(map(float, t2))]
    best = [start[0], start[1]]
    best_score = analysis.lattice_of(best[0], best[1], cache)
    for step in steps:
        for _ in range(5):
            improved = False
            for which in (0, 1):
                for du in (-step, 0.0, step):
                    for dv in (-step, 0.0, step):
                        if du == 0.0 and dv == 0.0:
                            continue
                        cand = [list(best[0]), list(best[1])]
                        cand[which][0] += du
                        cand[which][1] += dv
                        c0 = (cand[0][0], cand[0][1])
                        c1 = (cand[1][0], cand[1][1])
                        drift = max(np.hypot(c0[0] - start[0][0], c0[1] - start[0][1]),
                                    np.hypot(c1[0] - start[1][0], c1[1] - start[1][1]))
                        if drift > max_drift:
                            continue
                        sc = analysis.lattice_of(c0, c1, cache)
                        if sc > best_score + min_gain:
                            best = [c0, c1]
                            best_score = sc
                            improved = True
                            break
                    if improved:
                        break
                if improved:
                    break
            if not improved:
                break
    return best[0], best[1], best_score


def _reduce_basis(analysis: PeriodicityAnalysis, t1: Vec, t2: Vec,
                  min_length: float, max_factor: int = 6,
                  acceptance: float = 0.012) -> Tuple[Vec, Vec, float, int]:
    """尝试把基矢按整数倍缩短 (半步/三分之一…)。

    只有当缩短后的整张点阵相关不下降时才接受, 所以不会把真正的整步误缩。
    返回 (t1, t2, 点阵分, 累计缩小倍数)。
    """
    best = (t1, t2)
    best_score = analysis.lattice_of(t1, t2)
    factor = 1
    guard = 0
    while guard < 8:
        guard += 1
        improved = False
        options: List[Tuple[int, Tuple[Vec, Vec]]] = []
        for k in range(2, max_factor + 1):
            for which in (0, 1):
                v = best[which]
                nv = (v[0] / k, v[1] / k)
                if np.hypot(*nv) < min_length:
                    continue
                cand = (nv, best[1]) if which == 0 else (best[0], nv)
                options.append((k, cand))
        for k, cand in options:
            s = analysis.lattice_of(*cand)
            if s >= best_score - acceptance:
                best = cand
                best_score = s
                factor *= k
                improved = True
                break
        if not improved:
            break
    return best[0], best[1], best_score, factor


def _pick_groups(candidates: List[BasisCandidate],
                 analysis: PeriodicityAnalysis) -> List[BasisCandidate]:
    """从候选基矢中挑出"候选组 A/B", 并尽量缩短到最小周期。"""
    best_lat = max(c.lattice_score for c in candidates)
    pool = [c for c in candidates if c.lattice_score >= best_lat - 0.03] or candidates
    best_peak = max(c.score for c in pool)
    pool = [c for c in pool if c.score >= best_peak - 0.06] or pool

    def shorter_side(c: BasisCandidate) -> float:
        return min(np.hypot(*c.t1), np.hypot(*c.t2))

    initial = min(pool, key=lambda c: (c.area, shorter_side(c)))
    cache: Dict[Tuple[float, float], Optional[float]] = {}

    f1, f2, _ = _refine_basis(analysis, initial.t1, initial.t2, cache)
    r1, r2, lat, factor = _reduce_basis(
        analysis, f1, f2,
        min_length=max(6.0, 0.03 * min(analysis.peak.shape[:2])),
    )
    r1, r2, lat = _refine_basis(analysis, r1, r2, cache)
    reduced = initial.copy_with(
        r1, r2, lattice_score=lat, kind="primitive",
        note=("检测到的最短可信周期" if factor == 1
              else f"由 {factor} 倍步长缩短得到的最小周期"),
    )
    groups: List[BasisCandidate] = [reduced]

    if factor > 1:
        groups.append(initial.copy_with(
            initial.t1, initial.t2, kind="multiple",
            note=f"缩短前的整步候选 ({factor} 倍)",
        ))
    else:
        best_lat = max(c.lattice_score for c in candidates)
        rest = [c for c in candidates
                if not (c is initial) and c.lattice_score >= best_lat - 0.06]
        super_cands = [c for c in rest if _is_superlattice(reduced, c)]
        if super_cands:
            def det_ratio(c: BasisCandidate) -> float:
                try:
                    M = (np.linalg.inv(solve_basis(reduced.t1, reduced.t2))
                         @ solve_basis(c.t1, c.t2))
                except ValueError:
                    return 1e9
                return abs(float(np.linalg.det(M)))

            second = min(super_cands, key=lambda c: (det_ratio(c), c.area))
            groups.append(second.copy_with(
                second.t1, second.t2,
                kind="multiple", note="整步候选 (基本周期的整数倍)"))
        else:
            rest_sorted = sorted(rest, key=lambda c: (-c.lattice_score, c.area))
            if rest_sorted:
                groups.append(rest_sorted[0].copy_with(
                    rest_sorted[0].t1, rest_sorted[0].t2,
                    kind="alternative", note="另一组高分基矢"))
            else:
                groups.append(reduced.copy_with(
                    reduced.t1, (reduced.t2[0] * 2, reduced.t2[1] * 2),
                    kind="multiple", note="整步候选 (基本周期的两倍)"))
    return groups


# ---------------------------------------------------------------------------
# 主入口
# ---------------------------------------------------------------------------

def estimate_periodicity(patch: np.ndarray,
                         max_analysis_dim: int = 420,
                         max_period: Optional[float] = None,
                         min_period: float = 7.0,
                         min_area: float = 28.0,
                         max_ratio: float = 9.0,
                         peak_threshold: float = 0.45,
                         min_overlap_frac: float = 0.18,
                         max_peaks: int = 28,
                         max_candidates: int = 60) -> PeriodicityAnalysis:
    """对一块 RGB 区域估计重复点阵。

    patch: HxWx3 (0..1 或任意实数)。返回的平移以 patch 的像素为单位。
    """
    raw = np.asarray(patch, dtype=np.float64)
    if raw.ndim == 2:
        raw = raw[..., None]
    if float(raw.std()) < 1e-6:
        raise ValueError("这块区域几乎是纯色, 没有可辨认的重复花纹")
    z_full = _zscore_patch(patch)
    h0, w0 = z_full.shape[:2]
    step = max(1, int(np.ceil(max(h0, w0) / float(max_analysis_dim))))
    work = z_full[::step, ::step]

    h, w = work.shape[:2]
    if max_period is None:
        # 都以原图像素为单位: 分析区最多能找到 min(w, h)*step 附近的周期
        max_period = min(w, h) * step * 0.45
    max_px = min(int(max_period / step), int(min(w, h) * 0.5))
    max_px = max(4, max_px)
    if max_px < 2:
        raise ValueError("区域太小, 无法估算重复步长")

    score, _valid = ncc_map(work, max_px, max_px, min_overlap_frac)
    # 压掉接近零平移的格子 (没有信息); 边界附近重叠不足, 会冒出虚假高峰。
    dys = np.arange(0, max_px + 1)
    dxs = np.arange(-max_px, max_px + 1)
    DY0, DX0 = np.meshgrid(dys * step, dxs * step, indexing="ij")
    too_close = np.hypot(DY0, DX0) < max(min_period, 2.5 * step)
    edge = ((np.abs(DX0) >= max_px * step - 1.5 * step)
            | (DY0 >= max_px * step - 1.5 * step))
    score[too_close | edge] = 0.0
    maxima = _local_maxima(score, radius=2)

    peaks: List[Peak] = []
    for iy, ix in np.argwhere(maxima):
        s = float(score[iy, ix])
        if s < peak_threshold:
            continue
        fy = (_parabola_offset(score[iy - 1, ix], s, score[iy + 1, ix])
              if 0 < iy < score.shape[0] - 1 else 0.0)
        fx = (_parabola_offset(score[iy, ix - 1], s, score[iy, ix + 1])
              if 0 < ix < score.shape[1] - 1 else 0.0)
        dx = (dxs[ix] + fx) * step
        dy = (dys[iy] + fy) * step
        # 统一半平面 (dy>0, 或 dy==0 且 dx>0), 便于去重
        if dy < -1e-9 or (abs(dy) <= 1e-9 and dx < 0):
            dx, dy = -dx, -dy
        if np.hypot(dx, dy) < min_period:
            continue
        peaks.append(Peak((float(dx), float(dy)), s, (int(iy), int(ix))))

    peaks.sort(key=lambda p: (-p.score, p.length))
    uniq: List[Peak] = []
    for p in peaks:
        if all(np.hypot(p.t[0] - q.t[0], p.t[1] - q.t[1])
               > max(1.0, step * 0.75) for q in uniq):
            uniq.append(p)
    if not uniq:
        raise ValueError("没有找到高相关的重复平移, 请换一块花纹更清楚的区域")

    best_peak = uniq[0]
    strong = [p for p in uniq if p.score >= best_peak.score - 0.05][:40]

    def too_parallel(p: Peak, q: Peak) -> bool:
        n1, n2 = np.hypot(*p.t), np.hypot(*q.t)
        if n1 < 1e-6 or n2 < 1e-6:
            return True
        return abs(det2(p.t, q.t)) / (n1 * n2) < 0.14

    max_shift = max_px * step
    one_dim = all(too_parallel(best_peak, p) for p in strong if p is not best_peak)

    if one_dim:
        u = best_peak.t
        n = np.array([-u[1], u[0]], dtype=float)
        n /= max(np.linalg.norm(n), 1e-9)
        length = 1.4 * float(np.hypot(*u))
        v = (float(n[0] * length), float(n[1] * length))
        if v[1] < 0 or (abs(v[1]) < 1e-9 and v[0] < 0):
            v = (-v[0], -v[1])
        cand = BasisCandidate(
            u, v, best_peak.score, "primitive",
            "只有一维周期: 第二根沿条纹方向, 可以任意取",
            lattice_score=best_peak.score,
        )
        return PeriodicityAnalysis(
            peak=work.astype(np.float64), step=step,
            peaks=[best_peak, Peak(v, best_peak.score, best_peak.index)],
            candidates=[cand], groups=[cand],
            min_overlap_frac=min_overlap_frac,
            score_map=score, score_dys=dys, score_dxs=dxs,
        )

    # 候选基矢: 高分峰两两组合, 只对相关性接近最好的那批算点阵一致分
    need = max(0.9 * min_area, (min_period ** 2) * 0.55)
    raw: List[Tuple[float, Peak, Peak]] = []
    for i in range(len(strong)):
        for j in range(i + 1, len(strong)):
            p, q = strong[i], strong[j]
            if too_parallel(p, q):
                continue
            area = abs(det2(p.t, q.t))
            la, lb = p.length, q.length
            if area < need:
                continue
            if max(la, lb) / max(min(la, lb), 1e-9) > max_ratio:
                continue
            raw.append(((p.score + q.score) / 2.0, p, q))
    if not raw:
        raise ValueError("没有找到两个不共线的高相关平移, 请换一块花纹更清楚的区域")

    raw.sort(key=lambda r: (-r[0], abs(det2(r[1].t, r[2].t))))
    candidates: List[BasisCandidate] = []
    checked = 0
    cache: Dict[Tuple[float, float], Optional[float]] = {}
    for peak_score, p, q in raw:
        if checked >= max_candidates:
            break
        a, b = snap_vectors_to_lattice(p.t, q.t)
        cand = BasisCandidate(a, b, peak_score)
        if any(_bases_equivalent(cand, c) for c in candidates):
            continue
        checked += 1
        cand.lattice_score = _lattice_score(
            a, b, work, step, max_shift, min_overlap_frac, cache)
        candidates.append(cand)

    if not candidates:
        raise ValueError("候选基矢都不可用, 请换一块花纹更清楚的区域")

    analysis = PeriodicityAnalysis(
        peak=work.astype(np.float64), step=step, peaks=strong,
        candidates=candidates, groups=[], min_overlap_frac=min_overlap_frac,
    )
    groups = _pick_groups(candidates, analysis)
    candidates.sort(key=lambda c: (-c.lattice_score, -c.score, c.area))

    return PeriodicityAnalysis(
        peak=work.astype(np.float64), step=step, peaks=strong,
        candidates=candidates, groups=groups,
        min_overlap_frac=min_overlap_frac,
        score_map=score, score_dys=dys, score_dxs=dxs,
    )
