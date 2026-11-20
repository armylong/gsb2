"""双色分色引擎：色域搜索、调墨曲线、限墨重算与误差统计。

管线（每一步都保留中间量，供"同一位置前后读数"）：

    目标图（线性RGB）
      -> 色域最近邻 + 覆盖率空间模式搜索   => a_raw, b_raw（原始分色）
      -> 两版各自调墨曲线                  => a_curve, b_curve
      -> 限墨（TAC 总覆盖率上限，等比缩放）=> a_final, b_final
      -> 正向模型重合成                    => 预测 RGB
      -> CIEDE2000 误差分布与误差热图
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from . import color as C
from .curves import ToneCurve
from .model import InkParams, build_gamut_grid, composite, ink_usage

# 覆盖率搜索的 8 邻域 + 原地
_OFFSETS = np.array(
    [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [-1, 1], [1, -1], [1, 1]],
    dtype=np.float64,
)
_STEPS = (0.25, 0.125, 0.0625, 0.03125, 0.015625, 0.0078125, 0.00390625)
OOG_THRESHOLD = 1.0  # 最近色域样本 ΔE00 超过该值即记为色域外


def _nearest_grid_k(target_lab: np.ndarray, grid_ab: np.ndarray,
                    grid_lab: np.ndarray, k: int = 4,
                    chunk: int = 32768) -> np.ndarray:
    """每个目标取距离最近的 k 个网格点索引（多起点，防折叠脊线局部最优）。

    两级网格策略，避免 N×n² 的全表距离矩阵：
      1) 在 11×11 粗网格（细网格等距子采样）上找全局最近粗格；
      2) 映射回细网格坐标，在其 7×7 邻域内向量化取 k 个最近候选。
    粗网格保证全局定位不跑偏，邻域窗口覆盖折叠脊线的局部歧义。
    """
    side = int(round(np.sqrt(grid_ab.shape[0])))
    coarse_side = 11
    step = (side - 1) / (coarse_side - 1)
    coarse_ij = np.round(np.arange(coarse_side) * step).astype(np.int64)
    coarse_idx = (coarse_ij[:, None] * side + coarse_ij[None, :]).ravel()
    coarse_lab = grid_lab[coarse_idx]

    radius = 3
    offsets = np.array([(dr, dc) for dr in range(-radius, radius + 1)
                        for dc in range(-radius, radius + 1)], dtype=np.int64)
    tgt_n = target_lab.shape[0]
    out = np.empty((tgt_n, k), dtype=np.int64)
    w = offsets.shape[0]
    for s in range(0, tgt_n, chunk):
        tl = target_lab[s:s + chunk]
        m = tl.shape[0]
        dc = ((tl[:, None, :] - coarse_lab[None, :, :]) ** 2).sum(axis=2)
        coarse_nn = dc.argmin(axis=1)
        cr = coarse_ij[coarse_nn // coarse_side]
        cc = coarse_ij[coarse_nn % coarse_side]
        cand_rows = cr[:, None] + offsets[None, :, 0]
        cand_cols = cc[:, None] + offsets[None, :, 1]
        valid = (cand_rows >= 0) & (cand_rows < side) & (cand_cols >= 0) & (cand_cols < side)
        cand_idx = np.where(valid, cand_rows * side + cand_cols,
                            (cr * side + cc)[:, None])
        cand_lab = grid_lab[cand_idx]
        cd = ((tl[:, None, :] - cand_lab) ** 2).sum(axis=2)
        cd = np.where(valid, cd, np.inf)
        order = np.argpartition(cd, kth=min(k - 1, w - 1), axis=1)[:, :k]
        out[s:s + m] = np.take_along_axis(cand_idx, order, axis=1)
    return out


def _pattern_search(target_lab: np.ndarray, ab0: np.ndarray,
                    p: InkParams, chunk: int = 16384) -> np.ndarray:
    """覆盖率空间 8 邻域模式搜索，目标为 Lab 欧氏距离（ΔE76，速度快）。

    ab0 形状 (n, starts, 2)，多起点同时搜索，每轮保留每像素最优起点；
    按像素分块控制峰值内存。
    """
    n, starts, _ = ab0.shape
    final_ab = np.empty((n, 2))
    for s0 in range(0, n, chunk):
        s1 = min(n, s0 + chunk)
        ab = ab0[s0:s1].reshape(-1, 2).copy()
        tlab = np.repeat(target_lab[s0:s1], starts, axis=0)
        best_lab = C.rgb_to_lab(composite(ab[:, 0], ab[:, 1], p))
        best_d = ((tlab - best_lab) ** 2).sum(axis=1)
        for step in _STEPS:
            cand = ab[:, None, :] + step * _OFFSETS[None, :, :]
            cand = np.clip(cand, 0.0, 1.0)
            cand_lab = C.rgb_to_lab(composite(cand[..., 0], cand[..., 1], p))
            d = ((tlab[:, None, :] - cand_lab) ** 2).sum(axis=2)
            pick = d.argmin(axis=1)
            improve = d[np.arange(len(ab)), pick] < best_d
            ab[improve] = cand[improve, pick[improve]]
            best_d[improve] = d[improve, pick[improve]]
        ab = ab.reshape(s1 - s0, starts, 2)
        best_d = best_d.reshape(s1 - s0, starts)
        final_ab[s0:s1] = ab[np.arange(s1 - s0), best_d.argmin(axis=1)]
    return final_ab


def separate_image(target_rgb: np.ndarray, p: InkParams,
                   grid_n: int = 65) -> dict:
    """把目标线性 RGB 图像分色为两版覆盖率。"""
    h, w, _ = target_rgb.shape
    tgt = np.clip(target_rgb, 0.0, 1.0).reshape(-1, 3)
    tgt_lab = C.rgb_to_lab(tgt)

    grid_ab, grid_rgb = build_gamut_grid(p, n=grid_n)
    grid_lab = C.rgb_to_lab(grid_rgb)

    nn_idx = _nearest_grid_k(tgt_lab, grid_ab, grid_lab, k=4)
    # 最近邻距离（第 1 起点）仍用于色域外判定
    nn1 = nn_idx[:, 0]
    nn_de00 = C.deltaE00(tgt_lab, grid_lab[nn1])  # 到色域样本的距离 = 色域外程度
    starts = grid_ab[nn_idx]  # (N, 4, 2)
    ab = _pattern_search(tgt_lab, starts, p)

    pred = composite(ab[:, 0], ab[:, 1], p)
    de = C.deltaE00(tgt_lab, C.rgb_to_lab(pred))
    return {
        "a": ab[:, 0].reshape(h, w),
        "b": ab[:, 1].reshape(h, w),
        "pred_rgb": pred.reshape(h, w, 3),
        "de00": de.reshape(h, w),
        "grid_distance_de00": nn_de00.reshape(h, w),
        "out_of_gamut_mask": (nn_de00 > OOG_THRESHOLD).reshape(h, w),
    }


def apply_ink_limit(a: np.ndarray, b: np.ndarray, tac: float) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """限墨：总覆盖率 a+b 超过 tac 时等比缩放（保持两版比例）。"""
    tac = float(np.clip(tac, 0.0, 2.0))
    total = a + b
    scale = np.where(total > tac, tac / np.maximum(total, 1e-12), 1.0)
    return a * scale, b * scale, scale


def error_stats(de00: np.ndarray, oog_mask: np.ndarray | None = None) -> dict:
    de = np.asarray(de00, dtype=np.float64).ravel()
    qs = np.percentile(de, [50, 75, 95, 99])
    stats = {
        "mean": float(de.mean()),
        "median": float(qs[0]),
        "p75": float(qs[1]),
        "p95": float(qs[2]),
        "p99": float(qs[3]),
        "max": float(de.max()),
        "fraction_de_gt_1": float((de > 1.0).mean()),
        "fraction_de_gt_2": float((de > 2.0).mean()),
        "fraction_de_gt_5": float((de > 5.0).mean()),
    }
    if oog_mask is not None:
        stats["out_of_gamut_fraction"] = float(np.asarray(oog_mask).mean())
    return stats


def heat_colormap(de00: np.ndarray, vmax: float | None = None) -> np.ndarray:
    """误差热图：单色相（蓝）由浅到深的顺序色阶，输出 sRGB 0..1 (H,W,3)。"""
    de = np.asarray(de00, dtype=np.float64)
    if vmax is None:
        vmax = max(float(np.percentile(de, 99)), 1.0)
    t = np.clip(de / vmax, 0.0, 1.0)
    # 浅蓝 #f7fbff -> 深蓝 #08306b（ColorBrewer Blues 风格的连续单色阶）
    light = np.array([0.969, 0.984, 1.0])
    dark = np.array([0.031, 0.188, 0.420])
    rgb = light[None, None, :] * (1.0 - t[..., None]) + dark[None, None, :] * t[..., None]
    return rgb  # 已是 sRGB 风格显示值，直接展示/导出


@dataclass
class PipelineResult:
    target_rgb: np.ndarray
    inks: InkParams
    a_raw: np.ndarray
    b_raw: np.ndarray
    a_curve: np.ndarray
    b_curve: np.ndarray
    a_final: np.ndarray
    b_final: np.ndarray
    limit_scale: np.ndarray
    pred_rgb_raw: np.ndarray
    pred_rgb_final: np.ndarray
    de_raw: np.ndarray
    de_final: np.ndarray
    grid_distance: np.ndarray
    out_of_gamut_mask: np.ndarray
    tac: float
    stats_raw: dict
    stats_final: dict
    ink: dict

    def probe(self, row: int, col: int) -> dict:
        """同一像素在各管线阶段的读数。"""
        r, c = int(row), int(col)
        tgt = self.target_rgb[r, c]
        pred = self.pred_rgb_final[r, c]
        return {
            "position": (r, c),
            "target_hex": C.rgb_to_hex(tgt),
            "predicted_hex": C.rgb_to_hex(pred),
            "plate_a_raw": float(self.a_raw[r, c]),
            "plate_b_raw": float(self.b_raw[r, c]),
            "plate_a_after_curve": float(self.a_curve[r, c]),
            "plate_b_after_curve": float(self.b_curve[r, c]),
            "plate_a_final": float(self.a_final[r, c]),
            "plate_b_final": float(self.b_final[r, c]),
            "limit_scale": float(self.limit_scale[r, c]),
            "de00_raw": float(self.de_raw[r, c]),
            "de00_final": float(self.de_final[r, c]),
        }


def run_pipeline(target_rgb: np.ndarray, inks: InkParams,
                 curve_a: ToneCurve, curve_b: ToneCurve,
                 tac: float = 2.0, grid_n: int = 65,
                 pixel_area: float = 1.0) -> PipelineResult:
    """完整分色管线；改曲线/限墨时可只重跑本函数的后半段（见 rerender）。"""
    sep = separate_image(target_rgb, inks, grid_n=grid_n)
    return rerender(sep, target_rgb, inks, curve_a, curve_b, tac, pixel_area)


def rerender(sep: dict, target_rgb: np.ndarray, inks: InkParams,
             curve_a: ToneCurve, curve_b: ToneCurve,
             tac: float = 2.0, pixel_area: float = 1.0) -> PipelineResult:
    """曲线/限墨调整后的快速重算（不再跑色域搜索）。"""
    a_raw, b_raw = sep["a"], sep["b"]
    a_c = curve_a.apply(a_raw)
    b_c = curve_b.apply(b_raw)
    a_f, b_f, scale = apply_ink_limit(a_c, b_c, tac)

    pred_raw = composite(a_raw, b_raw, inks)
    pred_final = composite(a_f, b_f, inks)
    tgt_lab = C.rgb_to_lab(np.clip(target_rgb, 0.0, 1.0))
    de_raw = C.deltaE00(tgt_lab, C.rgb_to_lab(pred_raw))
    de_final = C.deltaE00(tgt_lab, C.rgb_to_lab(pred_final))

    return PipelineResult(
        target_rgb=np.clip(target_rgb, 0.0, 1.0),
        inks=inks,
        a_raw=a_raw, b_raw=b_raw,
        a_curve=a_c, b_curve=b_c,
        a_final=a_f, b_final=b_f,
        limit_scale=scale,
        pred_rgb_raw=pred_raw,
        pred_rgb_final=pred_final,
        de_raw=de_raw, de_final=de_final,
        grid_distance=sep["grid_distance_de00"],
        out_of_gamut_mask=sep["out_of_gamut_mask"],
        tac=float(tac),
        stats_raw=error_stats(de_raw, sep["out_of_gamut_mask"]),
        stats_final=error_stats(de_final, sep["out_of_gamut_mask"]),
        ink=ink_usage(a_f, b_f, pixel_area),
    )
