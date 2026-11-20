"""Rasterisation / reconstruction and diff rendering.

``reconstruct`` fills the even-odd interior of every (simplified) ring.  The
original pixel boundaries use integer corner coordinates, so an even-odd
scanline over pixel centres ``(c + 0.5, r + 0.5)`` reproduces the mask
exactly.  Simplified polygons are no longer pixel aligned; the same scanline
rule still gives a deterministic, comparable rasterisation.
"""

from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

from .geometry import Point


def polygon_mask(
    polygons: list[list[Point]], width: int, height: int
) -> np.ndarray:
    """Even-odd fill of closed polygons; pixels beyond their edges are 0."""
    img = np.zeros((height, width), np.uint8)
    if not polygons:
        return img
    # Build integer fill paths from the float/possibly clipped polygons using
    # the even-odd rule with an explicit supersampled scanline is expensive;
    # instead use filled polygons with XOR composition.  Each ring is a simple
    # polygon, so "fill each ring, XOR into the image" equals even-odd.
    for poly in polygons:
        pts = np.round(np.asarray(poly, dtype=np.float64) * 4.0).astype(np.int32)
        layer = np.zeros((height * 4, width * 4), np.uint8)
        cv2.fillPoly(layer, [pts], 1, lineType=cv2.LINE_8)
        layer = layer.reshape(height, 4, width, 4).mean(axis=(1, 3))
        bitmap = (layer >= 0.5).astype(np.uint8)
        img ^= bitmap
    return img


def scanline_mask(
    polygons: list[list[Point]], width: int, height: int
) -> np.ndarray:
    """Exact even-odd ruler test at pixel centres (used for verification).

    Slow but dependency-light: for every scanline y = r + 1/2, collect the
    x-coordinates where each polygon edge crosses it, sort them, and fill
    between pairs.  For integer corner polygons this is exactly the original
    mask (no anti-aliasing, no half-pixel bias).
    """
    img = np.zeros((height, width), np.uint8)
    for r in range(height):
        y = r + 0.5
        xs: list[float] = []
        for poly in polygons:
            n = len(poly)
            for i in range(n):
                x1, y1 = poly[i]
                x2, y2 = poly[(i + 1) % n]
                if (y1 > y) != (y2 > y):
                    xs.append(x1 + (y - y1) * (x2 - x1) / (y2 - y1))
        xs.sort()
        for a, b in zip(xs[0::2], xs[1::2]):
            c0 = max(0, int(np.ceil(a - 0.5)))
            c1 = min(width - 1, int(np.floor(b - 0.5)))
            if c1 >= c0:
                img[r, c0:c1 + 1] = 1
    return img


def reconstruct(rings, width: int, height: int) -> np.ndarray:
    """Fill a list of rings (objects with ``.points``) into a binary mask."""
    return polygon_mask([r.points for r in rings], width, height)


@dataclass
class RasterDiff:
    missing: np.ndarray       # reference 1, rebuilt 0
    extra: np.ndarray         # reference 0, rebuilt 1
    missing_count: int
    extra_count: int
    iou: float
    area_ref: int
    area_new: int


def raster_diff(reference: np.ndarray, rebuilt: np.ndarray) -> RasterDiff:
    a = reference != 0
    b = rebuilt != 0
    missing = (a & ~b).astype(np.uint8)
    extra = (b & ~a).astype(np.uint8)
    inter = int((a & b).sum())
    union = int((a | b).sum())
    return RasterDiff(
        missing=missing,
        extra=extra,
        missing_count=int(missing.sum()),
        extra_count=int(extra.sum()),
        iou=(inter / union) if union else 1.0,
        area_ref=int(a.sum()),
        area_new=int(b.sum()),
    )


def overlay_diff(
    reference: np.ndarray,
    diff: RasterDiff,
    *,
    base_rgb=(30, 30, 30),
    ref_rgb=(70, 70, 70),
    missing_rgb=(255, 80, 80),
    extra_rgb=(80, 160, 255),
) -> np.ndarray:
    """RGB image: grey reference, red missing, blue extra."""
    h, w = reference.shape
    out = np.zeros((h, w, 3), np.uint8)
    out[:] = base_rgb
    out[reference != 0] = ref_rgb
    out[diff.missing != 0] = missing_rgb
    out[diff.extra != 0] = extra_rgb
    return out


def colourise_components(labels: np.ndarray) -> np.ndarray:
    """Stable pseudo-colours for component labels (label 0 stays dark)."""
    out = np.zeros((*labels.shape, 3), np.uint8)
    out[:] = (28, 28, 30)
    for comp in range(1, int(labels.max()) + 1):
        h = (comp * 2654435761) & 0xFFFFFFFF
        r = 70 + (h & 0x7F)
        g = 70 + ((h >> 8) & 0x7F)
        b = 70 + ((h >> 16) & 0x7F)
        out[labels == comp] = (int(r), int(g), int(b))
    return out


def render_boundaries(
    mask: np.ndarray,
    rings,
    *,
    scale: int = 1,
    show_vertices: bool = True,
    highlight: tuple[int, int] | None = None,
    hole_colours: bool = True,
) -> np.ndarray:
    """RGB preview of the mask with each ring in a component-coloured overlay.

    Ring labels are drawn next to the first vertex: ``C<n>/O`` for the outer
    ring of a component and ``C<n>/H<k>`` for its holes.
    """
    from .palette import component_colour, hole_colour

    h, w = mask.shape
    base = colourise_components(np.where(mask, 1, 0).astype(np.int32))
    base[mask == 0] = (18, 18, 20)
    img = base.copy()
    for ring in rings:
        col = component_colour(ring.comp_id)
        if ring.kind == "hole" and hole_colours:
            col = hole_colour(ring.comp_id, ring.index, col)
        pts = np.asarray(ring.points, dtype=np.int32)
        cv2.polylines(img, [pts.reshape(-1, 1, 2)], True, col, 1, cv2.LINE_8)
        if show_vertices:
            for x, y in ring.points:
                cv2.circle(img, (x, y), 1, (0, 0, 0), -1)
                cv2.circle(img, (x, y), 1, col, 1)
        if ring is highlight or (highlight is not None and (ring.comp_id, ring.index) == highlight):
            pts2 = np.asarray(ring.points, dtype=np.int32)
            cv2.polylines(img, [pts2.reshape(-1, 1, 2)], True, (255, 255, 255), 1, cv2.LINE_AA)
    if scale != 1:
        img = cv2.resize(img, (w * scale, h * scale), interpolation=cv2.INTER_NEAREST)
    return img


def draw_ring_labels(
    img: np.ndarray, rings, scale: int = 1, offset=(4, -4), font_scale=0.35
) -> np.ndarray:
    """Draw ``C<n>/O`` / ``C<n>/H<k>`` next to each ring's first vertex."""
    h, w = img.shape[:2]
    for ring in rings:
        x, y = ring.points[0]
        text = ring.label
        org = (int(x * scale) + offset[0], int(y * scale) + offset[1])
        for thickness, colour in ((2, (0, 0, 0)), (1, (255, 255, 255))):
            cv2.putText(
                img,
                text,
                org,
                cv2.FONT_HERSHEY_SIMPLEX,
                font_scale,
                colour,
                thickness,
                cv2.LINE_AA,
            )
    return img
