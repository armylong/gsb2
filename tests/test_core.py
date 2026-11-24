"""Core analysis tests: distances, calibration, ROI semantics, holes, empties."""
from __future__ import annotations

import numpy as np
import pytest

from maskdiff import samples
from maskdiff.core import (
    Calibration,
    Roi,
    analyze,
    boundary_parts,
    percentile_scale,
)


def square(size: int = 40, margin: int = 5) -> np.ndarray:
    m = np.zeros((size, size), dtype=bool)
    m[margin : size - margin, margin : size - margin] = True
    return m


# ---------------------------------------------------------------- distances
def test_identical_masks_have_zero_distance():
    a = square()
    d = analyze(a, a.copy())
    for side in ("a_to_b", "b_to_a"):
        st = d.stats(side)
        assert st.n > 0
        assert st.maximum == pytest.approx(0.0)
        assert st.over_tolerance == 0


def test_shift_distance_equals_shift_in_pixels():
    """A 4 px shift means each boundary is at least 4 px from the other."""
    a = square()
    b = np.roll(a, 4, axis=1)
    d = analyze(a, b)
    st = d.stats("a_to_b")
    # Straight edges sit exactly 4 px away; corners are a little farther.
    assert st.maximum >= 4.0 - 1e-9
    assert st.maximum < 6.5


def test_distance_direction_is_symmetric_for_a_pure_shift():
    a = square()
    b = np.roll(a, 3, axis=0)
    d = analyze(a, b)
    assert d.stats("a_to_b").n == d.stats("b_to_a").n
    assert d.stats("a_to_b").mean == pytest.approx(d.stats("b_to_a").mean, rel=1e-6)


def test_anisotropic_pixel_size_scales_each_axis():
    """Row and column pixel sizes are applied independently.

    Two 1-px-thick lines, one row apart vertically and three columns apart
    horizontally, give exact distances -- no shape distortion to confuse the
    comparison.
    """
    row_a = np.zeros((30, 30), bool)
    row_a[10, 5:25] = True
    row_b = np.zeros_like(row_a)
    row_b[11, 5:25] = True

    col_a = np.zeros((30, 30), bool)
    col_a[5:25, 10] = True
    col_b = np.zeros_like(col_a)
    col_b[5:25, 13] = True

    calib = Calibration(row_size=2.0, col_size=0.5)
    d_row = analyze(row_a, row_b, calib=calib)
    d_col = analyze(col_a, col_b, calib=calib)
    assert d_row.stats("a_to_b").median == pytest.approx(2.0)
    assert d_col.stats("a_to_b").median == pytest.approx(1.5)


def test_boundary_is_the_contour_not_the_filled_pixel_set():
    """Regression: measuring to every target *pixel* gives 0 for overlaps.

    For a shift the source contour overlaps the target interior, so the old
    "distance to the target mask" implementation returned 0. The contour-based
    measurement must be non-zero.
    """
    a = square()
    b = np.roll(a, 4, axis=1)
    d = analyze(a, b)
    assert d.stats("a_to_b").median > 0


def test_worst_edges_give_both_ends():
    a = square()
    b = np.roll(a, 4, axis=1)
    d = analyze(a, b)
    edges = d.worst_edges("a_to_b", limit=3)
    assert edges
    e = edges[0]
    assert e["distance"] == d.stats("a_to_b").maximum
    src_r, src_c = e["source"]
    near_r, near_c = e["nearest"]
    assert (src_r, src_c) != (near_r, near_c)
    assert 0 <= near_r < a.shape[0] and 0 <= near_c < a.shape[1]
    # Reverse end is a source boundary pixel.
    rev_r, rev_c = e["reverse"]
    assert d.a_to_b.source_boundary[rev_r, rev_c]


