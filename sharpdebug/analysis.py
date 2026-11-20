"""Quantitative checks for the sharpen curve: step-edge response, dense-texture
detail retention, parameter sweeps and report export.

Everything here is head-less (numpy only) so it can be driven from a test or
a CLI as well as from the UI.
"""
from __future__ import annotations

import csv
import json
import os
from dataclasses import dataclass, asdict
from typing import Sequence

import numpy as np

from .core import (
    SharpenParams,
    ScaleSpec,
    compute_sharpen,
    gaussian_blur,
    luma,
    to_display_rgb,
    detail_to_display,
    clipping_stats,
    heatmap_display,
)


# ---------------------------------------------------------------------------
# Step-edge analysis
# ---------------------------------------------------------------------------


@dataclass
class EdgeMetrics:
    label: str
    low: float
    high: float
    observed_min: float
    observed_max: float
    overshoot: float        # how far above the high plateau (absolute 0..1)
    undershoot: float       # how far below the low plateau
    ringing_pct: float      # (overshoot+undershoot)/contrast * 100
    contrast: float         # high - low after sharpening
    edge_width_px: float    # 10-90 % rise distance
    overshoot_px: int
    undershoot_px: int

    def as_row(self) -> dict:
        return {
            "band": self.label,
            "low": round(self.low, 5),
            "high": round(self.high, 5),
            "min": round(self.observed_min, 5),
            "max": round(self.observed_max, 5),
            "overshoot": round(self.overshoot, 5),
            "undershoot": round(self.undershoot, 5),
            "ringing_pct": round(self.ringing_pct, 2),
            "contrast": round(self.contrast, 5),
            "edge_width_px": round(self.edge_width_px, 3),
            "overshoot_px": self.overshoot_px,
            "undershoot_px": self.undershoot_px,
        }


