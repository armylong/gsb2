"""Constraint-record validation, export consistency and stale-preview guards."""

from __future__ import annotations

import json
import os

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import cv2
import numpy as np
import pytest

from matting.constraints import Stroke, StrokeHistory
from matting.engine import ComputeSettings, compute_matting
from matting.imageio import ensure_bgra, fingerprint_image, read_png_bgra
from matting.record import ConstraintRecord, RecordError, state_key
from matting.samples import generate_sample
from ui.exports import export_alpha_png, export_constraints, export_foreground_png

FAST = dict(refine_radius=3, grabcut_iterations=3)


def _setup(key="jug"):
    sample = generate_sample(key)
    h, w = sample.image.shape[:2]
    history = StrokeHistory(h, w)
    for stroke in sample.strokes:
        history.push(stroke)
    settings = ComputeSettings(box=sample.box, **FAST)
    return sample, history, settings


# ---------------------------------------------------------------------------
# record contents
# ---------------------------------------------------------------------------


def test_record_contains_fingerprint_and_size():
    sample, history, settings = _setup()
    record = ConstraintRecord.build(sample.image, sample.box, settings, history)
    data = record.to_dict()
    assert data["format"] == "scribble-matting-constraints"
    assert data["image"]["width"] == sample.image.shape[1]
    assert data["image"]["height"] == sample.image.shape[0]
    assert len(data["image"]["sha256"]) == 64
    assert data["box"] == list(sample.box)
    assert len(data["strokes"]) == len(sample.strokes)
    assert "saved_at" in data


def test_record_round_trip_is_lossless():
    sample, history, settings = _setup()
    record = ConstraintRecord.build(sample.image, sample.box, settings, history)
    text = record.to_json()
    loaded = ConstraintRecord.from_json(text, sample.image)

    new_history = StrokeHistory(*sample.image.shape[:2])
    new_settings = ComputeSettings()
    loaded.apply_to(new_history, new_settings)
    assert np.array_equal(new_history.labels.data, history.labels.data)
    assert new_settings.box == settings.box
    assert new_settings.refine_radius == settings.refine_radius


