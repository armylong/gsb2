"""Pytest suite.  GUI tests run on Qt's ``offscreen`` platform.

Coverage maps to the brief:
  * hard constraints & algorithm determinism     -> test_constraints.py
  * zoomed brush mapping, undo/redo              -> test_interaction.py
  * record validation, stale preview, export     -> test_record_export.py
"""

from __future__ import annotations

import os

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import numpy as np
import pytest

from matting.constraints import BG, ERASE, FG, LabelMap, Stroke, StrokeHistory
from matting.engine import ComputeSettings, MattingError, compute_matting
from matting.samples import SAMPLES, generate_sample

# Smaller blobs keep the GrabCut calls in the test suite fast.
FAST = dict(refine_radius=3, grabcut_iterations=3)


@pytest.fixture(scope="session")
def qapp():
    from PySide6 import QtWidgets

    app = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])
    yield app


@pytest.fixture(scope="session")
def jug():
    return generate_sample("jug")


@pytest.fixture(scope="session")
def sample_keys():
    return tuple(SAMPLES)


def build_history(sample) -> StrokeHistory:
    h, w = sample.image.shape[:2]
    history = StrokeHistory(h, w)
    for stroke in sample.strokes:
        history.push(stroke)
    return history


# ---------------------------------------------------------------------------
# algorithm / hard constraints
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("key", tuple(SAMPLES))
def test_sample_quality(key):
    sample = generate_sample(key)
    history = build_history(sample)
    result = compute_matting(
        sample.image, history.labels, ComputeSettings(box=sample.box, **FAST)
    )
    iou = (
        np.logical_and(result.alpha > 0.5, sample.alpha > 0.5).sum()
        / np.logical_or(result.alpha > 0.5, sample.alpha > 0.5).sum()
    )
    assert iou >= 0.90
    assert float(((result.alpha - sample.alpha) ** 2).mean()) <= 0.01


@pytest.mark.parametrize("key", ("jug", "ring"))
def test_hard_constraints(key):
    sample = generate_sample(key)
    history = build_history(sample)
    result = compute_matting(
        sample.image, history.labels, ComputeSettings(box=sample.box, **FAST)
    )
    assert np.all(result.alpha[history.labels.data == FG] == 1.0)
    assert np.all(result.alpha[history.labels.data == BG] == 0.0)
    # outside the box must be fully transparent
    x0, y0, x1, y1 = sample.box
    assert result.alpha[:y0].max() == 0.0
    assert result.alpha[y1:].max() == 0.0


def test_deterministic_recompute(jug):
    history = build_history(jug)
    cfg = ComputeSettings(box=jug.box, **FAST)
    a = compute_matting(jug.image, history.labels, cfg)
    b = compute_matting(jug.image, history.labels, cfg)
    assert np.array_equal(a.alpha, b.alpha)


def test_recompute_uses_only_original_and_constraints(jug):
    """Adding a stroke then removing it must return to the original result."""
    history = build_history(jug)
    cfg = ComputeSettings(box=jug.box, **FAST)
    first = compute_matting(jug.image, history.labels, cfg)
    # A new *background* mark inside the jug body forces that area transparent,
    # so the result must change...
    extra = Stroke(kind=BG, radius=11.0, points=[(500.0, 560.0)])
    history.push(extra)
    second = compute_matting(jug.image, history.labels, cfg)
    assert not np.array_equal(first.alpha, second.alpha)
    # ...and undoing it must give back the *identical* earlier result, proving the
    # recompute never fed the previous cut-out back in.
    history.undo()
    third = compute_matting(jug.image, history.labels, cfg)
    assert np.array_equal(first.alpha, third.alpha)


def test_trimap_isolates_the_soft_band(jug):
    history = build_history(jug)
    result = compute_matting(jug.image, history.labels, ComputeSettings(box=jug.box, **FAST))
    unknown = result.trimap == 128
    assert unknown.any(), "refinement should leave an unknown band"
    # Outside the band the result is binary...
    assert np.all(result.alpha[result.trimap == 255] > 0.5)
    assert np.all(result.alpha[result.trimap == 0] <= 0.5)
    # ...and every partial (anti-aliased) pixel lives inside the band.
    partial = (result.alpha > 0.02) & (result.alpha < 0.98)
    assert np.count_nonzero(partial & ~unknown) == 0
    # Hard marks keep their exact values even where they cross the band.
    assert np.all(result.alpha[history.labels.data == FG] == 1.0)
    assert np.all(result.alpha[history.labels.data == BG] == 0.0)


def test_soft_edges_exist(jug):
    history = build_history(jug)
    result = compute_matting(jug.image, history.labels, ComputeSettings(box=jug.box, **FAST))
    soft = np.count_nonzero((result.alpha > 0.05) & (result.alpha < 0.95))
    assert soft > 500, "expected an anti-aliased / feathered boundary"


def test_no_dark_fringe_on_dark_backdrop(jug):
    from matting.imageio import composite

    history = build_history(jug)
    result = compute_matting(jug.image, history.labels, ComputeSettings(box=jug.box, **FAST))
    dark = composite(result.foreground, result.alpha, (18, 18, 18)).astype(np.float32)
    band = (result.alpha > 0.2) & (result.alpha < 0.8)
    # compare with the ideal composite using the true object colour
    truth = np.array(jug.spec.foreground_color, np.float32)
    ideal = truth[None, None, :] * result.alpha[:, :, None] + 18.0 * (1 - result.alpha[:, :, None])
    err = np.abs(dark[band] - ideal[band]).mean()
    assert err < 12.0, f"soft edge drifts {err:.1f} levels from ideal (fringe)"


