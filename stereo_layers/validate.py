"""Local numerical/visual checks without a camera calibration.

Run with the project virtual environment:

    .venv/bin/python -m stereo_layers.validate

It builds deterministic two-layer pairs, measures subpixel disparity error,
checks occlusion-edge leakage, image/range boundary handling and signed
behaviour after reversing the input order.  Optional images/NPZ are written to
``validation_output/``.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import cv2
import numpy as np

from .matching import (
    edge_trim_pixels,
    export_npz,
    match_pair,
    retention_mask,
    segment_disparity_layers,
    to_gray,
)
from .synthetic import make_two_layer_pair
from .visualization import (
    bgr_to_rgb,
    candidate_overlay,
    colorize_disparity,
    layer_map,
    reason_map,
    retention_split,
)


def _error_stats(disparity: np.ndarray, gt: np.ndarray, mask: np.ndarray) -> dict[str, float | int]:
    mask = mask & np.isfinite(disparity) & np.isfinite(gt)
    if not np.any(mask):
        return {"count": 0, "mae": float("nan"), "rmse": float("nan"), "p95": float("nan"), "max": float("nan")}
    err = np.abs(disparity[mask] - gt[mask])
    return {
        "count": int(mask.sum()),
        "mae": float(np.mean(err)),
        "rmse": float(np.sqrt(np.mean(err * err))),
        "p95": float(np.quantile(err, 0.95)),
        "max": float(np.max(err)),
    }


def _save_rgb(path: Path, rgb: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
    ok, buf = cv2.imencode(".png", bgr)
    if ok:
        buf.tofile(path)


def run_validation(output_dir: str | Path | None = "validation_output") -> dict[str, Any]:
    checks: list[dict[str, Any]] = []

    def check(name: str, ok: bool, detail: dict[str, Any]) -> None:
        checks.append({"name": name, "ok": bool(ok), "detail": detail})

    out = Path(output_dir) if output_dir is not None else None
    if out is not None:
        out.mkdir(parents=True, exist_ok=True)

    # ---------------------------------------------------------------- normal
    scene = make_two_layer_pair(width=320, height=220, bg_disp=4, fg_disp=18, seed=7)
    pair = match_pair(
        to_gray(scene.left),
        to_gray(scene.right),
        0,
        scene.fg_disp + 8,
        radius=2,
        lr_threshold=1.2,
    )
    res = pair.left
    pre_trim = retention_mask(res, 0.15, lr_threshold=1.2, edge_trim=0)
    trim = edge_trim_pixels(pre_trim, 2)
    kept = pre_trim & ~trim
    stats = _error_stats(res.disparity, scene.ground_truth_disparity_left, kept)

    fg_med = float(np.median(res.disparity[kept & scene.foreground_mask_left]))
    bg_med = float(np.median(res.disparity[kept & ~scene.foreground_mask_left]))
    check(
        "two_layer_accuracy",
        stats["count"] > 10000 and stats["mae"] < 0.10 and stats["p95"] < 0.25
        and abs(fg_med - scene.fg_disp) < 0.25
        and abs(bg_med - scene.bg_disp) < 0.25,
        {**stats, "foreground_median": fg_med, "background_median": bg_med},
    )

    # ------------------------------------------------------- occlusion edge
    bg_mask = ~scene.foreground_mask_left
    near_fg = np.abs(res.disparity - scene.fg_disp) < 2.0
    far_from_bg = np.abs(res.disparity - scene.bg_disp) > 2.0
    raw_leak = int(np.sum(bg_mask & res.geometry_mask & near_fg & far_from_bg))
    kept_leak = int(np.sum(bg_mask & kept & near_fg & far_from_bg))
    occ_kept = int(np.sum(scene.occluded_background_left & kept))
    check(
        "occlusion_edge_not_assigned_foreground_after_protection",
        kept_leak == 0 and occ_kept == 0,
        {"raw_leak_pixels_before_trim": raw_leak, "retained_leak_pixels": kept_leak,
         "retained_occluded_pixels": occ_kept},
    )

    # ------------------------------------------- low texture / repetition
    check(
        "low_texture_and_repetition_visible",
        int(res.textureless_mask.sum()) > 300 and int(res.repetitive_mask.sum()) > 300,
        {
            "textureless_pixels": int(res.textureless_mask.sum()),
            "repetitive_pixels": int(res.repetitive_mask.sum()),
        },
    )

    # ------------------------------------------------------- zero vs invalid
    zero_scene = make_two_layer_pair(width=256, height=176, bg_disp=0, fg_disp=14, seed=11)
    zero_pair = match_pair(
        to_gray(zero_scene.left), to_gray(zero_scene.right), -2, 20, radius=2, lr_threshold=1.2
    )
    zero_res = zero_pair.left
    zero_kept = retention_mask(zero_res, 0.15, lr_threshold=1.2, edge_trim=2)
    zero_pixels = int(np.sum(zero_kept & (np.abs(zero_res.disparity) < 0.20)))
    invalid_float = int(np.sum(~np.isfinite(zero_res.disparity)))
    check(
        "zero_disparity_is_valid_and_distinct_from_invalid_nan",
        zero_pixels > 1000 and invalid_float > 0,
        {"valid_zero_pixels": zero_pixels, "nan_pixels": invalid_float},
    )

    # -------------------------------------------------------- image touch edge
    edge_reports = {}
    edge_ok = True
    for touch in ("left", "right"):
        edge_scene = make_two_layer_pair(edge_touch=touch, seed=19)
        edge_pair = match_pair(
            to_gray(edge_scene.left),
            to_gray(edge_scene.right),
            0,
            edge_scene.fg_disp + 8,
            radius=2,
            lr_threshold=1.2,
        )
        er = edge_pair.left
        ek = retention_mask(er, 0.15, lr_threshold=1.2, edge_trim=2)
        estats = _error_stats(er.disparity, edge_scene.ground_truth_disparity_left, ek)
        eleak = int(
            np.sum(
                (~edge_scene.foreground_mask_left)
                & ek
                & (np.abs(er.disparity - edge_scene.fg_disp) < 2.0)
                & (np.abs(er.disparity - edge_scene.bg_disp) > 2.0)
            )
        )
        # Exercise boundary/candidate rendering and indexing.
        _ = colorize_disparity(er)
        _ = candidate_overlay(edge_scene.right, 0, edge_scene.left.shape[0] // 2, er)
        _ = candidate_overlay(edge_scene.right, edge_scene.left.shape[1] - 1, 0, er)
        edge_reports[touch] = {
            **estats,
            "border_pixels": int(er.border_mask.sum()),
            "leak_pixels": eleak,
        }
        edge_ok &= estats["mae"] < 0.10 and eleak == 0 and er.border_mask.sum() > 0
    check("touching_image_edges", edge_ok, edge_reports)

    # ------------------------------------------------- search range endpoint
    short_pair = match_pair(to_gray(scene.left), to_gray(scene.right), 0, 10, radius=2, lr_threshold=1.2)
    short = short_pair.left
    endpoint_fg = int(np.sum(short.range_edge_mask & scene.foreground_mask_left))
    short_kept = retention_mask(short, 0.15, lr_threshold=1.2, edge_trim=2, reject_range_edge=True)
    endpoint_fg_kept = int(np.sum(short_kept & short.range_edge_mask & scene.foreground_mask_left))
    check(
        "out_of_range_is_marked_as_search_endpoint",
        endpoint_fg > 1000 and endpoint_fg_kept == 0,
        {"foreground_endpoint_pixels": endpoint_fg, "endpoint_pixels_kept_after_reject": endpoint_fg_kept},
    )

    # --------------------------------------------------------- reversal
    rev_pair = match_pair(
        to_gray(scene.right),
        to_gray(scene.left),
        -(scene.fg_disp + 8),
        0,
        radius=2,
        lr_threshold=1.2,
    )
    rev = rev_pair.left  # first input is the original right image
    rev_kept = retention_mask(rev, 0.15, lr_threshold=1.2, edge_trim=2)
    rev_stats = _error_stats(rev.disparity, scene.ground_truth_disparity_right_signed, rev_kept)
    rev_fg_med = float(np.median(rev.disparity[rev_kept & scene.foreground_mask_right]))
    rev_bg_med = float(np.median(rev.disparity[rev_kept & ~scene.foreground_mask_right]))
    check(
        "reverse_inputs_negates_signed_disparity_with_similar_accuracy",
        rev_stats["mae"] < 0.10
        and abs(rev_fg_med + scene.fg_disp) < 0.25
        and abs(rev_bg_med + scene.bg_disp) < 0.25,
        {**rev_stats, "foreground_median_signed": rev_fg_med, "background_median_signed": rev_bg_med},
    )

    wrong_pair = match_pair(to_gray(scene.right), to_gray(scene.left), 0, 26, radius=2, lr_threshold=1.2)
    wrong_kept = retention_mask(wrong_pair.left, 0.15, lr_threshold=1.2, edge_trim=2)
    wrong_cov = float(wrong_kept.mean())
    check(
        "same_positive_range_after_swap_is_not_confidently_hallucinated",
        wrong_cov < 0.05,
        {"wrong_direction_retained_coverage": wrong_cov},
    )

    report: dict[str, Any] = {
        "all_passed": all(item["ok"] for item in checks),
        "checks": checks,
    }

    if out is not None:
        _save_rgb(out / "01_left_right_pair.png", np.concatenate([bgr_to_rgb(scene.left), bgr_to_rgb(scene.right)], axis=1))
        _save_rgb(out / "02_disparity_color.png", colorize_disparity(res))
        _save_rgb(out / "03_raw_reliable_split.png", retention_split(res, kept))
        _save_rgb(out / "04_reliability_masks.png", reason_map(res, kept, trim))
        layer_labels, layer_centers = segment_disparity_layers(res.disparity, kept, 2)
        _save_rgb(out / "05_two_layers.png", layer_map(layer_labels, layer_centers))
        x, y = 150, 100
        _save_rgb(out / "06_candidate_inspection.png", candidate_overlay(scene.right, x, y, res))
        export_npz(
            out / "disparity_layer_data.npz",
            pair,
            kept,
            depth_coefficient=1000.0,
            source_paths=("<synthetic-left>", "<synthetic-right>"),
            trim_mask=trim,
            settings={"validation": True, "confidence": 0.15, "lr_threshold": 1.2, "edge_trim": 2},
            layer_labels=layer_labels,
            layer_centers=layer_centers,
        )
        (out / "validation_report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")

    return report


def main() -> int:
    report = run_validation()
    for item in report["checks"]:
        mark = "PASS" if item["ok"] else "FAIL"
        print(f"[{mark}] {item['name']}")
        print(f"       {json.dumps(item['detail'], ensure_ascii=False)}")
    print(f"\nOverall: {'PASS' if report['all_passed'] else 'FAIL'}")
    if Path("validation_output").exists():
        print("Artifacts: validation_output/")
    return 0 if report["all_passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
