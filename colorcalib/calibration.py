"""颜色修正模型：在线性光空间用最小二乘拟合 3x3 矩阵。

提供两个版本：
- full：完整 3x3 矩阵，9 个自由度，可纠正通道串扰、灯光偏色与饱和度变化；
- white_balance：对角矩阵（每通道独立增益），只调白平衡，作为对照基线。

拟合在线性 sRGB 空间进行：measured_linear @ M.T ≈ target_linear。
矩阵求逆类操作通过 SVD 完成，并报告条件数：条件数过大意味着
参考色在空间中太接近共线（例如全是灰色块），修正不可信。
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from . import srgb

# 条件数超过该值给出警告（修正对输入噪声高度敏感）
COND_WARN = 30.0
# 条件数超过该值判定为无法可靠计算
COND_FAIL = 200.0
# 参与拟合的有效色格最少数量（full 矩阵理论下限 3，留余量）
MIN_FIT_PATCHES = 3
# ΔE 超过该值视为“很大的改动/残差偏大”
LARGE_DELTA_E = 8.0


class CalibrationError(RuntimeError):
    """无法计算可靠修正（色格不足、矩阵奇异等）。"""


@dataclass
class ColorModel:
    """拟合得到的颜色修正模型。"""

    kind: str  # "full" | "white_balance"
    matrix: np.ndarray  # 3x3，作用于线性光像素（右侧乘）
    used_ids: list[str]
    condition_number: float
    fit_residual_mean: float  # 参与拟合色格的平均 ΔE76
    fit_residual_max: float

    def apply_srgb(self, image: np.ndarray) -> np.ndarray:
        """作用到整张 sRGB 图，返回可能越界的浮点 sRGB 图。"""
        return srgb.apply_linear_matrix(image, self.matrix)


def _least_squares_matrix(measured_lin: np.ndarray, target_lin: np.ndarray) -> tuple[np.ndarray, float]:
    """解 M 使 measured @ M.T ≈ target。返回 M 与设计矩阵条件数。"""
    # measured: Nx3，按行最小二乘: M.T = measured^+ @ target
    try:
        mt, residuals, rank, _ = np.linalg.lstsq(measured_lin, target_lin, rcond=None)
    except np.linalg.LinAlgError as exc:
        raise CalibrationError(f"最小二乘求解失败: {exc}") from exc
    if rank < 3:
        raise CalibrationError(
            f"设计矩阵秩为 {rank}（需要 3）：参考色在颜色空间中过于接近一条线，"
            "请增加色相差异更大的取样格"
        )
    matrix = mt.T
    # 条件数：衡量修正对测量噪声的敏感程度
    cond = float(np.linalg.cond(measured_lin))
    if not np.isfinite(cond) or cond > COND_FAIL:
        raise CalibrationError(
            f"设计矩阵条件数 {cond:.1f} 超过 {COND_FAIL:.0f}：颜色分布太集中，"
            "修正会被噪声放大，结果不可信。请加入更暗/更亮或色相不同的色格"
        )
    return matrix, cond


def fit_model(
    measured_srgb: np.ndarray,
    target_srgb: np.ndarray,
    used_ids: list[str],
    kind: str = "full",
) -> ColorModel:
    """根据取样色格拟合修正模型。

    measured_srgb / target_srgb: Nx3 的 sRGB 0-255 数组，行与 used_ids 对应。
    kind: "full" 完整矩阵；"white_balance" 仅对角增益。
    """
    measured_srgb = np.asarray(measured_srgb, dtype=np.float64)
    target_srgb = np.asarray(target_srgb, dtype=np.float64)
    if measured_srgb.ndim != 2 or measured_srgb.shape[1] != 3:
        raise CalibrationError("取样颜色数组形状应为 Nx3")
    n = measured_srgb.shape[0]
    if n < MIN_FIT_PATCHES:
        raise CalibrationError(
            f"只有 {n} 个有效取样格参与计算，至少需要 {MIN_FIT_PATCHES} 个"
        )
    if target_srgb.shape != measured_srgb.shape:
        raise CalibrationError("取样色与目标色数量不一致")

    measured_lin = srgb.srgb_to_linear(measured_srgb)
    target_lin = srgb.srgb_to_linear(target_srgb)

    if kind == "white_balance":
        # 对角矩阵：每通道一个增益，按最小二乘标量求解
        gains = np.zeros(3)
        for c in range(3):
            denom = float(measured_lin[:, c] @ measured_lin[:, c])
            if denom < 1e-12:
                raise CalibrationError(
                    f"通道 {'RGB'[c]} 的取样值几乎全为 0，无法估计白平衡增益"
                )
            gains[c] = float(measured_lin[:, c] @ target_lin[:, c]) / denom
        matrix = np.diag(gains)
        # 对角模型的条件数用各通道能量之比近似
        energy = np.array([
            float(measured_lin[:, c] @ measured_lin[:, c]) for c in range(3)
        ])
        cond = float(np.sqrt(energy.max() / max(energy.min(), 1e-12)))
    elif kind == "full":
        matrix, cond = _least_squares_matrix(measured_lin, target_lin)
    else:
        raise CalibrationError(f"未知模型类型: {kind!r}")

    corrected_lin = measured_lin @ matrix.T
    corrected_srgb = srgb.linear_to_srgb(corrected_lin)
    delta = srgb.delta_e(
        srgb.srgb_array_to_lab(corrected_srgb),
        srgb.srgb_array_to_lab(target_srgb),
    )
    return ColorModel(
        kind=kind,
        matrix=matrix,
        used_ids=list(used_ids),
        condition_number=cond,
        fit_residual_mean=float(np.mean(delta)),
        fit_residual_max=float(np.max(delta)),
    )


@dataclass
class PatchResidual:
    """单个色格的修正前后残差（ΔE76，越小越接近目标色）。"""

    patch_id: str
    role: str  # fit | check
    enabled: bool
    usable: bool
    measured_rgb: np.ndarray
    target_rgb: np.ndarray
    corrected_rgb: np.ndarray
    delta_before: float
    delta_after: float
    changed: float  # 修正前后自身的 ΔE，衡量该颜色被改动的幅度
    overexposed: bool
    border_risk: bool
    excluded_reason: str  # 未参与计算的原因（空字符串表示参与了计算）


def compute_residuals(
    samples: dict,
    references: dict,
    rois: list,
    model: ColorModel | None,
) -> list[PatchResidual]:
    """计算每个色格修正前后相对目标色的 ΔE。

    samples: sampling.sample_all 的结果；references: patch_id -> ReferencePatch；
    model 为 None 时（算不出修正）只给修正前残差。
    """
    used = set(model.used_ids) if model is not None else set()
    results: list[PatchResidual] = []

    for roi in rois:
        pid = roi.patch_id
        if pid not in references or pid not in samples:
            continue
        s = samples[pid]
        ref = references[pid]
        target = np.asarray(ref.rgb, dtype=np.float64)
        measured = s.median_rgb.copy()

        if model is not None:
            corrected = model.apply_srgb(measured.reshape(1, 1, 3)).reshape(3)
        else:
            corrected = measured.copy()

        lab_target = np.asarray(ref.lab)
        delta_before = float(srgb.delta_e(
            srgb.srgb_array_to_lab(measured.reshape(1, 3)), lab_target.reshape(1, 3)
        )[0])
        delta_after = float(srgb.delta_e(
            srgb.srgb_array_to_lab(corrected.reshape(1, 3)), lab_target.reshape(1, 3)
        )[0])
        changed = float(srgb.delta_e(
            srgb.srgb_array_to_lab(corrected.reshape(1, 3)),
            srgb.srgb_array_to_lab(measured.reshape(1, 3)),
        )[0])

        reason = ""
        if not s.usable:
            reason = s.note or "取样区域无效"
        elif not roi.enabled:
            reason = "已手动停用"
        elif pid not in used:
            reason = "留作检查（未参与对色）" if roi.role == "check" else "未参与拟合"

        results.append(
            PatchResidual(
                patch_id=pid,
                role=roi.role,
                enabled=roi.enabled,
                usable=s.usable,
                measured_rgb=measured,
                target_rgb=target,
                corrected_rgb=corrected,
                delta_before=delta_before,
                delta_after=delta_after,
                changed=changed,
                overexposed=s.overexposed,
                border_risk=s.border_risk,
                excluded_reason=reason,
            )
        )
    return results
