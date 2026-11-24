"""Export helpers: difference image PNG and per-region / per-direction CSV."""
from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image

from .colormap import composite_rgba
from .core import Difference


def _fmt(v: float) -> str:
    if v is None or not np.isfinite(v):
        return ""
    return f"{v:.6g}"


def export_difference_png(diff: Difference, path: str | Path) -> Path:
    """Write the four-way classification (A only / overlap / B only) as RGBA."""
    path = Path(path)
    rgba = composite_rgba(diff.shape, diff.only_a, diff.overlap, diff.only_b)
    Image.fromarray(rgba, mode="RGBA").save(path)
    return path


def summary_rows(diff: Difference) -> list[list[str]]:
    a = diff.stats("a_to_b")
    b = diff.stats("b_to_a")
    ar = diff.area_stats()
    unit_u = diff.calib.unit
    area_u = diff.calib.area_unit
    rows: list[list[str]] = [
        ["项目", "A→B", "B→A"],
        ["边界采样点数", *[a.as_row()[0], b.as_row()[0]]],
        [f"平均距离({unit_u})", a.as_row()[1], b.as_row()[1]],
        [f"中位距离({unit_u})", a.as_row()[2], b.as_row()[2]],
        [f"P95 距离({unit_u})", a.as_row()[3], b.as_row()[3]],
        [f"最大距离({unit_u})", a.as_row()[4], b.as_row()[4]],
        [f"超差比例(>{diff.calib.tolerance:g} {unit_u})", a.as_row()[5], b.as_row()[5]],
        [],
        ["面积项目", "数值", ""],
        [f"A 面积({area_u})", _fmt(ar.a_area), ""],
        [f"B 面积({area_u})", _fmt(ar.b_area), ""],
        [f"重叠面积({area_u})", _fmt(ar.overlap_area), ""],
        [f"仅 A 面积({area_u})", _fmt(ar.only_a_area), ""],
        [f"仅 B 面积({area_u})", _fmt(ar.only_b_area), ""],
        ["IoU", f"{ar.jaccard:.4f}", ""],
        ["面积差 |A-B|/max", f"{ar.area_diff_ratio:.4f}", ""],
        [],
        ["比例尺", f"行 {diff.calib.row_size:g} {unit_u}/px", f"列 {diff.calib.col_size:g} {unit_u}/px"],
        ["允许误差", f"{diff.calib.tolerance:g} {unit_u}", ""],
    ]
    if diff.roi_active:
        rows.append([
            "统计区(行0,行1,列0,列1)",
            ",".join(str(v) for v in diff.roi.to_tuple()),
            "",
        ])
    else:
        rows.append(["统计区", "整图", ""])
    return rows


def export_region_csv(diff: Difference, path: str | Path) -> Path:
    """Write per-region statistics, using the same unit as the on-screen table."""
    path = Path(path)
    with path.open("w", newline="", encoding="utf-8-sig") as fh:
        import csv

        writer = csv.writer(fh)
        writer.writerow(
            [
                "类型",
                "来源掩膜",
                "区域编号",
                "像素数",
                f"面积({diff.calib.area_unit})",
                f"最大边界距离({diff.calib.unit})",
                f"平均边界距离({diff.calib.unit})",
                "质心行",
                "质心列",
                "包围盒(行0,行1,列0,列1)",
                "是否孔",
            ]
        )
        for r in diff.regions:
            writer.writerow(
                [
                    r.kind,
                    r.source,
                    r.label,
                    r.area_px,
                    _fmt(r.area),
                    _fmt(r.max_distance),
                    _fmt(r.mean_distance),
                    _fmt(r.centroid[0]),
                    _fmt(r.centroid[1]),
                    ",".join(str(v) for v in r.bbox),
                    "是" if r.in_hole else "否",
                ]
            )
    return path


def export_summary_csv(diff: Difference, path: str | Path) -> Path:
    path = Path(path)
    with path.open("w", newline="", encoding="utf-8-sig") as fh:
        import csv

        csv.writer(fh).writerows(summary_rows(diff))
    return path


def export_hole_csv(diff: Difference, path: str | Path) -> Path:
    """Write the hole inventory -- never filtered by size."""
    path = Path(path)
    with path.open("w", newline="", encoding="utf-8-sig") as fh:
        import csv

        writer = csv.writer(fh)
        writer.writerow(
            [
                "掩膜",
                "编号",
                "像素数",
                f"面积({diff.calib.area_unit})",
                f"内切半径({diff.calib.unit})",
                "质心行",
                "质心列",
                "仅此掩膜有",
                "是否小孔(<=4px)",
            ]
        )
        for h in diff.holes:
            writer.writerow(
                [
                    h.mask_name,
                    h.index,
                    h.area_px,
                    _fmt(h.area),
                    _fmt(h.radius),
                    _fmt(h.centroid[0]),
                    _fmt(h.centroid[1]),
                    "是" if h.only_here else "否",
                    "是" if h.is_tiny else "否",
                ]
            )
    return path
