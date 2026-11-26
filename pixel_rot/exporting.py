"""批量导出一组角度的 PNG 与每张的中心点, 以及重开对照所需的 manifest。

导出目录结构::

    <out_dir>/
      manifest.json
      original.png
      roi_<name>.json ...
      angle_000_<method>.png
      angle_045_<method>.png
      ...

manifest 记录每张图的中心(输出格网连续坐标)、画布原点、原画框四角、
角度、方法、画布模式与统计摘要, 重开后即可对照透明区与边界。
"""

from __future__ import annotations

import json
from dataclasses import asdict
from pathlib import Path

import numpy as np
from PIL import Image

from .core import (
    EXPAND,
    TRANSPARENT,
    METHODS,
    PaletteImage,
    RotationResult,
    load_png,
    rotate,
    save_png,
    to_rgba_array,
)

MANIFEST_NAME = "manifest.json"
ORIGINAL_NAME = "original.png"


def _poly_to_list(poly: np.ndarray) -> list[list[float]]:
    return [[float(x), float(y)] for x, y in np.asarray(poly)]


def export_batch(
    img: PaletteImage,
    out_dir: str | Path,
    angles: list[float],
    methods: list[str] | None = None,
    center: tuple[float, float] = (9.0, 9.0),
    canvas_mode: str = EXPAND,
    fixed_size: tuple[int, int] | None = None,
    rois: list[tuple[str, np.ndarray]] | None = None,
    supersample: int = 4,
    coverage_threshold: float = 0.5,
) -> dict:
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    methods = methods or list(METHODS)
    rois = rois or []
    save_png(out_dir / ORIGINAL_NAME, img)

    # ROI 单独存一份, 重开时仍可叠加关注区
    rois_payload = [
        {"name": name, "polygon": _poly_to_list(poly)} for name, poly in rois
    ]
    (out_dir / "rois.json").write_text(
        json.dumps(rois_payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    entries = []
    for angle in angles:
        for method in methods:
            res = rotate(
                method, img, center, angle, canvas_mode, fixed_size, rois,
                supersample=supersample,
                coverage_threshold=coverage_threshold,
            )
            fname = f"angle_{int(round(angle)):03d}_{method}.png"
            save_png(out_dir / fname, res.image)
            entries.append(_entry(fname, res, angle))

    manifest = {
        "version": 1,
        "source": ORIGINAL_NAME,
        "source_size": list(img.size),
        "center": list(center),
        "canvas_mode": canvas_mode,
        "fixed_size": list(fixed_size) if fixed_size else None,
        "angles": [float(a) for a in angles],
        "methods": methods,
        "rois": rois_payload,
        "ssaa": {"supersample": supersample, "coverage_threshold": coverage_threshold},
        "entries": entries,
    }
    (out_dir / MANIFEST_NAME).write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return manifest


def _entry(fname: str, res: RotationResult, angle: float) -> dict:
    st = res.stats
    return {
        "file": fname,
        "angle": float(angle),
        "method": res.method,
        "canvas_mode": res.canvas_mode,
        "size": [res.image.width, res.image.height],
        "origin": [float(res.origin[0]), float(res.origin[1])],
        "center_out": [float(res.center_out[0]), float(res.center_out[1])],
        "frame_quad": _poly_to_list(res.frame_quad),
        "outside_pixels": res.outside_pixels,
        "collisions": res.collisions,
        "stats": {
            "pixel_count": st.pixel_count,
            "components": st.components,
            "component_sizes": st.component_sizes,
            "holes": [asdict(h) for h in st.holes],
            "border_contacts": st.border_contacts,
            "colors_used": st.colors_used,
            "color_counts": {str(k): v for k, v in st.color_counts.items()},
            "bbox": list(st.bbox) if st.bbox else None,
        },
        "rois": [
            {
                "name": r.name,
                "pixels": r.pixels,
                "components": r.components,
                "holes": r.holes,
                "hole_sizes": r.hole_sizes,
                "colors_used": r.colors_used,
                "changed": r.changed,
                "note": r.note,
                "polygon": r.polygon,
            }
            for r in res.roi_results
        ],
        "params": res.params,
    }


def load_manifest(out_dir: str | Path) -> dict:
    out_dir = Path(out_dir)
    manifest = json.loads((out_dir / MANIFEST_NAME).read_text(encoding="utf-8"))
    original = load_png(out_dir / manifest["source"])
    return {"dir": out_dir, "manifest": manifest, "original": original}


def load_entry(bundle: dict, entry: dict) -> PaletteImage:
    return load_png(bundle["dir"] / entry["file"])


def compare_transparent_and_border(
    original: PaletteImage, exported: PaletteImage, entry: dict
) -> dict:
    """重开对照: 透明区轮廓、边界接触与中心落点核对。

    尺寸不同(扩画布)时按 bbox 与 frame_quad 做说明, 不强行逐格比。
    """
    rgba_o = to_rgba_array(original)
    rgba_e = to_rgba_array(exported)
    out = {
        "same_size": original.size == exported.size,
        "original_size": list(original.size),
        "exported_size": list(exported.size),
        "exported_transparent": int((exported.indices == TRANSPARENT).sum()),
        "exported_opaque": int((exported.indices != TRANSPARENT).sum()),
        "border_contacts": entry["stats"]["border_contacts"],
        "center_out": entry["center_out"],
        "center_on_pixel_center": _on_pixel_center(entry["center_out"]),
        "center_on_grid_corner": _on_grid_corner(entry["center_out"]),
    }
    if out["same_size"]:
        diff_mask = (rgba_o != rgba_e).any(axis=2)
        out["pixel_diffs_vs_original"] = int(diff_mask.sum())
    return out


def _on_pixel_center(pt: list[float]) -> bool:
    return abs(pt[0] - round(pt[0] - 0.5) - 0.5) < 1e-9 and abs(
        pt[1] - round(pt[1] - 0.5) - 0.5
    ) < 1e-9


def _on_grid_corner(pt: list[float]) -> bool:
    return abs(pt[0] - round(pt[0])) < 1e-9 and abs(pt[1] - round(pt[1])) < 1e-9


def transparent_mask_png(img: PaletteImage) -> Image.Image:
    """把透明区画成红斜纹底色、不透明像素原样, 供肉眼对照边界。"""
    h, w = img.indices.shape
    rgba = to_rgba_array(img)
    base = np.zeros((h, w, 4), dtype=np.uint8)
    base[:, :, :3] = 255
    base[:, :, 3] = 255
    r = np.arange(h)[:, None]
    c = np.arange(w)[None, :]
    stripe = ((r + c) % 2 == 0)
    base[stripe] = (255, 210, 210, 255)
    opaque = img.indices != TRANSPARENT
    base[opaque] = rgba[opaque]
    return Image.fromarray(base, "RGBA")
