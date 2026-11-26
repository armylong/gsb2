"""Point lookup between the source image and exported crops.

Two directions are needed for "find the same point again":

* display -> crop: given an upright point, report which crops contain it and
  where it lands inside each crop;
* crop -> display: given a pixel in an exported crop, report the upright
  point and the crop-relative offset.

A point that misses a crop entirely still gets a *converted* position —
computed by extending the crop-local arithmetic past its edges — so the UI
can say "outside by 7 px to the left" instead of silently doing nothing.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import List, Sequence, Tuple

from cropkit.rectmath import Rect


@dataclass
class CropHit:
    index: int
    name: str
    inside: bool
    local: Tuple[int, int]        # crop-local pixel, may be out of range
    outside_px: int               # 0 when inside, else distance to nearest edge
    edge: str                     # "左/右/上/下" when outside


def point_in_crop(rect: Rect, x: int, y: int, index: int = 0,
                  name: str = "") -> CropHit:
    lx, ly = x - rect.x0, y - rect.y0
    inside = rect.contains(x, y)
    if inside:
        return CropHit(index, name, True, (lx, ly), 0, "")
    overs = {
        "左": -lx,
        "上": -ly,
        "右": lx - (rect.width - 1),
        "下": ly - (rect.height - 1),
    }
    overs = {k: v for k, v in overs.items() if v > 0}
    if overs:
        # the nearest edge is the one overshot by the least
        edge = min(overs, key=overs.get)
        return CropHit(index, name, False, (lx, ly), overs[edge], edge)
    return CropHit(index, name, False, (lx, ly), 1, "外")


def locate_in_crops(crops: Sequence, x: int, y: int) -> List[CropHit]:
    hits = []
    for i, crop in enumerate(crops):
        r = crop.rect if hasattr(crop, "rect") else crop
        name = crop.name if hasattr(crop, "name") else ""
        hits.append(point_in_crop(r, x, y, i, name))
    return hits


def crop_to_display(rect: Rect, lx: int, ly: int) -> Tuple[int, int]:
    return rect.x0 + lx, rect.y0 + ly


def display_to_crop(rect: Rect, x: int, y: int) -> Tuple[int, int]:
    return x - rect.x0, y - rect.y0