def _band_rows(chart: np.ndarray) -> list[tuple[str, int, int, int]]:
    """Return (label, row_center, y0, y1) for each step band in the chart.

    Must stay in sync with ``core.synth_step_chart``.  Each band is 14 % of
    the image height starting at 6 %, 24 % and 42 %.
    """
    h, w = chart.shape[:2]
    out = []
    for i, lo_hi in enumerate([(0.02, 0.98), (0.24, 0.44), (0.60, 0.90)]):
        y0 = int(h * (0.06 + i * 0.18))
        y1 = y0 + int(h * 0.14)
        out.append((f"{lo_hi[0]:.2f}→{lo_hi[1]:.2f}", (y0 + y1) // 2, y0, y1))
    return out


def step_edge_metrics(
    img: np.ndarray, chart: np.ndarray, edge_frac: float = 0.5
) -> list[EdgeMetrics]:
    """Measure per-band overshoot/undershoot along horizontal profiles.

    The plateau values are medians of the *input* chart (so grain cannot bias
    them); overshoot/undershoot are measured against those plateaus on the
    processed image, in absolute 0..1 units.
    """
    y = luma(img) if img.ndim == 3 else np.asarray(img, dtype=np.float64)
    cy = luma(chart) if chart.ndim == 3 else np.asarray(chart, dtype=np.float64)
    h, w = y.shape
    ex = int(w * edge_frac)
    rows: list[EdgeMetrics] = []
    for label, yc, y0, y1 in _band_rows(chart):
        inset = max(2, (y1 - y0) // 10)
        lo_y = max(y0 + inset, yc - max(1, (y1 - y0) // 4))
        hi_y = min(y1 - inset, yc + max(1, (y1 - y0) // 4))
        prof = y[lo_y:hi_y, :].mean(axis=0)
        ref = cy[lo_y:hi_y, :].mean(axis=0)
        lo_plateau = float(np.median(ref[: max(4, ex // 4)]))
        hi_plateau = float(np.median(ref[min(w - 4, ex + 20) :]))
        # Overshoot / undershoot are measured against the *target* plateau on
        # each side of the edge, not against the global profile extremum:
        #   * overshoot  = max of the bright side beyond the bright plateau
        #     (this is the white fringe)
        #   * undershoot = min of the dark side below the dark plateau
        #     (this is the dark rim)
        # Only a symmetric unsharp mask produces an undershoot on the dark
        # side; a pure white-fringe test would miss it.
        over_side = prof[ex:] if hi_plateau >= lo_plateau else prof[:ex]
        under_side = prof[:ex] if hi_plateau >= lo_plateau else prof[ex:]
        bright = max(lo_plateau, hi_plateau)
        dark = min(lo_plateau, hi_plateau)
        # 4 px guard next to the transition (the synthetic ramp is ~2 px)
        guard = 4
        if hi_plateau >= lo_plateau:
            observed_max = float(prof[ex + guard :].max())
            observed_min = float(prof[: ex - guard].min())
        else:
            observed_max = float(prof[: ex - guard].max())
            observed_min = float(prof[ex + guard :].min())
        overshoot = max(0.0, observed_max - bright)
        undershoot = max(0.0, dark - observed_min)
        contrast = hi_plateau - lo_plateau
        rng = max(abs(contrast), 1e-6)
        # 10-90 rise width of the *processed* profile, measured across the
        # edge.  Same profile/plateau definition as the overshoot above.
        lvl10 = lo_plateau + 0.1 * contrast
        lvl90 = lo_plateau + 0.9 * contrast
        width = float("nan")
        if contrast > 0:
            a = max(0, ex - 16)
            b = min(w, ex + 16)
            seg = prof[a:b]
            above10 = np.nonzero(seg >= lvl10)[0]
            above90 = np.nonzero(seg >= lvl90)[0]
            if above10.size and above90.size:
                width = float(max(0, above90[0] - above10[0]))
        rows.append(
            EdgeMetrics(
                label=label,
                low=lo_plateau,
                high=hi_plateau,
                observed_min=observed_min,
                observed_max=observed_max,
                overshoot=overshoot,
                undershoot=undershoot,
                ringing_pct=100.0 * (overshoot + undershoot) / rng,
                contrast=contrast,
                edge_width_px=width,
                overshoot_px=int(np.sum(over_side > bright + 1e-4)),
                undershoot_px=int(np.sum(under_side < dark - 1e-4)),
            )
        )
    return rows


def edge_profile_curve(
    img: np.ndarray, chart: np.ndarray, band_index: int = 2, half: int = 24
) -> tuple[np.ndarray, np.ndarray]:
    """Return (distance from edge in px, luma profile averaged over the band)."""
    y = luma(img)
    h, w = y.shape
    ex = int(w * 0.5)
    bands = _band_rows(chart)
    _, yc, y0, y1 = bands[band_index]
    lo_y = max(y0 + 2, yc - max(1, (y1 - y0) // 8))
    hi_y = min(y1 - 2, yc + max(1, (y1 - y0) // 8))
    prof = y[lo_y:hi_y, :].mean(axis=0)
    a = max(0, ex - half)
    b = min(w, ex + half)
    dist = np.arange(a, b, dtype=np.float64) - ex
    return dist, prof[a:b]


# ---------------------------------------------------------------------------
# Texture analysis
# ---------------------------------------------------------------------------

TEXTURE_BOX = (0.62, 1.0, 0.62, 1.0)  # y0,y1,x0,x1 fractions of step chart


def _crop(img: np.ndarray, box: tuple[float, float, float, float]) -> np.ndarray:
    h, w = img.shape[:2]
    y0, y1, x0, x1 = box
    return img[int(h * y0) : int(h * y1), int(w * x0) : int(w * x1)]


def texture_metrics(img: np.ndarray, box=TEXTURE_BOX) -> dict:
    """High-frequency RMS and local contrast in a dense-texture region."""
    y = luma(img) if img.ndim == 3 else img
    c = _crop(np.asarray(y, dtype=np.float64), box)
    if c.size == 0:
        return {"hf_rms": 0.0, "local_std": 0.0}
    hf = c - gaussian_blur(c, 1.2)
    return {
        "hf_rms": float(np.sqrt(np.mean(hf * hf))),
        "local_std": float(np.mean([np.std(c[i : i + 8, j : j + 8])
                                    for i in range(0, max(1, c.shape[0] - 8), 8)
                                    for j in range(0, max(1, c.shape[1] - 8), 8)])
                          ) if c.shape[0] > 8 and c.shape[1] > 8 else float(np.std(c)),
    }


# ---------------------------------------------------------------------------
# Parameter sweeps
# ---------------------------------------------------------------------------


def default_sweep_strengths() -> np.ndarray:
    return np.array([0.0, 0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0])


def default_sweep_thresholds() -> np.ndarray:
    return np.array([0.02, 0.05, 0.10, 0.15, 0.25, 0.40, 0.60])


def _measure_image(res) -> np.ndarray:
    """Use the unclipped float result for curve measurements.

    Overshoot above 1.0 is exactly the white-fringe signal we are chasing;
    measuring it on the clipped 8-bit result would cap the number at the
    clipping point and hide it.  Clipping itself is counted separately.
    """
    return res.result_unclipped


def sweep_strength(
    chart: np.ndarray,
    params: SharpenParams,
    strengths: Sequence[float] | None = None,
) -> dict:
    """Overshoot / ringing / texture gain vs strength (threshold fixed)."""
    strengths = list(strengths if strengths is not None else default_sweep_strengths())
    tex = texture_metrics(chart)
    rows = []
    for s in strengths:
        p = SharpenParams(
            strength=float(s),
            edge_threshold=params.edge_threshold,
            edge_softness=params.edge_softness,
            scales=[ScaleSpec(x.sigma, x.weight, x.gate_sigma, x.enabled) for x in params.scales],
            quantize_bits=params.quantize_bits,
            chroma=params.chroma,
        )
        res = compute_sharpen(chart, p)
        m = step_edge_metrics(_measure_image(res), chart)
        t = texture_metrics(_measure_image(res))
        rows.append(
            {
                "strength": float(s),
                "max_overshoot": max(e.overshoot for e in m),
                "max_undershoot": max(e.undershoot for e in m),
                "mean_ringing_pct": float(np.mean([e.ringing_pct for e in m])),
                "edge_width_px": float(np.mean([e.edge_width_px for e in m])),
                "texture_hf_rms": t["hf_rms"],
                "texture_gain": t["hf_rms"] / max(tex["hf_rms"], 1e-9),
                "clipped_px": int(np.sum((res.result >= 1.0).any(axis=-1) | (res.result <= 0.0).any(axis=-1))),
            }
        )
    return {"rows": rows, "baseline_texture": tex["hf_rms"], "measured_on": "unclipped_float"}


def sweep_threshold(
    chart: np.ndarray,
    params: SharpenParams,
    thresholds: Sequence[float] | None = None,
) -> dict:
    """Overshoot on the step edge and texture retention vs edge threshold."""
    thresholds = list(
        thresholds if thresholds is not None else default_sweep_thresholds()
    )
    tex = texture_metrics(chart)
    rows = []
    for t in thresholds:
        p = SharpenParams(
            strength=params.strength,
            edge_threshold=float(t),
            edge_softness=params.edge_softness,
            scales=[ScaleSpec(x.sigma, x.weight, x.gate_sigma, x.enabled) for x in params.scales],
            quantize_bits=params.quantize_bits,
            chroma=params.chroma,
        )
        res = compute_sharpen(chart, p)
        m = step_edge_metrics(_measure_image(res), chart)
        tt = texture_metrics(_measure_image(res))
        rows.append(
            {
                "threshold": float(t),
                "max_overshoot": max(e.overshoot for e in m),
                "max_undershoot": max(e.undershoot for e in m),
                "mean_ringing_pct": float(np.mean([e.ringing_pct for e in m])),
                "texture_hf_rms": tt["hf_rms"],
                "texture_gain": tt["hf_rms"] / max(tex["hf_rms"], 1e-9),
            }
        )
    return {"rows": rows, "baseline_texture": tex["hf_rms"], "measured_on": "unclipped_float"}


def per_scale_contribution(
    base: np.ndarray, params: SharpenParams
) -> list[dict]:
    """Measure each detail layer's energy, plus the gated fraction on edges."""
    res = compute_sharpen(base, params)
    return per_scale_contribution_from_result(res, params.scales)


def per_scale_contribution_from_result(
    res, scales: Sequence[ScaleSpec]
) -> list[dict]:
    """Same as :func:`per_scale_contribution` but reuses an existing result.

    The UI recomputes on every slider move, so running the pipeline a second
    time just to fill the contribution labels would double the latency.
    """
    out = []
    for spec, det, raw, gate in zip(scales, res.details, res.raw_details, res.gates):
        raw_rms = float(np.sqrt(np.mean(raw * raw)))
        det_rms = float(np.sqrt(np.mean(det * det)))
        out.append(
            {
                "sigma": spec.sigma,
                "weight": spec.weight,
                "enabled": spec.enabled,
                "raw_rms": raw_rms,
                "gated_rms": det_rms,
                "kept_ratio": det_rms / max(raw_rms, 1e-9),
                "gate_mean": float(gate.mean()),
            }
        )
    return out


# ---------------------------------------------------------------------------
# Export
# ---------------------------------------------------------------------------


def write_png(path: str, rgb_float: np.ndarray) -> None:
    """Write a float RGB image to PNG without any autoscaling.

    Uses Qt if available (already a dependency of the app); keeps the display
    transform identical to what is shown in the canvas.
    """
    from PySide6.QtGui import QImage

    a = np.ascontiguousarray(to_display_rgb(rgb_float))
    h, w = a.shape[:2]
    qimg = QImage(a.data, w, h, 3 * w, QImage.Format_RGB888).copy()
    if not qimg.save(path):
        raise OSError(f"无法写入 {path}")


def export_bundle(
    out_dir: str,
    original: np.ndarray,
    result: np.ndarray,
    params: SharpenParams,
    profile: tuple[np.ndarray, np.ndarray, np.ndarray] | None = None,
    chart: np.ndarray | None = None,
    chart_result: np.ndarray | None = None,
) -> dict:
    """Write an export bundle: PNGs + metrics CSV/JSON.

    Returns the manifest dict that was written to ``manifest.json``.
    """
    os.makedirs(out_dir, exist_ok=True)
    paths = {}
    paths["original.png"] = os.path.join(out_dir, "original.png")
    write_png(paths["original.png"], original)
    paths["result.png"] = os.path.join(out_dir, "result.png")
    write_png(paths["result.png"], result)

    res_full = compute_sharpen(original, params)
    for i, det in enumerate(res_full.details):
        name = f"detail_sigma_{params.scales[i].sigma:g}.png"
        d = detail_to_display(det, 4.0)
        paths[name] = os.path.join(out_dir, name)
        write_png(paths[name], d)
    # fixed-colour clipping / hue overlays so numbers survive outside the UI
    st = clipping_stats(res_full, None)
    paths["overlay_clipping.png"] = os.path.join(out_dir, "overlay_clipping.png")
    write_png(paths["overlay_clipping.png"], heatmap_display(st["clipped_mask"]))
    paths["overlay_hue_shift.png"] = os.path.join(out_dir, "overlay_hue_shift.png")
    write_png(paths["overlay_hue_shift.png"], heatmap_display(st["hue_shift_mask"]))

    manifest: dict = {
        "params": {
            "strength": params.strength,
            "edge_threshold": params.edge_threshold,
            "edge_softness": params.edge_softness,
            "quantize_bits": params.quantize_bits,
            "chroma": params.chroma,
            "scales": [asdict(s) for s in params.scales],
        },
        "clipping": {
            k: st[k]
            for k in (
                "pixels",
                "clipped_high",
                "clipped_low",
                "clipped_any",
                "clipped_ratio",
                "hue_shift_px",
                "hue_shift_ratio",
                "hue_shift_deg_max",
                "hue_shift_deg_mean",
                "desat_px",
                "max_overshoot",
                "max_undershoot",
            )
        },
        "scales": per_scale_contribution(original, params),
        "files": {k: os.path.basename(v) for k, v in paths.items()},    }

    if profile is not None:
        dist, base_l, res_rgb = profile
        wl = res_rgb @ np.array([0.2126, 0.7152, 0.0722])
        prof_path = os.path.join(out_dir, "profile.csv")
        with open(prof_path, "w", newline="", encoding="utf-8") as fh:
            wr = csv.writer(fh)
            wr.writerow(["distance_px", "original_luma", "result_R", "result_G", "result_B", "result_luma"])
            for i in range(len(dist)):
                wr.writerow(
                    [
                        f"{dist[i]:.3f}",
                        f"{base_l[i]:.6f}",
                        *[f"{v:.6f}" for v in res_rgb[i]],
                        f"{wl[i]:.6f}",
                    ]
                )
        manifest["profile_csv"] = os.path.basename(prof_path)
        manifest["profile_overshoot"] = float(max(0.0, wl.max() - 1.0))
        manifest["profile_undershoot"] = float(max(0.0, -wl.min()))

    if chart is not None:
        if chart_result is None:
            full = compute_sharpen(chart, params)
            chart_res_clipped = full.result
            chart_res_measure = full.result_unclipped
        else:
            chart_res_clipped = chart_result
            # the caller may pass the clipped canvas image; re-run to measure
            # on unclipped floats so overshoot above 1.0 is not capped
            chart_res_measure = compute_sharpen(chart, params).result_unclipped
        paths["chart_result.png"] = os.path.join(out_dir, "chart_result.png")
        write_png(paths["chart_result.png"], chart_res_clipped)
        metrics = [e.as_row() for e in step_edge_metrics(chart_res_measure, chart)]
        manifest["step_edges"] = metrics
        with open(os.path.join(out_dir, "step_edges.csv"), "w", newline="", encoding="utf-8") as fh:
            wr = csv.DictWriter(fh, fieldnames=list(metrics[0].keys()))
            wr.writeheader()
            wr.writerows(metrics)
        manifest["texture"] = texture_metrics(chart_res_measure)
        manifest["files"]["step_edges.csv"] = "step_edges.csv"
        manifest["files"]["chart_result.png"] = "chart_result.png"

    with open(os.path.join(out_dir, "manifest.json"), "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, ensure_ascii=False, indent=2)
    return manifest
