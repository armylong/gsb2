"""Accuracy, labelling and invalidity of the robust solver."""
from __future__ import annotations

import numpy as np

from photometric import solver, synthesis, vecmath


def _errors(result, truth):
    return vecmath.angle_between(result.normals, truth)


# ---------------------------------------------------------------------------
# Reconstruction accuracy
# ---------------------------------------------------------------------------

def test_sphere_normals_recovered(sphere_scene, sphere_result):
    d = _errors(sphere_result, sphere_scene.truth_normals)[sphere_result.valid]
    assert d.size > 0
    assert np.median(d) < 2.0
    assert np.percentile(d, 95) < 10.0
    assert (d > 45).mean() < 0.01


def test_relief_normals_recovered(relief_scene, relief_result):
    d = _errors(relief_result, relief_scene.truth_normals)[relief_result.valid]
    assert np.median(d) < 2.5
    assert np.percentile(d, 95) < 12.0


def test_most_of_the_object_is_covered(sphere_result, relief_result):
    assert sphere_result.valid.sum() / sphere_result.object_mask.sum() > 0.75
    assert relief_result.valid.sum() / relief_result.object_mask.sum() > 0.75


def test_normals_are_unit_and_face_camera(sphere_result):
    n = sphere_result.normals[sphere_result.valid]
    assert np.allclose(np.linalg.norm(n, axis=-1), 1.0, atol=1e-6)
    assert np.all(n[:, 2] > 0)


def test_albedo_close_to_truth(sphere_scene, sphere_result):
    sel = sphere_result.valid
    err = np.abs(sphere_result.albedo[sel] - sphere_scene.truth_albedo[sel])
    assert np.median(err) < 0.02


# ---------------------------------------------------------------------------
# Per-reading statuses
# ---------------------------------------------------------------------------

def test_saturated_readings_are_found(sphere_scene, sphere_result):
    found = 0
    truth = 0
    for k in range(sphere_scene.n_lights):
        clipped = sphere_scene.images[k] >= 0.995
        truth += int(clipped.sum())
        found += int((sphere_result.status[k][clipped] == solver.STATUS_SATURATED).sum())
    assert truth > 0
    assert found / truth > 0.95


def test_unlit_readings_are_found(relief_scene, relief_result):
    """Black readings that face away must be labelled (unlit or shadow).

    On a black pixel a cast shadow and an unlit surface are photometrically
    identical, so either label is correct; what must not happen is calling it
    a usable reading.
    """
    for k in range(relief_scene.n_lights):
        ndl = np.einsum("hwj,j->hw", relief_scene.truth_normals,
                        relief_scene.direction_matrix()[k])
        black = relief_scene.images[k] <= 0.045
        unavailable = (ndl <= 0.0) & black & relief_scene.object_mask
        if unavailable.sum() == 0:
            continue
        labelled = (relief_result.status[k] == solver.STATUS_UNLIT) | \
                   (relief_result.status[k] == solver.STATUS_SHADOW)
        assert (labelled & unavailable).sum() / unavailable.sum() > 0.95


def test_cast_shadow_on_lit_surface_is_found(sphere_scene, sphere_result):
    k_found = 0
    total = 0
    underlying = sphere_scene.truth_normals
    dirs = sphere_scene.direction_matrix()
    for k in range(sphere_scene.n_lights):
        ndl = np.einsum("hwj,j->hw", underlying, dirs[k])
        shadow = sphere_scene.truth_shadow[k] & (ndl > 0.15)   # surface faces the light
        total += int(shadow.sum())
        k_found += int((sphere_result.status[k][shadow] == solver.STATUS_SHADOW).sum())
    assert total > 100
    assert k_found / total > 0.5


def test_specular_highlights_are_found(relief_scene, relief_result):
    total = 0
    hit = 0
    dirs = relief_scene.direction_matrix()
    view = np.array([0.0, 0.0, 1.0])
    for k in range(relief_scene.n_lights):
        half = dirs[k] + view
        half /= np.linalg.norm(half)
        ndh = np.einsum("hwj,j->hw", relief_scene.truth_normals, half)
        strong = (0.28 * np.clip(ndh, 0, 1) ** 55 > 0.06) & relief_scene.object_mask
        total += int(strong.sum())
        hit += int((relief_result.status[k][strong] == solver.STATUS_NONLAMBERT).sum())
    assert total > 100
    assert hit / total > 0.25


