"""畸变模型与坐标映射核心。

模型约定（与 OpenCV 的 ``k1,k2,p1,p2`` 约定完全一致）
=====================================================

设畸变中心为像素坐标 ``(cx, cy)``，归一化尺度
``s = 0.5 * sqrt(width^2 + height^2)``（像素，画幅半对角线长），
则任意像素点 ``(u, v)`` 的**归一化坐标**（无量纲）为::

    x = (u - cx) / s
    y = (v - cy) / s

正向（理想 -> 畸变，OpenCV projectPoints 约定）::

    r2 = x^2 + y^2
    xd = x * (1 + k1*r2 + k2*r2^2)
       + 2*p1*x*y + p2*(r2 + 2*x^2)
    yd = y * (1 + k1*r2 + k2*r2^2)
       + p1*(r2 + 2*y^2) + 2*p2*x*y

    ud = cx + s*xd,  vd = cy + s*yd

* ``k1, k2``：径向畸变系数，无量纲。桶形畸变（画面向外鼓、直线向内弯）
  对应 ``k1 < 0``；枕形畸变对应 ``k1 > 0``。
* ``p1, p2``：偏心（薄透镜）畸变系数，无量纲。``p1`` 主导竖直方向偏心，
  ``p2`` 主导水平方向偏心；正值方向与 OpenCV 约定相同。
* 归一化坐标以画幅半对角线为 1 个单位，画幅角点 ``r ≈ 1``，
  因此系数数值具有直观含义（如 k1=-0.3 表示角点径向位移约 -30%*r）。
* 零参数（k1=k2=p1=p2=0）时正/反向映射都是恒等映射。

反向（畸变 -> 理想）没有闭式解，采用解析雅可比 Newton 迭代，
归一化容差 1e-12（折合像素约 1e-9 量级），不收敛的点标记为无效。

支持的稳定参数范围（超出界面会给出警告，不作为成功结果）::

    |k1| <= 1, |k2| <= 1, |p1| <= 0.2, |p2| <= 0.2
"""

from __future__ import annotations

from dataclasses import dataclass, asdict
import numpy as np
import cv2

# 支持的稳定参数范围（文档与界面、拟合共用）
SUPPORTED_RANGES = {
    "k1": (-1.0, 1.0),
    "k2": (-1.0, 1.0),
    "p1": (-0.2, 0.2),
    "p2": (-0.2, 0.2),
}

# 界面 SpinBox 允许调整的更宽范围（超出支持范围时给出警告而非禁止）
SPIN_RANGES = {
    "k1": (-5.0, 5.0),
    "k2": (-5.0, 5.0),
    "p1": (-1.0, 1.0),
    "p2": (-1.0, 1.0),
}

_NEWTON_TOL = 1e-12
_NEWTON_MAX_ITER = 40


@dataclass
class DistortionParams:
    """一组畸变参数。cx/cy 单位为像素，其余为无量纲系数。"""

    k1: float = 0.0
    k2: float = 0.0
    p1: float = 0.0
    p2: float = 0.0
    cx: float = 0.0
    cy: float = 0.0

    def copy(self) -> "DistortionParams":
        return DistortionParams(**asdict(self))

    def is_zero(self) -> bool:
        return (self.k1 == 0.0 and self.k2 == 0.0
                and self.p1 == 0.0 and self.p2 == 0.0)

    def within_supported(self) -> bool:
        for name, (lo, hi) in SUPPORTED_RANGES.items():
            if not (lo <= getattr(self, name) <= hi):
                return False
        return True


def norm_scale(shape: tuple[int, int]) -> float:
    """归一化尺度 s = 画幅半对角线长（像素）。"""
    h, w = shape[:2]
    return 0.5 * float(np.hypot(w, h))


def _to_2d(points: np.ndarray) -> np.ndarray:
    arr = np.asarray(points, dtype=np.float64)
    if arr.size == 0:
        return arr.reshape(0, 2)
    return arr.reshape(-1, 2)


def project_normalized(x: np.ndarray, y: np.ndarray,
                       p: DistortionParams):
    """正向映射的归一化部分：理想 (x,y) -> 畸变 (xd,yd)，均为无量纲数组。"""
    r2 = x * x + y * y
    radial = 1.0 + p.k1 * r2 + p.k2 * r2 * r2
    xd = (x * radial
          + 2.0 * p.p1 * x * y
          + p.p2 * (r2 + 2.0 * x * x))
    yd = (y * radial
          + p.p1 * (r2 + 2.0 * y * y)
          + 2.0 * p.p2 * x * y)
    return xd, yd


