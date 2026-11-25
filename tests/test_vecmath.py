"""Vector conventions and the normal-map encoding round-trip."""
from __future__ import annotations

import numpy as np

from photometric import vecmath


def test_az_el_round_trip():
    for az, el in [(0, 0), (90, 0), (180, 45), (270, 30), (359, 89), (45, 60)]:
        d = vecmath.light_from_az_el(az, el)
        assert d.shape == (3,)
        assert np.isclose(np.linalg.norm(d), 1.0)
        az2, el2 = vecmath.az_el_from_direction(d)
        assert np.isclose(az2 % 360, az % 360, atol=1e-9)
        assert np.isclose(el2, el, atol=1e-9)


def test_conventions():
    # azimuth 0 = to the right, azimuth 90 = up, elevation 90 = at the camera
    assert np.allclose(vecmath.light_from_az_el(0, 0), [1, 0, 0])
    assert np.allclose(vecmath.light_from_az_el(90, 0), [0, 1, 0], atol=1e-12)
    assert np.allclose(vecmath.light_from_az_el(0, 90), [0, 0, 1], atol=1e-12)


def test_encode_decode_round_trip():
    rng = np.random.default_rng(3)
    v = rng.normal(size=(40, 50, 3))
    v /= np.linalg.norm(v, axis=-1, keepdims=True)
    rgb = vecmath.encode_normals(v)
    assert rgb.dtype == np.uint8
    assert rgb.shape == (40, 50, 3)
    back = vecmath.decode_normals(rgb)
    back /= np.linalg.norm(back, axis=-1, keepdims=True)
    err = vecmath.angle_between(back, v)   # already in degrees
    assert err.max() < 1.0
    assert np.percentile(err, 99) < 0.6


def test_encode_specific_values():
    # flat normal (0, 0, 1) must be the classic lavender (128, 128, 255)
    rgb = vecmath.encode_normals(np.array([[[0.0, 0.0, 1.0]]]))
    assert tuple(rgb[0, 0]) == (128, 128, 255)


def test_green_points_up_not_down():
    # A normal tilted up (+y) must raise the green channel.
    up = vecmath.encode_normals(np.array([[[0.0, 0.6, 0.8]]]))[0, 0]
    down = vecmath.encode_normals(np.array([[[0.0, -0.6, 0.8]]]))[0, 0]
    assert up[1] > down[1]
    assert up[1] > 128 > down[1]


def test_invalid_pixels_are_background():
    n = np.array([[[0.0, 0.0, 1.0], [0.0, 0.0, 1.0]]])
    valid = np.array([[True, False]])
    rgb = vecmath.encode_normals(n, valid)
    assert tuple(rgb[0, 0]) == (128, 128, 255)
    assert tuple(rgb[0, 1]) == (vecmath.NORMAL_BACKGROUND,) * 3


def test_directx_flip():
    rgb = vecmath.encode_normals(np.array([[[0.0, 0.6, 0.8]]]))
    gl = vecmath.decode_normals(rgb)
    dx = vecmath.decode_normals(rgb, green_down=True)
    assert np.isclose(gl[0, 0, 1], -dx[0, 0, 1])
    assert np.isclose(gl[0, 0, 0], dx[0, 0, 0])


def test_hsv_primaries():
    rgb = vecmath.hsv_to_rgb(np.array([0.0]), np.array([1.0]), np.array([1.0]))
    assert np.allclose(rgb, [[1, 0, 0]], atol=1e-9)
    rgb = vecmath.hsv_to_rgb(np.array([1 / 3]), np.array([1.0]), np.array([1.0]))
    assert np.allclose(rgb, [[0, 1, 0]], atol=1e-9)
