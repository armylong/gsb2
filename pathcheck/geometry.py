"""Exact geometry helpers for pixel boundaries and simplification checks.

A boundary path is a list of integer corner points ``(x, y)`` in *corner
coordinates*: pixel ``(col, row)`` covers the square ``[col, col+1) x
[row, row+1)``, so its four corners are ``(col, row) .. (col+1, row+1)``.

Canonical closed paths are:
  * free of duplicate and collinear vertices (where possible),
  * oriented so outer rings are *clockwise on screen* (``signed_area > 0``
    with the shoelace formula and y pointing down) and holes are
    counter-clockwise (``signed_area < 0``),
  * started at the lexicographically smallest ``(y, x)`` corner, so the same
    mask always exports byte-identical JSON.

Area uses ``Fraction`` internally; public helpers return ``float``.
"""

from __future__ import annotations

from fractions import Fraction
from typing import Iterable, Sequence

Point = tuple[int, int]
Segment = tuple[Point, Point]

DIRS: dict[str, Point] = {
    "R": (1, 0),
    "L": (-1, 0),
    "D": (0, 1),
    "U": (0, -1),
}
_OPPOSITE = {"R": "L", "L": "R", "U": "D", "D": "U"}


def _dir_of(a: Point, b: Point) -> str:
    step = (b[0] - a[0], b[1] - a[1])
    for name, d in DIRS.items():
        if step == d:
            return name
    raise ValueError(f"non-unit step from {a} to {b}")


def path_edges(path: Sequence[Point]) -> list[Segment]:
    """Edges of a closed path (the last point connects back to the first)."""
    n = len(path)
    return [(tuple(path[i]), tuple(path[(i + 1) % n])) for i in range(n)]


def signed_area(path: Sequence[Point]) -> Fraction:
    """Exact shoelace area.  Positive = clockwise on screen (y down)."""
    s = Fraction(0)
    n = len(path)
    for i in range(n):
        x1, y1 = path[i]
        x2, y2 = path[(i + 1) % n]
        s += Fraction(x1 * y2 - x2 * y1, 2)
    return s


def area_float(path: Sequence[Point]) -> float:
    return float(signed_area(path))


def turn_flags(path: Sequence[Point]) -> list[int]:
    """Corner turn flags in traversal order (only for axis-aligned paths).

    ``+1`` right turn, ``-1`` left turn, ``0`` collinear.  With y pointing
    down, a clockwise (outer) ring has mostly right turns.
    """
    n = len(path)
    flags = []
    for i in range(n):
        a, b, c = path[i - 1], path[i], path[(i + 1) % n]
        d1, d2 = _dir_of(a, b), _dir_of(b, c)
        if d1 == d2:
            flags.append(0)
        elif _OPPOSITE[d1] == d2:
            raise ValueError(f"path doubles back at {b}")
        elif DIRS[d1][0] * DIRS[d2][1] - DIRS[d1][1] * DIRS[d2][0] > 0:
            flags.append(1)
        else:
            flags.append(-1)
    return flags


def _same_point(a: Sequence[float], b: Sequence[float]) -> bool:
    return a[0] == b[0] and a[1] == b[1]


def _orientation(a: Point, b: Point, c: Point) -> int:
    v = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
    return (v > 0) - (v < 0)


def _on_segment(a: Point, b: Point, p: Point) -> bool:
    return (
        min(a[0], b[0]) <= p[0] <= max(a[0], b[0])
        and min(a[1], b[1]) <= p[1] <= max(a[1], b[1])
        and _orientation(a, b, p) == 0
    )


def segment_relation(
    a: Point, b: Point, c: Point, d: Point
) -> str | None:
    """Classify the intersection of segments ab and cd.

    Returns ``None`` (disjoint), ``"touch"`` (a single shared point,
    including a T-junction or endpoint contact), ``"overlap"`` (collinear
    overlap with positive length) or ``"cross"`` (proper interior crossing).
    """
    o1 = _orientation(a, b, c)
    o2 = _orientation(a, b, d)
    o3 = _orientation(c, d, a)
    o4 = _orientation(c, d, b)
    if o1 == 0 and o2 == 0 and o3 == 0 and o4 == 0:
        # Collinear: project on the dominant axis.
        axis = 0 if abs(b[0] - a[0]) >= abs(b[1] - a[1]) else 1
        lo1, hi1 = sorted((a[axis], b[axis]))
        lo2, hi2 = sorted((c[axis], d[axis]))
        if hi1 < lo2 or hi2 < lo1:
            return None
        if hi1 == lo2 or hi2 == lo1:
            return "touch"
        return "overlap"
    if o1 * o2 < 0 and o3 * o4 < 0:
        return "cross"
    # Any endpoint lying on the other segment -> single-point contact.
    for p in (a, b):
        if _orientation(c, d, p) == 0 and _on_segment(c, d, p):
            return "touch"
    for p in (c, d):
        if _orientation(a, b, p) == 0 and _on_segment(a, b, p):
            return "touch"
    return None


def _adjacent(i: int, j: int, n: int) -> bool:
    return j == (i + 1) % n or i == (j + 1) % n


def ring_self_intersection(path: Sequence[Point]) -> list[tuple[int, int, str]]:
    """Return non-adjacent edge pairs that touch/overlap/cross."""
    edges = path_edges(path)
    n = len(edges)
    problems = []
    for i in range(n):
        a, b = edges[i]
        for j in range(i + 1, n):
            c, d = edges[j]
            if _adjacent(i, j, n):
                rel = segment_relation(a, b, c, d)
                # Adjacent edges may share their common endpoint, nothing more.
                if rel == "overlap":
                    problems.append((i, j, rel))
                continue
            rel = segment_relation(a, b, c, d)
            if rel is not None:
                problems.append((i, j, rel))
    return problems