def _jacobian_normalized(x: np.ndarray, y: np.ndarray,
                         p: DistortionParams):
    """正向映射对理想归一化坐标的 2x2 解析雅可比（供 Newton 反投）。"""
    r2 = x * x + y * y
    dqdx = 2.0 * p.k1 * x + 4.0 * p.k2 * r2 * x
    dqdy = 2.0 * p.k1 * y + 4.0 * p.k2 * r2 * y
    radial = 1.0 + p.k1 * r2 + p.k2 * r2 * r2

    j00 = radial + x * dqdx + 2.0 * p.p1 * y + 6.0 * p.p2 * x
    j01 = x * dqdy + 2.0 * p.p1 * x + 2.0 * p.p2 * y
    j10 = y * dqdx + 2.0 * p.p1 * x + 2.0 * p.p2 * y
    j11 = radial + y * dqdy + 6.0 * p.p1 * y + 2.0 * p.p2 * x
    return j00, j01, j10, j11


def unproject_normalized(xd: np.ndarray, yd: np.ndarray,
                         p: DistortionParams,
                         tol: float = _NEWTON_TOL,
                         max_iter: int = _NEWTON_MAX_ITER):
    """反向映射归一化部分：畸变 (xd,yd) -> 理想 (x,y)，Newton 迭代。

    返回 ``(x, y, converged)``，``converged`` 为布尔数组，
    标记每个点是否在容差内收敛。
    """
    xd = np.asarray(xd, dtype=np.float64)
    yd = np.asarray(yd, dtype=np.float64)
    x = xd.copy()
    y = yd.copy()
    converged = np.zeros(xd.shape, dtype=bool)
    active = np.ones(xd.shape, dtype=bool)

    for _ in range(max_iter):
        if not np.any(active):
            break
        fx, fy = project_normalized(x, y, p)
        res_x = xd - fx
        res_y = yd - fy
        j00, j01, j10, j11 = _jacobian_normalized(x, y, p)
        det = j00 * j11 - j01 * j10
        # 雅可比奇异时该点无法稳定反投
        good = np.abs(det) > 1e-14
        dx = np.where(good, (j11 * res_x - j01 * res_y) /
                      np.where(good, det, 1.0), 0.0)
        dy = np.where(good, (j00 * res_y - j10 * res_x) /
                      np.where(good, det, 1.0), 0.0)
        x = np.where(active & good, x + dx, x)
        y = np.where(active & good, y + dy, y)
        done = active & good & (np.hypot(res_x, res_y) < tol)
        converged |= done
        active &= ~done
        active &= good
    # 再做一次残差检查，未达标即视为不收敛
    fx, fy = project_normalized(x, y, p)
    converged &= np.hypot(xd - fx, yd - fy) < tol * 100.0
    return x, y, converged


def project_pixels(points_uv: np.ndarray, shape: tuple[int, int],
                   p: DistortionParams) -> np.ndarray:
    """正向像素映射：理想像素坐标 -> 畸变像素坐标，形状 (N,2)。"""
    pts = _to_2d(points_uv)
    if pts.shape[0] == 0:
        return pts.copy()
    s = norm_scale(shape)
    x = (pts[:, 0] - p.cx) / s
    y = (pts[:, 1] - p.cy) / s
    xd, yd = project_normalized(x, y, p)
    return np.column_stack([p.cx + s * xd, p.cy + s * yd])


def unproject_pixels(points_uv: np.ndarray, shape: tuple[int, int],
                     p: DistortionParams):
    """反向像素映射：畸变像素坐标 -> 理想像素坐标。

    返回 ``(pts_ideal, converged)``。
    """
    pts = _to_2d(points_uv)
    if pts.shape[0] == 0:
        return pts.copy(), np.ones(0, dtype=bool)
    s = norm_scale(shape)
    xd = (pts[:, 0] - p.cx) / s
    yd = (pts[:, 1] - p.cy) / s
    x, y, converged = unproject_normalized(xd, yd, p)
    ideal = np.column_stack([p.cx + s * x, p.cy + s * y])
    return ideal, converged


