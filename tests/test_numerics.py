"""Key numeric checks: orientation, ramp signs, green convention, boundaries,
round-trip lighting, and preset expectations.

Run with:  .venv/bin/python -m pytest -q
"""

from __future__ import annotations

import math

import numpy as np
import pytest

from normalmap_tool.io import (
    load_height_png,
    load_normal_png,
    read_sidecar,
    save_normal_png,
)
from normalmap_tool.model import (
    BOUNDARY_EXTEND,
    BOUNDARY_WRAP,
    GREEN_Y_DOWN,
    GREEN_Y_UP,
    LightSettings,
    compute_normal_field,
    decode_normal_rgb,
    encode_normal_rgb,
    height_gradient,
    light_direction_field,
    shade,
)
from normalmap_tool.pipeline import BuildParams, build_normals, shade_build
from normalmap_tool.presets import (
    PRESET_FLAT,
    PRESET_HORIZONTAL,
    PRESET_VERTICAL,
    PRESET_WAVE,
    VALIDATION_LIGHT,
    expected_normal_for_ramp,
    expected_normal_wave,
    fixed_lamp_intensity,
    generate_preset,
    wave_tolerance,
)


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #

def gaussian_bump(size: int = 65, sigma: float = 8.0, amplitude: float = 1.0):
    c = (size - 1) / 2.0
    r = np.arange(size, dtype=np.float64)[:, None]
    k = np.arange(size, dtype=np.float64)[None, :]
    field = amplitude * np.exp(-((r - c) ** 2 + (k - c) ** 2) / (2.0 * sigma**2))
    return field / field.max()


def litness(build, light, row, col):
    result = shade_build(build, light)
    return float(result.lit[row, col])


# --------------------------------------------------------------------------- #
# 1. flat ground and unit length
# --------------------------------------------------------------------------- #

def test_flat_height_gives_plus_z_normal_and_unit_length():
    h = np.full((16, 20), 0.5)
    n, _, _ = compute_normal_field(h, strength=64.0, boundary=BOUNDARY_EXTEND)
    assert np.allclose(n[..., 0], 0.0, atol=1e-12)
    assert np.allclose(n[..., 1], 0.0, atol=1e-12)
    assert np.allclose(n[..., 2], 1.0, atol=1e-12)

    rgb = encode_normal_rgb(n, GREEN_Y_UP)
    # flat normal -> R=128, G=128, B=255 under the standard mapping
    assert np.all(rgb[..., 0] == 128)
    assert np.all(rgb[..., 1] == 128)
    assert np.all(rgb[..., 2] == 255)

    dec = decode_normal_rgb(rgb, GREEN_Y_UP)
    lengths = np.linalg.norm(dec.unit, axis=-1)
    assert np.min(lengths) == pytest.approx(1.0, abs=1e-9)
    assert np.max(lengths) == pytest.approx(1.0, abs=1e-9)
    # 128/255 decodes to +0.39% in x and y; that is the 8-bit floor.
    assert np.allclose(dec.unit, n, atol=6e-3)


def test_generated_normal_lengths_are_near_one():
    build = build_normals(gaussian_bump(), BuildParams(strength=40.0))
    lengths = np.linalg.norm(build.geometric, axis=-1)
    assert np.min(lengths) == pytest.approx(1.0, abs=1e-12)
    assert np.max(lengths) == pytest.approx(1.0, abs=1e-12)
    stored = build.decoded_length
    # 8-bit storage: decoded lengths are close to 1 but not exact
    assert np.min(stored) > 0.95
    assert np.max(stored) < 1.05


# --------------------------------------------------------------------------- #
# 2. ramp signs (both image orientations)
# --------------------------------------------------------------------------- #

def test_horizontal_ramp_tilts_normal_toward_minus_x():
    preset = generate_preset(PRESET_HORIZONTAL)
    strength = 32.0
    build = build_normals(preset.height, BuildParams(strength=strength))
    n, _, _ = compute_normal_field(preset.height, strength, BOUNDARY_EXTEND)
    expected = expected_normal_for_ramp(PRESET_HORIZONTAL, strength, preset.width)

    mid = slice(8, -8)
    interior = n[mid, mid]
    assert np.allclose(interior, expected[None, None, :], atol=1e-6)
    # height rises to the right -> surface faces left (-x)
    assert interior[..., 0].max() < -0.05
    assert np.allclose(interior[..., 1], 0.0, atol=1e-9)
    # and the stored map agrees after quantisation
    assert np.all(build.rgb[mid, mid, 0] < 128)
    assert np.all(build.rgb[mid, mid, 1] == 128)


