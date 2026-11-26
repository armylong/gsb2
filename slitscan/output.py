"""Saving strip pages and the relocation manifest.

A manifest captures everything needed to rebuild the strip and to map any
output column back to the source video: slit geometry, trim/skip ranges,
per-block timestamps and source-column maps.  Page boundaries never split a
slice, so consecutive pages share no column and drop none.
"""

from __future__ import annotations

import json
from pathlib import Path

from PIL import Image

from .core import BuildResult, SliceBlock

MANIFEST_VERSION = 1


def save_png_pages(result: BuildResult, base_path: str | Path) -> list[Path]:
    """Write one PNG per page; returns the list of written paths."""
    base = Path(base_path)
    base.parent.mkdir(parents=True, exist_ok=True)
    suffix = base.suffix or ".png"
    stem = base.stem
    paths: list[Path] = []
    for i, page in enumerate(result.pages):
        if len(result.pages) == 1:
            out = base if base.suffix else base.with_suffix(suffix)
        else:
            out = base.with_name(f"{stem}_p{i + 1:03d}{suffix}")
        Image.fromarray(page).save(out)
        paths.append(out)
    return paths


def build_manifest(result: BuildResult, source_path: str,
                   page_paths: list[Path]) -> dict:
    cfg = result.config
    return {
        "tool": "slitscan",
        "manifest_version": MANIFEST_VERSION,
        "source": {
            "path": str(source_path),
            "frame_width": result.frame_width,
            "frame_height": result.frame_height,
            "frame_count": len(result.timestamps),
            "timestamps": [float(t) for t in result.timestamps],
        },
        "config": {
            "slit_width": cfg.width,
            "start_center": cfg.start_center,
            "end_center": cfg.end_center,
            "padding": cfg.padding,
            "layout": cfg.layout,
            "interval": cfg.interval,
            "trim_start": cfg.trim_start,
            "trim_end": cfg.trim_end,
            "skip_intervals": [list(s) for s in cfg.skip_intervals],
            "max_page_width": cfg.max_page_width,
        },
        "output": {
            "total_width": result.total_width,
            "page_count": len(result.pages),
            "page_widths": [int(p.shape[1]) for p in result.pages],
            "pages": [str(p) for p in page_paths],
        },
        "blocks": [b.to_dict() for b in result.blocks],
    }


def save_manifest(manifest: dict, path: str | Path) -> Path:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(manifest, indent=1, ensure_ascii=False))
    return p


def save_result(result: BuildResult, source_path: str,
                base_png: str | Path) -> tuple[list[Path], Path]:
    """Save page PNGs plus a sibling ``.manifest.json``."""
    paths = save_png_pages(result, base_png)
    manifest = build_manifest(result, source_path, paths)
    mp = Path(base_png).with_suffix(".manifest.json")
    save_manifest(manifest, mp)
    return paths, mp


def load_manifest(path: str | Path) -> dict:
    return json.loads(Path(path).read_text())


def manifest_blocks(manifest: dict) -> list[SliceBlock]:
    return [SliceBlock(**b) for b in manifest["blocks"]]


def verify_pages(result: BuildResult) -> list[str]:
    """Structural self-check: page joins and block coverage.

    Returns a list of human-readable problems (empty when everything is
    consistent).
    """
    problems: list[str] = []
    expected_total = sum(p.shape[1] for p in result.pages)
    covered = 0
    prev_global_end = 0
    for i, b in enumerate(result.blocks):
        if b.global_x0 != prev_global_end:
            problems.append(
                f"block {i}: global gap/overlap at x={b.global_x0} "
                f"(expected {prev_global_end})")
        if b.page_x0 + b.width > result.pages[b.page].shape[1]:
            problems.append(f"block {i}: overflows page {b.page}")
        if len(b.source_cols) != b.width:
            problems.append(f"block {i}: source_cols length != slit width")
        covered += b.width
        prev_global_end = b.global_x0 + b.width
    if covered != expected_total:
        problems.append(f"covered {covered} columns but strip is {expected_total}")
    return problems
