"""Boundary extraction from a binary mask using 4-connected foreground.

Why not ``cv2.findContours``?  Its contours run *through* pixel centres, so a
rasterised polygon loses part of the exact staircase (OpenCV's own fill of a
one-pixel circle contour drops 12 pixels in the checker's regression test).
Here boundaries are traced on the *crack* between pixels (marching squares on
the dual grid).  Properties we rely on:

* each foreground 4-connected component owns its boundary loops;
* every loop is made of unit horizontal/vertical steps between pixel corners,
  so an even-odd scanline fill reproduces the mask **exactly** (every pixel is
  hit by exactly one boundary, so there is no half-pixel bias);
* touching the image border is handled explicitly: the boundary follows the
  border crack instead of being cut off, hence the loop is still closed and
  the outer ring keeps an area equal to the pixel count;
* 4-connectivity for foreground means diagonally touching blocks are separate
  components; their boundaries only share a corner;
* a loop that revisits a corner (a pinch, e.g. a one-pixel hole adjacent to
  the outside) is split into simple sub-loops at the repeated vertex, so every
  exported ring is a simple closed polygon (outer or hole).
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from fractions import Fraction

import cv2
import numpy as np

from .geometry import (
    Point,
    area_float,
    canonicalize,
    path_bbox,
    point_in_ring,
    signed_area,
)

# Screen-space order of the four pixel sides, clockwise on screen (y down).
_ORDER = ("R", "D", "L", "U")
_IDX = {d: i for i, d in enumerate(_ORDER)}
_SIDE_NAME = {"top": "上边 y=0", "bottom": "下边 y=H", "left": "左边 x=0", "right": "右边 x=W"}


@dataclass
class Ring:
    comp_id: int
    kind: str                     # "outer" | "hole" | "notch"
    index: int                    # 0 for outer, 1.. for holes/notches
    points: list[Point]           # canonical closed polygon (no repeated last point)
    pixel_edges: list[tuple[Point, Point]]
    border_spans: list[tuple[str, int, int]]
    nesting_depth: int = 1
    parent_ring: tuple[int, int] | None = None
    #: False for a "notch": a negative loop whose interior background is the
    #: exterior, reachable only through a diagonal gap.  It still has to be
    #: exported and subtracted so that the raster reconstruction is exact, but
    #: it is not a topological hole.
    enclosed: bool = True

    @property
    def area(self) -> float:
        return abs(area_float(self.points))

    @property
    def signed_area(self) -> float:
        return area_float(self.points)

    @property
    def bbox(self) -> tuple[int, int, int, int]:
        return path_bbox(self.points)

    @property
    def touches_border(self) -> bool:
        return bool(self.border_spans)

    @property
    def label(self) -> str:
        if self.kind == "outer":
            code = "O"
        elif self.kind == "notch":
            code = f"N{self.index}"
        else:
            code = f"H{self.index}"
        return f"C{self.comp_id}/{code}"

    def describe(self) -> str:
        if self.kind == "outer":
            return f"组件 C{self.comp_id} 外边"
        if self.kind == "notch":
            return f"组件 C{self.comp_id} 凹口 N{self.index} (对角接缝, 非拓扑洞)"
        return f"组件 C{self.comp_id} 内洞 H{self.index}"

    def border_description(self, width: int, height: int) -> str:
        if not self.border_spans:
            return "不触边"
        parts = []
        for side, a, b in self.border_spans:
            name = _SIDE_NAME[side].replace("W", str(width)).replace("H", str(height))
            coord = "x" if side in ("top", "bottom") else "y"
            parts.append(f"{name} ({coord}={a}..{b})")
        return "触边并沿图边闭合: " + ", ".join(parts)


@dataclass
class Component:
    comp_id: int
    pixel_count: int
    bbox: tuple[int, int, int, int]   # x, y, w, h in pixels
    outer: Ring
    holes: list[Ring] = field(default_factory=list)
    notches: list[Ring] = field(default_factory=list)

    @property
    def net_area(self) -> float:
        return (
            self.outer.area
            - sum(h.area for h in self.holes)
            - sum(n.area for n in self.notches)
        )

    @property
    def ring_count(self) -> int:
        return 1 + len(self.holes) + len(self.notches)

    @property
    def negative_rings(self) -> list[Ring]:
        return [*self.holes, *self.notches]


@dataclass
class Extraction:
    mask: np.ndarray
    labels: np.ndarray
    components: list[Component]
    problems: list[str]

    @property
    def rings(self) -> list[Ring]:
        out: list[Ring] = []
        for c in self.components:
            out.append(c.outer)
            out.extend(c.holes)
            out.extend(c.notches)
        return out

    @property
    def border_rings(self) -> list[Ring]:
        return [r for r in self.rings if r.touches_border]

    @property
    def pixel_count(self) -> int:
        return int(self.mask.sum())

    @property
    def hole_count(self) -> int:
        return sum(len(c.holes) for c in self.components)


def _side_edges(mask: np.ndarray, labels: np.ndarray):
    """Yield one directed unit edge per exposed pixel side.

    Directions put the foreground on the *right* of the walk, so traced outer
    cycles are clockwise on screen (positive shoelace area with y down).
    """
    h, w = mask.shape
    ys, xs = np.nonzero(mask)
    for r, c in zip(ys.tolist(), xs.tolist()):
        comp = int(labels[r, c])
        if r == 0 or not mask[r - 1, c]:          # top side: walk right
            yield comp, (c, r), (c + 1, r), "R"
        if c == w - 1 or not mask[r, c + 1]:      # right side: walk down
            yield comp, (c + 1, r), (c + 1, r + 1), "D"
        if r == h - 1 or not mask[r + 1, c]:      # bottom: walk left
            yield comp, (c + 1, r + 1), (c, r + 1), "L"
        if c == 0 or not mask[r, c - 1]:          # left side: walk up
            yield comp, (c, r + 1), (c, r), "U"


def _trace_cycles(
    edges: list[tuple[int, Point, Point, str]],
) -> tuple[list[list[int]], list[str]]:
    """Trace the midpoint graph.  Each vertex has exactly two incident edges.

    The right-most-available-turn rule keeps loops simple wherever possible;
    loops that still revisit a vertex are split later by ``_split_cycle``.
    """
    outgoing: dict[int, dict[Point, list[tuple[str, int]]]] = defaultdict(
        lambda: defaultdict(list)
    )
    for eid, (comp, s, _e, d) in enumerate(edges):
        outgoing[comp][s].append((d, eid))

    used = [False] * len(edges)
    cycles: list[list[int]] = []
    problems: list[str] = []

    vertex_order = {
        comp: sorted(verts, key=lambda v: (v[1], v[0]))
        for comp, verts in outgoing.items()
    }
    for comp in sorted(vertex_order):
        for vertex in vertex_order[comp]:
            for _d, eid in sorted(outgoing[comp][vertex], key=lambda t: _IDX[t[0]]):
                if used[eid]:
                    continue
                cycle: list[int] = []
                start_vertex = vertex
                start_eid = eid
                cur = eid
                ok = True
                while True:
                    if used[cur]:
                        problems.append(
                            f"组件 {comp}: 追踪时边被重复使用 (顶点 {start_vertex})"
                        )
                        ok = False
                        break
                    used[cur] = True
                    cycle.append(cur)
                    _c, _s, end_v, direction = edges[cur]
                    nxt = None
                    # Prefer right turn, then straight, then left.  The edge
                    # closing the loop counts even though it is already used.
                    for turn in (1, 0, -1):
                        want = _ORDER[(_IDX[direction] + turn) % 4]
                        for dd, ee in outgoing[comp].get(end_v, []):
                            if dd == want and (ee == start_eid or not used[ee]):
                                nxt = ee
                                break
                        if nxt is not None:
                            break
                    if nxt is None:
                        problems.append(f"组件 {comp}: 顶点 {end_v} 处边界不闭合")
                        ok = False
                        break
                    if nxt == start_eid:
                        if edges[nxt][1] != start_vertex:
                            problems.append(f"组件 {comp}: 闭合边指向了别的顶点")
                            ok = False
                        break
                    cur = nxt
                if ok:
                    cycles.append(cycle)
    return cycles, problems


def _split_cycle(
    edge_ids: list[int], edges: list[tuple[int, Point, Point, str]]
) -> list[list[int]]:
    """Split a closed walk at repeated vertices into simple sub-cycles.

    A foreground component can pinch at a corner (e.g. two diagonally adjacent
    foreground pixels around a background pixel that touches the outside by a
    one-pixel hole).  The Eulerian walk then visits one vertex twice.  Splitting
    there yields the outer ring plus the small hole ring, both closed.
    """
    start_vertices = [edges[e][1] for e in edge_ids]
    n = len(edge_ids)
    stack_v: list[Point] = [start_vertices[0]]
    stack_e: list[int] = []
    pos: dict[Point, int] = {start_vertices[0]: 0}
    out: list[list[int]] = []
    for i in range(1, n + 1):
        v = start_vertices[i % n]
        e = edge_ids[i - 1]
        if v in pos:
            j = pos[v]
            sub = stack_e[j:] + [e]
            if sub:
                out.append(sub)
            # Discard the consumed sub-path; keep v as the new chain end.
            for w in stack_v[j + 1:]:
                pos.pop(w, None)
            del stack_v[j + 1:]
            del stack_e[j:]
            pos[v] = j
        else:
            stack_e.append(e)
            stack_v.append(v)
            pos[v] = len(stack_v) - 1
    if stack_e:
        out.append(stack_e[:])
    return out


def _border_spans(
    pixel_edges: list[tuple[Point, Point]], w: int, h: int
) -> list[tuple[str, int, int]]:
    """Describe runs of the ring that lie exactly on the image border."""
    raw: dict[str, list[tuple[int, int]]] = defaultdict(list)
    for (x1, y1), (x2, y2) in pixel_edges:
        if y1 == y2 == 0:
            raw["top"].append(tuple(sorted((x1, x2))))
        elif y1 == y2 == h:
            raw["bottom"].append(tuple(sorted((x1, x2))))
        elif x1 == x2 == 0:
            raw["left"].append(tuple(sorted((y1, y2))))
        elif x1 == x2 == w:
            raw["right"].append(tuple(sorted((y1, y2))))
    spans: list[tuple[str, int, int]] = []
    for side in ("top", "bottom", "left", "right"):
        segs = sorted(set(raw.get(side, [])))
        merged: list[list[int]] = []
        for a, b in segs:
            if merged and a <= merged[-1][1]:
                merged[-1][1] = max(merged[-1][1], b)
            else:
                merged.append([a, b])
        spans.extend((side, a, b) for a, b in merged)
    return spans


def _interior_sample(points: list[Point]) -> tuple[float, float]:
    """A point strictly inside the polygon described by ``points``."""
    n = len(points)
    for i in range(n):
        (x1, y1), (x2, y2) = points[i], points[(i + 1) % n]
        mx, my = (x1 + x2) / 2.0, (y1 + y2) / 2.0
        dx, dy = x2 - x1, y2 - y1
        length = (dx * dx + dy * dy) ** 0.5
        if length == 0:
            continue
        # unit normal
        nx, ny = -dy / length, dx / length
        for sign in (1.0, -1.0):
            px, py = mx + sign * nx * 0.25, my + sign * ny * 0.25
            if point_in_ring(points, px, py):
                return px, py
    # Fallback: bbox centre (only reached for degenerate polygons).
    x0, y0, x1, y1 = path_bbox(points)
    return ((x0 + x1) / 2.0, (y0 + y1) / 2.0)


def _assign_nesting(rings: list[Ring], width: int, height: int) -> None:
    samples = [_interior_sample(r.points) for r in rings]
    for i, ring in enumerate(rings):
        px, py = samples[i]
        containers = [
            j
            for j, other in enumerate(rings)
            if j != i and point_in_ring(other.points, px, py)
        ]
        ring.nesting_depth = len(containers) + 1
        if containers:
            parent = min(containers, key=lambda j: abs(area_float(rings[j].points)))
            ring.parent_ring = (rings[parent].comp_id, rings[parent].index)


def _purge_spurious_holes(
    components: list[Component],
    mask: np.ndarray,
    problems: list[str],
) -> None:
    """Classify negative loops as real holes or pinch "notches".

    A negative loop appears whenever a pixel side is exposed.  When two
    background cells meet only diagonally, 4-connected foreground seals them
    off into separate loops; under the standard convention (foreground
    4-connected, background 8-connected) they are the *same* outside region.
    Such a loop surrounds no enclosed background, so it is not a topological
    hole.  It is **kept** as a ``notch`` (subtracted like a hole) because the
    even-odd fill needs it to reproduce the mask exactly; it is just excluded
    from the hole count and reported with an explanatory info message.

    Test: sample a background pixel centre inside the loop; if the
    8-connected background component containing it also touches the image
    border, the region is the exterior.
    """
    if not components:
        return
    import cv2

    bg_n, bg_labels = cv2.connectedComponents(
        (mask == 0).astype(np.uint8), connectivity=8
    )
    border_labels = set(bg_labels[0, :].tolist()) | set(bg_labels[-1, :].tolist())
    border_labels |= set(bg_labels[:, 0].tolist()) | set(bg_labels[:, -1].tolist())

    for comp in components:
        negatives = comp.holes
        comp.holes = []
        comp.notches = []
        for ring in negatives:
            label = _enclosing_bg_label(ring, mask, bg_labels)
            if label is None:
                problems.append(f"{ring.label}: 环内没有背景像素, 已剔除非洞环")
                continue
            if label in border_labels:
                ring.kind = "notch"
                ring.enclosed = False
                comp.notches.append(ring)
            else:
                ring.kind = "hole"
                ring.enclosed = True
                comp.holes.append(ring)
        comp.holes.sort(key=lambda r: (r.bbox[1], r.bbox[0]))
        comp.notches.sort(key=lambda r: (r.bbox[1], r.bbox[0]))
        for i, h in enumerate(comp.holes, start=1):
            h.index = i
        for i, n in enumerate(comp.notches, start=1):
            n.index = i


def _enclosing_bg_label(
    hole: Ring, mask: np.ndarray, bg_labels: np.ndarray
) -> int | None:
    """Background label of a pixel strictly inside the hole ring."""
    x0, y0, x1, y1 = hole.bbox
    best = None
    best_d = float("inf")
    cx, cy = (x0 + x1) / 2.0, (y0 + y1) / 2.0
    for r in range(max(0, y0), min(mask.shape[0], y1)):
        for c in range(max(0, x0), min(mask.shape[1], x1)):
            if mask[r, c]:
                continue
            if not point_in_ring(hole.points, c + 0.5, r + 0.5):
                continue
            if x0 < c + 0.5 < x1 or y0 < r + 0.5 < y1:
                d = (c + 0.5 - cx) ** 2 + (r + 0.5 - cy) ** 2
                if d < best_d:
                    best_d = d
                    best = int(bg_labels[r, c])
    return best


def extract(mask: np.ndarray) -> Extraction:
    """Trace all boundaries of ``mask`` (non-zero = foreground)."""
    mask = np.ascontiguousarray(mask != 0)
    extraction_mask = mask
    h, w = mask.shape
    _n, labels, stats, _ = cv2.connectedComponentsWithStats(
        mask.astype(np.uint8), connectivity=4
    )
    edges = list(_side_edges(mask, labels))
    cycles, problems = _trace_cycles(edges)
    edge_lookup = {eid: edge for eid, edge in enumerate(edges)}

    comp_loops: dict[int, list[Ring]] = defaultdict(list)
    for cycle in cycles:
        comp = edge_lookup[cycle[0]][0]
        for sub in _split_cycle(cycle, edges):
            pts = [edge_lookup[eid][1] for eid in sub]
            area = signed_area(pts)
            if area == 0:
                problems.append(f"组件 {comp}: 面积为 0 的退化环")
                continue
            clockwise = area > 0
            try:
                canon = canonicalize(pts, clockwise=clockwise)
            except ValueError as exc:
                problems.append(f"组件 {comp}: {exc}")
                continue
            pixel_edges = [(edge_lookup[eid][1], edge_lookup[eid][2]) for eid in sub]
            comp_loops[comp].append(
                Ring(
                    comp_id=comp,
                    kind="outer" if clockwise else "hole",
                    index=0,
                    points=canon,
                    pixel_edges=pixel_edges,
                    border_spans=_border_spans(pixel_edges, w, h),
                )
            )

    components: list[Component] = []
    for comp in sorted(comp_loops):
        loops = comp_loops[comp]
        outers = [r for r in loops if r.kind == "outer"]
        negatives = [r for r in loops if r.kind == "hole"]
        if len(outers) != 1:
            problems.append(f"组件 {comp}: 期望 1 个外环, 实际 {len(outers)} 个")
            if not outers:
                continue
        outer = outers[0]
        outer.index = 0
        negatives.sort(key=lambda r: (r.bbox[1], r.bbox[0]))
        x, y, bw, bh, _area = stats[comp]
        components.append(
            Component(
                comp_id=comp,
                pixel_count=int((labels == comp).sum()),
                bbox=(int(x), int(y), int(bw), int(bh)),
                outer=outer,
                holes=negatives,
            )
        )

    _purge_spurious_holes(components, extraction_mask, problems)
    rings = [r for c in components for r in (c.outer, *c.holes, *c.notches)]
    _assign_nesting(rings, w, h)

    total = sum(c.net_area for c in components)
    px = int(mask.sum())
    if abs(total - px) > 1e-9:
        problems.append(
            f"面积不守恒: 边界净面积 {total}, 像素数 {px} "
            "(外环面积减去洞/凹口面积应等于像素数)"
        )
    if abs(sum(c.pixel_count for c in components) - px) > 0:
        problems.append("组件像素数与掩码不一致")

    return Extraction(mask=mask, labels=labels, components=components, problems=problems)


def ring_area_exact(ring: Ring) -> Fraction:
    return abs(signed_area(ring.points))