def ring_pair_relation(
    path_a: Sequence[Point], path_b: Sequence[Point]
) -> list[tuple[int, int, str]]:
    """Intersections between two closed rings (proper crossings/overlaps)."""
    out = []
    ea, eb = path_edges(path_a), path_edges(path_b)
    for i, (a, b) in enumerate(ea):
        for j, (c, d) in enumerate(eb):
            rel = segment_relation(a, b, c, d)
            if rel in ("cross", "overlap"):
                out.append((i, j, rel))
    return out


def point_in_ring(path: Sequence[Point], x: float, y: float) -> bool:
    """Even-odd point-in-polygon test (pixel centres use +0.5)."""
    inside = False
    n = len(path)
    for i in range(n):
        x1, y1 = path[i]
        x2, y2 = path[(i + 1) % n]
        if (y1 > y) != (y2 > y):
            xint = x1 + (y - y1) * (x2 - x1) / (y2 - y1)
            if xint > x:
                inside = not inside
    return inside


def _collinear(a: Point, b: Point, c: Point) -> bool:
    return (
        (b[0] - a[0]) * (c[1] - b[1])
        - (b[1] - a[1]) * (c[0] - b[0])
        == 0
    )


def _drop_collinear(points: Sequence[Point]) -> list[Point]:
    q = [tuple(p) for p in points]
    # remove consecutive duplicates
    dedup: list[Point] = []
    for p in q:
        if not dedup or dedup[-1] != p:
            dedup.append(p)
    q = dedup
    changed = True
    while changed and len(q) >= 3:
        changed = False
        for i in range(len(q)):
            a, b, c = q[i - 1], q[i], q[(i + 1) % len(q)]
            if _collinear(a, b, c) and (
                (b[0] - a[0]) * (c[0] - b[0])
                + (b[1] - a[1]) * (c[1] - b[1])
                >= 0
            ):
                del q[i]
                changed = True
                break
    if len(q) >= 2 and q[0] == q[-1]:
        q.pop()
    return q


def canonicalize(path: Sequence[Point], *, clockwise: bool) -> list[Point]:
    """Remove collinear vertices, fix orientation and rotate the start.

    With y pointing down, a clockwise-on-screen ring has positive shoelace
    area, so ``clockwise=True`` means ``signed_area > 0``.
    """
    q = _drop_collinear(path)
    if len(q) < 3:
        raise ValueError("ring has fewer than 3 distinct corners")
    is_clockwise = signed_area(q) > 0
    if is_clockwise != clockwise:
        q.reverse()
    k = min(range(len(q)), key=lambda i: (q[i][1], q[i][0]))
    return q[k:] + q[:k]


def path_bbox(path: Sequence[Point]) -> tuple[int, int, int, int]:
    xs = [p[0] for p in path]
    ys = [p[1] for p in path]
    return min(xs), min(ys), max(xs), max(ys)


def polyline_distance(
    points: Iterable[Sequence[float]], q: Sequence[float]
) -> float:
    """Distance from ``q`` to a closed polyline."""
    pts = [(float(p[0]), float(p[1])) for p in points]
    if not pts:
        return float("inf")
    if len(pts) == 1:
        return _hypot(q[0] - pts[0][0], q[1] - pts[0][1])
    best = float("inf")
    for a, b in zip(pts, pts[1:] + pts[:1]):
        best = min(best, _point_segment_distance(q, a, b))
    return best


def _hypot(dx: float, dy: float) -> float:
    return (dx * dx + dy * dy) ** 0.5


def _point_segment_distance(q, a, b) -> float:
    ax, ay = a
    bx, by = b
    qx, qy = q
    vx, vy = bx - ax, by - ay
    den = vx * vx + vy * vy
    if den == 0:
        return _hypot(qx - ax, qy - ay)
    t = ((qx - ax) * vx + (qy - ay) * vy) / den
    t = max(0.0, min(1.0, t))
    return _hypot(qx - (ax + t * vx), qy - (ay + t * vy))


def closest_point_on_ring(
    path: Sequence[Point], q: Sequence[float]
) -> tuple[float, float]:
    """Closest point on a closed polyline to ``q``."""
    pts = [(float(p[0]), float(p[1])) for p in path]
    best = (float("inf"), pts[0])
    n = len(pts)
    for i in range(n):
        a, b = pts[i], pts[(i + 1) % n]
        vx, vy = b[0] - a[0], b[1] - a[1]
        den = vx * vx + vy * vy
        if den == 0:
            t = 0.0
        else:
            t = ((q[0] - a[0]) * vx + (q[1] - a[1]) * vy) / den
            t = max(0.0, min(1.0, t))
        p = (a[0] + t * vx, a[1] + t * vy)
        d = _hypot(q[0] - p[0], q[1] - p[1])
        if d < best[0]:
            best = (d, p)
    return best


def dilate_bbox(
    bbox: tuple[int, int, int, int], pad: float, width: int, height: int
) -> tuple[int, int, int, int]:
    x0, y0, x1, y1 = bbox
    return (
        max(0, int(x0 - pad)),
        max(0, int(y0 - pad)),
        min(width, int(x1 + pad + 1)),
        min(height, int(y1 + pad + 1)),
    )