def test_vertical_ramp_tilts_normal_toward_plus_y():
    preset = generate_preset(PRESET_VERTICAL)
    strength = 32.0
    build = build_normals(preset.height, BuildParams(strength=strength))
    n, _, _ = compute_normal_field(preset.height, strength, BOUNDARY_EXTEND)
    expected = expected_normal_for_ramp(PRESET_VERTICAL, strength, preset.width)

    mid = slice(8, -8)
    interior = n[mid, mid]
    # rows increase downward and brightness increases downward; +y is up, so
    # the surface faces upward (+y).
    assert np.allclose(interior, expected[None, None, :], atol=1e-6)
    assert interior[..., 1].min() > 0.05
    assert np.allclose(interior[..., 0], 0.0, atol=1e-9)
    assert np.all(build.rgb[mid, mid, 1] > 128)  # y_up encoding
    assert np.all(build.rgb[mid, mid, 0] == 128)


def test_vertical_ramp_lighting_matches_expected_fixed_lamp():
    preset = generate_preset(PRESET_VERTICAL)
    strength = 32.0
    build = build_normals(preset.height, BuildParams(strength=strength))
    expected = expected_normal_for_ramp(PRESET_VERTICAL, strength, preset.width)
    row, col = 128, 128
    expected_intensity = fixed_lamp_intensity(
        expected, row, col, preset.width, preset.height_px, VALIDATION_LIGHT
    )
    result = shade_build(build, VALIDATION_LIGHT)
    assert result.lit[row, col] == pytest.approx(expected_intensity, abs=2e-3)


def test_bump_is_convex_not_pit_under_side_light():
    """Light from +x must brighten the +x flank of a bump (a pit would invert)."""
    h = gaussian_bump()
    build = build_normals(h, BuildParams(strength=20.0))
    light = LightSettings(plane_x=0.8, plane_y=0.0, height=1.0,
                          ambient=0.1, diffuse=0.9)
    lit = shade_build(build, light).lit
    mid = h.shape[0] // 2
    right = lit[mid, mid + 10]
    left = lit[mid, mid - 10]
    assert right > left + 0.05
    # normals point away from the peak on each side
    n = build.decoded
    assert n[mid, mid + 10, 0] > 0.05
    assert n[mid, mid - 10, 0] < -0.05


# --------------------------------------------------------------------------- #
# 3. green convention toggling only changes storage
# --------------------------------------------------------------------------- #

def test_green_switch_changes_only_storage_not_geometry():
    h = gaussian_bump()
    up = build_normals(h, BuildParams(strength=24.0, green=GREEN_Y_UP))
    down = build_normals(h, BuildParams(strength=24.0, green=GREEN_Y_DOWN))

    assert np.array_equal(up.rgb[..., 0], down.rgb[..., 0])
    assert np.array_equal(up.rgb[..., 2], down.rgb[..., 2])
    assert np.array_equal(down.rgb[..., 1], 255 - up.rgb[..., 1])
    assert np.array_equal(up.geometric, down.geometric)
    # decoding each with its own convention recovers the same normals
    assert np.allclose(up.decoded, down.decoded, atol=1e-12)
    assert np.allclose(up.decoded, up.geometric, atol=6e-3)

    # therefore lighting is identical too: no convex -> concave surprise
    light = LightSettings(plane_x=0.6, plane_y=0.5, height=0.8,
                          ambient=0.15, diffuse=0.85)
    assert np.allclose(shade_build(up, light).lit,
                       shade_build(down, light).lit, atol=1e-12)


def test_green_convention_mismatch_detection_is_meaningful():
    """Decoding a -Y map as +Y mirrors y; this is the misconfiguration to avoid."""
    h = gaussian_bump()
    up = build_normals(h, BuildParams(strength=24.0, green=GREEN_Y_UP))
    down = build_normals(h, BuildParams(strength=24.0, green=GREEN_Y_DOWN))
    wrong = decode_normal_rgb(down.rgb, GREEN_Y_UP)
    assert np.allclose(wrong.unit[..., 1], -up.decoded[..., 1], atol=2e-3)


# --------------------------------------------------------------------------- #
# 4. boundaries
# --------------------------------------------------------------------------- #

def test_wrap_uses_same_row_and_same_column_neighbours():
    h = (np.arange(9)[:, None] * 1000.0 + np.arange(7)[None, :]).astype(np.float64)
    d_row, d_col = height_gradient(h, BOUNDARY_WRAP)
    # right edge neighbourhood comes from the same row (col 0 vs col W-2)
    assert d_col[:, -1] == pytest.approx((h[:, 0] - h[:, -2]) / 2.0)
    assert d_col[:, 0] == pytest.approx((h[:, 1] - h[:, -1]) / 2.0)
    # bottom edge neighbourhood comes from the same column (row 0 vs row H-2)
    assert d_row[-1, :] == pytest.approx((h[0, :] - h[-2, :]) / 2.0)
    # row 3 = 3000 + col, so d_col at the right edge is (0 - 5)/2 = -2.5
    assert d_col[3, -1] == pytest.approx(-2.5)