@pytest.mark.parametrize(
    "mutator,expected",
    [
        (lambda s: _label_only(s, BG), "no_foreground"),
        (lambda s: _label_only(s, FG), "no_background"),
    ],
)
def test_missing_marks_errors(jug, mutator, expected):
    labels = mutator(jug)
    with pytest.raises(MattingError) as excinfo:
        compute_matting(jug.image, labels, ComputeSettings(box=jug.box, **FAST))
    assert excinfo.value.code == expected


def _label_only(sample, kind):
    h, w = sample.image.shape[:2]
    labels = LabelMap(h, w)
    x0, y0, x1, y1 = sample.box
    labels.data[y0 + 20:y0 + 40, x0 + 20:x0 + 40] = kind
    return labels


def test_tiny_box_error(jug):
    labels = _label_only(jug, FG)
    labels.data[100:120, 100:120] = BG
    with pytest.raises(MattingError) as excinfo:
        compute_matting(jug.image, labels, ComputeSettings(box=(50, 50, 60, 60), **FAST))
    assert excinfo.value.code == "box_too_small"


def test_uniform_image_error(jug):
    flat = np.full_like(jug.image, 128)
    labels = _label_only(jug, FG)
    x0, y0, x1, y1 = jug.box
    labels.data[y0 + 200:y0 + 220, x0 + 200:x0 + 220] = BG
    with pytest.raises(MattingError) as excinfo:
        compute_matting(flat, labels, ComputeSettings(box=jug.box, **FAST))
    assert excinfo.value.code == "uniform_image"


def test_failure_keeps_history(jug):
    from ui.document import Document

    doc = Document()
    doc.load_image(jug.image, "jug")
    doc.set_box(jug.box)
    doc.load_strokes(jug.strokes)
    assert doc.compute() is not None
    alpha_before = doc.result.alpha.copy()
    # Remove all foreground marks: compute must fail but keep state.
    doc.history.load_json([s for s in doc.history.to_json() if s["kind"] != FG])
    doc.constraints_changed.emit()
    assert doc.compute() is None
    assert "缺少确定前景" in doc.last_error
    # The remaining (background-only) strokes are kept, never silently dropped.
    assert len(doc.history) == 4
    assert np.array_equal(doc.result.alpha, alpha_before)
    assert doc.is_stale()


# ---------------------------------------------------------------------------
# undo / redo / eraser semantics
# ---------------------------------------------------------------------------


def test_one_gesture_one_undo(jug):
    h, w = jug.image.shape[:2]
    history = StrokeHistory(h, w)
    stroke = Stroke(kind=FG, radius=10.0, points=[(100 + i * 3, 200.0) for i in range(50)])
    history.push(stroke)
    assert len(history) == 1
    assert history.labels.count(FG) > 0
    history.undo()
    assert history.labels.count(FG) == 0
    history.redo()
    assert history.labels.count(FG) > 0


def test_undo_restores_mixed_strokes_exactly(jug):
    h, w = jug.image.shape[:2]
    history = StrokeHistory(h, w)
    fg = Stroke(kind=FG, radius=12.0, points=[(300.0, 300.0), (360.0, 320.0)])
    bg = Stroke(kind=BG, radius=12.0, points=[(300.0, 300.0), (360.0, 320.0)])
    history.push(fg)
    history.push(bg)
    snapshot = history.labels.data.copy()
    history.undo()
    assert np.array_equal(history.labels.data == BG, np.zeros((h, w), bool))
    history.redo()
    assert np.array_equal(history.labels.data, snapshot)


def test_eraser_clears_labels(jug):
    h, w = jug.image.shape[:2]
    history = StrokeHistory(h, w)
    history.push(Stroke(kind=FG, radius=15.0, points=[(200.0, 200.0), (260.0, 210.0)]))
    painted = history.labels.count(FG)
    assert painted > 0
    history.push(Stroke(kind=ERASE, radius=15.0, points=[(200.0, 200.0)]))
    assert history.labels.count(FG) < painted


def test_new_stroke_drops_redo_branch(jug):
    h, w = jug.image.shape[:2]
    history = StrokeHistory(h, w)
    history.push(Stroke(kind=FG, radius=8.0, points=[(50.0, 50.0)]))
    history.push(Stroke(kind=FG, radius=8.0, points=[(90.0, 90.0)]))
    history.undo()
    assert history.can_redo()
    history.push(Stroke(kind=BG, radius=8.0, points=[(130.0, 130.0)]))
    assert not history.can_redo()


# ---------------------------------------------------------------------------
# document-level behaviour
# ---------------------------------------------------------------------------


def test_new_image_clears_old_constraints(jug, qapp):
    from ui.document import Document

    other = generate_sample("ring")
    doc = Document()
    doc.load_image(jug.image, "jug")
    doc.set_box(jug.box)
    doc.load_strokes(jug.strokes)
    doc.compute()
    assert doc.result is not None

    doc.load_image(other.image, "ring", sample_key="ring")
    assert doc.result is None
    assert doc.settings.box is None
    assert len(doc.history) == 0
    assert doc.history.labels.count(FG) == 0
    assert not doc.status().has_result
    assert doc.is_stale()


def test_stale_tracking(jug, qapp):
    from ui.document import Document

    doc = Document()
    doc.load_image(jug.image, "jug")
    doc.set_box(jug.box)
    doc.load_strokes(jug.strokes)
    assert doc.is_stale() and doc.result is None
    doc.compute()
    assert not doc.is_stale()
    doc.commit_stroke(Stroke(kind=FG, radius=8.0, points=[(505.0, 500.0)]))
    assert doc.is_stale()
