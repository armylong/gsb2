"""偏振分析核心.

物理模型 (马吕斯定律的 Stokes 线性形式, 周期 180 度):

    y(theta) = A + B*cos(2*theta) + C*sin(2*theta)

其中 A 为直流亮度, R = hypot(B, C) 为随角度变化的调制幅度,
偏振方向 phi = 0.5 * atan2(C, B) (角度制, 模 180 度),
偏振度 rho = R / A.

所有计算基于"可比较的亮度": Rec.709 加权亮度, 可选 sRGB 线性化,
并对各帧做中位数曝光归一化, 消除帧间曝光差异.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import numpy as np

REC709 = np.array([0.2126, 0.7152, 0.0722], dtype=np.float64)


# ---------------------------------------------------------------------------
# 亮度与曝光
# ---------------------------------------------------------------------------

def srgb_to_linear(x: np.ndarray) -> np.ndarray:
    """sRGB 传递函数逆变换, 输入输出均为 0..1 浮点."""
    x = np.asarray(x, dtype=np.float64)
    return np.where(x <= 0.04045, x / 12.92, ((x + 0.055) / 1.055) ** 2.4)


def luminance(rgb: np.ndarray, linearize: bool = True) -> np.ndarray:
    """(..., 3) uint8/float RGB -> Rec.709 亮度, 范围 0..1."""
    x = rgb.astype(np.float64) / 255.0 if np.issubdtype(rgb.dtype, np.integer) else rgb.astype(np.float64)
    if linearize:
        x = srgb_to_linear(x)
    return x @ REC709


def normalize_exposure(lum: np.ndarray, valid: np.ndarray | None = None) -> tuple[np.ndarray, np.ndarray]:
    """按每帧中位数做曝光归一化.

    Parameters
    ----------
    lum : (K, H, W) 亮度栈
    valid : (K, H, W) 参与中位数统计的像素 (例如排除过曝/极暗), None 表示全部
    Returns
    -------
    normalized, factors : 归一化栈与每帧因子 (原始 = 归一化 * factor)
    """
    factors = np.empty(lum.shape[0], dtype=np.float64)
    for k in range(lum.shape[0]):
        vals = lum[k] if valid is None else lum[k][valid[k]]
        vals = vals[vals > 0]
        factors[k] = np.median(vals) if vals.size else 1.0
    factors = np.where(factors > 0, factors, 1.0)
    factors /= np.mean(factors)
    return lum / factors[:, None, None], factors


# ---------------------------------------------------------------------------
# 角度合法性
# ---------------------------------------------------------------------------

def check_angles(angles_deg: list[float]) -> list[str]:
    """返回角度配置的问题说明; 空列表表示可以拟合."""
    problems: list[str] = []
    if len(angles_deg) < 3:
        problems.append(f"只有 {len(angles_deg)} 个有效角度, 马吕斯模型至少需要 3 个不同角度")
        return problems
    mod = np.mod(np.asarray(angles_deg, dtype=np.float64), 180.0)
    seen: dict[float, int] = {}
    for i, a in enumerate(mod):
        for j, b in seen.items():
            if abs(a - j) < 1e-9 or abs(a - j - 180.0) < 1e-9:
                problems.append(f"第 {b + 1} 个与第 {i + 1} 个角度在模 180° 下重复 (均为 {j:g}°), 该角度没有新增信息")
        seen.setdefault(float(a), i)
    if len(set(np.round(mod, 6))) < 3:
        problems.append("不同角度不足 3 个, 设计矩阵秩不足, 无法解出 A/B/C 三个参数")
        return problems
    X = design_matrix(np.asarray(angles_deg, dtype=np.float64))
    if np.linalg.matrix_rank(X, tol=1e-8) < 3:
        problems.append("角度在 (cos2θ, sin2θ) 平面共线, 设计矩阵奇异, 无法唯一拟合")
    return problems


def design_matrix(angles_deg: np.ndarray) -> np.ndarray:
    """构造 [1, cos2θ, sin2θ] 设计矩阵."""
    t = np.deg2rad(angles_deg)
    return np.column_stack([np.ones_like(t), np.cos(2 * t), np.sin(2 * t)])


# ---------------------------------------------------------------------------
# 拟合结果与阈值
# ---------------------------------------------------------------------------

@dataclass
class Thresholds:
    dark: float = 0.03          # 归一化亮度低于此值视为极暗
    saturated_value: int = 250  # 任一通道 >= 该 uint8 值视为过曝
    residual_ratio: float = 0.10  # 残差 rms / A 超过此值视为模型无法解释
    unphysical_tol: float = 0.05   # R > A*(1+tol) 视为非物理


@dataclass
class FitResult:
    angles: np.ndarray              # (K,) 实际使用的角度
    A: np.ndarray                   # (H, W) 直流分量
    B: np.ndarray
    C: np.ndarray
    R: np.ndarray                   # 调制幅度
    phi: np.ndarray                 # 偏振方向, 角度 [0, 180)
    rho: np.ndarray                 # 偏振度 R/A
    rms: np.ndarray                 # 拟合残差 rms (亮度单位)
    mean_rgb: np.ndarray            # (H,W,3) float 0..1, 用于彩色预览重建
    factors: np.ndarray             # 曝光归一化因子
    lum: np.ndarray                 # (K,H,W) 归一化后的拟合输入
    thresholds: Thresholds
    mask_dark: np.ndarray
    mask_saturated: np.ndarray
    mask_unphysical: np.ndarray
    mask_residual: np.ndarray
    trustworthy: np.ndarray
    residual_dof: int
    problems: list[str] = field(default_factory=list)

    @property
    def shape(self):
        return self.A.shape

    def simulate_luminance(self, theta_deg: float) -> np.ndarray:
        """模拟滤镜转到 theta_deg 时的亮度图."""
        t = np.deg2rad(theta_deg)
        return self.A + self.B * np.cos(2 * t) + self.C * np.sin(2 * t)

    def simulate_rgb(self, theta_deg: float) -> np.ndarray:
        """模拟彩色预览: 以平均 RGB 为底色, 按模拟亮度/A 缩放, 保持色调."""
        y = self.simulate_luminance(theta_deg)
        scale = np.divide(y, self.A, out=np.zeros_like(y), where=self.A > 1e-12)
        rgb = self.mean_rgb * scale[..., None]
        return np.clip(rgb, 0.0, 1.0)

    def category_at(self, y: int, x: int) -> str:
        if self.mask_saturated[y, x]:
            return "过曝"
        if self.mask_unphysical[y, x]:
            return "非物理(R>A)"
        if self.mask_residual[y, x]:
            return "模型无法解释"
        if self.mask_dark[y, x]:
            return "极暗"
        if self.trustworthy[y, x]:
            return "可信"
        return "未知"


# ---------------------------------------------------------------------------
# 拟合
# ---------------------------------------------------------------------------

def fit_stack(
    rgb_stack: np.ndarray,
    angles_deg: list[float],
    linearize: bool = True,
    exposure_normalize: bool = True,
    thresholds: Thresholds | None = None,
) -> FitResult:
    """对 (K,H,W,3) uint8 图像栈做逐像素马吕斯拟合.

    调用前应已用 check_angles 排除角度配置问题, 并用 io 层保证同尺寸.
    """
    thresholds = thresholds or Thresholds()
    angles = np.asarray(angles_deg, dtype=np.float64)
    k = rgb_stack.shape[0]
    if k < 3:
        raise ValueError("至少需要 3 张图才能拟合")

    raw_lum = np.stack([luminance(im, linearize=linearize) for im in rgb_stack], axis=0)
    sat_mask = np.any(rgb_stack >= thresholds.saturated_value, axis=(0, 3))
    dark_raw = np.all(raw_lum < thresholds.dark, axis=0)
    valid = ~(sat_mask[None].repeat(k, axis=0) | dark_raw[None].repeat(k, axis=0))

    if exposure_normalize:
        lum, factors = normalize_exposure(raw_lum, valid=valid)
    else:
        lum, factors = raw_lum, np.ones(k)

    # 最小二乘: 设计矩阵对所有像素相同, 预求逆后一次性算全部像素
    X = design_matrix(angles)
    xtx_inv = np.linalg.inv(X.T @ X)
    xty = np.einsum("ki,khw->ihw", X, lum)
    coef = np.einsum("ij,jhw->ihw", xtx_inv, xty)
    A, B, C = coef[0], coef[1], coef[2]

    pred = np.einsum("ki,ihw->khw", X, coef)
    rms = np.sqrt(np.mean((lum - pred) ** 2, axis=0))

    R = np.hypot(B, C)
    phi = np.mod(0.5 * np.rad2deg(np.arctan2(C, B)), 180.0)
    rho = np.divide(R, A, out=np.zeros_like(R), where=A > 1e-12)

    mask_dark = np.all(lum < thresholds.dark, axis=0)
    mask_unphysical = R > A * (1.0 + thresholds.unphysical_tol)
    with np.errstate(divide="ignore", invalid="ignore"):
        mask_residual = (A > 1e-12) & (rms / np.maximum(A, 1e-12) > thresholds.residual_ratio)
    if k <= 3:
        # 3 帧恰好确定 3 个参数, 残差自由度为 0, 残差掩码没有判别力
        mask_residual = np.zeros_like(A, dtype=bool)

    trustworthy = ~(mask_dark | sat_mask | mask_unphysical | mask_residual) & (A > 1e-12)
    mean_rgb = np.mean(rgb_stack.astype(np.float64) / 255.0, axis=0)

    return FitResult(
        angles=angles, A=A, B=B, C=C, R=R, phi=phi, rho=rho, rms=rms,
        mean_rgb=mean_rgb, factors=factors, lum=lum, thresholds=thresholds,
        mask_dark=mask_dark, mask_saturated=sat_mask,
        mask_unphysical=mask_unphysical, mask_residual=mask_residual,
        trustworthy=trustworthy, residual_dof=max(k - 3, 0),
        problems=check_angles(angles_deg),
    )


# ---------------------------------------------------------------------------
# 可视化渲染 (全部输出 RGB uint8; 错误类别使用固定显式颜色, 不进默认色图)
# ---------------------------------------------------------------------------

ERROR_COLORS = {
    "saturated": (255, 0, 255),    # 品红: 过曝
    "unphysical": (255, 0, 0),     # 红: 非物理
    "residual": (255, 140, 0),     # 橙: 模型无法解释
    "dark": (40, 44, 60),          # 暗蓝灰: 极暗
}


def _hsv_to_rgb(h: np.ndarray, s: np.ndarray, v: np.ndarray) -> np.ndarray:
    """向量化 HSV->RGB, h/s/v 同为任意形状, h,s,v 范围 0..1."""
    i = np.floor(h * 6.0).astype(np.int64)
    f = h * 6.0 - i
    p = v * (1.0 - s)
    q = v * (1.0 - f * s)
    t = v * (1.0 - (1.0 - f) * s)
    i_mod = i % 6
    r = np.choose(i_mod, [v, q, p, p, t, v])
    g = np.choose(i_mod, [t, v, v, q, p, p])
    b = np.choose(i_mod, [p, p, t, v, v, q])
    return np.stack([r, g, b], axis=-1)


def render_direction(fit: FitResult, rho_gain: float = 1.0) -> np.ndarray:
    """方向图: 色相=phi, 饱和度=偏振度, 明度=A; 错误像素用固定颜色覆盖."""
    h = fit.phi / 180.0
    s = np.clip(fit.rho * rho_gain, 0.0, 1.0)
    ref = np.percentile(fit.A[fit.A > 0], 98) if np.any(fit.A > 0) else 1.0
    v = np.clip(fit.A / max(ref, 1e-12), 0.0, 1.0)
    rgb = _hsv_to_rgb(h, s, v)

    rgb[fit.mask_dark] = np.array(ERROR_COLORS["dark"]) / 255.0
    rgb[fit.mask_residual] = np.array(ERROR_COLORS["residual"]) / 255.0
    rgb[fit.mask_unphysical] = np.array(ERROR_COLORS["unphysical"]) / 255.0
    rgb[fit.mask_saturated] = np.array(ERROR_COLORS["saturated"]) / 255.0
    return (rgb * 255).astype(np.uint8)


def render_gray(data: np.ndarray, fit: FitResult, percent: float = 98.0) -> np.ndarray:
    """通用灰度图 (幅度 R / 偏振度 rho 等), 错误像素同样用固定颜色标出."""
    ref = np.percentile(data[fit.trustworthy], percent) if np.any(fit.trustworthy) else 1.0
    g = np.clip(data / max(ref, 1e-12), 0.0, 1.0)
    rgb = np.repeat(g[..., None], 3, axis=-1)
    rgb[fit.mask_dark] = np.array(ERROR_COLORS["dark"]) / 255.0
    rgb[fit.mask_residual] = np.array(ERROR_COLORS["residual"]) / 255.0
    rgb[fit.mask_unphysical] = np.array(ERROR_COLORS["unphysical"]) / 255.0
    rgb[fit.mask_saturated] = np.array(ERROR_COLORS["saturated"]) / 255.0
    return (rgb * 255).astype(np.uint8)


def render_quality(fit: FitResult) -> np.ndarray:
    """质量分类图: 可信=深灰绿, 四类问题各自独立配色, 带显式图例色."""
    rgb = np.full((*fit.shape, 3), (220, 225, 220), dtype=np.uint8)
    rgb[fit.trustworthy] = (170, 200, 170)
    rgb[fit.mask_dark] = ERROR_COLORS["dark"]
    rgb[fit.mask_residual] = ERROR_COLORS["residual"]
    rgb[fit.mask_unphysical] = ERROR_COLORS["unphysical"]
    rgb[fit.mask_saturated] = ERROR_COLORS["saturated"]
    return rgb


def overlay_errors(rgb: np.ndarray, fit: FitResult, alpha: float = 0.55) -> np.ndarray:
    """在任意 RGB 图上半透明叠加错误类别颜色."""
    out = rgb.astype(np.float64).copy()
    for name, mask in (
        ("dark", fit.mask_dark),
        ("residual", fit.mask_residual),
        ("unphysical", fit.mask_unphysical),
        ("saturated", fit.mask_saturated),
    ):
        color = np.array(ERROR_COLORS[name], dtype=np.float64)
        out[mask] = (1 - alpha) * out[mask] + alpha * color
    return np.clip(out, 0, 255).astype(np.uint8)
