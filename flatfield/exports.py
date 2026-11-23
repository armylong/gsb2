"""Export helpers: 16-bit data, masks, reference set, session report.

Every export writes sample values, never preview-mapped values.  Display
range, zoom and overlays live only in the UI layer.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

import numpy as np

from .core import CorrectionResult, ReferenceModel
from .io import Meta, write_ascii_pgm, write_mask_png, write_png

DATASET_VERSION = 1


@dataclass
class ExportPaths:
    written: list[Path]
    skipped: list[tuple[str, str]]


def _unique(base: Path, suffix: str) -> Path:
    candidate = base.with_name(base.name + suffix)
    counter = 2
    while candidate.exists():
        candidate = base.with_name(f"{base.name}_v{counter}{suffix}")
        counter += 1
    return candidate


def export_corrected(
    outdir: str | Path,
    correction: CorrectionResult,
    model: ReferenceModel,
    sample_name: str,
    meta: Meta | None = None,
    prefix: str = "corrected",
    stem: str | None = None,
    include_pgm: bool = False,
) -> ExportPaths:
    out = Path(outdir)
    out.mkdir(parents=True, exist_ok=True)
    stem = stem or Path(sample_name).stem
    written: list[Path] = []
    corrected_path = _unique(out / f"{prefix}_{stem}", ".png")
    write_png(corrected_path, correction.corrected_u16, meta)
    written.append(corrected_path)
    mask_path = _unique(out / f"{prefix}_{stem}_validmask", ".png")
    write_mask_png(mask_path, correction.valid_mask)
    written.append(mask_path)
    if include_pgm:
        pgm_path = _unique(out / f"{prefix}_{stem}", ".pgm")
        write_ascii_pgm(pgm_path, correction.corrected_u16)
        written.append(pgm_path)
    return ExportPaths(written=written, skipped=[])


def export_masks(
    outdir: str | Path,
    model: ReferenceModel,
    prefix: str = "mask",
    stem: str = "",
) -> ExportPaths:
    out = Path(outdir)
    out.mkdir(parents=True, exist_ok=True)
    suffix = f"_{stem}" if stem else ""
    written = []
    entries = {
        f"{prefix}_valid{suffix}.png": model.valid_mask,
        f"{prefix}_low{suffix}.png": model.defects.low,
        f"{prefix}_saturated{suffix}.png": model.defects.saturated,
        f"{prefix}_unstable{suffix}.png": model.defects.unstable,
        f"{prefix}_patched{suffix}.png": model.patched_mask,
    }
    for name, mask in entries.items():
        path = _unique(out / name[:-4], ".png")
        write_mask_png(path, mask)
        written.append(path)
    return ExportPaths(written=written, skipped=[])


def export_references(
    outdir: str | Path,
    model: ReferenceModel,
    sample: np.ndarray,
    meta: Meta | None = None,
    prefix: str = "ref",
    include_pgm: bool = False,
) -> ExportPaths:
    out = Path(outdir)
    out.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []
    skipped: list[tuple[str, str]] = []
    meta = meta or Meta()

    def save(name: str, arr: np.ndarray) -> None:
        path = _unique(out / f"{prefix}_{name}", ".png")
        write_png(path, arr, meta)
        written.append(path)

    save("dark_mean", np.clip(np.rint(model.dark_mean), 0, 65535).astype(np.uint16))
    save("dark_std", np.clip(np.rint(model.dark_std * 16), 0, 65535).astype(np.uint16))
    save("light_mean", np.clip(np.rint(model.light_mean), 0, 65535).astype(np.uint16))
    save("light_std", np.clip(np.rint(model.light_std * 16), 0, 65535).astype(np.uint16))
    save("flat_norm", np.clip(np.rint(model.flat_norm * 16384), 0, 65535).astype(np.uint16))
    save("flat_raw", np.clip(np.rint(model.flat_norm_raw * 16384), 0, 65535).astype(np.uint16))
    save("sample", sample)
    scaling = {
        "dark_mean": "1 ADU per count, offset 0",
        "dark_std": "value/16 ADU (16x scaled for visibility)",
        "light_mean": "1 ADU per count, offset 0",
        "light_std": "value/16 ADU (16x scaled for visibility)",
        "flat_norm": "value/16384 = normalized flat (1.0 = median response)",
        "flat_raw": "value/16384 = normalized flat before patching",
        "sample": "1 ADU per count, original sample",
        "mask": "0 = invalid, 65535 = valid",
    }
    scaling_path = _unique(out / f"{prefix}_scaling", ".json")
    scaling_path.write_text(json.dumps(scaling, indent=2, ensure_ascii=False), "utf-8")
    written.append(scaling_path)
    if include_pgm:
        pgm_path = _unique(out / f"{prefix}_flat_norm", ".pgm")
        write_ascii_pgm(pgm_path, np.clip(np.rint(model.flat_norm * 16384), 0, 65535).astype(np.uint16))
        written.append(pgm_path)
    return ExportPaths(written=written, skipped=skipped)


def export_report(
    outdir: str | Path,
    payload: dict[str, Any],
    stem: str = "report",
) -> Path:
    out = Path(outdir)
    out.mkdir(parents=True, exist_ok=True)
    payload = dict(payload)
    payload.setdefault("generated_at", datetime.now().isoformat(timespec="seconds"))
    payload.setdefault("version", DATASET_VERSION)
    path = _unique(out / stem, ".json")
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False, default=_json_default),
                    "utf-8")
    return path


def _json_default(value: Any) -> Any:
    if isinstance(value, np.ndarray):
        return value.tolist()
    if isinstance(value, (np.floating, np.integer)):
        return value.item()
    if isinstance(value, Path):
        return str(value)
    return str(value)
