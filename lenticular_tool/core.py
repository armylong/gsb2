"""纯 numpy 核心: 镜条相位、交错取样、区段占用统计、本地校验。

本模块不依赖 Qt, 可以在命令行 / 单元测试里直接运行:

    python -m lenticular_tool.verify
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Sequence

import numpy as np

from .params import LensParams, normalize_order

RGBA = np.ndarray  # dtype uint8, shape (H, W, 4)


# ---------------------------------------------------------------------------
# 周期 / 相位
# ---------------------------------------------------------------------------
def effective_pitch(p: LensParams, width: int | None) -> float:
    """镜条周期 P(输出像素)。

    默认就是 ``dpi / lpi``。开启 ``fit_right_edge`` 时, 在名义周期附近找一个
    最小修正, 使基准行右端 ``x = width`` 的相位恰好等于设定的右端相位。
    这样周期不能整除像素数时, 右侧相位仍是“设好的相位”, 而不是累积误差。
    """
    base = p.base_pitch()
    if width is None:
        return base
    width = int(width)
    if getattr(p, "whole_periods", False) and width > 0:
        # 让 W/P 恰好是离名义周期数最近的整数: 左右边缘相位自然相同
        m = max(1, int(round(width / base)))
        return float(width) / m
    if not p.fit_right_edge:
        return base
    span = float(width) - float(p.offset_px)
    if span <= 1.0:
        return base
    target = float(p.right_edge_phase) % 1.0
    nominal_periods = span / base
    m0 = int(round(nominal_periods - target))
    best: tuple[float, float] | None = None
    for m in range(max(1, m0 - 2), m0 + 3):
        denom = m + target
        if denom <= 1e-12:
            continue
        pitch = span / denom
        if pitch <= 0:
            continue
        err = abs(pitch - base)
        if best is None or err < best[0]:
            best = (err, pitch)
    return best[1] if best is not None else base


def pivot_y(height: int, p: LensParams) -> float:
    """基准行的 y 像素坐标: pivot=0 时是顶行像素中心, 1 时是底行中心。"""
    if height <= 1:
        return 0.5
    return 0.5 + float(np.clip(p.pivot_frac, 0.0, 1.0)) * (height - 1)


def tilt_slope(p: LensParams) -> float:
    """镜条分界线每向下 1 px 在 x 方向的平移量 dx/dy = tan(angle)。"""
    return math.tan(math.radians(float(p.angle_deg)))


def phase_grid(height: int, width: int, pitch: float, p: LensParams) -> np.ndarray:
    """每个像素中心的镜条周期坐标 u(x,y), float64。

    镜条分界线 m 的方程(像素坐标)::

        x = offset_px + m * P + (y - y_pivot) * tan(angle)

    因此 ``u = (x - offset - (y-y_pivot)*tan) / P``,
    ``floor(u)`` 是镜条编号, ``u - floor(u)`` 是镜条内相位。

    相位始终用全局坐标一次性算出, 不做逐根镜条的整数累加 —— 周期不能整除
    像素数时, 图尾不会产生累积取整漂移。
    """
    if pitch <= 0:
        raise ValueError("pitch must be positive")
    ys = (np.arange(height, dtype=np.float64) + 0.5 - pivot_y(height, p))[:, None]
    xs = (np.arange(width, dtype=np.float64) + 0.5 - float(p.offset_px))[None, :]
    return (xs - ys * tilt_slope(p)) / float(pitch)


def phase_at(x: float, y: float, height: int, pitch: float, p: LensParams) -> float:
    """任意像素坐标处的镜条周期坐标(标量版)。"""
    return ((float(x) - float(p.offset_px))
            - (float(y) - pivot_y(height, p)) * tilt_slope(p)) / float(pitch)


# 分界线恰好落在像素中心 / 切片边界上时, 浮点误差可能让 floor 倒向错误一侧。
# 在这么小的容差内吸附到最近整数, 保证归属确定、可复现。
SNAP_PHASE = 1e-7
SNAP_SLICE = 1e-6


def stable_lens_ids(u: np.ndarray, tol: float = SNAP_PHASE) -> np.ndarray:
    """相位场 -> 镜条编号, 整数边界附近做吸附。"""
    ui = np.rint(u)
    us = np.where(np.abs(u - ui) < tol, ui, u)
    return np.floor(us).astype(np.int64)


def stable_lens_id(u: float, tol: float = SNAP_PHASE) -> int:
    ui = round(u)
    if abs(u - ui) < tol:
        u = float(ui)
    return int(math.floor(u))


def stable_slice_indices(u: np.ndarray, n_views: int) -> np.ndarray:
    """相位场 -> 切片号 0..n_views-1, 镜条/切片边界均做吸附。"""
    ui = np.rint(u)
    us = np.where(np.abs(u - ui) < SNAP_PHASE, ui, u)
    m = np.floor(us)
    frac = us - m
    t = frac * n_views
    ti = np.rint(t)
    t = np.where(np.abs(t - ti) < SNAP_SLICE, ti, t)
    s = np.floor(t).astype(np.int64)
    return np.clip(s, 0, n_views - 1)


def boundary_x(lens_index: int | float, y: float, height: int,
               pitch: float, p: LensParams) -> float:
    """第 ``lens_index`` 根左分界线在第 y 行的 x 坐标。"""
    return (float(p.offset_px) + float(lens_index) * float(pitch)
            + (float(y) - pivot_y(height, p)) * tilt_slope(p))


# ---------------------------------------------------------------------------
# 取样图
# ---------------------------------------------------------------------------
def slice_map(height: int, width: int, n_views: int,
              pitch: float, p: LensParams) -> np.ndarray:
    """每个输出像素对应的 *切片序号* 0..n-1(尚未套用视图顺序)。"""
    u = phase_grid(height, width, pitch, p)
    return stable_slice_indices(u, n_views)


def assignment_map(height: int, width: int, n_views: int,
                  pitch: float, p: LensParams) -> np.ndarray:
    """每个输出像素实际取自哪个视角(已套用调换后的顺序), int 0..n-1。"""
    s = slice_map(height, width, n_views, pitch, p)
    order = np.asarray(p.normalized_order(n_views), dtype=np.int64)
    return order[s]


def interlace(views: Sequence[RGBA], p: LensParams,
              pitch: float | None = None,
              assign: np.ndarray | None = None) -> RGBA:
    """按当前参数把同尺寸视图交错成一张原像素 PNG 数组。

    输出形状/像素数与输入完全相同, 不做任何缩放。
    可传入已经算好的 ``assign`` 避免大图重复计算相位场。
    """
    if not views:
        raise ValueError("至少需要一张视角图")
    h, w = views[0].shape[:2]
    for i, v in enumerate(views):
        if v.shape[:2] != (h, w):
            raise ValueError(f"视角 {i + 1} 尺寸 {v.shape[:2]} 与第一张 {(h, w)} 不一致")
    n = len(views)
    pitch = effective_pitch(p, w) if pitch is None else pitch
    if assign is None:
        assign = assignment_map(h, w, n, pitch, p)
    out = np.empty_like(views[0])
    for view_id in range(n):
        mask = assign == view_id
        if mask.any():
            out[mask] = views[view_id][mask]
    return out


def source_layer(assign: np.ndarray, n_views: int,
                 colors: Sequence[tuple[int, int, int]]) -> RGBA:
    """把“每个像素来自哪个视角”画成平涂彩色图层(RGBA)。"""
    h, w = assign.shape
    layer = np.empty((h, w, 4), dtype=np.uint8)
    for k in range(n_views):
        c = colors[k % len(colors)]
        layer[assign == k] = (c[0], c[1], c[2], 255)
    return layer


def blend_overlay(interlaced: RGBA, layer: RGBA, alpha: float = 0.45) -> RGBA:
    """交错成品与来源彩色图层的叠加。"""
    a = float(np.clip(alpha, 0.0, 1.0))
    out = interlaced.astype(np.float32) * (1 - a) + layer.astype(np.float32) * a
    return out.astype(np.uint8)


# ---------------------------------------------------------------------------
# 观察位置示意预览的权重
# ---------------------------------------------------------------------------
def observer_weights(y_native: np.ndarray, height: int, n_views: int,
                     pitch: float, p: LensParams) -> np.ndarray:
    """计算若干原始分辨率 y 坐标上, 各视角进入眼睛的权重 (len(y), n)。

    模型(示意, 非光线追踪):
    - 观察位置 ``eye_phase`` 是一个周期内的相位;
    - 眼睛/像素有有限宽度, 用相位窗口表示(默认约 0.85 个切片宽),
      窗口正好压在切片分界线上时看到两图渐变过渡;
    - 镜片倾角让第 y 行的镜条栅格相对 *竖直交错列* 平移
      ``delta = (y-y_pivot)*tan/P`` 个周期; 基准行以外, 窗口逐渐压到别的
      切片上 -> 一侧正确、另一侧逐渐串图。

    权重用区间重叠的解析面积计算, 行和为 1。
    """
    y_native = np.asarray(y_native, dtype=np.float64)
    ya = pivot_y(height, p)
    delta = (y_native - ya) * tilt_slope(p) / float(pitch)
    # 倾角漂移可能累积很多个周期, 先折回 [0,1), 下面 ±1 平移即可处理圆周
    center = np.mod(float(p.eye_phase) + delta, 1.0)
    half = 0.5 * max(float(p.eye_width_slices), 1e-3) / n_views

    weights = np.zeros((y_native.shape[0], n_views), dtype=np.float64)
    for k, view_id in enumerate(p.normalized_order(n_views)):
        a = k / n_views
        b = (k + 1) / n_views
        overlap = np.zeros_like(center)
        for shift in (-1.0, 0.0, 1.0):
            left = np.maximum(a, center - half + shift)
            right = np.minimum(b, center + half + shift)
            overlap += np.maximum(0.0, right - left)
        weights[:, view_id] = overlap
    totals = weights.sum(axis=1, keepdims=True)
    bad = (totals[:, 0] <= 1e-12)
    if np.any(bad):
        # 兜底: 窗口异常时退化为最近切片的硬选择, 绝不出黑行
        k_hard = np.clip(np.floor(center[bad] * n_views).astype(int),
                         0, n_views - 1)
        order = p.normalized_order(n_views)
        for row, kk in zip(np.where(bad)[0], k_hard):
            weights[row, order[kk]] = 1.0
        totals = weights.sum(axis=1, keepdims=True)
    return weights / totals


def compose_preview(small_views: Sequence[RGBA], native_height: int,
                    p: LensParams, pitch: float) -> RGBA:
    """把缩小后的各视角按观察权重混成预览图。

    ``small_views`` 只服务屏幕流畅度; 导出从不走这里, 因此降低缩略图清晰度
    不会改变实际输出像素大小或取样。
    """
    n = len(small_views)
    ph, pw = small_views[0].shape[:2]
    y_native = (np.arange(ph, dtype=np.float64) + 0.5) * native_height / ph
    w = observer_weights(y_native, native_height, n, pitch, p)  # (ph, n) 实际视角序
    stack = np.stack([v[..., :3].astype(np.float32) for v in small_views], axis=0)
    # out[y,x,c] = sum_k w[y,k] * stack[k,y,x,c]
    out = np.einsum("yn,nyxc->yxc", w.astype(np.float32), stack)
    rgba = np.empty((ph, pw, 4), dtype=np.uint8)
    rgba[..., :3] = np.clip(out, 0, 255).astype(np.uint8)
    rgba[..., 3] = 255
    return rgba


# ---------------------------------------------------------------------------
# 区段占用统计(需求 4)
# ---------------------------------------------------------------------------
@dataclass
class SegmentStat:
    rect: tuple[int, int, int, int]          # x0,y0,x1_excl,y1_excl(原始像素)
    lens_index: int
    ref_y: int
    bounds_at_ref: tuple[float, float]       # 该镜条在参考行的左右分界线 x
    counts: list[int] = field(default_factory=list)   # 各实际视角像素数
    total: int = 0
    runs: list[tuple[int, int, int, int]] = field(default_factory=list)
    # runs: (view_id, x_start, x_end_inclusive, length) 参考行上的连续段

    @property
    def shares(self) -> list[float]:
        if self.total <= 0:
            return [0.0 for _ in self.counts]
        return [c / self.total for c in self.counts]


def _clamp_rect(rect: tuple[int, int, int, int], h: int, w: int
                ) -> tuple[int, int, int, int]:
    x0, y0, x1, y1 = rect
    xa, xb = sorted((int(x0), int(x1)))
    ya, yb = sorted((int(y0), int(y1)))
    xa = int(np.clip(xa, 0, w - 1))
    xb = int(np.clip(xb, 1, w))
    ya = int(np.clip(ya, 0, h - 1))
    yb = int(np.clip(yb, 1, h))
    if xb <= xa:
        xb = min(w, xa + 1)
    if yb <= ya:
        yb = min(h, ya + 1)
    return xa, ya, xb, yb


def analyze_segment(assign: np.ndarray, p: LensParams, pitch: float,
                    rect: tuple[int, int, int, int]) -> SegmentStat:
    """统计选区里落在 *同一根镜条* (按当前倾角方程) 下的各视角像素数。"""
    h, w = assign.shape
    n = int(assign.max()) + 1 if assign.size else 1
    xa, ya, xb, yb = _clamp_rect(rect, h, w)

    ref_y = int(np.clip((ya + yb) // 2, 0, h - 1))
    mid_x = (xa + xb) * 0.5
    m = stable_lens_id(phase_at(mid_x + 0.5, ref_y + 0.5, h, pitch, p))

    # 选区局部相位 -> 镜条编号, 取与中点同一根镜条的像素(倾斜时是平行四边形)
    ys = (np.arange(ya, yb, dtype=np.float64) + 0.5 - pivot_y(h, p))[:, None]
    xs = (np.arange(xa, xb, dtype=np.float64) + 0.5 - float(p.offset_px))[None, :]
    u = (xs - ys * tilt_slope(p)) / pitch
    lens_ids = stable_lens_ids(u)
    sub_assign = assign[ya:yb, xa:xb]
    mask = lens_ids == m

    counts = [0 for _ in range(n)]
    if mask.any():
        vals = sub_assign[mask]
        for view_id in range(n):
            counts[view_id] = int(np.count_nonzero(vals == view_id))
    total = int(sum(counts))

    b_left = boundary_x(m, ref_y + 0.5, h, pitch, p)
    b_right = boundary_x(m + 1, ref_y + 0.5, h, pitch, p)

    # 参考行上这根镜条的完整像素序列与连续段
    row_y = ref_y
    x_lo = max(0, int(math.floor(min(b_left, b_right))) - 1)
    x_hi = min(w, int(math.ceil(max(b_left, b_right))) + 2)
    runs: list[tuple[int, int, int, int]] = []
    if x_hi > x_lo:
        row = assign[row_y, x_lo:x_hi]
        urow = np.array([phase_at(x + 0.5, row_y + 0.5, h, pitch, p)
                         for x in range(x_lo, x_hi)])
        ids = stable_lens_ids(urow)
        keep = ids == m
        xs_full = np.arange(x_lo, x_hi)
        kept_x = xs_full[keep]
        kept_v = row[keep]
        if kept_x.size:
            start_x = int(kept_x[0])
            prev_x = start_x
            run_view = int(kept_v[0])
            run_start = start_x
            for x, v in zip(kept_x[1:], kept_v[1:]):
                x = int(x)
                v = int(v)
                if v != run_view or x != prev_x + 1:
                    runs.append((run_view, run_start, prev_x, prev_x - run_start + 1))
                    run_view, run_start = v, x
                prev_x = x
            runs.append((run_view, run_start, prev_x, prev_x - run_start + 1))

    return SegmentStat(
        rect=(xa, ya, xb, yb), lens_index=m, ref_y=ref_y,
        bounds_at_ref=(b_left, b_right), counts=counts, total=total, runs=runs,
    )


def lens_span_rect(assign_shape: tuple[int, int], p: LensParams, pitch: float,
                   x: int, y: int, full_height: bool = True
                   ) -> tuple[int, int, int, int]:
    """单击画面时给出一整根镜条的选区(默认全高), 返回半开矩形。"""
    h, w = assign_shape
    x = int(np.clip(x, 0, w - 1))
    y = int(np.clip(y, 0, h - 1))
    m = stable_lens_id(phase_at(x + 0.5, y + 0.5, h, pitch, p))
    if full_height:
        return 0, 0, w, h
    bl = boundary_x(m, y + 0.5, h, pitch, p)
    br = boundary_x(m + 1, y + 0.5, h, pitch, p)
    xa = max(0, int(math.floor(min(bl, br))))
    xb = min(w, int(math.ceil(max(bl, br))))
    return xa, max(0, y - 20), xb, min(h, y + 21)


# ---------------------------------------------------------------------------
# 图首 / 图中 / 图尾校验
# ---------------------------------------------------------------------------
@dataclass
class SpotReport:
    key: str
    title: str
    lens_index: int
    center_x: float
    boundary_left: float
    boundary_right: float
    first_pixel_phase: float
    last_pixel_phase: float
    counts: list[int]
    crop_x: tuple[int, int]
    crop_y: tuple[int, int]
    warnings: list[str] = field(default_factory=list)


def _full_lens_indices(height: int, width: int, pitch: float, p: LensParams
                       ) -> tuple[int, int, int]:
    ya = pivot_y(height, p)
    off = float(p.offset_px)
    # 第一根左边界 >= 0 的镜条: B_m = off + mP >= 0
    m_first = int(math.floor(-off / pitch)) - 1
    while boundary_x(m_first, ya, height, pitch, p) < -1e-9:
        m_first += 1
    while boundary_x(m_first - 1, ya, height, pitch, p) >= -1e-9:
        m_first -= 1
    # 最后一根右边界 <= width 的镜条: B_{m+1} <= W
    m_last = int(math.ceil((width - off) / pitch)) + 1
    while boundary_x(m_last + 1, ya, height, pitch, p) <= width + 1e-9:
        m_last += 1
    while boundary_x(m_last + 1, ya, height, pitch, p) > width + 1e-9:
        m_last -= 1
    m_mid = (m_first + m_last) // 2
    return m_first, m_mid, m_last


def spot_reports(height: int, width: int, n_views: int,
                 p: LensParams, pitch: float,
                 crop_band: int = 28) -> list[SpotReport]:
    """生成图首 / 图中 / 图尾三根完整镜条的相位与计数报告。"""
    assign = assignment_map(height, width, n_views, pitch, p)
    m_first, m_mid, m_last = _full_lens_indices(height, width, pitch, p)
    ya = pivot_y(height, p)
    anchor_row = int(np.clip(round(ya) - 0.5, 0, height - 1))

    span = int(np.clip(round(pitch * 7), 70, 260))
    cy = height // 2
    y0 = max(0, cy - crop_band)
    y1 = min(height, cy + crop_band)

    spots: list[SpotReport] = []
    for key, title, m in (("head", "图首", m_first),
                         ("mid", "图中", m_mid),
                         ("tail", "图尾", m_last)):
        bl = boundary_x(m, ya, height, pitch, p)
        br = boundary_x(m + 1, ya, height, pitch, p)
        cx = 0.5 * (bl + br)
        x0 = max(0, int(math.floor(bl)))
        x1 = min(width, int(math.ceil(br)) + 1)
        counts = [0] * n_views
        phases_first = phases_last = 0.0
        if x1 > x0:
            row = assign[anchor_row, x0:x1]
            urow = np.array([phase_at(x + 0.5, anchor_row + 0.5, height, pitch, p)
                             for x in range(x0, x1)])
            ids = stable_lens_ids(urow)
            kept = row[ids == m]
            for v in kept:
                counts[int(v)] += 1
            us = urow[ids == m]
            if us.size:
                uf = us - np.floor(us)
                phases_first = float(uf[0])
                phases_last = float(uf[-1])
        cx0 = max(0, int(cx - span / 2))
        cx1 = min(width, cx0 + span)
        cx0 = max(0, cx1 - span)

        warns: list[str] = []
        # 镜条 / 切片分界线是否压在像素中心线上(半像素临界取样)
        boundaries = [bl, br] + [bl + k * (br - bl) / n_views
                                 for k in range(1, n_views)]
        for bx in boundaries:
            nearest_center = round(bx - 0.5) + 0.5
            if abs(bx - nearest_center) < 0.02:
                warns.append(
                    f"分界线 x={bx:.3f} 压在像素中心 {nearest_center:.1f} 上"
                    "(半像素临界, 归属按左闭约定确定)")
        for vid, cnt in enumerate(counts):
            if cnt == 0:
                warns.append(f"视角 {vid + 1} 在这根镜条内没有整像素列"
                             "(小数周期/临界相位下被相邻段吸收)")

        spots.append(SpotReport(
            key=key, title=title, lens_index=m, center_x=cx,
            boundary_left=bl, boundary_right=br,
            first_pixel_phase=phases_first, last_pixel_phase=phases_last,
            counts=counts, crop_x=(cx0, cx1), crop_y=(y0, y1),
            warnings=warns,
        ))
    return spots


def edge_phases(height: int, width: int, pitch: float, p: LensParams) -> dict[str, float]:
    """基准行上左/右边缘与首/尾像素中心的相位, 用于核对右侧相位。"""
    ya = pivot_y(height, p)
    return {
        "left_edge": phase_at(0.0, ya, height, pitch, p) % 1.0,
        "right_edge": phase_at(float(width), ya, height, pitch, p) % 1.0,
        "first_pixel_center": phase_at(0.5, ya, height, pitch, p) % 1.0,
        "last_pixel_center": phase_at(width - 0.5, ya, height, pitch, p) % 1.0,
        "right_edge_raw": phase_at(float(width), ya, height, pitch, p),
        "total_periods": phase_at(float(width), ya, height, pitch, p)
                         - phase_at(0.0, ya, height, pitch, p),
    }


# ---------------------------------------------------------------------------
# 本地自检(需求 6): 不依赖样例图 / Qt
# ---------------------------------------------------------------------------
@dataclass
class CheckResult:
    name: str
    ok: bool
    detail: str = ""


def run_self_checks() -> list[CheckResult]:
    """一组可在本机直接复核的数值校验。"""
    results: list[CheckResult] = []

    def add(name: str, ok: bool, detail: str = "") -> None:
        results.append(CheckResult(name, bool(ok), detail))

    # 1) 整数周期: P=3, 三视图 -> 严格 0,1,2 循环
    p = LensParams(lpi=100, dpi=300, order=(0, 1, 2))
    w, h = 1200, 600
    P = effective_pitch(p, w)
    s = slice_map(1, w, 3, P, p)[0]
    expect = np.tile([0, 1, 2], w // 3 + 1)[:w]
    add("整数周期 P=3px 且 W 可整除: 严格 0,1,2 循环",
        abs(P - 3.0) < 1e-12 and np.array_equal(s, expect),
        f"P={P:.6f}, 前 12 列={s[:12].tolist()}")

    # 2) 非整除周期: 尾列必须等于全局公式(防止逐根累加取整漂移)
    p2 = LensParams(lpi=80, dpi=280, order=(0, 1))  # P=3.5
    P2 = effective_pitch(p2, w)
    s2 = slice_map(1, w, 2, P2, p2)[0]
    u_last = phase_at(w - 0.5, 0.5, 1, P2, p2)
    expect_last = min(int(math.floor((u_last - math.floor(u_last)) * 2)), 1)
    add("非整除 P=3.5px: 图尾取样与全局相位公式一致",
        abs(P2 - 3.5) < 1e-12 and s2[-1] == expect_last,
        f"末列切片={s2[-1]}, 公式={expect_last}, 右端相位={edge_phases(1, w, P2, p2)['right_edge']:.4f}")

    # 3) 半像素偏移: offset=0.5 时首像素中心正好落在分界线上
    p3 = LensParams(lpi=100, dpi=300, offset_px=0.5, order=(0, 1, 2))
    P3 = effective_pitch(p3, w)
    ph = phase_at(0.5, 0.5, 1, P3, p3)
    add("半像素偏移 offset=0.5px: 首像素中心相位为整数(分界线)",
        abs((ph - round(ph))) < 1e-9,
        f"首像素中心 u={ph:.6f}")

    # 4) 右端相位锁定
    p4 = LensParams(lpi=75, dpi=300, fit_right_edge=True, right_edge_phase=0.25,
                    order=(0, 1, 2))
    P4 = effective_pitch(p4, w)
    right = phase_at(float(w), pivot_y(h, p4), h, P4, p4) % 1.0
    add("右端相位锁定: fit_right_edge 后右端相位误差 < 1e-9",
        abs(right - 0.25) < 1e-9,
        f"修正后 P={P4:.6f}px (名义 4.0), 右端相位={right:.10f}")

    # 5) 区段统计计数自洽
    rng = np.random.default_rng(0)
    views = [rng.integers(0, 255, (h, w, 4), dtype=np.uint8) for _ in range(3)]
    out = interlace(views, p)
    assign = assignment_map(h, w, 3, effective_pitch(p, w), p)
    stat = analyze_segment(assign, p, effective_pitch(p, w), (100, 100, 260, 300))
    add("区段统计: 各视角计数之和 = 同一镜条像素总数",
        sum(stat.counts) == stat.total and stat.total > 0,
        f"counts={stat.counts}, total={stat.total}")
    recon = np.zeros_like(out)
    for vid in range(3):
        msk = assign == vid
        recon[msk] = views[vid][msk]
    add("交错图: 每像素都来自对应视角且可逐像素重建",
        np.array_equal(out, recon), f"检查像素数={out.size // 4}")

    # 6) 调换顺序只是对切片编号做置换
    p_rev = LensParams(lpi=100, dpi=300, order=(2, 1, 0))
    a_fwd = assignment_map(h, w, 3, 3.0, p)
    a_rev = assignment_map(h, w, 3, 3.0, p_rev)
    add("反转视图顺序: 0<->2 互换, 1 不变",
        np.array_equal(a_rev, 2 - a_fwd),
        f"正向首行前 9 列={a_fwd[0, :9].tolist()}, 反向={a_rev[0, :9].tolist()}")

    # 7) 观察权重行和为 1, 正对切片中心时该视角占绝对多数
    weights = observer_weights(np.array([pivot_y(h, LensParams())]), h, 3, 4.0,
                               LensParams(eye_phase=1 / 6, eye_width_slices=0.2))
    add("观察权重: 行和=1 且窄窗口正对视角 1",
        abs(float(weights.sum()) - 1.0) < 1e-9 and weights[0, 0] > 0.99,
        f"weights={np.round(weights[0], 3).tolist()}")

    # 8) 倾角基准行不漂移, 远端漂移量 = dy*tan/P
    p8 = LensParams(angle_deg=1.0, pivot_frac=0.0)
    P8 = 4.0
    d_top = phase_at(100.5, pivot_y(h, p8), h, P8, p8) - 100.5 / P8
    dy = h - 1
    expect_drift = dy * math.tan(math.radians(1.0)) / P8
    got_drift = -(phase_at(100.5, h - 0.5, h, P8, p8) - 100.5 / P8)
    add("倾角模型: 基准行零漂移, 底端漂移 = dy·tanθ/P",
        abs(d_top) < 1e-9 and abs(got_drift - expect_drift) < 1e-9,
        f"底端漂移 {got_drift:.4f} 周期 (理论 {expect_drift:.4f})")

    return results
