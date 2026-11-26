"""Image loading, preview caching and exact-rectangle export.

One rule ties the whole module together: **the exported PNG is produced from
the same integer rectangle that the preview draws**.  The preview never
computes an independent crop; it scales the upright image down and overlays
the rect.  Export crops the upright image with ``(x0, y0, x1, y1)`` exactly
as stored in the project, so the outermost row/column can never shift by
one because of zoom or rounding.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Dict, List, Optional, Sequence, Tuple

from PIL import Image, ImageDraw

from cropkit.orientation import Orientation
from cropkit.rectmath import Rect


class LoadedImage:
    """A decoded source plus its upright counterpart, cached."""

    __slots__ = ("path", "stored", "display", "orientation")

    def __init__(self, path: str):
        self.path = path
        with Image.open(path) as raw:
            raw.load()
            self.stored = raw.copy()
            try:
                value = raw.getexif().get(0x0112, 1)
            except Exception:
                value = 1
        self.orientation = Orientation(value)
        self.display = self.orientation.to_display(self.stored)

    @property
    def display_size(self) -> Tuple[int, int]:
        return self.display.size

    @property
    def stored_size(self) -> Tuple[int, int]:
        return self.stored.size

    def upright_crop(self, rect: Rect) -> Image.Image:
        """Crop the upright image with the exact integer rectangle.

        The rect is clamped rather than resized so the result can only ever
        be smaller than requested, never shifted.
        """
        r = rect.clamped_to(*self.display_size)
        return self.display.crop((r.x0, r.y0, r.x1, r.y1))


def open_image(path: str) -> LoadedImage:
    return LoadedImage(path)


def is_jpeg(path: str) -> bool:
    return os.path.splitext(path)[1].lower() in (".jpg", ".jpeg", ".jpe")


# ---------------------------------------------------------------------------
# preview scaling
# ---------------------------------------------------------------------------
def fit_scale(size: Tuple[int, int], box: Tuple[int, int]) -> float:
    if size[0] <= 0 or size[1] <= 0:
        return 1.0
    return min(box[0] / size[0], box[1] / size[1])


def resize_for_preview(img: Image.Image, scale: float) -> Image.Image:
    if scale <= 0:
        scale = 1.0
    w = max(1, int(round(img.width * scale)))
    h = max(1, int(round(img.height * scale)))
    if (w, h) == img.size:
        return img
    return img.resize((w, h), Image.Resampling.LANCZOS)


def make_thumbnail(img: Image.Image, box: Tuple[int, int]) -> Image.Image:
    thumb = img.copy()
    thumb.thumbnail(box, Image.Resampling.LANCZOS)
    return thumb


# ---------------------------------------------------------------------------
# mask generation
# ---------------------------------------------------------------------------
def marker_mask(rect: Rect, markers: Sequence[Tuple[int, int]],
                size: Optional[Tuple[int, int]] = None,
                background: int = 0, foreground: int = 255,
                dot: int = 0) -> Image.Image:
    """A same-size-as-crop mask with markers punched in.

    ``dot`` > 0 draws a small square of that half-size around each point.
    Markers that fall inside the crop are drawn; callers filter the rest.
    """
    w, h = size if size else (max(rect.width, 1), max(rect.height, 1))
    mask = Image.new("L", (w, h), background)
    draw = ImageDraw.Draw(mask)
    for mx, my in markers:
        lx, ly = mx - rect.x0, my - rect.y0
        if dot > 0:
            r = dot
            draw.ellipse((lx - r, ly - r, lx + r, ly + r), fill=foreground)
        elif 0 <= lx < w and 0 <= ly < h:
            mask.putpixel((lx, ly), foreground)
    return mask


# ---------------------------------------------------------------------------
# export
# ---------------------------------------------------------------------------
@dataclass
class ExportResult:
    name: str
    rect: Rect
    crop_path: Optional[str]
    mask_path: Optional[str]
    included: List[Tuple[str, int, int]]     # markers inside the crop
    outside: List[Tuple[str, int, int]]      # name, x, y (source coords)
    error: Optional[str] = None
    index: int = 0                           # index in the crop list


def sanitize_filename(name: str) -> str:
    cleaned = "".join(c for c in name if c not in '\\/:*?"<>|').strip()
    cleaned = cleaned.replace(" ", "_")
    return cleaned or "crop"


def unique_path(directory: str, stem: str, ext: str,
                used: Dict[str, int]) -> str:
    """A path unique within this export batch.

    Names from an earlier export in the same folder are reused (overwritten)
    so exporting twice is idempotent instead of piling up ``_2`` copies.
    """
    base = sanitize_filename(stem)
    key = base.lower()
    n = used.get(key, 0)
    used[key] = n + 1
    suffix = "" if n == 0 else f"_{n + 1}"
    return os.path.join(directory, f"{base}{suffix}{ext}")


def marker_outside_detail(rect: Rect, mx: int, my: int) -> int:
    """Offset of an outside marker expressed in crop-local coordinates.

    Negative or >= width/height values indicate how far outside the crop
    the marker lands; this is what the manifest reports so a marker that
    fell off the edge is not silently dropped.
    """
    lx, ly = mx - rect.x0, my - rect.y0
    if lx < 0:
        return lx
    if ly < 0:
        return ly
    if lx >= rect.width:
        return lx
    return ly


def export_crops(image: LoadedImage, crops: Sequence,
                 markers: Sequence, out_dir: str,
                 with_masks: bool = True,
                 mask_dot: int = 2,
                 mask_background: int = 0) -> List[ExportResult]:
    """Write every enabled crop and return a per-crop manifest."""
    os.makedirs(out_dir, exist_ok=True)
    used: Dict[str, int] = {}
    results: List[ExportResult] = []

    for index, (source_index, crop) in enumerate(
            [(i, c) for i, c in enumerate(crops) if c.enabled], start=1):
        rect = crop.rect.clamped_to(*image.display_size)
        base = sanitize_filename(crop.name) or f"crop_{index:02d}"

        included = [(m.name, m.x, m.y) for m in markers
                    if rect.contains(m.x, m.y)]
        outside = [(m.name, m.x, m.y)
                   for m in markers if not rect.contains(m.x, m.y)]

        result = ExportResult(crop.name, rect, None, None, included, outside,
                              index=source_index)
        if rect.width <= 0 or rect.height <= 0:
            result.error = "选区为空"
            results.append(result)
            continue
        try:
            piece = image.upright_crop(rect)
            crop_path = unique_path(out_dir, base, ".png", used)
            piece.save(crop_path, "PNG")
            result.crop_path = crop_path
            if with_masks:
                mask = marker_mask(rect, [(x, y) for _, x, y in included],
                                   size=piece.size, dot=mask_dot,
                                   background=mask_background)
                mask_path = unique_path(out_dir, base + "_mask", ".png", used)
                mask.save(mask_path, "PNG")
                result.mask_path = mask_path
        except Exception as exc:  # keep going; report the failure per crop
            result.error = str(exc)
        results.append(result)
    return results


def results_to_rows(results: Sequence[ExportResult]) -> List[dict]:
    """Flatten the per-crop manifests for the UI checklist."""
    rows = []
    for r in results:
        if r.included:
            for name, x, y in r.included:
                rows.append({
                    "crop": r.name, "marker": name, "status": "已包含",
                    "x": x, "y": y,
                    "local": f"{x - r.rect.x0}, {y - r.rect.y0}",
                    "note": "", "crop_index": r.index,
                })
        if r.outside:
            from cropkit.lookup import point_in_crop

            for name, x, y in r.outside:
                hit = point_in_crop(r.rect, x, y)
                rows.append({
                    "crop": r.name, "marker": name, "status": "未包含",
                    "x": x, "y": y,
                    "local": f"{x - r.rect.x0}, {y - r.rect.y0}",
                    "note": f"在{hit.edge}侧外 {hit.outside_px} px",
                    "crop_index": r.index,
                })
        if not r.included and not r.outside:
            rows.append({
                "crop": r.name, "marker": "—", "status": "无定点",
                "x": "", "y": "", "local": "", "note": "",
                "crop_index": r.index,
            })
    return rows


def write_manifest(results: Sequence[ExportResult], path: str) -> None:
    import json

    rows = results_to_rows(results)
    payload = {
        "crops": [
            {
                "name": r.name,
                "rect": r.rect.to_dict(),
                "crop": r.crop_path,
                "mask": r.mask_path,
                "error": r.error,
            }
            for r in results
        ],
        "markers": rows,
    }
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)


def verify_export_edges(image: LoadedImage, results: Sequence[ExportResult]
                        ) -> List[Tuple[str, bool, str]]:
    """Re-open each PNG and compare its outermost row/column with the
    upright source pixels inside the same rectangle.

    This is the guard for requirement 5: the exported edge must be the
    previewed selection edge.  It reads the written file back, so a bug in
    the save step cannot pass unnoticed.
    """
    out: List[Tuple[str, bool, str]] = []
    src = image.display
    for r in results:
        if not r.crop_path or not os.path.exists(r.crop_path):
            continue
        with Image.open(r.crop_path) as png:
            png = png.convert("RGB")
            rect = r.rect
            box = (rect.x0, rect.y0, rect.x1, rect.y1)
            expected = src.crop(box).convert("RGB")
            if png.size != expected.size:
                out.append((r.name, False,
                            f"尺寸 {png.size} != 选区 {expected.size}"))
                continue
            problems = []
            if png.tobytes("raw", "RGB") != expected.tobytes("raw", "RGB"):
                # distinguish an overall shift from an edge-only mismatch
                edge_names = ("上", "下", "左", "右")
                edge_ok = (
                    png.crop((0, 0, png.width, 1)).tobytes() ==
                    expected.crop((0, 0, expected.width, 1)).tobytes(),
                    png.crop((0, png.height - 1, png.width, png.height)
                             ).tobytes() ==
                    expected.crop((0, expected.height - 1, expected.width,
                                   expected.height)).tobytes(),
                    png.crop((0, 0, 1, png.height)).tobytes() ==
                    expected.crop((0, 0, 1, expected.height)).tobytes(),
                    png.crop((png.width - 1, 0, png.width, png.height)
                             ).tobytes() ==
                    expected.crop((expected.width - 1, 0, expected.width,
                                   expected.height)).tobytes(),
                )
                bad = [n for n, ok in zip(edge_names, edge_ok) if not ok]
                problems.append("最外行列不符: " + "/".join(bad) if bad
                                else "内部像素不符")
            if problems:
                out.append((r.name, False, "; ".join(problems)))
            else:
                out.append((r.name, True,
                            f"{png.width}×{png.height} 与选区逐像素一致"))
    return out
