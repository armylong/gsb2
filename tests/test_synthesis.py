"""Synthetic scene integrity: images must match the truth they ship with."""
from __future__ import annotations

import numpy as np
import pytest

from photometric import synthesis, vecmath


@pytest.mark.parametrize("key", synthesis.BUILTIN_KEYS)
def test_scene_shape_and_range(key):
    scene = synthesis.build_builtin(key, size=96)
    assert scene.images.shape == (scene.n_lights, 96, 96)
    assert scene.n_lights >= 3
    assert scene.images.min() >= 0.0 and scene.images.max() <= 1.0
    assert scene.truth_normals.shape == (96, 96, 3)
    assert scene.object_mask.shape == (96, 96)


@pytest.mark.parametrize("key", synthesis.BUILTIN_KEYS)
def test_truth_normals_are_unit_and_face_viewer(key):
    scene = synthesis.build_builtin(key, size=96)
    n = scene.truth_normals[scene.object_mask]
    assert np.allclose(np.linalg.norm(n, axis=-1), 1.0, atol=1e-6)
    assert np.all(n[:, 2] > -1e-6)


def test_light_directions_are_unit_and_spread(sphere_scene):
    dirs = sphere_scene.direction_matrix()
    assert np.allclose(np.linalg.norm(dirs, axis=-1), 1.0)
    from photometric import rig

    q = rig.assess(sphere_scene.lights)
    assert q.well_posed and q.covers_hemisphere


def test_images_match_lambert_plus_specular_model(sphere_scene):
    """Reconstruct each photograph from truth normal/albedo and the shading model.

    This guards against a render/truth mismatch, which would make every accuracy
    test meaningless.
    """
    scene = sphere_scene
    n = scene.truth_normals
    albedo = scene.truth_albedo
    view = np.array([0.0, 0.0, 1.0])
    for k, light in enumerate(scene.direction_matrix()):
        ndl = np.clip(np.einsum("hwj,j->hw", n, light), 0, 1)
        half = light + view
        half /= np.linalg.norm(half)
        spec = 0.52 * np.clip(np.einsum("hwj,j->hw", n, half), 0, 1) ** 90
        radiance = albedo * ndl + spec
        radiance = np.where(scene.truth_shadow[k], radiance * 0.045, radiance)
        model = np.clip(radiance, 0, 1) * scene.object_mask
        err = np.abs(model - scene.images[k])[scene.object_mask]
        assert np.percentile(err, 99) < 0.03


def test_builtin_scene_has_all_three_failure_modes(sphere_scene):
    assert sphere_scene.truth_shadow.any(), "no cast shadow in the test scene"
    assert (sphere_scene.images >= 0.995).any(), "no clipped pixel in the test scene"
    assert sphere_scene.truth_specular.any(), "no specular highlight in the test scene"
    assert sphere_scene.truth_unlit.any(), "no unlit reading in the test scene"


def test_relief_has_cast_shadow_and_specular(relief_scene):
    assert relief_scene.truth_shadow.any()
    assert relief_scene.truth_specular.any()


def test_sphere_geometry_is_analytic(sphere_scene):
    """Every object pixel's normal must point out of a sphere centred on the disc."""
    scene = sphere_scene
    h, w = scene.height, scene.width
    yy, xx = np.mgrid[0:h, 0:w]
    x = ((xx + 0.5) / w) * 2 - 1
    y = 1 - ((yy + 0.5) / h) * 2
    mask = scene.object_mask
    r = np.linalg.norm(scene.truth_normals[mask][:, :2], axis=-1)
    assert np.all(r <= 1.0 + 1e-9)
    # normals of the main sphere must be radial about the sphere's centre
    main = mask & (np.abs(x - 0.01) < 0.25) & (np.abs(y - 0.01) < 0.25)
    nx, ny = scene.truth_normals[main][:, 0], scene.truth_normals[main][:, 1]
    dx = (x[main] - 0.01) / 0.72
    dy = (y[main] - 0.01) / 0.72
    assert np.allclose(nx, dx, atol=0.02)
    assert np.allclose(ny, dy, atol=0.02)


def test_resize_stack_keeps_values_and_reports_factor():
    rng = np.random.default_rng(0)
    imgs = rng.random((4, 300, 400))
    out, factor = synthesis.resize_stack(imgs, 200)
    assert factor == pytest.approx(0.5)
    assert out.shape == (4, 150, 200)
    out2, f2 = synthesis.resize_stack(imgs, 1000)
    assert f2 == 1.0
    assert out2.shape == imgs.shape


def test_scene_from_images_round_trip():
    rng = np.random.default_rng(1)
    imgs = rng.random((3, 20, 30)).astype(np.float32)
    dirs = np.stack([vecmath.light_from_az_el(a, 30) for a in (0, 120, 240)])
    scene = synthesis.scene_from_images(imgs, dirs, ["a", "b", "c"])
    assert scene.n_lights == 3
    assert scene.has_truth is False
    assert scene.object_mask.all()          # every pixel has some light
    assert [s.name for s in scene.lights] == ["a", "b", "c"]