# --------------------------------------------------------------------- ROI
def test_roi_only_filters_samples_not_the_distance_field():
    """Crop edges must never become boundaries: distances stay full-image."""
    a, b = samples.notch()
    full = analyze(a, b)
    roi = Roi(20, 90, 100, 160)
    cropped = analyze(a, b, roi=roi)
    # The notch bottom sample is the global maximum; inside the ROI the max is
    # the same value (it is measured to the global B boundary, not the ROI edge).
    assert cropped.stats("a_to_b").maximum == pytest.approx(
        full.stats("a_to_b").maximum
    )
    assert cropped.stats("a_to_b").n < full.stats("a_to_b").n
    # Distance field itself is unchanged by the ROI.
    assert np.array_equal(cropped.a_to_b.values, full.a_to_b.values)


def test_roi_outside_geometry_yields_no_samples():
    a, b = samples.translation()
    d = analyze(a, b, roi=Roi(0, 10, 0, 10))
    assert d.stats("a_to_b").n == 0
    assert d.stats("a_to_b").as_row() == ["0", "—", "—", "—", "—", "—"]


def test_roi_clips_and_empty_roi_falls_back():
    a = square(20)
    d = analyze(a, a, roi=Roi(-5, 999, 3, 7))
    assert d.roi == Roi(0, 20, 3, 7)
    d2 = analyze(a, a, roi=Roi(5, 5, 5, 5))
    assert not d2.roi_active


def test_roi_region_stats_are_local():
    a, b = samples.translation()
    d = analyze(a, b, roi=Roi(50, 190, 70, 170))
    for r in d.regions:
        r0, r1, c0, c1 = r.bbox
        assert r1 > 50 and r0 < 190 and c1 > 70 and c0 < 170


# -------------------------------------------------------------------- holes
def test_one_pixel_hole_is_not_ignored():
    a, b = samples.pinhole((120, 120), 1)
    d = analyze(a, b)
    assert len(d.holes) == 1
    h = d.holes[0]
    assert h.mask_name == "A"
    assert h.area_px == 1
    assert h.is_tiny
    assert h.only_here

    st = d.stats("a_to_b")
    # The pinhole rim is a boundary sample: 4 rim pixels at 50-ish distance.
    assert st.maximum > 40
    assert st.over_tolerance >= 4
    # Reverse direction is unaffected: nothing of B is near A's notch or hole.
    assert d.stats("b_to_a").maximum == pytest.approx(0.0)


def test_ignore_hole_boundaries_is_opt_out_only():
    a, b = samples.pinhole((120, 120), 1)
    d = analyze(a, b, ignore_hole_boundaries=True)
    assert d.stats("a_to_b").maximum == pytest.approx(0.0)
    # Inventory is still reported even when the distance ignores hole rims.
    assert len(d.holes) == 1


def test_hole_area_uses_calibration():
    a = np.zeros((30, 30), bool)
    a[3:27, 3:27] = True
    a[14:16, 14:16] = False  # 2x2 hole
    b = a.copy()
    b[14:16, 14:16] = True
    calib = Calibration(row_size=0.5, col_size=0.25, unit="mm")
    d = analyze(a, b, calib=calib)
    assert len(d.holes) == 1
    assert d.holes[0].area == pytest.approx(4 * 0.5 * 0.25)


def test_hole_in_both_but_different_size_is_reported():
    a = np.zeros((60, 60), bool)
    a[5:55, 5:55] = True
    a[25:35, 25:35] = False
    b = a.copy()
    b[26:34, 26:34] = True
    d = analyze(a, b)
    assert {h.mask_name for h in d.holes} == {"A", "B"}
    kinds = {r.kind for r in d.regions}
    assert "B 填充 A 的孔" in kinds


def test_boundary_parts_splits_outer_and_hole():
    m = np.zeros((20, 20), bool)
    m[2:18, 2:18] = True
    m[9:11, 9:11] = False
    outer, hole_rim, hole_int = boundary_parts(m)
    assert outer[2, 2]
    # Hole interior is background; the rim is the mask pixels around it.
    assert hole_int[9, 9]
    assert not m[9, 9]
    assert hole_rim[8, 9] and hole_rim[9, 8]
    assert not outer[8, 9]
    assert outer.sum() > 0 and hole_rim.sum() == 8


