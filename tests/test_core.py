from __future__ import annotations

import numpy as np
import pytest

from negative_converter.core import (
    ConvertParams,
    ImageDoc,
    NormRect,
    SamplePatch,
    _normalise_array,
    analyze_patch,
    auto_endpoints,
    convert_positive,
    diagnostic_masks,
    encode_positive,
    estimate_base,
    expected_code_bounds,
    export_positive,
    load_image,
    measure_neutral,
    readback_output,
    suggest_neutral_gray,
)
from negative_converter.samples import color_negative_sample, range_verification_sample


def test_norm_rect_from_points_normalises_and_clamps():
    rect = NormRect.from_points(0.8, 0.9, 0.2, 0.1)
    assert rect.x == pytest.approx(0.2)
    assert rect.y == pytest.approx(0.1)
    assert rect.w == pytest.approx(0.6)
    assert rect.h == pytest.approx(0.8)

    ys, xs = rect.slices(100, 200)
    assert xs.start == 40 and xs.stop == 160
    assert ys.start == 10 and ys.stop == 90

    outside = NormRect.from_points(-0.2, 0.2, 0.1, 0.4)
    assert outside.x == 0.0
    assert outside.w == pytest.approx(0.1)


def test_sample_dust_and_overflow_are_detected_but_excluded_from_base():
    sample = color_negative_sample()
    patches = []
    statuses = []
    for i, rect in enumerate(sample.base_rects):
        patch = analyze_patch(sample.doc, rect)
        patch.id = i + 1
        patches.append(patch)
        statuses.append(patch.status)

    assert "dust" in statuses
    assert "overflow" in statuses
    assert sum(status == "ok" for status in statuses) >= 4

    base, used = estimate_base(patches)
    assert used >= 4
    # Clean edge illumination is close to the programmed orange mask.
    assert base[0] > base[1] > base[2]
    np.testing.assert_allclose(base, [0.84, 0.53, 0.31], atol=0.045)


def test_auto_endpoints_are_ordered():
    sample = range_verification_sample()
    rgb = sample.doc.preview_float()
    lo, hi = auto_endpoints(rgb, [0.84, 0.52, 0.30])
    assert hi > lo + 0.1


def test_neutral_assist_reduces_channel_chroma():
    base = np.array([0.80, 0.50, 0.30], dtype=np.float32)
    # Same physical grey detail, but residual channel density imbalance.
    densities = np.array([0.40, 0.70, 1.00], dtype=np.float32)
    rgb = base.reshape(1, 1, 3) * np.power(10.0, -densities).reshape(1, 1, 3)
    doc = ImageDoc(codes=rgb.astype(np.float32), code_max=1.0, bit_depth=32)
    patch = SamplePatch(id=1, rect=NormRect(0, 0, 1, 1), kind="neutral")

    params = ConvertParams(base=tuple(base), black=0.0, white=2.0, gamma=1.0)
    before = measure_neutral(doc, [patch], params)
    gains, message = suggest_neutral_gray(doc, [patch], params)
    assert "R=" in message

    corrected = ConvertParams(**{**params.__dict__, "gray": gains})
    after = measure_neutral(doc, [patch], corrected)
    agg_before = before.aggregate()
    agg_after = after.aggregate()
    assert agg_after["final_chroma"] < agg_before["final_chroma"] / 5
    assert agg_after["neutral_fraction"] > 0.95


def test_extreme_parameters_are_recoverable_by_recomputing_from_source():
    base = np.array([0.86, 0.55, 0.32], dtype=np.float32)
    density = np.linspace(0.0, 2.2, 512, dtype=np.float32)[None, :, None]
    density = np.repeat(density, 8, axis=0)
    density = np.repeat(density, 3, axis=2)
    rgb = base.reshape(1, 1, 3) * np.power(10.0, -density)
    doc = ImageDoc(codes=rgb.astype(np.float32), code_max=1.0, bit_depth=32)

    crushed = ConvertParams(base=tuple(base), black=0.90, white=1.00)
    recovered_params = ConvertParams(base=tuple(base), black=0.0, white=2.2)

    extreme, _ = convert_positive(doc.full_float(), crushed)
    recovered, _ = convert_positive(doc.full_float(), recovered_params)
    direct, _ = convert_positive(doc.full_float(), recovered_params)

    extreme_luma = extreme[..., 1]
    recovered_luma = recovered[..., 1]
    extreme_levels = len(np.unique(np.round(extreme_luma, 5)))
    recovered_levels = len(np.unique(np.round(recovered_luma, 5)))

    # The important recovery property is that no adjustment was baked into
    # the source: pulling the sliders back gives the full continuous ramp and
    # exactly matches a fresh conversion with those parameters.
    assert recovered_levels > extreme_levels * 4
    assert recovered_levels > 200
    np.testing.assert_array_equal(recovered, direct)