def test_record_rejects_different_size():
    sample, history, settings = _setup()
    text = ConstraintRecord.build(sample.image, sample.box, settings, history).to_json()
    smaller = cv2.resize(sample.image, (sample.image.shape[1] // 2, sample.image.shape[0] // 2))
    with pytest.raises(RecordError) as excinfo:
        ConstraintRecord.from_json(text, smaller)
    assert excinfo.value.code == "record_size_mismatch"


def test_record_rejects_same_size_different_pixels():
    sample, history, settings = _setup()
    text = ConstraintRecord.build(sample.image, sample.box, settings, history).to_json()
    altered = sample.image.copy()
    altered[10, 10] = (altered[10, 10] + 1) % 255
    with pytest.raises(RecordError) as excinfo:
        ConstraintRecord.from_json(text, altered)
    assert excinfo.value.code == "record_content_mismatch"


def test_record_rejects_garbage_json():
    sample, _, _ = _setup()
    with pytest.raises(RecordError):
        ConstraintRecord.from_json("{not json", sample.image)
    with pytest.raises(RecordError):
        ConstraintRecord.from_json(json.dumps({"format": "other"}), sample.image)


def test_record_rejects_corrupt_stroke():
    sample, history, settings = _setup()
    record = ConstraintRecord.build(sample.image, sample.box, settings, history)
    data = record.to_dict()
    data["strokes"][0]["points"] = [[1e9, 2e9]]
    with pytest.raises(RecordError) as excinfo:
        ConstraintRecord.from_json(json.dumps(data), sample.image)
    assert excinfo.value.code in ("record_bad_stroke", "record_stroke_out_of_bounds")


def test_document_load_record_marks_stale():
    from ui.document import Document

    sample, history, settings = _setup()
    text = ConstraintRecord.build(sample.image, sample.box, settings, history).to_json()

    doc = Document()
    doc.load_image(sample.image, "jug")
    assert doc.is_stale() and doc.result is None
    record = ConstraintRecord.from_json(text, doc.image)
    doc.load_record(record)
    assert doc.result is None  # a loaded record is NOT treated as done
    assert doc.is_stale()
    assert doc.status().fg_count > 0 and doc.status().bg_count > 0
    result = doc.compute()
    assert result is not None and not doc.is_stale()


# ---------------------------------------------------------------------------
# export consistency
# ---------------------------------------------------------------------------


def test_transparent_png_alpha_matches_preview(tmp_path):
    sample, history, settings = _setup()
    result = compute_matting(sample.image, history.labels, settings)
    path = str(tmp_path / "fg.png")
    export_foreground_png(path, result)
    rgba = read_png_bgra(path)
    assert rgba.shape[2] == 4
    back = rgba[:, :, 3].astype(np.float32) / 255.0
    assert np.abs(back - result.alpha).max() <= 1.0 / 255.0


def test_gray_alpha_png_matches(tmp_path):
    sample, history, settings = _setup()
    result = compute_matting(sample.image, history.labels, settings)
    path = str(tmp_path / "alpha.png")
    export_alpha_png(path, result)
    gray = cv2.imdecode(np.fromfile(path, np.uint8), cv2.IMREAD_GRAYSCALE)
    expected = np.clip(result.alpha * 255.0 + 0.5, 0, 255).astype(np.uint8)
    assert np.array_equal(gray, expected)


def test_composite_preview_equals_export(tmp_path):
    """The composite preview and the exported RGBA must be the same colours."""
    from matting.imageio import BACKDROP_DARK, composite, composite_on_backdrop

    sample, history, settings = _setup()
    result = compute_matting(sample.image, history.labels, settings)
    path = str(tmp_path / "fg.png")
    export_foreground_png(path, result)

    # What the preview shows for the built-in "dark" backdrop:
    preview_on_dark = composite_on_backdrop(result.foreground, result.alpha, "dark")
    # The same exported file, composited by any external consumer over the same colour:
    rgba = read_png_bgra(path).astype(np.float32)
    backdrop = np.round(BACKDROP_DARK * 255.0).astype(np.int16)
    exported_on_dark = composite(rgba[:, :, :3], rgba[:, :, 3] / 255.0, backdrop)
    assert np.abs(exported_on_dark.astype(np.int16) - preview_on_dark.astype(np.int16)).max() <= 1


def test_exported_edge_has_no_black_fringe(tmp_path):
    sample, history, settings = _setup()
    result = compute_matting(sample.image, history.labels, settings)
    data = ensure_bgra(result.foreground, result.alpha)
    band = (result.alpha > 0.2) & (result.alpha < 0.8)
    # Straight (unpremultiplied) RGBA: hidden colour at partially transparent
    # pixels must resemble the object, not black.
    lum = data[:, :, :3].astype(np.float32).mean(axis=2)
    assert float(lum[band].mean()) > 40.0
    assert float(lum[band].min()) > 12.0


def test_constraints_file_written(tmp_path):
    sample, history, settings = _setup()
    record = ConstraintRecord.build(sample.image, sample.box, settings, history)
    path = str(tmp_path / "c.json")
    export_constraints(path, record)
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    assert data["image"]["sha256"] == fingerprint_image(sample.image).sha256


# ---------------------------------------------------------------------------
# stale preview guard
# ---------------------------------------------------------------------------


def test_state_key_changes_on_every_input():
    sample, history, settings = _setup()
    base = state_key(sample.image, settings.box, settings, history,
                     refine_radius=settings.refine_radius)
    assert base == state_key(sample.image, settings.box, settings, history,
                             refine_radius=settings.refine_radius)
    assert base != state_key(sample.image, (10, 10, 300, 300), settings, history,
                             refine_radius=settings.refine_radius)
    assert base != state_key(sample.image, settings.box, settings, history, refine_radius=7)
    history.push(Stroke(kind=1, radius=10.0, points=[(400.0, 400.0)]))
    assert base != state_key(sample.image, settings.box, settings, history,
                             refine_radius=settings.refine_radius)


def test_record_settings_survive_recompute():
    """Loaded record settings must drive the next compute (not the old slider)."""
    from ui.document import Document

    sample, history, settings = _setup()
    settings.refine_radius = 7
    record = ConstraintRecord.build(sample.image, sample.box, settings, history)
    doc = Document()
    doc.load_image(sample.image, "jug")
    doc.load_record(record)
    assert doc.settings.refine_radius == 7
    result = doc.compute()
    assert result is not None and result.refine_radius == 7


def test_export_blocked_when_never_computed():
    from ui.document import Document

    sample = generate_sample("ring")
    doc = Document()
    doc.load_image(sample.image, "ring")
    doc.set_box(sample.box)
    doc.load_strokes(sample.strokes)
    assert doc.result is None
    assert doc.is_stale()
