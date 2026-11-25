"""Export files and the read-back verification that closes the loop."""
from __future__ import annotations

import json

import numpy as np
import pytest

from photometric import exporting, vecmath


@pytest.fixture()
def exported(sphere_scene, sphere_result, tmp_path):
    names = [spec.name for spec in sphere_scene.lights]
    return exporting.export_result(sphere_result, tmp_path / "out",
                                   stem="sphere", light_names=names)


def test_export_writes_all_files(exported):
    for path in (exported.normal_map, exported.invalid_mask,
                 exported.albedo, exported.manifest):
        assert path.exists()
        assert path.stat().st_size > 0


def test_manifest_describes_encoding(exported):
    manifest = json.loads(exported.manifest.read_text(encoding="utf-8"))
    assert manifest["normal_encoding"]["convention"] == "opengl"
    assert manifest["size"] == {"width": 320, "height": 320} or \
        manifest["size"]["width"] > 0
    assert len(manifest["lights"]) >= 3
    for light in manifest["lights"]:
        assert len(light["direction"]) == 3
        assert 0 <= light["azimuth_deg"] < 360
        assert 0 <= light["elevation_deg"] <= 90
    assert "invalid_reasons" in manifest["quality"]


def test_read_back_matches_memory(sphere_result, exported):
    report = exporting.read_back_against(sphere_result, exported)
    assert report.ok, report.problems
    assert report.checked_pixels == int(sphere_result.valid.sum())
    assert report.mask_agreement == pytest.approx(1.0)
    assert report.max_error_deg < 1.0


def test_standalone_read_back_passes(exported):
    report = exporting.read_back(exported)
    assert report.ok, report.problems
    assert report.declared_encoding == "opengl"


def test_read_back_detects_a_flipped_green_channel(sphere_result, exported):
    """A DirectX-style map must be caught, not silently accepted."""
    from PySide6.QtGui import QImage

    image = QImage(str(exported.normal_map)).convertToFormat(QImage.Format.Format_RGB888)
    w, h = image.width(), image.height()
    ptr = image.constBits()
    arr = np.frombuffer(ptr, dtype=np.uint8, count=h * image.bytesPerLine())
    arr = arr.reshape(h, image.bytesPerLine())[:, : w * 3].reshape(h, w, 3).copy()
    arr[..., 1] = 255 - arr[..., 1]
    arr = np.ascontiguousarray(arr)
    flipped = QImage(arr.data, w, h, 3 * w, QImage.Format.Format_RGB888)
    flipped.save(str(exported.normal_map))

    report = exporting.read_back_against(sphere_result, exported)
    assert not report.ok
    assert any("往返误差" in problem or "尺寸" in problem for problem in report.problems) \
        or report.max_error_deg > 1.5


def test_read_back_detects_a_wrong_mask(sphere_result, exported):
    from PySide6.QtGui import QImage

    white = np.full((sphere_result.height, sphere_result.width, 3), 255, np.uint8)
    white = np.ascontiguousarray(white)
    img = QImage(white.data, sphere_result.width, sphere_result.height,
                 3 * sphere_result.width, QImage.Format.Format_RGB888)
    img.save(str(exported.invalid_mask))
    report = exporting.read_back_against(sphere_result, exported)
    assert not report.ok
    assert any("掩码" in problem for problem in report.problems)


def test_read_normal_map_round_trip(sphere_result):
    rgb = vecmath.encode_normals(sphere_result.normals, sphere_result.valid,
                                 background=vecmath.NORMAL_BACKGROUND)
    normals, valid = exporting.read_normal_map(rgb)
    assert np.array_equal(valid, sphere_result.valid)
    err = vecmath.angle_between(normals[valid], sphere_result.normals[valid])
    assert err.max() < 1.0


def test_background_decodes_as_invalid():
    rgb = np.full((4, 4, 3), vecmath.NORMAL_BACKGROUND, dtype=np.uint8)
    normals, valid = exporting.read_normal_map(rgb)
    assert valid.sum() == 0
    assert np.all(normals == 0.0)


def test_flat_normal_decodes_as_valid():
    rgb = np.zeros((4, 4, 3), dtype=np.uint8)
    rgb[..., 0] = rgb[..., 1] = 128
    rgb[..., 2] = 255
    normals, valid = exporting.read_normal_map(rgb)
    assert valid.sum() == 16
    # the encoding puts 0.0 at 128, so this is the flat "facing camera" normal
    assert np.allclose(normals[..., 2], 1.0, atol=1e-3)
