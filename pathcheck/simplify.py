"""Polygon simplification with three selectable algorithms.

All simplifiers work on closed rings and return *closed* candidate polygons
(the closing vertex is implicit).  They are deliberately conservative about
structure: no vertices are merged across different components, and the
caller validates the result afterwards (see ``validate``).
"""

from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

from .geometry import Point, _drop_collinear, area_float, path_bbox, signed_area


@dataclass(frozen=True)
class SimplifyParams:
    method: str = "rdp"        # "rdp" | "approx" | "vertex" (tolerance-based)
    epsilon: float = 1.0       # pixel units; RDP / approxPolyDP tolerance
    min_hole_ratio: float = 0.0  # drop holes whose |area| / outer area <= ratio
    min_hole_area: float = 0.0   # drop holes with |area| <= this many pixels

    def describe(self) -> str:
        extra = []
        if self.min_hole_ratio:
            extra.append(f"洞/外环面积比<={self.min_hole_ratio:g} 丢弃")
        if self.min_hole_area:
            extra.append(f"洞面积<={self.min_hole_area:g}px 丢弃")
        tail = ("; " + "; ".join(extra)) if extra else ""
        return f"{self.method} epsilon={self.epsilon:g}px{tail}"


METHODS = {
    "rdp": "Ramer–Douglas–Peucker (闭合环)",
    "approx": "OpenCV approxPolyDP",
    "vertex": "仅合并共线点",
}


def _rdp_open(points: np.ndarray, eps: float) -> np.ndarray:
    """RDP on an open polyline; closed rings are handled by the caller."""
    if len(points) <= 2:
        return points.copy()
    keep = np.zeros(len(points), dtype=bool)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        i, j = stack.pop()
        if j <= i + 1:
            continue
        a, b = points[i], points[j]
        ab = b - a
        den = float(ab @ ab)
        seg = points[i + 1:j]
        if den == 0.0:
            d = np.linalg.norm(seg - a, axis=1)
        else:
            t = np.clip(((seg - a) @ ab) / den, 0.0, 1.0)
            proj = a + t[:, None] * ab
            d = np.linalg.norm(seg - proj, axis=1)
        k = int(np.argmax(d))
        if d[k] > eps:
            m = i + 1 + k
            keep[m] = True
            stack.append((i, m))
            stack.append((m, j))
    return points[keep]


def rdp_closed(path: list[Point], eps: float) -> list[Point]:
    """RDP for a closed ring: split at the two points farthest apart first."""
    pts = np.asarray(path, dtype=np.float64)
    if len(pts) <= 4:
        return [tuple(map(int, p)) for p in pts]
    # Farthest pair (cheap approximation: farthest from point 0, then farthest
    # from that point) keeps the split stable and O(n).
    a = int(np.argmax(np.linalg.norm(pts - pts[0], axis=1)))
    b = int(np.argmax(np.linalg.norm(pts - pts[a], axis=1)))
    if a == b:
        return [tuple(map(int, p)) for p in pts]
    i, j = sorted((a, b))
    part1 = _rdp_open(np.vstack([pts[i:j + 1]]), eps)
    part2 = _rdp_open(
        np.vstack([pts[j:], pts[:i + 1]]), eps
    )
    merged = np.vstack([part1[:-1], part2[:-1]])
    return [tuple(map(int, np.round(p))) for p in merged]


def approx_closed(path: list[Point], eps: float) -> list[Point]:
    """``cv2.approxPolyDP`` with OpenCV's own closed-polygon semantics.

    ``approxPolyDP`` returns integer corners and may rotate the start vertex;
    ``simplify_ring`` canonicalises both.  Keeping OpenCV's exact behaviour
    means the result can be compared against a user's existing OpenCV
    pipeline.
    """
    pts = np.asarray(path, dtype=np.int32).reshape(-1, 1, 2)
    out = cv2.approxPolyDP(pts, float(eps), True)
    return [tuple(map(int, p[0])) for p in out]


def vertex_merge_closed(path: list[Point], eps: float) -> list[Point]:
    """Greedy vertex-clustering simplification (keeps at least a triangle).

    ``eps`` is the maximum distance a removed vertex may move the boundary;
    corners whose removal chord stays within ``eps`` of the previous vertex
    are merged iteratively, longest straight runs first.
    """
    q = _drop_collinear(path)
    if len(q) <= 4 or eps <= 0:
        return q
    pts = np.asarray(q, dtype=np.float64)
    alive = np.ones(len(pts), dtype=bool)
    changed = True
    while changed and alive.sum() > 3:
        changed = False
        idx = np.flatnonzero(alive)
        for k in range(len(idx)):
            i = idx[k]
            a = idx[(k - 1) % len(idx)]
            c = idx[(k + 1) % len(idx)]
            # distance of b from chord a-c
            a_pt, b_pt, c_pt = pts[a], pts[i], pts[c]
            ac = c_pt - a_pt
            den = float(ac @ ac)
            if den == 0:
                continue
            t = float((b_pt - a_pt) @ ac) / den
            if not (0.0 < t < 1.0):
                continue
            proj = a_pt + t * ac
            if np.linalg.norm(b_pt - proj) <= eps:
                alive[i] = False
                changed = True
                break
    return [tuple(map(int, pts[i])) for i in np.flatnonzero(alive)]


def simplify_ring(path: list[Point], params: SimplifyParams) -> list[Point]:
    if params.method == "rdp":
        out = rdp_closed(path, params.epsilon)
    elif params.method == "approx":
        out = approx_closed(path, params.epsilon)
    elif params.method == "vertex":
        out = vertex_merge_closed(path, params.epsilon)
    else:
        raise ValueError(f"unknown simplification method {params.method!r}")
    # Keep the original orientation; drop duplicates/collinear where possible.
    try:
        clean = _drop_collinear(out)
    except Exception:
        clean = out
    if len(clean) < 3:
        clean = out
    # Preserve the input winding (outer clockwise => positive area, y down).
    if (signed_area(clean) > 0) != (signed_area(path) > 0):
        clean = list(reversed(clean))
    # A ring needs >= 3 distinct corners; a 1- or 2-pixel feature can collapse
    # to a degenerate "ring".  Fall back to the original so validation can
    # report the geometry instead of silently exporting a zero-area path.
    if len(clean) < 3 or len({tuple(p) for p in clean}) < 3:
        return list(path)
    return clean
