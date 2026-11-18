"""控制点小范围拟合。

在带畸变图上拖动观测点 ``observed``（畸变坐标），在参考网格上指定
希望恢复到的目标位置 ``target``（理想坐标），固定畸变中心，
用 Levenberg-Marquardt 最小化正向映射残差::

    residual_i = project(target_i; theta) - observed_i

可选仅拟合两个径向参数 (k1,k2)，或拟合四个参数 (k1,k2,p1,p2)。
雅可比由链式法则解析给出，残差单位为像素。
"""

from __future__ import annotations

from dataclasses import dataclass
import numpy as np

from .distortion import (
    DistortionParams,
    norm_scale,
    project_normalized,
    SUPPORTED_RANGES,
)

# 点位分布的最低要求
MIN_POINTS_RADIAL = 3   # 2 个参数至少 3 点
MIN_POINTS_FULL = 4     # 4 个参数至少 4 点，建议 6 点以上
MIN_SPREAD = 0.15       # 归一化坐标上 x/y 方向最小展布
COLLINEAR_TOL = 1e-6    # 行列式为 0 判定共线
LM_MAX_ITER = 100
LM_TOL = 1e-12          # 步长/梯度的绝对收敛容差（归一化空间）
RMSE_LIMIT_PX = 5.0     # 成功拟合允许的最大 RMSE（像素）


@dataclass
class FitResult:
    ok: bool
    message: str
    params: DistortionParams | None = None
    residuals_px: np.ndarray | None = None   # 每点 (du,dv)，像素
    distances_px: np.ndarray | None = None   # 每点残差模长，像素
    rmse_px: float = 0.0
    max_err_px: float = 0.0
    iterations: int = 0


def _spread_ok(targets_norm: np.ndarray) -> tuple[bool, str]:
    spread_x = float(np.ptp(targets_norm[:, 0]))
    spread_y = float(np.ptp(targets_norm[:, 1]))
    if spread_x < MIN_SPREAD or spread_y < MIN_SPREAD:
        return False, (
            f"控制点分布过于集中（x/y 归一化展布 {spread_x:.3f}/"
            f"{spread_y:.3f}，要求均 ≥ {MIN_SPREAD}），拟合不适定，"
            "请把点分散到不同区域")
    centered = targets_norm - targets_norm.mean(axis=0)
    # 二阶矩行列式接近 0 说明点几乎共线
    cov = centered.T @ centered
    if abs(np.linalg.det(cov)) < COLLINEAR_TOL * (np.trace(cov) ** 2 + 1e-12):
        return False, "控制点近似共线，无法可靠估计畸变，请调整点位"
    return True, ""


def check_points(points: np.ndarray, mode: str) -> tuple[bool, str]:
    """拟合前的点数与分布检查。"""
    n = len(points)
    if mode == "radial":
        if n < MIN_POINTS_RADIAL:
            return False, (f"仅拟合两个径向参数至少需要 "
                           f"{MIN_POINTS_RADIAL} 个控制点，当前 {n} 个")
    else:
        if n < MIN_POINTS_FULL:
            return False, (f"拟合四个畸变参数至少需要 "
                           f"{MIN_POINTS_FULL} 个控制点（建议 6 个以上），"
                           f"当前 {n} 个")
    if not (4 <= n <= 12):
        return False, f"控制点数量需在 4~12 之间，当前 {n} 个"
    return True, ""


def _analytic_jacobian(targets_norm: np.ndarray,
                       p: DistortionParams, mode: str) -> np.ndarray:
    """归一化正向映射对参数的解析雅可比（无量纲）。

    最小二乘整体在归一化空间进行（像素残差除以常数 s，不改变解），
    最终 RMSE 再换算回像素。
    """
    x = targets_norm[:, 0]
    y = targets_norm[:, 1]
    r2 = x * x + y * y
    r4 = r2 * r2
    n = x.shape[0]
    cols: list[np.ndarray] = []

    # d(project)/d k1
    cols.append(np.column_stack([x * r2, y * r2]))
    # d(project)/d k2
    cols.append(np.column_stack([x * r4, y * r4]))
    if mode == "full":
        # d(project)/d p1
        cols.append(np.column_stack(
            [2.0 * x * y, r2 + 2.0 * y * y]))
        # d(project)/d p2
        cols.append(np.column_stack(
            [r2 + 2.0 * x * x, 2.0 * x * y]))

    # 行顺序必须与 residual 一致：先全部 u 分量，再全部 v 分量
    j = np.empty((2 * n, 2 if mode == "radial" else 4))
    for k, col in enumerate(cols):
        j[:n, k] = col[:, 0]
        j[n:, k] = col[:, 1]
    return j