def test_frame_can_be_boundary_or_not():
    m = np.zeros((30, 30), bool)
    m[5:25, 0:10] = True
    with_frame = boundary_parts(m)[0]
    without = boundary_parts(m, treat_frame_as_boundary=False)[0]
    assert with_frame[5:25, 0].sum() == 20
    # Only the two corner pixels remain boundary through internal contrast;
    # the rest of the frame-touching column is not a drawn edge.
    assert without[5:25, 0].sum() == 2
    assert with_frame.sum() > without.sum()


# ------------------------------------------------------------ degenerate IO
def test_both_empty_masks_explain_themselves():
    e = np.zeros((16, 16), bool)
    d = analyze(e, e.copy())
    assert d.both_empty and d.a_empty and d.b_empty
    assert "空图" in d.summary_text()
    assert not d.boundary_available
    assert d.stats("a_to_b").n == 0


def test_only_one_mask_has_content():
    e = np.zeros((16, 16), bool)
    a = square(16, 3)
    d = analyze(a, e)
    assert d.a_empty is False and d.b_empty is True
    assert "只有 A 有内容" in d.summary_text()
    assert not d.boundary_available
    assert d.area_stats().only_a_px == int(a.sum())


def test_shape_mismatch_raises():
    with pytest.raises(ValueError, match="尺寸不一致"):
        analyze(np.zeros((10, 10), bool), np.zeros((10, 11), bool))


def test_1d_input_rejected():
    with pytest.raises(ValueError, match="二维"):
        analyze(np.zeros(10, bool), np.zeros(10, bool))


def test_invalid_calibration_rejected():
    with pytest.raises(ValueError):
        Calibration(row_size=0)
    with pytest.raises(ValueError):
        Calibration(col_size=-1)
    with pytest.raises(ValueError):
        Calibration(tolerance=-0.1)


# ----------------------------------------------------- area vs distance split
def test_translation_area_identical_but_boundary_off():
    a, b = samples.translation()
    d = analyze(a, b)
    ar = d.area_stats()
    assert ar.a_px == ar.b_px  # total area identical
    assert ar.area_diff_ratio == pytest.approx(0.0)
    assert d.stats("a_to_b").maximum > 3.0


def test_notch_area_tiny_but_boundary_deep():
    a, b = samples.notch()
    d = analyze(a, b)
    ar = d.area_stats()
    assert ar.area_diff_ratio < 0.01
    assert ar.jaccard > 0.99
    assert d.stats("a_to_b").maximum == pytest.approx(22.0)
    assert d.stats("b_to_a").maximum <= 1.0


def test_percentile_scale_robust_and_nonzero():
    vals = np.array([np.inf, np.nan, 0.0, 0.0, 5.0])
    assert percentile_scale(vals) > 0
    assert percentile_scale(np.array([np.inf])) == 1.0


# ------------------------------------------------------- band & region limits
def test_boundary_band_matches_samples():
    from maskdiff.core import boundary_band

    a, b = samples.notch()
    d = analyze(a, b)
    band, vals = boundary_band(d, "a_to_b")
    assert band.sum() > d.a_to_b.n  # grown beyond the exact samples
    assert band.shape == d.shape
    assert np.isfinite(vals).all()
    # Distance at an exact sample pixel equals that sample's own value.
    r, c = d.a_to_b.sample_rows[0], d.a_to_b.sample_cols[0]
    assert vals[r, c] == pytest.approx(d.a_to_b.sample_values[0])


def test_region_cap_is_reported_not_silent(monkeypatch):
    import maskdiff.core as core

    monkeypatch.setattr(core, "MAX_REGIONS", 2)
    rng = np.random.default_rng(1)
    a = rng.random((120, 120)) > 0.5
    b = ~a
    d = core.analyze(a, b)
    # Two caps apply (A-only and B-only), so two regions each are measured.
    assert len(d.regions) == 4
    assert d.regions_omitted > 0
    # Area statistics still count every pixel, cap or no cap.
    assert d.area_stats().only_a_px == int((a & ~b).sum())
