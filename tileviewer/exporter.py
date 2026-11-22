"""Lossless export of an arbitrary original-coordinate selection.

The export is defined on the *original* pixel grid, never on tiles, so a
selection that crosses tile boundaries is still an exact crop of the source.
A selection may also extend beyond the image; in that case the requested
canvas size is preserved and the outside area is filled with a documented
colour (transparent / black / white), unless clipping is explicitly asked
for.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Literal

import numpy as np
from PIL import Image

from .geometry import Rect

__all__ = [
    "FillMode",
    "SizeMode",
    "ExportResult",
    "export_region",
    "save_export",
]

FillMode = Literal["transparent", "black", "white"]
SizeMode = Literal["exact", "clip"]


@dataclass(frozen=True)
class ExportResult:
    image: Image.Image
    requested: Rect
    inside: Rect
    outside_pixels: int

    @property
    def size(self) -> tuple[int, int]:
        return self.image.size


def _fill_value(fill: FillMode) -> int:
    if fill == "black":
        return 0
    if fill == "white":
        return 255
    raise ValueError(f"unknown fill mode: {fill!r}")


def export_region(
    source: np.ndarray,
    rect: Rect,
    *,
    fill: FillMode = "transparent",
    size_mode: SizeMode = "exact",
) -> ExportResult:
    """Export ``rect`` (original pixel coordinates) from ``source``.

    ``size_mode='exact'`` keeps the requested width/height even when the
    rectangle extends outside the image.  ``size_mode='clip'`` narrows the
    output to the in-image intersection.
    """
    if source.ndim != 3 or source.shape[2] != 3:
        raise ValueError("source must be an H x W x 3 array")
    if rect.w <= 0 or rect.h <= 0:
        raise ValueError("selection must have a positive width and height")
    if fill not in ("transparent", "black", "white"):
        raise ValueError(f"unknown fill mode: {fill!r}")
    if size_mode not in ("exact", "clip"):
        raise ValueError(f"unknown size mode: {size_mode!r}")

    image_bounds = Rect(0, 0, int(source.shape[1]), int(source.shape[0]))
    inside = rect.clipped_to(image_bounds)

    if size_mode == "clip":
        if inside.is_empty:
            raise ValueError("selection does not intersect the image")
        canvas_w, canvas_h = inside.w, inside.h
        output_rect = inside
    else:
        canvas_w, canvas_h = rect.w, rect.h
        output_rect = rect

    if fill == "transparent":
        canvas = np.zeros((canvas_h, canvas_w, 4), dtype=np.uint8)
        alpha = canvas[:, :, 3]
        rgb = canvas[:, :, :3]
    else:
        value = _fill_value(fill)
        canvas = np.full((canvas_h, canvas_w, 3), value, dtype=np.uint8)
        rgb = canvas

    if not inside.is_empty:
        patch = source[inside.y : inside.y2, inside.x : inside.x2, :]
        dst_x = inside.x - output_rect.x
        dst_y = inside.y - output_rect.y
        rgb[dst_y : dst_y + inside.h, dst_x : dst_x + inside.w, :] = patch
        if fill == "transparent":
            alpha[dst_y : dst_y + inside.h, dst_x : dst_x + inside.w] = 255

    # A 4-channel canvas converts to RGBA, a 3-channel one to RGB.
    image = Image.fromarray(canvas)
    outside_pixels = canvas_w * canvas_h - inside.w * inside.h
    return ExportResult(
        image=image,
        requested=rect,
        inside=inside,
        outside_pixels=outside_pixels,
    )


def save_export(
    result: ExportResult,
    path: str | Path,
    *,
    format: str | None = None,
) -> Path:
    """Save an export losslessly where the container allows it."""
    target = Path(path).expanduser()
    if not target.parent.exists():
        raise FileNotFoundError(f"directory does not exist: {target.parent}")
    suffix = (format or target.suffix.lstrip(".")).lower()
    if suffix in {"jpg", "jpeg"} and result.image.mode == "RGBA":
        raise ValueError(
            "JPEG cannot store the transparent padding; choose PNG/TIFF or "
            "use black/white fill"
        )
    image = result.image
    if suffix in {"jpg", "jpeg"}:
        image.save(target, format="JPEG", quality=95, subsampling=0)
    elif suffix in {"tif", "tiff"}:
        image.save(target, format="TIFF", compression="tiff_deflate")
    else:
        image.save(target, format="PNG", compress_level=6)
    return target
