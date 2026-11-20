"""Export helpers shared by the UI and tests.

Requirement 4 and 6 both hinge on the exported foreground being computed by the
*same* function the preview uses, so all export paths route through
``matting.imageio.composite`` / ``ensure_bgra``.
"""

from __future__ import annotations

import os

import numpy as np

from matting.engine import MattingResult
from matting.imageio import ensure_bgra, write_png
from matting.record import ConstraintRecord


def export_alpha_png(path: str, result: MattingResult) -> None:
    write_png(path, result.alpha_u8)


def export_foreground_png(path: str, result: MattingResult) -> None:
    write_png(path, ensure_bgra(result.foreground, result.alpha))


def export_constraints(path: str, record: ConstraintRecord) -> None:
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(record.to_json())


def default_export_names(base: str) -> tuple[str, str, str]:
    stem = os.path.splitext(os.path.basename(base))[0] or "foreground"
    return (f"{stem}_foreground.png", f"{stem}_alpha.png", f"{stem}_constraints.json")


def read_back_alpha(path: str) -> np.ndarray:
    """Read an exported RGBA PNG back as float alpha in [0, 1] (tests)."""
    from matting.imageio import read_png_bgra

    data = read_png_bgra(path)
    if data.ndim != 3 or data.shape[2] != 4:
        raise ValueError("expected an RGBA png")
    return data[:, :, 3].astype(np.float32) / 255.0
