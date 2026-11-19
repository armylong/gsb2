"""Colour pipeline: sRGB <-> linear conversions and known-value checks."""

from __future__ import annotations

import numpy as np
import pytest

from mblend.color import (
    ImageError,
    linear_to_rgb8,
    load_rgb_image,
    luminance,
    rgb8_to_linear,
    srgb_to_linear,
    linear_to_srgb,
)


def test_endpoints_exact():
    assert srgb_to_linear(np.array([0.0], np.float32))[0] == pytest.approx(0.0, abs=1e-7)
    assert srgb_to_linear(np.array([1.0], np.float32))[0] == pytest.approx(1.0, abs=1e-7)
    assert linear_to_srgb(np.array([0.0], np.float32))[0] == pytest.approx(0.0, abs=1e-7)
    assert linear_to_srgb(np.array([1.0], np.float32))[0] == pytest.approx(1.0, abs=1e-7)


def test_mid_grey_known_value():
    # 128/255 sRGB must decode to ~0.2158 linear light.
    linear = srgb_to_linear(np.array([128.0 / 255.0], np.float32))[0]
    assert linear == pytest.approx(0.21586, abs=2e-4)
    encoded = linear_to_srgb(np.array([0.21586], np.float32))[0]
    assert encoded == pytest.approx(128.0 / 255.0, abs=2e-4)


def test_round_trip_is_stable():
    values = np.linspace(0.0, 1.0, 4096, dtype=np.float32)
    back = linear_to_srgb(srgb_to_linear(values))
    assert np.max(np.abs(back - values)) < 1e-5


def test_linear_blend_is_not_gamma_space_blend():
    """Independent colour sample: 50/50 black and white in linear light."""
    black = rgb8_to_linear(np.array([[[0, 0, 0]]], np.uint8))
    white = rgb8_to_linear(np.array([[[255, 255, 255]]], np.uint8))
    mixed = 0.5 * black + 0.5 * white
    encoded = linear_to_rgb8(mixed)[0, 0]
    # Linear-light mid point is 188 sRGB; a naive 8-bit average would be 128.
    assert tuple(int(c) for c in encoded) == (188, 188, 188)
    assert abs(int(encoded[0]) - 128) > 50


def test_linear_blend_known_colour_triplet():
    """A single known colour: 25 % of pure red in linear light."""
    red = rgb8_to_linear(np.array([[[255, 0, 0]]], np.uint8))
    zero = np.zeros((1, 1, 3), np.float32)
    mixed = 0.25 * red + 0.75 * zero
    out = linear_to_rgb8(mixed)[0, 0]
    # srgb(0.25) = 0.5371 -> 137
    assert int(out[0]) == pytest.approx(137, abs=1)
    assert int(out[1]) == 0 and int(out[2]) == 0
    # The same arithmetic in gamma space would give 64.
    assert int(out[0]) != 64


def test_luminance_weights_sum_to_one():
    white = np.ones((2, 2, 3), dtype=np.float32)
    assert np.allclose(luminance(white), 1.0)


def _write_png(path, rgb):
    import cv2

    ok, buf = cv2.imencode(".png", cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR))
    assert ok
    buf.tofile(str(path))


def test_load_rejects_transparent(tmp_path):
    rgba = np.zeros((10, 10, 4), dtype=np.uint8)
    rgba[..., 3] = 255
    rgba[0, 0, 3] = 128
    import cv2

    ok, buf = cv2.imencode(".png", rgba)
    assert ok
    path = tmp_path / "transparent.png"
    buf.tofile(str(path))
    with pytest.raises(ImageError, match="透明"):
        load_rgb_image(path)


def test_load_rejects_oversized(tmp_path):
    rgb = np.zeros((12, 13, 3), dtype=np.uint8)
    path = tmp_path / "big.png"
    _write_png(path, rgb)
    with pytest.raises(ImageError, match="超出上限"):
        load_rgb_image(path, max_size=12)
    loaded = load_rgb_image(path, max_size=13)
    assert loaded.shape == (12, 13, 3)


def test_load_converts_grayscale_and_strips_opaque_alpha(tmp_path):
    import cv2

    gray = np.full((9, 7), 77, dtype=np.uint8)
    ok, buf = cv2.imencode(".png", gray)
    path = tmp_path / "gray.png"
    buf.tofile(str(path))
    loaded = load_rgb_image(path)
    assert loaded.shape == (9, 7, 3)
    assert np.all(loaded == 77)

    rgba = np.zeros((6, 5, 4), dtype=np.uint8)
    rgba[..., 3] = 255
    rgba[..., :3] = (10, 20, 30)
    ok, buf = cv2.imencode(".png", rgba)
    path2 = tmp_path / "alpha.png"
    buf.tofile(str(path2))
    loaded2 = load_rgb_image(path2)
    assert loaded2.shape == (6, 5, 3)
    assert tuple(int(c) for c in loaded2[0, 0]) == (10, 20, 30)


def test_load_accepts_jpeg(tmp_path):
    import cv2

    rgb = np.full((16, 16, 3), 200, dtype=np.uint8)
    ok, buf = cv2.imencode(".jpg", cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR))
    path = tmp_path / "x.jpg"
    buf.tofile(str(path))
    loaded = load_rgb_image(path)
    assert loaded.shape == (16, 16, 3)
