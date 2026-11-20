"""Maximum-deviation measurement between an original and a simplified ring.

The original boundary is the pixel staircase (unit steps), the simplified one
is an arbitrary closed polygon.  We report the symmetric (directed Hausdorff)
maximum and the actual point pair responsible, plus a bbox that the GUI uses
to draw the "worst deviation" region.
"""

from __future__ import annotations

from dataclasses import dataclass

from .geometry import Point, closest_point_on_ring, path_bbox


@dataclass
class Deviation:
    max_distance: float
    original_point: tuple[float, float]   # point on the staircase
    simplified_point: tuple[float, float]  # closest point on the simplified ring
    vertex: Point                          # original vertex that produced it
    direction: str                         # "original->simplified" | "simplified->original"
    bbox: tuple[int, int, int, int]
    epsilon: float

    @property
    def within(self) -> bool:
        return self.max_distance <= self.epsilon + 1e-9


def ring_deviation(
    original: list[Point],
    simplified: list[Point],
    epsilon: float,
    *,
    pad: float = 4.0,
) -> Deviation:
    best = 0.0
    best_pair = ((float(original[0][0]), float(original[0][1])),
                 (float(simplified[0][0]), float(simplified[0][1])))
    best_vertex: Point = original[0]
    direction = "original->simplified"

    for p in original:
        d, q = closest_point_on_ring(simplified, p)
        if d > best:
            best = d
            best_pair = ((float(p[0]), float(p[1])), q)
            best_vertex = p
            direction = "original->simplified"
    for q in simplified:
        d, p = closest_point_on_ring(original, q)
        if d > best:
            best = d
            best_pair = (p, (float(q[0]), float(q[1])))
            best_vertex = (int(round(p[0])), int(round(p[1])))
            direction = "simplified->original"

    x0, y0, x1, y1 = path_bbox(original + simplified)
    xx = [best_pair[0][0], best_pair[1][0]]
    yy = [best_pair[0][1], best_pair[1][1]]
    r = max(pad, best)
    bbox = (
        int(min(xx) - r),
        int(min(yy) - r),
        int(max(xx) + r + 1),
        int(max(yy) + r + 1),
    )
    return Deviation(
        max_distance=best,
        original_point=best_pair[0],
        simplified_point=best_pair[1],
        vertex=best_vertex,
        direction=direction,
        bbox=bbox,
        epsilon=epsilon,
    )


def intersection_area(
    original: list[Point], simplified: list[Point], width: int, height: int
) -> tuple[float, float]:
    """Return (simplified area, symmetric difference area) by rasterisation.

    Kept in ``deviation`` for callers that only have rings; the checker uses
    the full-mask diff instead.  ``width``/``height`` bound the canvas.
    """
    from .render import scanline_mask

    a = scanline_mask([original], width, height)
    b = scanline_mask([simplified], width, height)
    area_a = float((a != 0).sum())
    area_b = float((b != 0).sum())
    sym = float(((a != 0) ^ (b != 0)).sum())
    return area_b, sym