def build_undistort_map(shape: tuple[int, int],
                        p: DistortionParams) -> np.ndarray:
    """校正重映射表（输出校正图每个像素应去畸变图的哪里采样）。

    校正图与原图同尺寸、同像素坐标系；对每个校正像素做正向映射
    得到畸变图采样坐标，配合 ``cv2.remap`` 使用。
    """
    h, w = shape[:2]
    s = norm_scale(shape)
    vv, uu = np.meshgrid(np.arange(h), np.arange(w), indexing="ij")
    x = (uu.astype(np.float64) - p.cx) / s
    y = (vv.astype(np.float64) - p.cy) / s
    xd, yd = project_normalized(x, y, p)
    map_xy = np.empty((h, w, 2), dtype=np.float32)
    map_xy[..., 0] = (p.cx + s * xd).astype(np.float32)
    map_xy[..., 1] = (p.cy + s * yd).astype(np.float32)
    return map_xy


def build_distort_map(shape: tuple[int, int],
                      p: DistortionParams):
    """生成畸变图的重映射表（理想图 -> 带畸变图）。

    返回 ``(map_xy, converged_mask)``，不收敛位置在 mask 中为 False，
    对应输出像素应视为越界无效。
    """
    h, w = shape[:2]
    s = norm_scale(shape)
    vv, uu = np.meshgrid(np.arange(h), np.arange(w), indexing="ij")
    xd = (uu.astype(np.float64) - p.cx) / s
    yd = (vv.astype(np.float64) - p.cy) / s
    x, y, converged = unproject_normalized(xd, yd, p)
    map_xy = np.empty((h, w, 2), dtype=np.float32)
    map_xy[..., 0] = (p.cx + s * x).astype(np.float32)
    map_xy[..., 1] = (p.cy + s * y).astype(np.float32)
    return map_xy, converged


def remap_image(image: np.ndarray, map_xy: np.ndarray) -> np.ndarray:
    """按 (H,W,2) 的 x,y 浮点映射表做双线性重映射，越界填黑。"""
    return cv2.remap(
        image, map_xy, None, interpolation=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0))


def valid_mask_from_map(map_xy: np.ndarray,
                        source_shape: tuple[int, int]) -> np.ndarray:
    """采样坐标落在源图有效范围内（含双线性半像素边界）的布尔掩膜。"""
    h, w = source_shape[:2]
    x = map_xy[..., 0]
    y = map_xy[..., 1]
    return ((x >= 0.5) & (x <= w - 1.5) &
            (y >= 0.5) & (y <= h - 1.5))


def radial_monotonic_ok(p: DistortionParams,
                        r_max: float = 1.05,
                        n: int = 400) -> bool:
    """检查径向函数 g(r)=r(1+k1 r^2+k2 r^4) 在 [0, r_max] 单调。

    单调性等价于 g'(r) = 1 + 3 k1 r^2 + 5 k2 r^4 > 0。
    偏心项不影响径向单调性，局部雅可比奇异由全网格收敛检查补充。
    """
    rs = np.linspace(0.0, r_max, n)
    deriv = 1.0 + 3.0 * p.k1 * rs ** 2 + 5.0 * p.k2 * rs ** 4
    return bool(np.min(deriv) > 1e-6)


@dataclass
class StabilityReport:
    ok: bool
    warnings: list[str]

    @property
    def message(self) -> str:
        return "；".join(self.warnings) if self.warnings else ""


def check_stability(shape: tuple[int, int],
                    p: DistortionParams) -> StabilityReport:
    """综合稳定性判定：范围、径向单调性、全网格反投收敛率。"""
    warnings: list[str] = []
    for name, (lo, hi) in SUPPORTED_RANGES.items():
        val = getattr(p, name)
        if not (lo <= val <= hi):
            warnings.append(
                f"{name}={val:.4f} 超出支持范围 [{lo}, {hi}]")

    if not radial_monotonic_ok(p):
        warnings.append("径向映射非单调，反投存在多解，校正不可靠")

    # 在画幅网格上抽样做反投收敛检查
    h, w = shape[:2]
    step = max(8, min(h, w) // 40)
    vv, uu = np.meshgrid(np.arange(0, h, step),
                         np.arange(0, w, step), indexing="ij")
    pts = np.column_stack([uu.ravel(), vv.ravel()]).astype(np.float64)
    _, converged = unproject_pixels(pts, shape, p)
    fail_ratio = 1.0 - float(np.mean(converged))
    if fail_ratio > 0.01:
        warnings.append(
            f"反投不收敛点占 {fail_ratio * 100:.1f}%，"
            "存在不能稳定反向映射的区域")

    return StabilityReport(ok=not warnings, warnings=warnings)
