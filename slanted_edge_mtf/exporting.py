"""分析结果导出: 一份 JSON(选区/参数/读数/可信度) + 每份选区两个 CSV。"""

from __future__ import annotations

import csv
import json
from pathlib import Path

import numpy as np

from .analysis import AnalysisResult


def result_to_dict(r: AnalysisResult, name: str) -> dict:
    return {
        "name": name,
        "roi_xywh": list(r.roi),
        "inverted": r.inverted,
        "fit_half_width_px": r.fit_half_width,
        "edge": {
            "normal": [r.edge.nx, r.edge.ny],
            "rho": r.edge.rho,
            "angle_to_nearest_axis_deg": r.edge.angle_deg,
            "residual_rms_px": r.edge.residual_rms_px,
            "bins_used": r.edge.bins_used,
            "bins_total": r.edge.bins_total,
            "outlier_fraction": r.edge.outlier_fraction,
        },
        "metrics": {
            "dark_level": r.dark_level,
            "light_level": r.light_level,
            "contrast": abs(r.contrast),
            "noise_est": r.noise_est,
            "mtf50_cycles_per_pixel": r.mtf50,
            "mtf_at_nyquist": r.mtf_nyquist,
            "ringing_pct": r.ringing_pct,
            "overshoot_pct": r.overshoot_pct,
            "samples_used": int(r.sample_used.sum()),
            "samples_total": int(r.sample_used.size),
        },
        "confidence": r.confidence,
        "flags": r.flag_dicts(),
    }


def export_json(path: str | Path, results: list[AnalysisResult | None],
                names: list[str], source: str = "") -> Path:
    payload = {
        "source": source,
        "frequency_unit": "cycles_per_original_pixel",
        "distance_unit": "original_pixel",
        "rois": [
            result_to_dict(r, n) if r is not None else
            {"name": n, "available": False}
            for r, n in zip(results, names)
        ],
    }
    path = Path(path)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2),
                    encoding="utf-8")
    return path


def export_csv(path: str | Path, r: AnalysisResult, name: str) -> list[Path]:
    """每个选区写三个 CSV: 原像素样本 / ESF / MTF。"""
    base = Path(path)
    stem = f"{base.stem}_{name}"
    out: list[Path] = []

    p1 = base.with_name(f"{stem}_samples.csv")
    with p1.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["signed_distance_px", "gray_value", "used_in_fit"])
        for d, v, u in zip(r.sample_dist, r.sample_value, r.sample_used):
            w.writerow([f"{d:.6f}", f"{v:.6f}", int(bool(u))])
    out.append(p1)

    p2 = base.with_name(f"{stem}_esf.csv")
    with p2.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["distance_px", "esf_mean", "esf_std", "sample_count"])
        for row in zip(r.esf_dist, r.esf_mean, r.esf_std, r.esf_count):
            w.writerow([f"{v:.6f}" for v in row])
    out.append(p2)

    p3 = base.with_name(f"{stem}_mtf.csv")
    with p3.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["frequency_cycles_per_pixel", "mtf"])
        for fq, m in zip(r.mtf_freq, r.mtf):
            w.writerow([f"{fq:.6f}", f"{m:.6f}"])
    out.append(p3)
    return out


def export_all(dir_path: str | Path, results: list[AnalysisResult | None],
               names: list[str], source: str = "") -> list[Path]:
    """导出到目录: 一份汇总 JSON + 每个可用选区的 CSV。"""
    d = Path(dir_path)
    d.mkdir(parents=True, exist_ok=True)
    written = [export_json(d / "mtf_report.json", results, names, source)]
    for r, n in zip(results, names):
        if r is not None:
            written += export_csv(d / "curves.csv", r, n)
    return written