def test_extend_and_wrap_agree_in_the_interior():
    h = gaussian_bump()
    dr_e, dc_e = height_gradient(h, BOUNDARY_EXTEND)
    dr_w, dc_w = height_gradient(h, BOUNDARY_WRAP)
    mid = (slice(2, -2), slice(2, -2))
    assert np.allclose(dr_e[mid], dr_w[mid], atol=1e-12)
    assert np.allclose(dc_e[mid], dc_w[mid], atol=1e-12)


def test_periodic_wave_matches_analytic_normals_at_edges():
    """Wrap edges must be as accurate as the interior relative to the sine law."""
    preset = generate_preset(PRESET_WAVE)
    strength = 32.0
    n_wrap, _, _ = compute_normal_field(preset.height, strength, BOUNDARY_WRAP)
    want = expected_normal_wave(strength, preset.width)
    tol = wave_tolerance(strength)
    lengths = np.linalg.norm(n_wrap, axis=-1)
    assert np.allclose(lengths, 1.0, atol=1e-12)
    assert np.all(n_wrap[..., 2] > 0)
    interior = n_wrap[2:-2, 2:-2]
    interior_err = float(np.abs(interior - want[2:-2, 2:-2]).max())
    edges = np.concatenate([n_wrap[0], n_wrap[-1], n_wrap[:, 0], n_wrap[:, -1]])
    want_edges = np.concatenate([want[0], want[-1], want[:, 0], want[:, -1]])
    edge_err = float(np.abs(edges - want_edges).max())
    assert interior_err <= tol
    assert edge_err <= tol


def test_edge_gradient_uses_the_row_neighbour_not_a_flattened_index():
    """A distinct-pitch grid proves the wrap handles rows and columns separately."""
    h = (np.arange(9)[:, None] * 1000.0 + np.arange(7)[None, :]).astype(np.float64)
    d_row, d_col = height_gradient(h, BOUNDARY_WRAP)
    # right edge pairs with col 0 of the SAME row: (0 - 5) / 2 = -2.5.
    # A flattened neighbour (next row, col 0) would give ~1000 instead.
    assert d_col[0, -1] == pytest.approx(-2.5)
    assert d_col[5, -1] == pytest.approx(-2.5)
    # left edge pairs with the same row's second-to-last pixel: (1 - 6) / 2
    assert d_col[0, 0] == pytest.approx(-2.5)


def test_wrap_and_extend_differ_only_at_the_border():
    # A slanted plane has a non-zero slope everywhere, including the border,
    # so the two boundary rules must disagree there and nowhere else.
    cols = np.arange(65, dtype=np.float64)[None, :]
    h = np.broadcast_to(0.2 + 0.6 * cols / 64.0, (65, 65)).copy()
    build_wrap = build_normals(h, BuildParams(strength=32.0,
                                              boundary=BOUNDARY_WRAP))
    build_ext = build_normals(h, BuildParams(strength=32.0,
                                             boundary=BOUNDARY_EXTEND))
    assert np.allclose(build_wrap.decoded[2:-2, 2:-2],
                       build_ext.decoded[2:-2, 2:-2], atol=1e-12)
    # compare the continuous field: 8-bit rounding can hide sub-code changes
    assert not np.allclose(build_wrap.geometric[0], build_ext.geometric[0],
                           atol=1e-6)


# --------------------------------------------------------------------------- #
# 5. export -> reload -> lighting consistency
# --------------------------------------------------------------------------- #

def test_export_and_reload_lighting_is_consistent(tmp_path):
    preset = generate_preset(PRESET_WAVE)
    build = build_normals(preset.height, BuildParams(strength=37.0,
                                                     boundary=BOUNDARY_WRAP))
    light = LightSettings(plane_x=0.4, plane_y=-0.3, height=1.2,
                          ambient=0.1, diffuse=0.9)
    before = shade_build(build, light)

    out = tmp_path / "wave_normal.png"
    sidecar = save_normal_png(
        out, build.rgb,
        green=GREEN_Y_UP, boundary=BOUNDARY_WRAP, strength=37.0,
        smoothing=0.0, width=build.width, height=build.height,
        source_heightmap="preset:wave", light=light,
    )
    assert out.is_file() and sidecar.is_file()

    loaded = load_normal_png(out)
    assert loaded.meta["green_channel"] == GREEN_Y_UP
    assert loaded.meta["boundary"] == BOUNDARY_WRAP
    assert loaded.meta["height_strength"] == pytest.approx(37.0)
    assert np.array_equal(loaded.rgb, build.rgb)

    dec = decode_normal_rgb(loaded.rgb, loaded.meta["green_channel_resolved"])
    lvec = light_direction_field(build.width, build.height, light)
    after = shade(dec.unit, lvec, light.ambient, light.diffuse)
    assert np.allclose(after, before.lit, atol=1e-12)


