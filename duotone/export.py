"""导出：两张墨版、合成预览、误差热图、检查条与 JSON 报告。"""

from __future__ import annotations

import json
import os

import numpy as np

from . import color as C
from . import png
from .samples import make_check_strip
from .separation import PipelineResult, heat_colormap


def _linrgb_to_display(rgb: np.ndarray) -> np.ndarray:
    return C.rgb_to_srgb(rgb)


def export_all(out_dir: str, result: PipelineResult, source_name: str = "source") -> dict:
    """导出整套文件，返回写出的路径清单。"""
    os.makedirs(out_dir, exist_ok=True)
    paths: dict[str, str] = {}

    paths["plate_a"] = os.path.join(out_dir, "plate_A_gray.png")
    paths["plate_b"] = os.path.join(out_dir, "plate_B_gray.png")
    png.write_png_gray(paths["plate_a"], result.a_final)
    png.write_png_gray(paths["plate_b"], result.b_final)

    paths["preview"] = os.path.join(out_dir, "composite_preview.png")
    png.write_png_rgb(paths["preview"], _linrgb_to_display(result.pred_rgb_final))

    paths["target"] = os.path.join(out_dir, f"{source_name}_target.png")
    png.write_png_rgb(paths["target"], _linrgb_to_display(result.target_rgb))

    heat = heat_colormap(result.de_final)
    paths["error_map"] = os.path.join(out_dir, "error_de00_map.png")
    png.write_png_rgb(paths["error_map"], heat)

    strip, labels = make_check_strip(
        C.rgb_to_hex(result.inks.solid_a_rgb),
        C.rgb_to_hex(result.inks.solid_b_rgb),
        C.rgb_to_hex(result.inks.paper_rgb),
    )
    paths["check_strip"] = os.path.join(out_dir, "check_strip_paper_inks_overprint.png")
    png.write_png_rgb(paths["check_strip"], _linrgb_to_display(strip))

    report = {
        "source": source_name,
        "inks": result.inks.to_dict(),
        "tac_limit": result.tac,
        "ink_usage": result.ink,
        "error_de00_before_curve_and_limit": result.stats_raw,
        "error_de00_final": result.stats_final,
        "check_strip_order": labels,
        "plate_convention": "grayscale 255 = 100% ink coverage, 0 = paper",
        "files": {k: os.path.basename(v) for k, v in paths.items()},
    }
    paths["report"] = os.path.join(out_dir, "report.json")
    with open(paths["report"], "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    return paths
