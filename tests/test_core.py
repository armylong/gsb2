"""Tests for the numeric core and I/O. Run with:

    .venv/bin/python -m pytest -q
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

from flatfield import core
from flatfield.core import (
    Conditions,
    DefectConfig,
    Frame,
    build_reference,
    correct,
    display_limits,
    frame_stats,
    group_stats,
    to_display_u8,
    validate_set,
)
from flatfield.generator import generate_set, save_set
from flatfield.io import (
    ImageLoadError,
    Meta,
    read_bundle,
    read_image,
    write_ascii_pgm,
    write_mask_png,
    write_png,
)
from flatfield.session import Session
from flatfield.verification import evaluate, ground_truth_from_set, load_ground_truth


# --------------------------------------------------------------------------- #
# Fixtures
# --------------------------------------------------------------------------- #

@pytest.fixture(scope="module")
def dataset():
    return generate_set((180, 240), n_dark=4, n_light=5, seed=7)


@pytest.fixture(scope="module")
def model(dataset):
    return build_reference(dataset.darks, dataset.lights, DefectConfig())


# --------------------------------------------------------------------------- #
# I/O
# --------------------------------------------------------------------------- #

def test_png_roundtrip_exact(tmp_path: Path):
    rng = np.random.default_rng(0)
    arr = rng.integers(0, 65536, (37, 53), dtype=np.uint16)
    meta = Meta(exposure_ms=12.5, gain_db=-3.0, black_level=100, bit_depth=16)
    write_png(tmp_path / "a.png", arr, meta)
    loaded = read_image(tmp_path / "a.png")
    assert np.array_equal(loaded.array, arr)
    assert loaded.meta.exposure_ms == 12.5
    assert loaded.meta.gain_db == -3.0


def test_pgm_roundtrip(tmp_path: Path):
    arr = (np.arange(65536, dtype=np.uint32).reshape(256, 256) % 65536).astype(np.uint16)
    write_ascii_pgm(tmp_path / "a.pgm", arr)
    loaded = read_image(tmp_path / "a.pgm")
    assert np.array_equal(loaded.array, arr)


def test_rejects_eight_bit(tmp_path: Path):
    from PIL import Image

    Image.fromarray(np.zeros((8, 8), np.uint8)).save(tmp_path / "eight.png")
    with pytest.raises(ImageLoadError, match="8 bit|8 位"):
        read_image(tmp_path / "eight.png")


def test_rejects_color(tmp_path: Path):
    from PIL import Image

    Image.fromarray(np.zeros((8, 8, 3), np.uint8), mode="RGB").save(tmp_path / "rgb.png")
    with pytest.raises(ImageLoadError):
        read_image(tmp_path / "rgb.png")


def test_mask_export_is_lossless(tmp_path: Path):
    mask = np.zeros((20, 30), bool)
    mask[3:8, 5:19] = True
    write_mask_png(tmp_path / "mask.png", mask)
    loaded = read_image(tmp_path / "mask.png")
    assert np.array_equal(loaded.array == 65535, mask)
    assert loaded.array.dtype == np.uint16


def test_generated_bundle_roundtrip(tmp_path: Path):
    ds = generate_set((96, 128), n_dark=2, n_light=3, seed=3)
    info = save_set(ds, tmp_path)
    bundle = read_bundle(info["bundle_json"])
    assert len(bundle.dark) == 2 and len(bundle.light) == 3
    assert bundle.sample is not None
    assert np.array_equal(bundle.sample.array, ds.sample.array)
    assert bundle.sample.meta.exposure_ms == ds.meta.exposure_ms
    truth = load_ground_truth(info["ground_truth"])
    assert truth.shape == (96, 128)
    assert truth.true_defects.any()


# --------------------------------------------------------------------------- #
# Statistics & validation
# --------------------------------------------------------------------------- #

def test_frame_stats_saturation_bbox():
    arr = np.zeros((10, 12), np.uint16)
    arr[2:4, 3:6] = 65535
    stats = frame_stats(Frame(arr, name="x"))
    assert stats.vmin == 0 and stats.vmax == 65535
    assert stats.sat_count == 6
    assert stats.sat_bbox == (2, 3, 3, 5)
    assert stats.sat_centroid == pytest.approx((2.5, 4.0))


def test_group_stats_persistent_saturation():
    a = Frame(np.zeros((5, 5), np.uint16) + 100)
    b = Frame(np.zeros((5, 5), np.uint16) + 100)
    a.array[0, 0] = 65535
    b.array[0, 0] = 65535
    b.array[1, 1] = 65535
    stats = group_stats([a, b], "亮场")
    assert stats.sat_any == 2
    assert stats.sat_persistent == 1
    assert "每帧均饱和 1" in stats.sat_text()


def test_validate_blocks_on_size_and_accepts_matching(dataset):
    issues = validate_set(dataset.darks, dataset.lights, dataset.sample)
    assert not any(i.blocks for i in issues)

    bad = Frame(np.zeros((10, 10), np.uint16), name="small", meta=dataset.sample.meta)
    issues = validate_set(dataset.darks, dataset.lights, bad)
    assert any(i.code == "size_mismatch" and i.blocks for i in issues)


def test_validate_exposure_mismatch_warns():
    meta_ok = Meta(exposure_ms=30.0, gain_db=0.0)
    meta_bad = Meta(exposure_ms=60.0, gain_db=0.0)
    dark = Frame(np.zeros((4, 4), np.uint16) + 10, name="dark", meta=meta_ok)
    light = Frame(np.zeros((4, 4), np.uint16) + 500, name="light", meta=meta_bad)
    sample = Frame(np.zeros((4, 4), np.uint16) + 300, name="sample", meta=meta_ok)
    conditions = Conditions(dark_exposure_ms=30.0, light_exposure_ms=30.0,
                            sample_exposure_ms=30.0, gain_db=0.0)
    issues = validate_set([dark], [light], sample, conditions)
    codes = {i.code for i in issues}
    assert "conditions_mismatch_light" in codes
    assert not any(i.blocks for i in issues)


def test_validate_missing_meta_is_info_only():
    dark = Frame(np.zeros((4, 4), np.uint16) + 10, name="dark")
    light = Frame(np.zeros((4, 4), np.uint16) + 500, name="light")
    sample = Frame(np.zeros((4, 4), np.uint16) + 300, name="sample")
    issues = validate_set([dark], [light], sample, Conditions(light_exposure_ms=30.0))
    assert any(i.code == "conditions_unknown_light" for i in issues)
    assert all(not i.blocks for i in issues)


# --------------------------------------------------------------------------- #
# Defects
# --------------------------------------------------------------------------- #

def test_defect_detection_matches_truth(dataset, model):
    defects = model.defects
    truth = dataset.true_defects
    assert np.count_nonzero(defects.invalid & truth) / np.count_nonzero(truth) > 0.99
    assert np.count_nonzero(defects.invalid & ~truth) == 0
    large = defects.large_components
    assert large, "the occluded disk must be reported as a large region"
    biggest = max(large, key=lambda c: c.area)
    # bbox must cover the generated occluder
    r0, c0, r1, c1 = biggest.bbox
    tr, tc = np.nonzero(dataset.true_large_area)
    assert r0 <= tr.min() and r1 >= tr.max() and c0 <= tc.min() and c1 >= tc.max()
    assert any("大面积" in note for note in model.notes)


def test_connected_components_eight_connectivity():
    mask = np.zeros((6, 6), bool)
    mask[0, 0] = True
    mask[1, 1] = True          # diagonal -> same component
    mask[5, 5] = True
    labels, stats = core.connected_components(mask)
    assert labels[0, 0] == labels[1, 1] != 0
    assert labels[0, 0] != labels[5, 5]
    assert len(stats) == 2


def test_connected_components_large_region_performance():
    mask = np.zeros((300, 400), bool)
    mask[40:180, 60:260] = True
    labels, stats = core.connected_components(mask)
    assert len(stats) == 1
    _, area, r0, c0, r1, c1, _, _ = stats[0]
    assert area == 140 * 200
    assert (r0, c0, r1, c1) == (40, 60, 179, 259)


def test_patch_only_small_by_default(dataset):
    base = build_reference(dataset.darks, dataset.lights)
    small = core.apply_patch_policy(base, "small")
    assert small.patched_mask.any()
    # the large occluder stays invalid
    large_mask = np.zeros(base.shape, bool)
    for comp in base.defects.large_components:
        large_mask |= base.defects.labels == comp.id
    assert not (small.patched_mask & large_mask).any()
    # patched pixels come back as usable, the occluder stays excluded
    assert np.count_nonzero(small.valid_mask) > np.count_nonzero(base.valid_mask)
    assert not small.valid_mask[large_mask].any()


def test_patch_selected_ids(dataset):
    base = build_reference(dataset.darks, dataset.lights)
    target = base.defects.small_components[0]
    patched = core.apply_patch_policy(base, "selected", {target.id})
    assert np.count_nonzero(patched.patched_mask) == target.area


# --------------------------------------------------------------------------- #
# Correction & display independence
# --------------------------------------------------------------------------- #

def test_correction_requires_switches(dataset, model):
    full = correct(dataset.sample, model)
    dark_only = correct(dataset.sample, model, apply_light=False)
    light_only = correct(dataset.sample, model, apply_dark=False)
    assert not np.allclose(np.nan_to_num(full.corrected),
                           np.nan_to_num(dark_only.corrected))
    assert "仅暗场" in dark_only.source
    assert "仅亮场" in light_only.source
    # with dark correction off the intermediate is the untouched sample
    assert np.array_equal(light_only.dark_corrected,
                          dataset.sample.array.astype(np.float32))


def test_export_values_ignore_display_range(dataset, model):
    result = correct(dataset.sample, model)
    lo, hi = 100.0, 500.0
    _ = to_display_u8(result.corrected, lo, hi)
    _ = display_limits(result.corrected, result.valid_mask)
    # u16 export must equal the raw corrected values (clipped & rounded)
    ref = np.rint(np.clip(np.nan_to_num(result.corrected, nan=0.0), 0, 65535))
    assert np.array_equal(result.corrected_u16.astype(np.float64), ref)
    assert result.corrected_u16.dtype == np.uint16


def test_correction_flatness_improves(dataset, model):
    result = correct(dataset.sample, model)
    valid = result.valid_mask & dataset.valid_truth & dataset.background_mask
    raw = dataset.sample.array.astype(np.float32)
    raw_region = core.region_summary(raw, valid)
    corrected_region = core.region_summary(result.corrected, valid)
    assert corrected_region.plane_std_pct < raw_region.plane_std_pct / 5
    # texture must survive (background mask above excludes it by design)
    mask = result.valid_mask & dataset.valid_truth & dataset.texture_mask
    corr = np.corrcoef(result.corrected[mask], dataset.sample_ideal[mask])[0, 1]
    assert corr > 0.99


def test_mask_and_valid_flags(dataset, model):
    result = correct(dataset.sample, model)
    assert result.corrected_u16[~result.valid_mask].max() == 0
    assert np.isnan(result.corrected[~result.valid_mask]).all()
    assert not result.valid_mask[dataset.true_defects].any()


# --------------------------------------------------------------------------- #
# Verification
# --------------------------------------------------------------------------- #

def test_verification_report(dataset, model):
    result = correct(dataset.sample, model)
    truth = ground_truth_from_set(dataset)
    report = evaluate(dataset.sample.array, model, result, truth)
    assert report.defect_recall > 0.99
    assert report.defect_precision > 0.99
    assert report.large_region_iou > 0.9
    assert report.truth.background.plane_std_pct < 3.0
    variant = report.variant("暗场+亮场")
    assert variant is not None and variant.background.plane_std_pct < 3.0
    assert abs(variant.texture_ratio_median - 1.0) < 0.02
    payload = report.to_dict()
    json.dumps(payload)


def test_truth_size_mismatch_raises(dataset, model):
    from flatfield.verification import GroundTruth, TruthError

    result = correct(dataset.sample, model)
    truth = ground_truth_from_set(dataset)
    small = GroundTruth(
        bias=truth.bias[:10, :10], flat_norm=truth.flat_norm[:10, :10],
        sample_ideal=truth.sample_ideal[:10, :10], texture=truth.texture[:10, :10],
        illumination=truth.illumination[:10, :10],
        true_defects=truth.true_defects[:10, :10],
        true_large_area=truth.true_large_area[:10, :10])
    with pytest.raises(TruthError):
        evaluate(dataset.sample.array, model, result, small)


# --------------------------------------------------------------------------- #
# Session
# --------------------------------------------------------------------------- #

def test_session_pipeline(dataset):
    session = Session()
    session.add_frames("dark", dataset.darks)
    session.add_frames("light", dataset.lights)
    session.set_sample(dataset.sample)
    session.attach_truth_generated(dataset)
    assert not [i for i in session.validate() if i.blocks]
    model = session.ensure_model()
    assert model is not None
    result = session.ensure_correction()
    assert result is not None
    assert session.view("corrected") is not None
    assert len(session.profiles("corrected")[0]) == 4
    assert session.verify() is not None

    session.apply_dark = False
    session.apply_light = True
    changed = session.ensure_correction()
    assert changed.source.startswith("仅亮场")


def test_session_rejects_mismatched_dimensions(dataset):
    session = Session()
    session.add_frames("dark", dataset.darks)
    session.add_frames("light", dataset.lights)
    session.set_sample(Frame(np.zeros((5, 5), np.uint16), name="tiny"))
    assert session.ensure_model() is None
    assert session.ensure_correction() is None


def test_duplicate_import_is_ignored(dataset):
    session = Session()
    session.add_frames("dark", dataset.darks)
    session.add_frames("dark", dataset.darks)
    assert len(session.darks) == len(dataset.darks)


# --------------------------------------------------------------------------- #
# Flatness helpers
# --------------------------------------------------------------------------- #

def test_flat_plane_metrics_on_synthetic_ramp():
    yy, xx = np.mgrid[0:200, 0:300]
    plane = 1000.0 + 0.5 * yy + 0.2 * xx
    summary = core.region_summary(plane.astype(np.float32))
    assert summary.plane_std_pct < 1e-3
    noise = plane + np.random.default_rng(0).normal(0, 5, plane.shape)
    assert core.local_roughness_pct(noise.astype(np.float32)) < 2.0


def test_display_limits_ignore_outliers():
    arr = np.full((50, 50), 1000.0, np.float32)
    arr[0, 0] = 65535
    lo, hi = display_limits(arr, None, 0.5, 99.5)
    assert lo <= 1000 <= hi
    assert hi < 65535
