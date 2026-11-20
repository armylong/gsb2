"""One-call pipeline used by the GUI, the CLI and the tests.

``analyse(mask, params)``:
    extract exact boundaries -> simplify -> validate -> rasterise -> compare.

The result contains everything the UI needs (rings for drawing, deviation
regions, issue list, topology numbers) and everything the exporter needs.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from .deviation import Deviation, ring_deviation
from .export import ExportedRing, ExportDocument
from .extract import Component, Extraction, Ring, extract
from .render import raster_diff, reconstruct
from .simplify import METHODS, SimplifyParams, simplify_ring
from .validate import (
    Issue,
    RingCheck,
    ValidationReport,
    _topology,
    compare_to_reference,
    validate_rings,
)


@dataclass
class RingResult:
    label: str
    comp_id: int
    kind: str
    index: int
    original: list[tuple[int, int]]
    simplified: list[tuple[int, int]]
    dropped: bool = False
    deviation: Deviation | None = None
    original_area: float = 0.0
    simplified_area: float = 0.0
    original_points: int = 0
    simplified_points: int = 0
    border_spans: list[tuple[str, int, int]] = field(default_factory=list)

    @property
    def area_delta(self) -> float:
        return self.simplified_area - self.original_area


@dataclass
class Analysis:
    mask: np.ndarray
    extraction: Extraction
    params: SimplifyParams
    rings: list[RingResult]
    report: ValidationReport
    rebuild: np.ndarray
    width: int
    height: int
    deviations: list[Deviation] = field(default_factory=list)
    reference_name: str = "reference.png"

    @property
    def components(self) -> list[Component]:
        return self.extraction.components

    @property
    def issues(self) -> list[Issue]:
        return self.report.issues

    @property
    def worst_deviation(self) -> Deviation | None:
        return max(self.deviations, key=lambda d: d.max_distance, default=None)

    @property
    def kept_rings(self) -> list[RingResult]:
        return [r for r in self.rings if not r.dropped]

    def exported_rings(self) -> list[ExportedRing]:
        return [
            ExportedRing(
                comp=r.comp_id,
                kind=r.kind,
                index=r.index,
                points=r.simplified,
                border_spans=r.border_spans,
            )
            for r in self.kept_rings
        ]

    def to_document(self) -> ExportDocument:
        report = self.report
        return ExportDocument(
            width=self.width,
            height=self.height,
            rings=self.exported_rings(),
            params={
                "method": self.params.method,
                "epsilon": self.params.epsilon,
                "min_hole_ratio": self.params.min_hole_ratio,
                "min_hole_area": self.params.min_hole_area,
                "describe": self.params.describe(),
            },
            validations={
                "ok": report.ok,
                "errors": len(report.errors),
                "warnings": len(report.warnings),
                "area_ref": report.area_ref,
                "area_new": report.area_new,
                "missing": report.missing_pixels,
                "extra": report.extra_pixels,
                "iou": report.iou,
                "components_ref": report.components_ref,
                "components_new": report.components_new,
                "holes_ref": report.holes_ref,
                "holes_new": report.holes_new,
                "euler_ref": report.euler_ref,
                "euler_new": report.euler_new,
                "issues": [
                    {"level": i.level, "code": i.code, "message": i.message, "ring": i.ring}
                    for i in report.issues
                ],
            },
            meta={
                "generator": "pathcheck",
                # The other half of the reload round-trip: a reference raster
                # stored next to the JSON lets ``verify`` re-check it without
                # the original image.
                "reference": {"png": self.reference_name, "rule": "non-zero = foreground"},
            },
        )


def simplify_rings(
    extraction: Extraction, params: SimplifyParams
) -> tuple[list[RingResult], list[str]]:
    """Simplify every ring; holes may only vanish via an explicit policy."""
    results: list[RingResult] = []
    dropped: list[str] = []
    for comp in extraction.components:
        outer = comp.outer
        outer_area = max(outer.area, 1e-9)
        for ring in (outer, *comp.holes, *comp.notches):
            label = ring.label
            pts = ring.points
            new_pts = simplify_ring(pts, params)
            is_hole = ring.kind == "hole"
            drop = False
            if is_hole and ring.area > 0:
                ratio = ring.area / outer_area
                if params.min_hole_ratio > 0 and ratio <= params.min_hole_ratio:
                    drop = True
                if params.min_hole_area > 0 and ring.area <= params.min_hole_area:
                    drop = True
            if drop:
                dropped.append(label)
            results.append(
                RingResult(
                    label=label,
                    comp_id=ring.comp_id,
                    kind=ring.kind,
                    index=ring.index,
                    original=pts,
                    simplified=new_pts,
                    dropped=drop,
                    original_area=ring.area,
                    simplified_area=abs(_area(new_pts)),
                    original_points=len(pts),
                    simplified_points=len(new_pts),
                    border_spans=list(ring.border_spans),
                )
            )
    return results, dropped


def _area(pts) -> float:
    from .geometry import area_float

    return area_float(pts)


def analyse(
    mask: np.ndarray,
    params: SimplifyParams | None = None,
    *,
    allow_dropped_holes: bool = False,
    wall_px: float = 2.0,
    **kwargs,
) -> Analysis:
    """Run the full pipeline.  Extra kwargs go to ``compare_to_reference``."""
    params = params or SimplifyParams()
    extraction = extract(mask)
    h, w = extraction.mask.shape

    results, dropped = simplify_rings(extraction, params)
    kept = [r for r in results if not r.dropped]

    border_spans = {r.label: r.border_spans for r in results}
    notches = set()
    for comp in extraction.components:
        for n in comp.notches:
            notches.add(n.label)
    simplified_entries = [
        (r.label, r.comp_id, r.kind, r.index, r.simplified, r.original_area)
        for r in kept
        if r.kind == "outer" or r.label not in notches
    ]
    notch_entries = [
        (r.label, r.comp_id, r.kind, r.index, r.simplified, r.original_area)
        for r in kept
        if r.label in notches
    ]
    checks, issues = validate_rings(
        simplified_entries,
        border_spans=border_spans,
        width=w,
        height=h,
        dropped_holes=dropped,
        allow_dropped_holes=allow_dropped_holes,
        wall_px=wall_px,
    )
    # Notch loops only need closure/simplicity; they are not holes.
    notch_checks, notch_issues = validate_rings(
        notch_entries,
        width=w,
        height=h,
        allow_dropped_holes=True,
        check_structure=False,
    )
    # Notches belong to their outer ring: they are subtracted rather than
    # nested, so structural hole checks would misfire.  Validate them for
    # closure and simplicity only, and never let them produce duplicate codes.
    checks.extend(notch_checks)
    mine = {id(i) for i in issues}
    issues.extend(i for i in notch_issues if id(i) not in mine)
    issues.extend(Issue("error", "extract.problem", p) for p in extraction.problems)
    if any(c.notches for c in extraction.components):
        issues.append(
            Issue(
                "info",
                "notch.count",
                f"{sum(len(c.notches) for c in extraction.components)} 个对角凹口 "
                "(负向环, 仅用于奇偶填充复原, 不计作洞)",
            )
        )

    rebuild = reconstruct(
        [type("R", (), {"points": r.simplified})() for r in kept], w, h
    )
    report = compare_to_reference(
        extraction.mask,
        rebuild,
        checks,
        issues,
        reference_components=len(extraction.components),
        reference_holes=extraction.hole_count,
        thin_px=wall_px,
        **kwargs,
    )

    deviations: list[Deviation] = []
    for r in kept:
        dev = ring_deviation(r.original, r.simplified, params.epsilon)
        r.deviation = dev
        deviations.append(dev)

    return Analysis(
        mask=extraction.mask,
        extraction=extraction,
        params=params,
        rings=results,
        report=report,
        rebuild=rebuild,
        width=w,
        height=h,
        deviations=deviations,
    )


def find_first_failure(
    mask: np.ndarray,
    params: SimplifyParams | None = None,
    *,
    max_eps: float = 12.0,
    step: float = 0.5,
    **kwargs,
) -> tuple[float, Analysis] | None:
    """Scan epsilon upward and return the first analysis that fails.

    Simplification damage is monotone *in practice* for a fixed method (a
    larger chord erases more), but not guaranteed cell by cell -- so we return
    the first failing value rather than assuming a threshold exists.
    """
    base = params or SimplifyParams()
    eps = step
    while eps <= max_eps + 1e-9:
        candidate = SimplifyParams(
            method=base.method,
            epsilon=eps,
            min_hole_ratio=base.min_hole_ratio,
            min_hole_area=base.min_hole_area,
        )
        a = analyse(mask, candidate, **kwargs)
        if not a.report.ok:
            return eps, a
        eps = round(eps + step, 6)
    return None


__all__ = [
    "Analysis",
    "RingResult",
    "analyse",
    "find_first_failure",
    "simplify_rings",
    "extract",
    "SimplifyParams",
    "METHODS",
]
