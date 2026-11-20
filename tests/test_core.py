"""Regression tests for the boundary extraction/simplification checker.

Run with ``python -m pytest tests -q`` or (no pytest needed) via
``python tests/test_core.py``.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import cv2  # noqa: E402

from pathcheck.export import read_json, write_json, write_raster  # noqa: E402
from pathcheck.extract import extract  # noqa: E402
from pathcheck.geometry import signed_area  # noqa: E402
from pathcheck.pipeline import analyse  # noqa: E402
from pathcheck.render import polygon_mask, raster_diff, scanline_mask  # noqa: E402
from pathcheck.samples import SAMPLES, generate_sample, load_mask  # noqa: E402
from pathcheck.simplify import SimplifyParams  # noqa: E402
from pathcheck.validate import _topology  # noqa: E402


def _thin_bridge_mask() -> np.ndarray:
    m = np.zeros((24, 40), np.uint8)
    cv2.rectangle(m, (3, 6), (13, 17), 1, -1)
    cv2.rectangle(m, (25, 6), (35, 17), 1, -1)
    m[11, 14:25] = 1          # 1-pixel horizontal bridge
    m[8:10, 7:9] = 0          # 2x2 hole in the left block
    return m


def test_sample_topology_matches_extraction():
    for spec in SAMPLES:
        mask = generate_sample(spec.key)
        ex = extract(mask)
        comps, holes = _topology(mask)
        assert len(ex.components) == comps, spec.key
        assert ex.hole_count == holes, spec.key
        assert not ex.problems, (spec.key, ex.problems)
        net = sum(c.net_area for c in ex.components)
        # Real holes plus diagonal "notches" are both subtracted; the sum of
        # all ring areas must equal the pixel count for every sample.
        assert net == float(mask.sum()), (spec.key, net, mask.sum())


def test_crack_boundaries_reconstruct_exactly():
    for spec in SAMPLES:
        mask = generate_sample(spec.key)
        ex = extract(mask)
        rings = ex.rings
        a = scanline_mask([r.points for r in rings], mask.shape[1], mask.shape[0])
        b = polygon_mask([r.points for r in rings], mask.shape[1], mask.shape[0])
        assert np.array_equal(a, mask), spec.key
        assert np.array_equal(b, mask), spec.key


def test_orientations_and_closure():
    mask = generate_sample("metaballs")
    ex = extract(mask)
    for ring in ex.rings:
        assert ring.points[0] != ring.points[-1]          # implicitly closed
        area = signed_area(ring.points)
        if ring.kind == "outer":
            assert area > 0, ring.label                    # clockwise on screen
        else:
            assert area < 0, ring.label                    # holes anticlockwise


def test_zero_epsilon_is_identity():
    for spec in SAMPLES:
        a = analyse(generate_sample(spec.key), SimplifyParams(epsilon=0.0))
        assert a.report.missing_pixels == 0
        assert a.report.extra_pixels == 0
        assert a.report.iou == 1.0
        assert a.report.components_ref == a.report.components_new
        assert a.report.holes_ref == a.report.holes_new


def test_thin_bridge_break_is_reported():
    mask = generate_sample("bridges")
    good = analyse(mask, SimplifyParams(epsilon=0.5))
    assert good.report.ok
    broken = analyse(mask, SimplifyParams(epsilon=1.5))
    codes = {i.code for i in broken.report.errors}
    assert not broken.report.ok
    assert "raster.components" in codes


def test_hole_loss_is_reported():
    mask = generate_sample("bridges")
    broken = analyse(mask, SimplifyParams(method="vertex", epsilon=4.0))
    codes = {i.code for i in broken.report.errors}
    assert "raster.holes" in codes


def test_border_touching_ring_stays_closed():
    mask = generate_sample("metaballs")
    ex = extract(mask)
    border = [r for r in ex.rings if r.border_spans]
    assert border, "sample must contain border-touching structures"
    h, w = mask.shape
    for ring in border:
        assert ring.kind == "outer"
        # Closed loop: some corner lies exactly on the image border, and the
        # ring carries that run as an explicit border span.
        assert any(
            x in (0, w) or y in (0, h) for x, y in ring.points
        ), ring.label

    a = analyse(mask, SimplifyParams(method="vertex", epsilon=8.0))
    assert any(i.code == "border.lost" for i in a.report.errors)


def test_illegal_simplification_flagged():
    mask = generate_sample("bridges")
    a = analyse(mask, SimplifyParams(method="vertex", epsilon=4.0))
    codes = {i.code for i in a.report.errors}
    assert "hole.outside-outer" in codes or "raster.holes" in codes


def test_json_reload_roundtrip(tmp=tempfile.mkdtemp()):
    mask = generate_sample("metaballs")
    a = analyse(mask, SimplifyParams(epsilon=0.0))
    json_path = os.path.join(tmp, "case.paths.json")
    write_json(a.to_document(), json_path)
    write_raster(mask * 255, os.path.join(tmp, "case.reference.png"))
    doc = read_json(json_path)
    assert (doc.width, doc.height) == (mask.shape[1], mask.shape[0])
    assert len(doc.rings) == len(a.kept_rings)
    # Reloaded rings reproduce the stored raster exactly.
    reloaded = polygon_mask([r.points for r in doc.rings], doc.width, doc.height)
    ref = load_mask(os.path.join(tmp, "case.reference.png"))
    d = raster_diff(ref, reloaded)
    assert d.missing_count == 0 and d.extra_count == 0
    payload = json.loads(open(json_path, encoding="utf-8").read())
    assert payload["format"] == "pathcheck.boundaries"
    assert all(ring["closed"] for ring in payload["rings"])


def test_deviations_within_epsilon():
    mask = generate_sample("grid")
    a = analyse(mask, SimplifyParams(epsilon=1.0))
    for res in a.kept_rings:
        dev = res.deviation
        assert dev is not None
        # RDP guarantees the original staircase is within epsilon of the
        # simplified polyline; the reverse direction can be a hair larger.
        assert dev.max_distance <= 1.5 * 1.0 + 1e-9, (res.label, dev.max_distance)


def test_ring_orientation_contract():
    from pathcheck.validate import validate_rings

    outer = [(1, 1), (1, 9), (9, 9), (9, 1)]          # clockwise, positive
    flipped_hole = [(3, 3), (5, 3), (5, 5), (3, 5)]   # same winding -> illegal
    _, issues = validate_rings(
        [("C1/O", 1, "outer", 0, outer, 0.0),
         ("C1/H1", 1, "hole", 1, flipped_hole, 0.0)],
        width=10,
        height=10,
    )
    assert [i.code for i in issues] == ["ring.orientation", "ring.orientation"]

    bowtie = [(0, 0), (4, 4), (4, 0), (0, 4)]
    _, issues = validate_rings(
        [("C1/O", 1, "outer", 0, bowtie, 0.0)], width=8, height=8
    )
    assert any(i.code == "ring.self-intersection" for i in issues)


def test_border_lost_is_error():
    from pathcheck.validate import validate_rings

    moved = [(1, 1), (1, 5), (5, 5), (5, 1)]
    _, issues = validate_rings(
        [("C1/O", 1, "outer", 0, moved, 0.0)],
        width=8,
        height=8,
        border_spans={"C1/O": [("top", 1, 5)]},
    )
    assert any(i.code == "border.lost" and i.level == "error" for i in issues)


def test_notch_loops_are_not_counted_as_holes():
    mask = generate_sample("noise")
    ex = extract(mask)
    assert any(c.notches for c in ex.components)
    comps, holes = _topology(mask)
    assert ex.hole_count == holes
    assert ex.hole_count + sum(len(c.notches) for c in ex.components) >= holes


if __name__ == "__main__":
    failed = 0
    tests = [(k, v) for k, v in sorted(globals().items()) if k.startswith("test_")]
    for name, fn in tests:
        try:
            fn()
            print(f"ok   {name}")
        except Exception as exc:  # noqa: BLE001
            failed += 1
            print(f"FAIL {name}: {exc}")
    sys.exit(1 if failed else 0)