def test_saved_green_metadata_controls_reload_decode(tmp_path):
    h = gaussian_bump()
    build = build_normals(h, BuildParams(strength=24.0, green=GREEN_Y_DOWN))
    out = tmp_path / "down_n.png"
    save_normal_png(out, build.rgb, green=GREEN_Y_DOWN,
                    boundary=BOUNDARY_EXTEND, strength=24.0, smoothing=0.0,
                    width=build.width, height=build.height)
    auto = load_normal_png(out)
    assert auto.meta["green_channel_resolved"] == GREEN_Y_DOWN
    manual = load_normal_png(out, green=GREEN_Y_UP)
    assert manual.meta["green_channel_resolved"] == GREEN_Y_UP
    a = decode_normal_rgb(auto.rgb, auto.meta["green_channel_resolved"]).unit
    b = decode_normal_rgb(manual.rgb, manual.meta["green_channel_resolved"]).unit
    assert np.allclose(a[..., 1], -b[..., 1], atol=2e-3)


def test_heightmap_loader_normalises_by_code_depth(tmp_path):
    import cv2

    raw = np.array([[0, 128, 0, 0], [64, 255, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]],
                   dtype=np.uint8)
    path = tmp_path / "h.png"
    cv2.imwrite(str(path), raw)
    loaded = load_height_png(path)
    assert loaded.bit_depth == 8
    assert loaded.data[0, 0] == pytest.approx(0.0)
    assert loaded.data[1, 1] == pytest.approx(1.0)
    assert loaded.data[1, 0] == pytest.approx(64 / 255)


def test_heightmap_loader_refuses_oversize_and_colour(tmp_path):
    import cv2

    big = tmp_path / "big.png"
    cv2.imwrite(str(big), np.zeros((1025, 8), np.uint8))
    with pytest.raises(Exception):
        load_height_png(big)

    colour = tmp_path / "colour.png"
    cv2.imwrite(str(colour), np.zeros((8, 8, 3), np.uint8))
    with pytest.raises(Exception):
        load_height_png(colour)


# --------------------------------------------------------------------------- #
# 6. presets: flat + both ramps with independent expected normals
# --------------------------------------------------------------------------- #

def test_preset_flat_orientation_and_fixed_lamp():
    preset = generate_preset(PRESET_FLAT)
    expected = expected_normal_for_ramp(PRESET_FLAT, 32.0, preset.width)
    assert np.allclose(expected, [0.0, 0.0, 1.0])
    build = build_normals(preset.height, BuildParams(strength=32.0))
    assert np.allclose(build.geometric[..., 2], 1.0, atol=1e-12)
    row, col = 128, 128
    expected_intensity = fixed_lamp_intensity(
        expected, row, col, preset.width, preset.height_px, VALIDATION_LIGHT
    )
    assert shade_build(build, VALIDATION_LIGHT).lit[row, col] == pytest.approx(
        expected_intensity, abs=2e-3
    )


@pytest.mark.parametrize("key", [PRESET_FLAT, PRESET_HORIZONTAL, PRESET_VERTICAL])
def test_ramp_expected_normals_match_within_quantisation(key):
    preset = generate_preset(key)
    strength = 32.0
    expected = expected_normal_for_ramp(key, strength, preset.width)
    build = build_normals(preset.height, BuildParams(strength=strength))
    interior = build.geometric[8:-8, 8:-8]
    err = np.abs(interior - expected[None, None, :]).max()
    # allowed 8-bit storage quantisation ~ 1/255 in each channel
    assert err < 0.01
    # raw encoded bytes within one code of the analytic encode
    from normalmap_tool.model import encode_normal_rgb as enc
    ideal = enc(expected.reshape(1, 1, 3), GREEN_Y_UP)
    delta = np.abs(build.rgb[8:-8, 8:-8].astype(int) - ideal.astype(int))
    assert delta.max() <= 1


def test_wave_preset_is_periodic_with_both_edges_equal():
    preset = generate_preset(PRESET_WAVE)
    h = preset.height
    # sample at the seam: value just after the last pixel wraps to the first
    assert h[0, 0] == pytest.approx(
        0.5 + 0.16 * math.sin(math.pi / 3.0), abs=1 / 255
    )
    d_row, d_col = height_gradient(h, BOUNDARY_WRAP)
    # left/right edge derivatives come from the same continuous sine
    assert np.allclose(d_col[:, 0], d_col[:, -1], atol=0.01)