def test_diagnostic_masks_mark_noise_and_input_clipping():
    rgb = np.full((32, 32, 3), 0.5, dtype=np.float32)
    rgb[:8] = 0.0
    rgb[-8:] = 1.0
    params = ConvertParams(base=(0.8, 0.5, 0.3), black=0.0, white=2.0)
    masks = diagnostic_masks(rgb, params, code_max=65535.0)
    assert masks["noise_floor"][:8].mean() > 0.8
    assert masks["input_clip"][-8:].mean() > 0.8


def test_low_memory_conversion_matches_detail_conversion():
    rng = np.random.default_rng(3)
    rgb = 0.05 + 0.9 * rng.random((16, 24, 3), dtype=np.float32)
    params = ConvertParams(
        base=(0.82, 0.52, 0.31), black=0.01, white=2.1, gamma=1.08, gray=(1.08, 0.98, 1.03)
    )
    detailed, _ = convert_positive(rgb, params, details=True)
    streaming, none_fields = convert_positive(rgb, params, details=False)
    assert none_fields is None
    np.testing.assert_allclose(streaming, detailed, atol=1e-6)


def test_encode_range_bounds():
    rgb = np.array([[[0.0, 0.5, 1.0]]], dtype=np.float32)
    u16 = encode_positive(rgb, 16, "full")
    assert u16[0, 0, 0] == 0 and u16[0, 0, 2] == 65535

    legal16 = encode_positive(rgb, 16, "legal")
    lo, hi = expected_code_bounds(16, "legal")
    assert legal16[0, 0, 0] == lo and legal16[0, 0, 2] == hi
    legal8 = encode_positive(rgb, 8, "legal")
    assert legal8[0, 0, 0] == 16 and legal8[0, 0, 2] == 235


def test_multipage_grayscale_tiff_uses_first_page(tmp_path):
    tifffile = pytest.importorskip("tifffile")
    stack = np.stack(
        [
            np.full((10, 12), 111, dtype=np.uint16),
            np.full((10, 12), 222, dtype=np.uint16),
            np.full((10, 12), 333, dtype=np.uint16),
        ],
        axis=0,
    )
    path = tmp_path / "pages.tiff"
    tifffile.imwrite(path, stack, photometric="minisblack")

    doc = load_image(path)
    assert doc.height == 10 and doc.width == 12
    assert doc.codes.shape == (10, 12, 3)
    assert np.all(doc.codes == 111)


def test_signed_and_big_endian_normalisation():
    signed = np.array([[[70000, -4, 12]]], dtype=np.int32)
    normalised = _normalise_array(signed)
    assert normalised.dtype == np.uint16
    assert normalised[0, 0, 0] == 65535
    assert normalised[0, 0, 1] == 0

    native = np.array([[[10, 200, 60000]]], dtype=np.uint16)
    big = native.astype(">u2")
    restored = _normalise_array(big)
    assert restored.dtype.byteorder == "="
    np.testing.assert_array_equal(restored, native)


def test_export_16bit_tiff_and_png_readback(tmp_path):
    sample = range_verification_sample()
    patches = []
    for i, rect in enumerate(sample.base_rects):
        patch = analyze_patch(sample.doc, rect)
        patch.id = i
        patches.append(patch)
    base, _ = estimate_base(patches)
    params = ConvertParams(base=tuple(base), **sample.suggested_params)
    positive, _ = convert_positive(sample.doc.full_float(), params)

    tiff_path = tmp_path / "positive.tiff"
    export_positive(tiff_path, positive, bit_depth=16, range_preset="full")
    report = readback_output(tiff_path, "full", 16)
    assert report.dtype == "uint16"
    assert report.global_min_code <= 2
    assert report.global_max_code >= 65530
    assert report.matches_expected

    png_path = tmp_path / "positive.png"
    export_positive(png_path, positive, bit_depth=8, range_preset="legal")
    png_report = readback_output(png_path, "legal", 8)
    assert png_report.dtype == "uint8"
    assert png_report.expected_min_code == 16
    assert png_report.expected_max_code == 235
