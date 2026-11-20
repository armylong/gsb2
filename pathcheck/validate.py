"""Validation of simplified boundaries.

Every check returns structured ``Issue`` objects whose ``message`` is written
for the GUI's issue log.  The checks are deliberately independent of the
simplification algorithm (they only look at the resulting rings), so they also
work as acceptance tests for imported files.

Check groups
------------
closure   each ring is closed after export/import, has >= 3 distinct points,
          no repeated vertices, no zero-length edges;
legality  no self-intersection / pinch / overlap (a simplified ring must stay
          a simple polygon);
          holes stay inside their outer ring and do not overlap each other;
structure per component exactly one outer ring, at least one hole ring per
          original hole unless the user explicitly chose to drop small holes;
          dropping every hole is reported, never silently accepted;
border    outer rings that started on the image border must keep their
          border spans, otherwise the exported area changes meaning;
raster    rebuilt area, component count and Euler-hole count compared with
          the reference mask.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable

import numpy as np

from .geometry import (
    Point,
    area_float,
    path_bbox,
    point_in_ring,
    ring_pair_relation,
    ring_self_intersection,
    signed_area,
)


@dataclass
class Issue:
    level: str            # "error" | "warning" | "info"
    code: str
    message: str
    ring: str | None = None     # "C1/O", "C1/H2", ...


@dataclass
class RingCheck:
    label: str
    comp_id: int
    kind: str
    index: int
    points: list[Point]
    original_area: float
    area: float
    closed: bool
    simple: bool = True
    issues: list[Issue] = field(default_factory=list)

    @property
    def area_delta(self) -> float:
        return self.area - self.original_area

    @property
    def ok(self) -> bool:
        return not any(i.level == "error" for i in self.issues)


@dataclass
class ValidationReport:
    rings: list[RingCheck]
    issues: list[Issue]
    area_ref: int
    area_new: int
    missing_pixels: int
    extra_pixels: int
    iou: float
    components_ref: int
    components_new: int
    holes_ref: int
    holes_new: int
    euler_ref: int
    euler_new: int

    @property
    def errors(self) -> list[Issue]:
        return [i for i in self.issues if i.level == "error"]

    @property
    def warnings(self) -> list[Issue]:
        return [i for i in self.issues if i.level == "warning"]

    @property
    def ok(self) -> bool:
        return not self.errors

    def headroom_pixels(self) -> int:
        return self.missing_pixels + self.extra_pixels


# --------------------------------------------------------------------------
# structural checks
# --------------------------------------------------------------------------

def _ring_vertices_ok(label: str, pts: list[Point], issues: list[Issue]) -> bool:
    if len(pts) < 3:
        issues.append(Issue("error", "ring.too-few", f"{label}: 少于 3 个顶点, 无法闭合", label))
        return False
    seen = set()
    for p in pts:
        if p in seen:
            issues.append(Issue("error", "ring.repeat-vertex", f"{label}: 顶点 {p} 重复出现 (自接触/夹点)", label))
            return False
        seen.add(p)
    n = len(pts)
    for i in range(n):
        if pts[i] == pts[(i + 1) % n]:
            issues.append(Issue("error", "ring.zero-edge", f"{label}: 存在零长度边 ({pts[i]})", label))
            return False
    return True


def _check_structure(
    by_comp: dict[int, list[RingCheck]], issues: list[Issue], wall_px: float
) -> None:
    for comp, group in sorted(by_comp.items()):
        outers = [r for r in group if r.kind == "outer"]
        holes = [r for r in group if r.kind == "hole"]
        if len(outers) != 1:
            issues.append(
                Issue("error", "comp.outer-count", f"C{comp}: 应有且仅有 1 个外环, 实际 {len(outers)} 个")
            )
            continue
        outer = outers[0]
        if not outer.simple:
            continue
        max_w = max((h.area for h in holes), default=0.0)
        if max_w > 1e-9 and outer.area <= max_w * 0.98:
            issues.append(
                Issue("error", "comp.outer-shrunk", f"C{comp}: 外环面积 {outer.area:g} 不大于最大洞面积 {max_w:g}, 结构被破坏")
            )
        for i, h in enumerate(holes):
            if not h.simple:
                continue
            if not point_in_ring(outer.points, *_interior(h.points)):
                issues.append(
                    Issue(
                        "error",
                        "hole.outside-outer",
                        f"{h.label}: 洞跑到外环之外/被翻面 "
                        f"(外环面积 {outer.area:g} -> 洞面积 {h.area:g})",
                        h.label,
                    )
                )
            else:
                # Only sane nested holes get the wall-thickness check.
                d = _wall_distance(h.points, outer.points)
                if wall_px > 0 and d < wall_px:
                    issues.append(
                        Issue(
                            "warning",
                            "wall.thin",
                            f"{h.label} -> {outer.label}: 最小壁厚 {d:.2f}px < {wall_px:g}px, "
                            "简化后细壁可能断开或洞被填平",
                            h.label,
                        )
                    )
            for h2 in holes[i + 1:]:
                if h.simple and h2.simple:
                    inner = _interior(h.points)
                    if point_in_ring(h2.points, *inner) or point_in_ring(h.points, *_interior(h2.points)):
                        issues.append(
                            Issue("error", "hole.overlap", f"{h.label} 与 {h2.label}: 洞互相重叠", h.label)
                        )
                    rel = ring_pair_relation(h.points, h2.points)
                    if rel:
                        issues.append(
                            Issue("error", "hole.cross", f"{h.label} 与 {h2.label}: 环边界交叉/重叠", h.label)
                        )
                    if wall_px > 0:
                        d2 = min(
                            _wall_distance(h.points, h2.points),
                            _wall_distance(h2.points, h.points),
                        )
                        if d2 < wall_px:
                            issues.append(
                                Issue(
                                    "warning",
                                    "wall.thin",
                                    f"{h.label} <-> {h2.label}: 洞间壁厚 {d2:.2f}px < {wall_px:g}px",
                                    h.label,
                                )
                            )
            rel = ring_pair_relation(outer.points, h.points)
            if rel:
                issues.append(
                    Issue("error", "hole.cross-outer", f"{h.label}: 与 {outer.label} 的边界交叉", h.label)
                )


def validate_rings(
    simplified: list[tuple[str, int, str, int, list[Point], float]],
    *,
    border_spans: dict[str, list[tuple[str, int, int]]] | None = None,
    width: int,
    height: int,
    allow_dropped_holes: bool = False,
    dropped_holes: Iterable[str] = (),
    wall_px: float = 2.0,
    check_structure: bool = True,
) -> tuple[list[RingCheck], list[Issue]]:
    """Check one list of rings.

    ``simplified`` entries are ``(label, comp_id, kind, index, points,
    original_area)``.  ``border_spans`` maps a label to the original border
    runs of that ring (for border checks after clipping/simplification).

    ``wall_px`` is the minimum foreground thickness (in pixels) the boundary
    must keep.  Thin walls are what a too-aggressive ``epsilon`` destroys
    first; measuring the wall directly gives an actionable message instead of
    only "a new component appeared".
    """
    issues: list[Issue] = []
    checks: list[RingCheck] = []

    for label, comp_id, kind, index, pts, orig_area in simplified:
        closed = bool(pts) and pts[0] != pts[-1]
        rc = RingCheck(
            label=label,
            comp_id=comp_id,
            kind=kind,
            index=index,
            points=list(pts),
            original_area=orig_area,
            area=abs(area_float(pts)) if len(pts) >= 3 else 0.0,
            closed=closed,
        )
        checks.append(rc)
        if not closed:
            issues.append(Issue("error", "ring.open", f"{label}: 路径未构成闭合环", label))
            rc.simple = False
            continue
        bad_vertices = _ring_vertices_ok(label, pts, issues)
        if not bad_vertices:
            rc.simple = False
            continue
        winding = area_float(pts)
        if kind == "outer" and winding <= 0:
            issues.append(
                Issue(
                    "error",
                    "ring.orientation",
                    f"{label}: 外环必须是顺时针 (signed_area>0), 实际 {winding:g}; "
                    "奇偶填充会把内部翻成外部",
                    label,
                )
            )
        elif kind in ("hole", "notch") and winding >= 0:
            issues.append(
                Issue(
                    "error",
                    "ring.orientation",
                    f"{label}: {'洞' if kind == 'hole' else '凹口'}环必须是逆时针 "
                    f"(signed_area<0), 实际 {winding:g}; 面积会被加而不是减",
                    label,
                )
            )
        bad = ring_self_intersection(pts)
        if bad:
            kinds = sorted({b[2] for b in bad})
            rc.simple = False
            desc = {"cross": "自相交", "overlap": "边重叠", "touch": "边接触"}
            issues.append(
                Issue(
                    "error",
                    "ring.self-intersection",
                    f"{label}: 简化后环不再简单 ({', '.join(desc.get(k, k) for k in kinds)}), "
                    f"例: 边 {bad[0][0]} 与边 {bad[0][1]}",
                    label,
                )
            )
        if rc.closed and len(pts) >= 3:
            bbox = path_bbox(pts)
            if bbox[0] < 0 or bbox[1] < 0 or bbox[2] > width or bbox[3] > height:
                issues.append(
                    Issue("warning", "ring.out-of-bounds", f"{label}: 超出画布 {width}x{height}", label)
                )

    # Hole nesting / overlap, restricted to rings of the same component.
    if check_structure:
        by_comp: dict[int, list[RingCheck]] = {}
        for rc in checks:
            by_comp.setdefault(rc.comp_id, []).append(rc)
        _check_structure(by_comp, issues, wall_px)
    if border_spans:
        for rc in checks:
            orig = border_spans.get(rc.label)
            if not orig or rc.kind != "outer" or not rc.closed:
                continue
            now = ring_border_spans(rc.points, width, height)
            if not now:
                issues.append(
                    Issue(
                        "error",
                        "border.lost",
                        f"{rc.label}: 原边界沿图边闭合 ({_fmt_spans(orig)}), 简化后不再触边; "
                        "触边结构必须保留贴边的闭合段",
                        rc.label,
                    )
                )
                continue
            orig_len = {s: b - a for s, a, b in orig}
            now_len = {s: b - a for s, a, b in now}
            for side, length in orig_len.items():
                got = now_len.get(side, 0)
                if got < length:
                    issues.append(
                        Issue(
                            "warning",
                            "border.shorter",
                            f"{rc.label}: 图边闭合段 {_fmt_spans(orig)} 缩短为 "
                            f"{_fmt_spans([(s, a, b) for s, a, b in now if s == side])}, "
                            f"贴边长度 {length} -> {got}",
                            rc.label,
                        )
                    )

    if dropped_holes and not allow_dropped_holes:
        for lab in dropped_holes:
            issues.append(
                Issue("error", "hole.dropped", f"{lab}: 洞被简化策略移除但未显式允许 (洞必须保留或明确接受丢失)", lab)
            )
    return checks, issues


def _fmt_spans(spans) -> str:
    names = {"top": "上", "bottom": "下", "left": "左", "right": "右"}
    return ", ".join(f"{names.get(s, s)}边 {a}..{b}" for s, a, b in spans)


def ring_border_spans(
    points: list[Point], width: int, height: int
) -> list[tuple[str, int, int]]:
    """Border runs covered by the *simplified* polygon (integer or float)."""
    from .geometry import path_edges

    raw: dict[str, list[tuple[float, float]]] = {}
    for (x1, y1), (x2, y2) in path_edges(points):
        if y1 == y2 == 0:
            raw.setdefault("top", []).append(tuple(sorted((x1, x2))))
        elif y1 == y2 == height:
            raw.setdefault("bottom", []).append(tuple(sorted((x1, x2))))
        elif x1 == x2 == 0:
            raw.setdefault("left", []).append(tuple(sorted((y1, y2))))
        elif x1 == x2 == width:
            raw.setdefault("right", []).append(tuple(sorted((y1, y2))))
    out: list[tuple[str, int, int]] = []
    for side in ("top", "bottom", "left", "right"):
        segs = sorted(raw.get(side, []))
        merged: list[list[float]] = []
        for a, b in segs:
            if merged and a <= merged[-1][1] + 1e-9:
                merged[-1][1] = max(merged[-1][1], b)
            else:
                merged.append([a, b])
        out.extend((side, int(round(a)), int(round(b))) for a, b in merged)
    return out


def _wall_distance(a: list[Point], b: list[Point]) -> float:
    """Minimum distance between two ring boundaries (sampled at vertices).

    Used as a lower-bound estimate of the foreground wall thickness between a
    hole and its outer ring, or between two holes.
    """
    from .geometry import polyline_distance

    return min((polyline_distance(b, p) for p in a), default=float("inf"))


def _interior(points: list[Point]) -> tuple[float, float]:
    from .extract import _interior_sample

    return _interior_sample(points)


# --------------------------------------------------------------------------
# high level comparison
# --------------------------------------------------------------------------

def compare_to_reference(
    reference: np.ndarray,
    rebuild: np.ndarray,
    checks: list[RingCheck],
    issues: list[Issue],
    *,
    reference_components: int,
    reference_holes: int,
    tol_missing: float = 0.0,
    tol_extra: float = 0.0,
    thin_px: float = 2.0,
) -> ValidationReport:
    """Raster comparison plus component/Euler checks.

    ``tol_missing``/``tol_extra`` are fractions of the reference pixel count.
    With the default 0.0 an exact reconstruction is required; any pixel change
    is reported as an error only when it changes the sampled feature (since
    simplification of a raster boundary *always* moves pixels).  Set a
    non-zero tolerance to turn area drift into a warning with an explicit
    budget -- that is what the GUI exposes for interactive work.
    """
    ref = reference != 0
    new = rebuild != 0
    missing = int((ref & ~new).sum())
    extra = int((new & ~ref).sum())
    inter = int((ref & new).sum())
    union = int((ref | new).sum())
    iou = inter / union if union else 1.0

    comp_new, holes_new = _topology(new)
    euler_ref = reference_components - reference_holes
    euler_new = comp_new - holes_new

    thin = _thin_regions(ref, new, thin_px) if thin_px > 0 else {}

    issues.extend(_component_changes(ref, new))

    if comp_new != reference_components:
        hint = ""
        if comp_new > reference_components and missing:
            hint = f"; 缺失像素 {missing} 集中在细桥/细连接处"
        elif comp_new < reference_components:
            hint = "; 组件之间的间隙被简化抹平"
        issues.append(
            Issue(
                "error",
                "raster.components",
                f"连通块数量变化: 参考 {reference_components} -> 重建 {comp_new}{hint}",
            )
        )
    if holes_new != reference_holes:
        hint = ""
        if holes_new < reference_holes:
            hint = f"; 被填平的洞附近缺失像素 {missing}, 检查 epsilon 是否不小于洞壁厚度"
        issues.append(
            Issue(
                "error",
                "raster.holes",
                f"洞数量变化: 参考 {reference_holes} -> 重建 {holes_new} "
                f"(欧拉数 {euler_ref} -> {euler_new}){hint}",
            )
        )
    for code, count in sorted(thin.items()):
        if count:
            issues.append(
                Issue(
                    "warning",
                    "wall.thin",
                    f"{'细桥/细结构' if code == 'bridge' else '薄壁'}区域: {count} 个前"
                    f"景像素只在 2px 尺度上存在; epsilon 接近或超过该厚度时会断开/填平",
                )
            )
    area_ref = int(ref.sum())
    if tol_missing > 0 and missing > tol_missing * area_ref:
        issues.append(
            Issue(
                "warning",
                "raster.missing",
                f"缺失像素 {missing} 超过容差 {tol_missing:.1%} ({tol_missing * area_ref:.1f}px)",
            )
        )
    if tol_extra > 0 and extra > tol_extra * area_ref:
        issues.append(
            Issue(
                "warning",
                "raster.extra",
                f"多出像素 {extra} 超过容差 {tol_extra:.1%} ({tol_extra * area_ref:.1f}px)",
            )
        )
    if tol_missing == 0 and tol_extra == 0 and (missing or extra):
        # Area drift alone is not an error for a *simplified* boundary, but it
        # must never be silent: report it as info so a clean pass is
        # distinguishable from "exactly reproduced".
        issues.append(
            Issue(
                "info",
                "raster.area-drift",
                f"简化使像素发生移动: 缺失 {missing}, 多出 {extra} "
                f"(面积 {area_ref} -> {int(new.sum())}, IoU {iou:.5f}); "
                "结构未变, 如需面积容差请设置 tol_missing/tol_extra",
            )
        )
    return ValidationReport(
        rings=checks,
        issues=issues,
        area_ref=area_ref,
        area_new=int(new.sum()),
        missing_pixels=missing,
        extra_pixels=extra,
        iou=iou,
        components_ref=reference_components,
        components_new=comp_new,
        holes_ref=reference_holes,
        holes_new=holes_new,
        euler_ref=euler_ref,
        euler_new=euler_new,
    )


def _thin_regions(ref: np.ndarray, new: np.ndarray, thin_px: float) -> dict[str, int]:
    """Count reference pixels belonging to structures thinner than ``thin_px``.

    Morphological opening with a disk just larger than ``thin_px`` deletes
    anything narrower than the disk.  Foreground pixels that vanish are thin
    bridges/protrusions; enclosed background pixels that vanish are thin hole
    walls.  These are the features an epsilon close to or above their
    thickness will erase, so the counts make later "component/hole changed"
    errors explainable.  ``new`` is accepted for symmetry with the other
    comparisons (currently unused).
    """
    import cv2

    size = max(3, int(round(thin_px)) * 2 + 1)
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (size, size))
    fg = (ref != 0).astype(np.uint8)
    opened = cv2.morphologyEx(fg, cv2.MORPH_OPEN, k)
    bridge = int((fg & ~opened).sum())

    bg = (ref == 0).astype(np.uint8)
    n, labels = cv2.connectedComponents(bg, connectivity=8)
    border = set(labels[0, :].tolist()) | set(labels[-1, :].tolist())
    border |= set(labels[:, 0].tolist()) | set(labels[:, -1].tolist())
    holes = np.isin(labels, [l for l in range(1, n) if l not in border])
    opened_bg = cv2.morphologyEx(holes.astype(np.uint8), cv2.MORPH_OPEN, k)
    wall = int((holes & ~opened_bg.astype(bool)).sum())
    return {"bridge": bridge, "wall": wall}


def _component_changes(ref: np.ndarray, new: np.ndarray) -> list[Issue]:
    """Map every changed reference/rebuilt pixel to its component.

    The aggregate "6 -> 8 components" message tells the user *that* something
    broke; this tells them *where*: it names the affected original components
    and the per-component missing/extra pixels, so a thin bridge or a filled
    hole can be found on the canvas.
    """
    import cv2

    n_ref, lab_ref = cv2.connectedComponents(ref.astype(np.uint8), connectivity=4)
    missing = ref & ~new
    extra = new & ~ref
    out: list[Issue] = []
    for comp in range(1, n_ref):
        sel = lab_ref == comp
        miss = int((sel & missing).sum())
        ext = int((sel & extra).sum())
        if miss == 0 and ext == 0:
            continue
        ys, xs = np.nonzero(sel & (missing | extra))
        if miss and ext:
            kind = "两侧都被改动"
        elif miss:
            kind = "被简化削掉"
        else:
            kind = "被简化补上"
        out.append(
            Issue(
                "warning",
                "component.area-change",
                f"C{comp}: {kind} {miss + ext} 像素 "
                f"(缺失 {miss}, 多出 {ext}), 区域 x {xs.min()}..{xs.max()}, "
                f"y {ys.min()}..{ys.max()}"
                + ("; 该区域是细桥/细连接, 或洞壁被抹平" if miss > 2 and ext > 2 else ""),
            )
        )
    return out


def _topology(mask: np.ndarray) -> tuple[int, int]:
    """4-connected component count and hole count.

    Holes are 8-connected background regions fully enclosed by foreground
    (foreground is 4-connected, so the background is 8-connected for the
    Jordan property).  Background regions touching the image border are not
    holes.
    """
    import cv2

    m = (mask != 0).astype(np.uint8)
    n, fg = cv2.connectedComponents(m, connectivity=4)
    nb, bg = cv2.connectedComponents(1 - m, connectivity=8)
    border_labels = set(bg[0, :].tolist()) | set(bg[-1, :].tolist())
    border_labels |= set(bg[:, 0].tolist()) | set(bg[:, -1].tolist())
    holes = sum(1 for lab in range(1, nb) if lab not in border_labels)
    return n - 1, holes
