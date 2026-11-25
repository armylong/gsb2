"""Pure-pixel rendering helpers (no Qt widgets involved)."""
from __future__ import annotations

import numpy as np

from photometric import rendering, solver, vecmath


def test_normal_map_matches_encoding(sphere_result):
    rgb = rendering.normal_map_rgb(sphere_result)
    assert rgb.dtype == np.uint8
    decoded = vecmath.decode_normals(rgb)
    length = np.linalg.norm(decoded, axis=-1)
    sel = sphere_result.valid
    unit = decoded[sel] / length[sel][..., None]
    err = vecmath.angle_between(unit, sphere_result.normals[sel])
    assert err.max() < 1.0


def test_invalid_pixels_are_visually_marked(sphere_result):
    # the on-screen map uses a dark background so the valid shape reads cleanly
    rgb = rendering.normal_map_rgb(sphere_result)
    assert np.all(rgb[~sphere_result.valid] == 0)
    # the encoder itself uses neutral grey so a bare file still decodes to zero
    enc = rendering.normal_map_rgb(sphere_result, background=vecmath.NORMAL_BACKGROUND)
    assert np.all(enc[~sphere_result.valid] == vecmath.NORMAL_BACKGROUND)


def test_relight_flat_surface_matches_lambert():
    opts = solver.SolverOptions()
    h = w = 8
    normals = np.zeros((h, w, 3))
    normals[..., 2] = 1.0
    result = solver.SolveResult(
        width=w, height=h,
        directions=np.stack([vecmath.light_from_az_el(a, 0) for a in (0, 90, 180)]),
        normals=normals,
        albedo=np.full((h, w), 0.8),
        status=np.zeros((3, h, w), np.int8),
        valid=np.ones((h, w), bool),
        reason=np.zeros((h, w), np.int8),
        object_mask=np.ones((h, w), bool),
        predictions=np.zeros((3, h, w)),
        residual=np.zeros((3, h, w)),
        uncertainty_deg=np.zeros((h, w)),
        readings_used=np.full((h, w), 3, np.int16),
        min_eigenvalue=np.ones((h, w)),
        confidence=np.ones((h, w)),
        sigma=0.01,
        options=opts,
    )
    head_on = rendering.relight(result, np.array([0.0, 0.0, 1.0]))
    assert np.allclose(head_on, 0.8, atol=1e-9)
    side = rendering.relight(result, np.array([1.0, 0.0, 0.0]))
    assert np.allclose(side, 0.0, atol=1e-9)


def test_relight_is_zero_outside_object(sphere_result):
    img = rendering.relight(sphere_result, np.array([0.0, 0.0, 1.0]))
    assert np.all(img[~sphere_result.object_mask] == 0.0)
    assert img.min() >= 0.0 and img.max() <= 1.0


def test_relight_fills_unknown_regions_with_grey(sphere_result):
    img = rendering.relight(sphere_result, np.array([0.2, 0.3, 0.9]))
    unknown = sphere_result.object_mask & ~sphere_result.valid
    assert unknown.any()
    assert np.allclose(img[unknown], rendering.UNKNOWN_GRAY)


def test_arrow_field_only_on_valid_pixels(sphere_result):
    arrows = rendering.arrow_field(sphere_result, spacing=16)
    assert arrows
    for x, y, dx, dy, tilt in arrows:
        assert sphere_result.valid[y, x]
        assert 0.0 <= tilt <= 90.0


def test_arrow_direction_follows_normal():
    h = w = 4
    normals = np.zeros((h, w, 3))
    normals[..., 0] = 0.5
    normals[..., 2] = np.sqrt(0.75)
    res = _fake_result(h, w, normals, valid=np.ones((h, w), bool))
    arrows = rendering.arrow_field(res, spacing=2, min_tilt_deg=1.0)
    assert arrows
    _, _, dx, dy, _ = arrows[0]
    # a normal leaning right must draw pointing right; +y normal must draw up
    assert dx > 0


def test_status_overlay_tints_only_problem_readings(sphere_scene, sphere_result):
    base = rendering.gray_rgb(sphere_scene.images[0])
    tinted = rendering.status_overlay(base, sphere_result, 0)
    problem = sphere_result.status[0] != solver.STATUS_OK
    # the overlay is a wash: a normal reading stays grey, a problem reading is
    # pulled towards its status hue.  "Unlit" is itself a neutral grey, so use
    # the reported status to know which pixels must have moved.
    base_f = base.astype(np.float64)
    tinted_f = tinted.astype(np.float64)
    moved = np.any(np.abs(tinted_f - base_f * 0.72) > 2.0, axis=-1)
    normal_pixels = ~problem & sphere_result.object_mask
    assert moved[problem].mean() > 0.95
    assert moved[normal_pixels].mean() < 0.05
    # background is never changed by the status tint
    assert np.all(tinted[~sphere_result.object_mask] == base[~sphere_result.object_mask])


def test_invalid_map_colours_unknown_regions(sphere_result):
    rgb = rendering.invalid_map_rgb(sphere_result)
    assert rgb.shape == (sphere_result.height, sphere_result.width, 3)
    bg = ~sphere_result.object_mask
    assert np.all(rgb[bg] == rgb[bg][0])


def test_truth_comparison_is_zero_error_bright():
    truth = np.zeros((2, 2, 3))
    truth[..., 2] = 1.0
    res = _fake_result(2, 2, truth.copy(), valid=np.ones((2, 2), bool))
    rgb = rendering.truth_comparison(res, truth)
    # zero error must be the lightest step of the sequential ramp
    assert rgb[0, 0].min() > 180


def _fake_result(h, w, normals, valid):
    return solver.SolveResult(
        width=w, height=h,
        directions=np.stack([vecmath.light_from_az_el(a, 30) for a in (0, 120, 240)]),
        normals=normals,
        albedo=np.full((h, w), 0.6),
        status=np.zeros((3, h, w), np.int8),
        valid=valid,
        reason=np.zeros((h, w), np.int8),
        object_mask=valid.copy(),
        predictions=np.zeros((3, h, w)),
        residual=np.zeros((3, h, w)),
        uncertainty_deg=np.full((h, w), 1.0),
        readings_used=np.full((h, w), 3, np.int16),
        min_eigenvalue=np.ones((h, w)),
        confidence=np.ones((h, w)),
        sigma=0.01,
    )