def fit_distortion(targets_uv: np.ndarray,
                   observed_uv: np.ndarray,
                   shape: tuple[int, int],
                   center: tuple[float, float],
                   mode: str = "radial") -> FitResult:
    """固定畸变中心，拟合 2 个径向或 4 个畸变参数。

    参数
    ----
    targets_uv:  参考网格上的理想目标坐标 (N,2)，像素
    observed_uv: 带畸变图上的观测坐标 (N,2)，像素
    shape:       图像 (H,W)
    center:      固定的畸变中心 (cx,cy)，像素
    mode:        ``"radial"`` 拟合 k1,k2；``"full"`` 拟合 k1,k2,p1,p2
    """
    targets = np.asarray(targets_uv, dtype=np.float64).reshape(-1, 2)
    observed = np.asarray(observed_uv, dtype=np.float64).reshape(-1, 2)
    if targets.shape != observed.shape or targets.shape[0] == 0:
        return FitResult(False, "控制点数据不完整")

    ok, msg = check_points(targets, mode)
    if not ok:
        return FitResult(False, msg)

    s = norm_scale(shape)
    cx, cy = center
    x = (targets[:, 0] - cx) / s
    y = (targets[:, 1] - cy) / s
    targets_norm = np.column_stack([x, y])
    # 观测点也换算到归一化坐标，最小二乘在归一化空间进行
    obs_norm = (observed - np.array([cx, cy])) / s

    ok, msg = _spread_ok(targets_norm)
    if not ok:
        return FitResult(False, msg)

    n_param = 2 if mode == "radial" else 4
    theta = np.zeros(n_param)           # 从零参数初值出发
    damping = 1e-3
    iters = 0

    def build_params(t: np.ndarray) -> DistortionParams:
        if mode == "radial":
            return DistortionParams(k1=t[0], k2=t[1], cx=cx, cy=cy)
        return DistortionParams(k1=t[0], k2=t[1], p1=t[2],
                                p2=t[3], cx=cx, cy=cy)

    def residual(t: np.ndarray) -> np.ndarray:
        """归一化残差（乘 s 即像素残差）。"""
        p = build_params(t)
        xd, yd = project_normalized(x, y, p)
        r = np.column_stack([xd, yd]) - obs_norm
        return np.concatenate([r[:, 0], r[:, 1]])

    cost = float(residual(theta) @ residual(theta))
    for iters in range(1, LM_MAX_ITER + 1):
        j = _analytic_jacobian(targets_norm, build_params(theta), mode)
        jtj = j.T @ j
        jtr = j.T @ residual(theta)

        accepted = False
        for _ in range(30):
            try:
                # 经典 Levenberg-Marquardt：单位阵缩放，
                # lambda→0 为高斯-牛顿，lambda→∞ 为小梯度步
                step = np.linalg.solve(
                    jtj + damping * np.eye(n_param), -jtr)
            except np.linalg.LinAlgError:
                damping *= 10.0
                continue
            new_theta = theta + step
            if not np.all(np.isfinite(new_theta)):
                damping *= 10.0
                continue
            new_cost = float(residual(new_theta) @ residual(new_theta))
            if new_cost < cost:
                theta = new_theta
                damping = max(damping * 0.3, 1e-12)
                accepted = True
                break
            damping *= 10.0

        if not accepted:
            # 阻尼已推到极大仍无法下降：到达当前模型的最小二乘驻点，
            # 作为收敛处理；是否可用由后面的 RMSE 阈值判定
            break
        # 步长与梯度都足够小才判定收敛，避免大代价基值下提前退出
        grad_norm = float(np.linalg.norm(jtr))
        if (float(np.linalg.norm(step)) < LM_TOL
                and grad_norm < LM_TOL):
            cost = new_cost
            break
        cost = new_cost

    fitted = build_params(theta)
    if not np.all(np.isfinite(theta)):
        return FitResult(False, "拟合结果非有限值，请调整控制点")
    for name in ("k1", "k2", "p1", "p2"):
        lo, hi = SUPPORTED_RANGES[name]
        if not (lo * 5 <= getattr(fitted, name) <= hi * 5):
            return FitResult(
                False, f"拟合得到的 {name} 过大，结果不可靠，"
                       "请检查控制点是否放错或改用更温和的畸变")

    r = residual(theta) * s          # 归一化残差换算回像素
    du = r[0::2]
    dv = r[1::2]
    dist = np.hypot(du, dv)
    rmse = float(np.sqrt(np.mean(dist ** 2)))
    max_err = float(np.max(dist))
    if rmse > 5.0:
        return FitResult(False,
                         f"拟合残差过大（RMSE={rmse:.2f}px > 5px），"
                         "点位与模型不匹配，请调整控制点")

    warn = ""
    if mode == "full" and len(targets) < 6:
        warn = "（点数偏少，四参数结果可能不稳定，建议 6 点以上）"
    return FitResult(
        ok=True,
        message=f"拟合成功，迭代 {iters} 次，RMSE={rmse:.3f}px，"
                f"最大误差={max_err:.3f}px{warn}",
        params=fitted,
        residuals_px=np.column_stack([du, dv]),
        distances_px=dist,
        rmse_px=rmse,
        max_err_px=max_err,
        iterations=iters,
    )
