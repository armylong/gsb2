"""Mask document: painting, softness, undo/redo, inversion, endpoints."""

from __future__ import annotations

import numpy as np
import pytest

from mblend.mask import (
    BASE_VALUE,
    MaskDocument,
    TARGET_A,
    TARGET_B,
    paint_segment,
    stamp,
    stroke_points,
)


def test_stroke_points_cover_the_segment():
    points = stroke_points((0, 0), (10, 0), 2.0)
    assert points[0][0] > 0
    assert points[-1] == pytest.approx((10, 0))
    xs = [p[0] for p in points]
    assert max(np.diff(xs)) <= 2.0 + 1e-6


def test_hard_brush_is_a_disc():
    bbox, weights = stamp((50, 50), 25, 25, 6, 0.0)
    assert weights.max() == 1.0
    assert weights.shape == (bbox[1] - bbox[0], bbox[3] - bbox[2])
    assert weights[weights.shape[0] // 2, weights.shape[1] // 2] == 1.0


def test_soft_brush_falls_off_to_zero():
    _, weights = stamp((80, 80), 40, 40, 12, 0.8)
    assert weights.max() <= 1.0
    assert weights[0, 0] == pytest.approx(0.0, abs=1e-6)
    assert weights[weights.shape[0] // 2, weights.shape[1] // 2] > 0.9


def test_painting_towards_a_reaches_one():
    mask = np.full((40, 40), BASE_VALUE, np.float32)
    for _ in range(6):
        paint_segment(mask, (20, 20), (20, 20), 5, 0.6, TARGET_A)
    assert mask.max() == pytest.approx(1.0, abs=1e-5)
    assert mask[20, 20] == pytest.approx(1.0, abs=1e-5)


def test_painting_towards_b_reaches_zero():
    mask = np.full((40, 40), BASE_VALUE, np.float32)
    for _ in range(6):
        paint_segment(mask, (20, 20), (20, 20), 5, 0.6, TARGET_B)
    assert mask[20, 20] == pytest.approx(0.0, abs=1e-5)


def test_brush_never_leaves_the_mask_range():
    mask = np.full((30, 30), 0.9, np.float32)
    paint_segment(mask, (0, 0), (30, 30), 4, 1.0, TARGET_B)
    assert mask.min() >= 0.0 and mask.max() <= 1.0


def test_mask_starts_at_half_and_fills():
    doc = MaskDocument(20, 30)
    assert np.allclose(doc.mask, BASE_VALUE)
    assert doc.fill_a()
    assert np.all(doc.mask == 1.0)
    assert doc.fill_b()
    assert np.all(doc.mask == 0.0)


def test_undo_redo_restores_exact_values():
    doc = MaskDocument(30, 30)
    doc.begin_stroke()
    doc.paint((5, 5), (25, 20), 6, 0.4, TARGET_A)
    assert doc.end_stroke()
    painted = doc.mask.copy()
    assert doc.undo()
    assert np.allclose(doc.mask, BASE_VALUE)
    assert doc.redo()
    assert np.array_equal(doc.mask, painted)


def test_undo_redo_of_whole_mask_operations():
    doc = MaskDocument(12, 12)
    doc.fill_a()
    doc.invert()
    assert np.all(doc.mask == 0.0)
    doc.undo()
    assert np.all(doc.mask == 1.0)
    doc.undo()
    assert np.allclose(doc.mask, BASE_VALUE)
    doc.redo()
    doc.redo()
    assert np.all(doc.mask == 0.0)


def test_new_stroke_clears_redo():
    doc = MaskDocument(20, 20)
    doc.fill_a()
    doc.undo()
    assert doc.can_redo
    doc.fill_b()
    assert not doc.can_redo


def test_noop_stroke_is_not_recorded():
    doc = MaskDocument(20, 20)
    doc.begin_stroke()
    doc.paint((5, 5), (5, 5), 0.1, 0.0, BASE_VALUE)
    doc.end_stroke()
    assert not doc.can_undo


def test_invert_of_soft_mask():
    doc = MaskDocument(16, 16)
    doc.begin_stroke()
    doc.paint((8, 8), (8, 8), 4, 1.0, TARGET_A)
    doc.end_stroke()
    before = doc.mask.copy()
    doc.invert()
    assert np.allclose(doc.mask, 1.0 - before)


def test_fill_region():
    doc = MaskDocument(10, 10)
    region = np.zeros((10, 10), bool)
    region[2:5, 3:7] = True
    assert doc.set_target(1.0, region)
    assert np.all(doc.mask[region] == 1.0)
    assert np.all(doc.mask[~region] == BASE_VALUE)


def test_stats():
    doc = MaskDocument(8, 8)
    doc.fill_a()
    stats = doc.stats()
    assert stats["mean"] == 1.0
    assert stats["a_fraction"] == 1.0
    assert stats["b_fraction"] == 0.0
