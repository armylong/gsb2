"""Pyramid decomposition: exact reconstruction, odd sizes, level limits."""

from __future__ import annotations

import numpy as np
import pytest

from mblend.pyramid import (
    build_pyramid,
    blend_pyramids,
    max_levels,
    reconstruct_pyramid,
    reduce_size,
    upsample_to,
)

ODD_SIZES = [(97, 131), (643, 979), (9, 33), (5, 5), (65, 27), (3, 401)]


@pytest.mark.parametrize("height,width", ODD_SIZES)
@pytest.mark.parametrize("levels", [1, 2, 4, 6])
def test_reconstruction_is_exact(height, width, levels):
    if levels > max_levels(height, width):
        pytest.skip("size does not support that many levels")
    rng = np.random.default_rng(height * 1000 + width + levels)
    image = rng.random((height, width, 3), dtype=np.float32)
    pyramid = build_pyramid(image, levels)
    rebuilt = reconstruct_pyramid(pyramid)
    assert rebuilt.shape == image.shape
    assert np.max(np.abs(rebuilt - image)) < 1e-5


@pytest.mark.parametrize("height,width", ODD_SIZES)
def test_level_sizes_use_ceil_halving(height, width):
    levels = max_levels(height, width)
    pyramid = build_pyramid(
        np.zeros((height, width, 3), dtype=np.float32), levels
    )
    expected = (height, width)
    for index, size in enumerate(pyramid.sizes):
        assert size == expected
        expected = reduce_size(*expected)
    assert pyramid.residual_size == expected
    # every level really has its declared size
    for size, detail in zip(pyramid.sizes, pyramid.details):
        assert detail.shape[:2] == size


@pytest.mark.parametrize("levels", [2, 4, 6])
def test_constant_image_stays_constant(levels):
    """No border darkening, no checkerboard modulation."""
    image = np.full((97, 131, 3), 0.37, dtype=np.float32)
    pyramid = build_pyramid(image, levels)
    rebuilt = reconstruct_pyramid(pyramid)
    assert np.max(np.abs(rebuilt - image)) < 1e-6
    for detail in pyramid.details:
        assert np.max(np.abs(detail)) < 1e-6


@pytest.mark.parametrize("coarse,target", [
    ((49, 66), (97, 131)),
    ((48, 60), (96, 120)),
    ((2, 2), (4, 4)),
    ((1, 4), (1, 7)),
    ((2, 1), (3, 1)),
])
def test_upsample_is_exact_on_odd_targets(coarse, target):
    value = 0.42
    image = np.full((*coarse, 3), value, dtype=np.float32)
    out = upsample_to(image, *target)
    assert out.shape == (*target, 3)
    assert np.max(np.abs(out - value)) < 1e-6


def test_odd_size_upsample_does_not_shift():
    """A bright column must land on exactly the same column after a round trip."""
    height, width = 97, 131
    image = np.zeros((height, width, 3), dtype=np.float32)
    image[:, 64] = 1.0
    pyramid = build_pyramid(image, 4)
    rebuilt = reconstruct_pyramid(pyramid)
    assert np.argmax(rebuilt[40, :, 0].sum(axis=-1) if rebuilt.ndim == 4 else rebuilt[40, :, 0]) == 64
    assert np.max(np.abs(rebuilt - image)) < 1e-5


def test_max_levels_respects_cap_and_size():
    assert max_levels(1200, 1200) == 6
    assert max_levels(2, 2) == 1
    assert max_levels(1, 1) == 0
    assert max_levels(3, 1200) == 6


def test_build_rejects_too_many_levels():
    with pytest.raises(ValueError, match="最多支持"):
        build_pyramid(np.zeros((2, 2, 3), np.float32), 3)


def test_identical_pyramids_blend_to_identity():
    rng = np.random.default_rng(5)
    image = rng.random((97, 131, 3), dtype=np.float32)
    levels = 4
    pyramid = build_pyramid(image, levels)
    mask = np.clip(
        np.linspace(0, 1, 131, dtype=np.float32)[None, :] * np.ones((97, 1), np.float32),
        0,
        1,
    )[..., None]
    mask_pyramid = build_pyramid(mask, levels)
    out = blend_pyramids(pyramid, pyramid, mask_pyramid)
    assert np.max(np.abs(out - image)) < 1e-5


def test_blend_constant_mask_returns_inputs():
    rng = np.random.default_rng(6)
    a = rng.random((97, 131, 3), dtype=np.float32)
    b = rng.random((97, 131, 3), dtype=np.float32)
    levels = 4
    pa = build_pyramid(a, levels)
    pb = build_pyramid(b, levels)
    for value, expected in ((1.0, a), (0.0, b)):
        mask = np.full((97, 131, 1), value, dtype=np.float32)
        pm = build_pyramid(mask, levels)
        out = blend_pyramids(pa, pb, pm)
        assert np.max(np.abs(out - expected)) < 1e-5


def test_multiresolution_differs_from_naive_blend():
    """Coarse levels use wider masks, so the result is not a plain blend."""
    rng = np.random.default_rng(7)
    a = rng.random((97, 131, 3), dtype=np.float32)
    b = rng.random((97, 131, 3), dtype=np.float32)
    levels = 4
    mask = np.zeros((97, 131, 1), dtype=np.float32)
    mask[:, 65:] = 1.0
    pa, pb = build_pyramid(a, levels), build_pyramid(b, levels)
    out = blend_pyramids(pa, pb, build_pyramid(mask, levels))
    naive = mask * a + (1.0 - mask) * b
    assert np.max(np.abs(out - naive)) > 1e-4


def _transition_width(values: np.ndarray, low: float, high: float) -> int:
    t = (values - low) / (high - low)
    return int(np.count_nonzero((t > 0.02) & (t < 0.98)))


def test_coarse_scales_widen_the_transition():
    """More levels must produce a wider low-frequency transition, and the
    finest band must still switch almost like a hard cut."""
    height, width = 200, 260
    seam = width // 2
    mask = np.zeros((height, width, 1), dtype=np.float32)
    mask[:, seam:] = 1.0
    a = np.full((height, width, 3), 0.55, dtype=np.float32)
    b = np.full((height, width, 3), 0.02, dtype=np.float32)
    widths = []
    for levels in (2, 4, 6):
        out = blend_pyramids(
            build_pyramid(a, levels),
            build_pyramid(b, levels),
            build_pyramid(mask, levels),
        )
        widths.append(_transition_width(out[height // 2, :, 0], 0.02, 0.55))
    assert widths[0] < widths[1] < widths[2]
    assert widths[0] > 0

    yy, xx = np.mgrid[0:height, 0:width]
    stripe = ((xx % 2) * 2 - 1).astype(np.float32) * 0.05
    fine_a = np.repeat((0.5 + stripe)[..., None], 3, axis=2)
    fine_b = np.repeat((0.5 - stripe)[..., None], 3, axis=2)
    levels = 4
    fine = blend_pyramids(
        build_pyramid(fine_a, levels),
        build_pyramid(fine_b, levels),
        build_pyramid(mask, levels),
    )[height // 2, :, 0]
    # Fine one-pixel stripes are switched at the finest scale: only a couple
    # of columns around the seam are mixed.
    assert _transition_width(fine, 0.45, 0.55) <= 6
