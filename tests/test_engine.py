"""End-to-end behaviour of the blend engine and the session model."""

from __future__ import annotations

import numpy as np
import pytest

from mblend.color import linear_to_rgb8
from mblend.engine import MODE_NAIVE, MODE_PYRAMID, BlendConfig, BlendEngine
from mblend.pyramid import max_levels
from mblend.session import Session


def _ramp_mask(height: int, width: int) -> np.ndarray:
    return np.tile(
        np.linspace(0.0, 1.0, width, dtype=np.float32)[None, :], (height, 1)
    )


def test_naive_blend_matches_linear_formula(random_pair):
    a, b = random_pair
    engine = BlendEngine(a, b)
    mask = _ramp_mask(*a.shape[:2])
    out = engine.result(mask, BlendConfig(MODE_NAIVE, 4))
    expected = mask[..., None] * engine.a_linear + (1 - mask[..., None]) * engine.b_linear
    assert np.max(np.abs(out - expected)) < 1e-6


def test_pyramid_constant_mask_endpoints_are_exact(random_pair):
    a, b = random_pair
    engine = BlendEngine(a, b)
    h, w = a.shape[:2]
    for value, reference in (
        (1.0, a),
        (0.0, b),
    ):
        mask = np.full((h, w), value, dtype=np.float32)
        out = linear_to_rgb8(engine.result(mask, BlendConfig(MODE_PYRAMID, 4)))
        assert np.array_equal(out, reference)
    # The same for naive blending.
    for value, reference in ((1.0, a), (0.0, b)):
        mask = np.full((h, w), value, dtype=np.float32)
        out = linear_to_rgb8(engine.result(mask, BlendConfig(MODE_NAIVE, 4)))
        assert np.array_equal(out, reference)


def test_pyramid_constant_mask_endpoints_float_exact(odd_pair):
    a, b = odd_pair
    engine = BlendEngine(a, b)
    h, w = a.shape[:2]
    out_a = engine.result(np.ones((h, w), np.float32), BlendConfig(MODE_PYRAMID, 6))
    out_b = engine.result(np.zeros((h, w), np.float32), BlendConfig(MODE_PYRAMID, 6))
    assert np.max(np.abs(out_a - engine.a_linear)) < 1e-6
    assert np.max(np.abs(out_b - engine.b_linear)) < 1e-6


def test_identical_pair_has_no_seam_or_luminance_shift(odd_pair):
    a, _ = odd_pair
    engine = BlendEngine(a, a)
    h, w = a.shape[:2]
    mask = _ramp_mask(h, w)
    mask[100:400, 120:800] += 0.2
    mask = np.clip(mask, 0, 1)
    for levels in (2, 4, 6):
        out = linear_to_rgb8(engine.result(mask, BlendConfig(MODE_PYRAMID, levels)))
        assert np.array_equal(out, a)
    out_naive = linear_to_rgb8(engine.result(mask, BlendConfig(MODE_NAIVE, 4)))
    assert np.array_equal(out_naive, a)


def test_level_limit_is_enforced(random_pair):
    a, b = random_pair
    engine = BlendEngine(a, b)
    limit = max_levels(*a.shape[:2])
    with pytest.raises(ValueError, match="层"):
        engine.result(np.zeros(a.shape[:2], np.float32), BlendConfig(MODE_PYRAMID, min(6, limit) + 1))
    with pytest.raises(ValueError, match="层"):
        BlendConfig(MODE_PYRAMID, 1).validate(*a.shape[:2])


def test_tiny_image_has_no_pyramid_levels():
    a = np.zeros((1, 1, 3), np.uint8)
    engine = BlendEngine(a, a)
    assert engine.max_levels == 0
    with pytest.raises(ValueError):
        engine.result(np.zeros((1, 1), np.float32), BlendConfig(MODE_PYRAMID, 2))


def test_two_images_never_exceed_the_six_level_cap():
    a = np.zeros((1200, 1200, 3), np.uint8)
    engine = BlendEngine(a, a)
    assert engine.max_levels == 6
    with pytest.raises(ValueError):
        engine.result(np.zeros((1200, 1200), np.float32), BlendConfig(MODE_PYRAMID, 7))


def test_level_views_have_real_sizes_and_signed_ranges(odd_pair):
    a, b = odd_pair
    engine = BlendEngine(a, b)
    h, w = a.shape[:2]
    mask = _ramp_mask(h, w)
    views = engine.level_views(mask, 4)
    assert len(views) == 4
    expected_h, expected_w = h, w
    for view in views:
        assert view["size"] == (expected_h, expected_w)
        assert view["detail_a"].shape[:2] == (expected_h, expected_w)
        assert view["detail_b"].shape[:2] == (expected_h, expected_w)
        assert view["mask"].shape == (expected_h, expected_w)
        a_lo, a_hi = view["detail_a_range"]
        assert a_lo == pytest.approx(float(view["detail_a"].min()))
        assert a_hi == pytest.approx(float(view["detail_a"].max()))
        assert a_lo <= a_hi
        # signed detail data really contains both signs
        assert a_lo < 0 < a_hi
        expected_h, expected_w = (expected_h + 1) // 2, (expected_w + 1) // 2
    residual = engine.residual_view(4)
    assert residual["size"] == (expected_h, expected_w)