def test_status_never_claims_valid_without_three_clean_readings(sphere_result):
    clean = (sphere_result.status == solver.STATUS_OK).sum(axis=0)
    assert np.all(clean[sphere_result.valid] >= 3)


def test_invalid_regions_have_a_reason(sphere_result, relief_result):
    for res in (sphere_result, relief_result):
        invalid = res.object_mask & ~res.valid
        assert np.all(res.reason[invalid] != solver.REASON_NONE)
        assert np.all(res.reason[res.valid] == solver.REASON_NONE)
        for code in np.unique(res.reason[invalid]):
            assert int(code) in solver.REASON_NAMES


def test_estimate_uncertainty_is_reported(sphere_result):
    u = sphere_result.uncertainty_deg[sphere_result.valid]
    assert u.size
    assert np.all(np.isfinite(u))
    assert np.median(u) < 5.0


# ---------------------------------------------------------------------------
# Solver robustness to its inputs
# ---------------------------------------------------------------------------

def test_three_lights_is_enough():
    scene = synthesis.build_builtin("sphere", size=120)
    dirs = scene.direction_matrix()[[0, 2, 4]]
    imgs = scene.images[[0, 2, 4]]
    res = solver.solve(imgs, dirs, scene.object_mask)
    d = vecmath.angle_between(res.normals, scene.truth_normals)[res.valid]
    assert res.valid.sum() > 0
    assert np.median(d) < 5.0


def test_degenerate_rig_rejects_everything():
    scene = synthesis.build_builtin("sphere", size=120)
    dirs = np.stack([vecmath.light_from_az_el(a, 0.0) for a in (0, 120, 240)])
    imgs = scene.images[[0, 1, 2]]
    res = solver.solve(imgs, dirs, scene.object_mask)
    # all three lights sit in the image plane: the z component of g is free
    assert res.valid.sum() / max(1, int(res.object_mask.sum())) < 0.05
    # and the reason must say so (conditioning or too few usable readings)
    assert res.invalid_counts().keys() & {solver.REASON_ILL_CONDITIONED,
                                          solver.REASON_TOO_FEW}


def test_quantised_input_still_works(sphere_scene):
    imgs = np.rint(np.clip(sphere_scene.images, 0, 1) * 255) / 255
    res = solver.solve(imgs, sphere_scene.direction_matrix(), sphere_scene.object_mask)
    d = vecmath.angle_between(res.normals, sphere_scene.truth_normals)[res.valid]
    assert np.median(d) < 2.0


def test_direct_light_reproduces_readings(sphere_scene, sphere_result):
    """The fitted model must explain the readings that were kept."""
    clean = sphere_result.status == solver.STATUS_OK
    model = sphere_result.albedo[None] * np.clip(
        np.einsum("ij,hwj->ihw", sphere_result.directions, sphere_result.normals), 0, None)
    residual = np.abs(sphere_scene.images - model)[clean]
    assert np.percentile(residual, 95) < 0.04


def test_solution_is_deterministic(sphere_scene, sphere_result):
    again = solver.solve(sphere_scene.images, sphere_scene.direction_matrix(),
                         sphere_scene.object_mask)
    np.testing.assert_array_equal(again.valid, sphere_result.valid)
    np.testing.assert_allclose(again.normals, sphere_result.normals, atol=1e-9)


def test_disabled_lights_keep_row_mapping(sphere_scene):
    """When a light is disabled the result rows must name the right scene light."""
    keep = [0, 1, 3]
    dirs = sphere_scene.direction_matrix()[keep]
    imgs = sphere_scene.images[keep]
    res = solver.solve(imgs, dirs, sphere_scene.object_mask,
                       light_indices=np.array(keep, dtype=np.int32))
    assert res.light_indices is not None
    assert [res.scene_index(i) for i in range(len(keep))] == keep
    assert res.row_for_scene_light(3) == 2
    assert res.row_for_scene_light(2) is None
    # the predictions must match the photographs they claim to explain
    for row, scene_light in enumerate(keep):
        pred = res.predictions[row]
        img = sphere_scene.images[scene_light]
        clean = res.status[row] == solver.STATUS_OK
        assert np.median(np.abs(pred[clean] - img[clean])) < 0.01


def test_option_limits_are_respected(sphere_scene):
    opts = solver.SolverOptions(min_eigenvalue=0.9)
    res = solver.solve(sphere_scene.images, sphere_scene.direction_matrix(),
                       sphere_scene.object_mask, opts)
    assert res.min_eigenvalue[res.valid].min() >= 0.9
