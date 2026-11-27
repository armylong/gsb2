"""逐像素鲁棒光度立体求解.

模型: I_k = rho * s_k * max(n . l_k, 0) + 噪声.
对每个像素独立求解法线 n 与反照率 rho, 不假设表面平滑,
因此"材料颜色变化"不会被平白解释成凹凸.

可信度/无解原因通过状态码返回, UI 与测试据此标记低可信区域.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

# ---- 状态码 (每个像素一个) ----
OK = 0
UNDERDETERMINED = 1      # 有效灯不足 3 盏, 方程无解
NEAR_PARALLEL = 2        # 灯方向几乎共面/平行, 法线不可靠
POOR_FIT = 3             # 观测与 Lambertian 模型明显不符 (含阴影/高光漏网)
NON_FRONT_FACING = 4     # 解出的法线背离相机 (n_z <= 0)
DARK_PIXEL = 5           # 全部灯都太暗, 数值上无法分辨方向
SATURATED_MAJORITY = 6   # 多数灯过曝, 有效观测不足

REASON = {
    OK: "有效",
    UNDERDETERMINED: "有效灯不足 3 盏, 无解",
    NEAR_PARALLEL: "灯方向过于接近, 低可信",
    POOR_FIT: "与漫反射模型不符, 低可信",
    NON_FRONT_FACING: "法线背离相机, 无解",
    DARK_PIXEL: "整体过暗, 无解",
    SATURATED_MAJORITY: "多数灯过曝, 无解",
}


def reason_text(code: int) -> str:
    return REASON.get(int(code), "未知")


@dataclass
class PSResult:
    normals: np.ndarray      # (H, W, 3) 估计法线, 无效点为 0
    albedo: np.ndarray       # (H, W) 估计反照率/反射强度, 无效点为 0
    confidence: np.ndarray   # (H, W) 0~1, 1 最可信
    status: np.ndarray       # (H, W) int 状态码
    used: np.ndarray         # (K, H, W) bool 该像素实际用上的灯
    fit_residual: np.ndarray # (H, W) 归一化拟合残差
    condition: np.ndarray    # (H, W) 有效灯方向矩阵的条件数
    directions: np.ndarray
    strengths: np.ndarray
    saturation: float
    min_intensity: float

    @property
    def valid(self) -> np.ndarray:
        return self.status == OK


def solve_photometric(
    images: np.ndarray,
    directions: np.ndarray,
    strengths: np.ndarray | None = None,
    *,
    saturation: float = 0.95,
    enabled: np.ndarray | None = None,
    min_intensity: float = 0.03,
    min_lights: int = 3,
    cond_threshold: float = 15.0,
    fit_threshold: float = 0.06,
) -> PSResult:
    """对所有像素求解.

    images:     (K, H, W) 同机位灰度图
    directions: (K, 3) 灯方向 (从表面指向灯)
    strengths:  (K,) 灯相对亮度
    enabled:    (K,) bool, 临时剔除某张图 (留灯重核); None 为全部启用
    """
    images = np.asarray(images, dtype=np.float64)
    directions = np.asarray(directions, np.float64)
    k, h, w = images.shape
    if strengths is None:
        strengths = np.ones(k)
    strengths = np.asarray(strengths, np.float64)
    if enabled is None:
        enabled = np.ones(k, dtype=bool)
    enabled = np.asarray(enabled, dtype=bool)

    # ---- 1. 每像素的"可用灯": 未被剔除、未过曝、观测高于暗部阈值 ----
    sat_mask = images >= saturation * 0.98
    dark_mask = images < min_intensity
    usable = enabled[:, None, None] & ~sat_mask & ~dark_mask  # (K,H,W)
    n_usable = usable.sum(axis=0)

    # 归一化亮度: 去掉灯的相对亮度, I_k / s_k
    safe_s = np.where(strengths > 1e-9, strengths, 1.0)
    b = images / safe_s[:, None, None]

    normals = np.zeros((h, w, 3))
    albedo = np.zeros((h, w))
    condition = np.full((h, w), np.inf)
    residual = np.full((h, w), np.nan)
    confidence = np.zeros((h, w))
    status = np.full((h, w), OK, dtype=np.int32)

    # ---- 2. 向量化加权最小二乘 + IRLS (逐像素独立) ----
    # work: 初始有效灯就够 3 盏的像素; 其余像素直接判无解.
    work = n_usable >= min_lights
    weights = usable.astype(np.float64)
    g = b  # 归一化观测, 期望等于 rho * max(n.l, 0)

    def _solve_w(
        w: np.ndarray,
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
        """当前权重下的逐像素 WLS, 返回法线、反照率、ATA、奇异掩膜."""
        wa = w[..., None] * directions[:, None, None, :]  # (K,H,W,3)
        ata = np.einsum("khwj,khwl->hwjl", wa, wa)
        atb = np.einsum("khwj,khw->hwj", wa, w * g)
        det = np.linalg.det(ata)
        singular = np.abs(det) < 1e-10
        ata_safe = ata.copy()
        ata_safe[singular] = np.eye(3)
        x = np.linalg.solve(ata_safe, np.expand_dims(atb, -1))[..., 0]
        x[singular] = 0.0
        norm_est = np.linalg.norm(x, axis=-1)
        n_est = x / np.maximum(norm_est[..., None], 1e-12)
        return n_est, norm_est, ata, singular

    # 固定 4 轮 IRLS; 非工作像素权重始终为 0, 不参与拟合
    prev_err = np.full((h, w), np.inf)
    for _ in range(4):
        n_est, rho_est, _, _ = _solve_w(weights)
        pred = rho_est[None] * np.maximum(
            np.einsum("hwc,kc->khw", n_est, directions), 0.0
        )
        nerr = np.abs(g - pred) / np.maximum(rho_est[None], 0.1)

        new_w = weights * np.clip(1.0 - (nerr - 0.03) / 0.15, 0.05, 1.0)
        new_w[nerr > 0.25] = 0.0
        new_w[~usable] = 0.0
        new_w[:, ~work] = 0.0
        mean_err = nerr.mean(axis=0)
        if np.all(mean_err >= prev_err - 1e-6):
            weights = new_w
            break
        prev_err = mean_err
        weights = new_w

    # 最终解 + 条件数/残差
    n_est, rho_est, ata, singular = _solve_w(weights)
    eig = np.linalg.eigvalsh(ata)
    eig_min = np.maximum(eig[..., 0], 0.0)
    eig_max = np.maximum(eig[..., 2], 1e-12)
    cond = np.sqrt(eig_max / np.maximum(eig_min, 1e-12))
    condition = np.where(work, cond, np.inf)

    pred = rho_est[None] * np.maximum(
        np.einsum("hwc,kc->khw", n_est, directions), 0.0
    )
    wsum = weights.sum(axis=0)
    resid_num = (weights * (g - pred) ** 2).sum(axis=0)
    residual = np.sqrt(resid_num / np.maximum(wsum, 1e-12)) / np.maximum(
        rho_est, 0.1
    )
    residual[~work] = 0.0

    # ---- 3. 逐像素状态判定 ----
    effective = (weights > 0.1) & usable
    n_eff = effective.sum(axis=0)
    sat_count = (enabled[:, None, None] & sat_mask).sum(axis=0)
    bright_any = (images >= min_intensity).any(axis=0)

    normals = np.where(work[..., None], n_est, 0.0)
    albedo = np.where(work, rho_est, 0.0)

    status = np.full((h, w), OK, np.int32)
    # 优先级: 全暗 > 欠定/过曝 > 平行 > 背向 > 拟合差
    status[~bright_any & (status == OK)] = DARK_PIXEL
    # 过曝占比显著 (>=40%) 且因此凑不够有效灯: 归为过曝无解而非一般欠定
    saturated_majority = sat_count >= max(2, int(np.ceil(0.4 * k)))
    status[~work & saturated_majority] = SATURATED_MAJORITY
    status[work & (n_eff < min_lights) & saturated_majority] = SATURATED_MAJORITY
    status[work & (n_eff < min_lights)] = UNDERDETERMINED
    status[~work & (status == OK)] = UNDERDETERMINED
    status[work & singular & (status == OK)] = UNDERDETERMINED
    status[work & (cond > cond_threshold) & (status == OK)] = NEAR_PARALLEL
    status[work & (n_est[..., 2] <= 0.05) & (status == OK)] = NON_FRONT_FACING
    status[work & (residual > fit_threshold) & (status == OK)] = POOR_FIT

    bad = status != OK
    normals[bad] = 0.0
    albedo[bad] = 0.0

    # ---- 4. 置信度: 条件数 + 残差 + 有效灯数 综合 ----
    cond_score = np.clip(1.0 - np.minimum(cond, cond_threshold) / cond_threshold, 0, 1)
    fit_score = np.clip(1.0 - residual / fit_threshold, 0, 1)
    light_score = np.clip(n_eff / max(k, 1), 0, 1)
    confidence = np.clip(0.45 * cond_score + 0.4 * fit_score + 0.15 * light_score, 0, 1)
    confidence[bad] = 0.0

    return PSResult(
        normals=normals,
        albedo=albedo,
        confidence=confidence,
        status=status,
        used=effective,
        fit_residual=np.where(np.isnan(residual), 0.0, residual),
        condition=condition,
        directions=directions,
        strengths=strengths,
        saturation=saturation,
        min_intensity=min_intensity,
    )


def relight(
    result: PSResult, light_dir: np.ndarray, *, mark_invalid: bool = True
) -> np.ndarray:
    """用估计法线/反照率对一个新光源重新打光, 返回 (H, W) 灰度.

    无效点 (status != OK) 置 0, 调用方可叠加醒目标记.
    """
    light_dir = np.asarray(light_dir, np.float64)
    light_dir = light_dir / np.linalg.norm(light_dir)
    cos = np.maximum(np.einsum("hwc,c->hw", result.normals, light_dir), 0.0)
    img = result.albedo * cos
    if mark_invalid:
        img[~result.valid] = 0.0
    return img