def test_detail_grey_bias_does_not_touch_the_result(odd_pair):
    """The inspector's grey bias is display-only; blending is unchanged."""
    from mblend.ui.scaling import detail_to_rgb8

    a, b = odd_pair
    engine = BlendEngine(a, b)
    h, w = a.shape[:2]
    mask = np.full((h, w), 0.5, np.float32)
    result_before = engine.result(mask, BlendConfig(MODE_PYRAMID, 4)).copy()
    views = engine.level_views(mask, 4)
    for view in views:
        for key in ("detail_a", "detail_b"):
            detail_to_rgb8(view[key], 4.0)
    result_after = engine.result(mask, BlendConfig(MODE_PYRAMID, 4))
    assert np.array_equal(result_before, result_after)


def test_session_caches_and_invalidates(random_pair):
    a, b = random_pair
    session = Session(a, b)
    first = session.result_linear()
    assert session.result_linear() is first
    assert session.result_rgb8() is session.result_rgb8()
    old_revision = session.revision
    session.mask_doc.fill_a()
    session.touch()
    assert session.revision > old_revision
    out = session.result_rgb8()
    assert np.array_equal(out, a)


def test_session_probe_uses_the_same_result(random_pair):
    a, b = random_pair
    session = Session(a, b)
    mask = _ramp_mask(*a.shape[:2])
    session.mask_doc.mask[:] = mask
    session.touch()
    session.set_pick((40, 60))
    probe = session.probe()
    result = session.result_linear()
    assert np.allclose(probe["result_linear"], result[60, 40])
    naive = session.comparison_linear()
    assert np.allclose(probe["naive_linear"], naive[60, 40])
    assert np.allclose(probe["mask"], mask[60, 40])


def test_session_levels_and_mode_switch(random_pair):
    a, b = random_pair
    session = Session(a, b)
    assert session.config.mode == MODE_PYRAMID
    session.set_levels(6)
    assert session.config.levels == 6
    assert len(session.level_views()) == 6
    session.set_mode(MODE_NAIVE)
    assert session.config.mode == MODE_NAIVE
    # Comparison is the pyramid result with the same mask.
    session.mask_doc.fill_b()
    session.mask_doc.set_target(1.0, np.indices(a.shape[:2])[1] > a.shape[1] // 2)
    session.touch()
    assert np.max(np.abs(session.result_linear() - session.comparison_linear())) > 1e-3
    session.set_mode(MODE_PYRAMID)
    assert session.config.mode == MODE_PYRAMID


def test_session_rejects_out_of_range_levels(random_pair):
    a, b = random_pair
    session = Session(a, b)
    limit = min(6, session.max_levels)
    with pytest.raises(ValueError):
        session.set_levels(limit + 1)
    with pytest.raises(ValueError):
        session.set_levels(1)


def _soft_disc_mask(height: int, width: int) -> np.ndarray:
    yy, xx = np.mgrid[0:height, 0:width].astype(np.float32)
    distance = np.sqrt(
        (xx - width * 0.5) ** 2 + (yy - height * 0.5) ** 2
    )
    return np.clip((0.35 * width - distance) / (0.25 * width), 0.0, 1.0).astype(
        np.float32
    )


def test_pyramid_and_naive_differ_on_a_soft_mask(odd_pair):
    a, b = odd_pair
    session = Session(a, b)
    session.mask_doc.mask[:] = _soft_disc_mask(*a.shape[:2])
    session.touch()
    naive = session.comparison_linear()
    pyramid = session.result_linear()
    assert np.abs(naive - pyramid).max() > 1e-3


def test_pyramid_result_is_not_just_a_blurred_naive_result(odd_pair):
    """A blurred naive blend cannot reproduce scale-dependent transitions."""
    import cv2

    a, b = odd_pair
    session = Session(a, b)
    session.mask_doc.mask[:] = _soft_disc_mask(*a.shape[:2])
    session.touch()
    pyramid = session.result_linear()
    naive = session.comparison_linear()
    blurred = cv2.GaussianBlur(naive, (0, 0), 3.0)
    assert np.mean(np.abs(pyramid - blurred)) > 1e-3
    # Nor is the result equal to the naive blend itself.
    assert np.mean(np.abs(pyramid - naive)) > 1e-5


def test_stripes_sample_shows_scale_separation(odd_pair):
    """Fine stripes stay sharp at high frequency while the smooth背景 blends."""
    from mblend.samples import make_sample

    a, b = make_sample("stripes")
    engine = BlendEngine(a, b)
    h, w = a.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    distance = np.sqrt((xx - w / 2) ** 2 + (yy - h / 2) ** 2)
    mask = np.clip((0.4 * w - distance) / (0.15 * w), 0.0, 1.0).astype(np.float32)
    levels = 4
    pyramid = engine.result(mask, BlendConfig(MODE_PYRAMID, levels))
    naive = engine.naive_result(mask)

    # Inside the transition, coarse structure (row averages) is mixed more
    # smoothly by the pyramid than by the per-pixel blend.
    row_pyr = pyramid.mean(axis=(0, 2))
    row_naive = naive.mean(axis=(0, 2))
    assert np.mean(np.abs(row_pyr - row_naive)) > 1e-4

    # And the fine detail really is taken from one side, not averaged away:
    # the high-pass energy of the result stays close to the source's.
    def highpass_energy(image):
        luminance = image.mean(axis=2)
        blurred = __import__("cv2").GaussianBlur(luminance, (0, 0), 1.0)
        return float(np.mean(np.abs(luminance - blurred)))

    energy_a = highpass_energy(engine.a_linear)
    energy_b = highpass_energy(engine.b_linear)
    energy_out = highpass_energy(pyramid)
    assert energy_out > 0.5 * min(energy_a, energy_b)
