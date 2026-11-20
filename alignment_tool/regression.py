"""用已知位移做回归：批量合成 -> 估计 -> 比对真值 -> 汇总误差。"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .estimator import EstimateResult, estimate_shift
from .geometry import residual_stats, warp_align
from .synthetic import make_pair, make_texture


@dataclass
class RegressionRow:
    kind: str
    true_dx: float
    true_dy: float
    est_dx: float
    est_dy: float
    err_dx: float
    err_dy: float
    err_norm: float
    confidence: float
    level: str
    rmse: float
    rmse_corrected: float
    n_valid: int


def run_regression(
    cases: list[dict] | None = None,
    size: tuple[int, int] = (320, 256),
    seed: int = 42,
) -> list[RegressionRow]:
    """对一组已知位移的合成用例跑配准并逐行比对。

    每个 case 支持字段: kind, dx, dy, brightness, noise_sigma, contrast。
    """
    if cases is None:
        cases = default_cases()

    rows: list[RegressionRow] = []
    for i, case in enumerate(cases):
        base = make_texture(size, kind=case["kind"], seed=seed + i)
        pair = make_pair(
            base=base,
            dx=float(case["dx"]),
            dy=float(case["dy"]),
            brightness=float(case.get("brightness", 8.0)),
            contrast=float(case.get("contrast", 1.0)),
            noise_sigma=float(case.get("noise_sigma", 3.0)),
            seed=seed + i,
        )
        est: EstimateResult = estimate_shift(pair.ref, pair.moving)
        aligned = warp_align(pair.moving, est.dx, est.dy)
        stats = residual_stats(pair.ref, aligned, est.dx, est.dy)

        err_dx = est.dx - pair.dx
        err_dy = est.dy - pair.dy
        rows.append(
            RegressionRow(
                kind=case["kind"],
                true_dx=pair.dx,
                true_dy=pair.dy,
                est_dx=est.dx,
                est_dy=est.dy,
                err_dx=err_dx,
                err_dy=err_dy,
                err_norm=float(np.hypot(err_dx, err_dy)),
                confidence=est.confidence,
                level=est.level,
                rmse=stats.rmse,
                rmse_corrected=stats.rmse_corrected,
                n_valid=stats.n_valid,
            )
        )
    return rows


def default_cases() -> list[dict]:
    """覆盖：亚像素、负方向、大位移、低纹理、重复条纹、强噪声。"""
    return [
        {"kind": "blobs",       "dx": 0.7,  "dy": -0.4, "noise_sigma": 3.0},
        {"kind": "dots",        "dx": 2.3,  "dy": 1.6,  "noise_sigma": 4.0},
        {"kind": "blobs",       "dx": -1.8, "dy": 2.9,  "brightness": 15.0},
        {"kind": "dots",        "dx": 5.25, "dy": -3.75,"noise_sigma": 8.0},
        {"kind": "stripes",     "dx": 0.7,  "dy": 0.3,  "noise_sigma": 2.0},
        {"kind": "checker",     "dx": 1.4,  "dy": -1.4, "noise_sigma": 2.0},
        {"kind": "low_texture", "dx": 0.7,  "dy": -0.4, "noise_sigma": 2.0},
        {"kind": "blobs",       "dx": 0.3,  "dy": 0.2,  "brightness": -12.0,
         "contrast": 1.05},
    ]


def summarize(rows: list[RegressionRow]) -> dict:
    """汇总回归指标。"""
    norms = np.array([r.err_norm for r in rows])
    good = [r for r in rows if r.kind not in ("stripes", "checker", "low_texture")]
    good_norms = np.array([r.err_norm for r in good])
    return {
        "n_cases": len(rows),
        "mean_abs_err": float(np.mean(norms)),
        "max_abs_err": float(np.max(norms)),
        # 纹理充分的用例上，亚像素估计误差应显著小于 1 像素
        "mean_abs_err_textured": float(np.mean(good_norms)),
        "max_abs_err_textured": float(np.max(good_norms)),
        "low_conf_cases": [r.kind for r in rows if r.level == "low"],
    }
