"""Image loader / saver tests, including alpha and size limits."""

from __future__ import annotations

import numpy as np
import pytest

from mesh_warp.io import (
    ImageLoadError,
    load_image_rgba,
    load_mesh_json,
    save_mesh_json,
    save_png_rgba,
)
from mesh_warp.mesh import ControlMesh, MeshError


def _write_png(path, array):
    import cv2

    ok, buf = cv2.imencode(".png", array)
    assert ok
    path.write_bytes(buf.tobytes())


def _rgba(w, h, seed=0) -> np.ndarray:
    rng = np.random.default_rng(seed)
    return rng.integers(0, 256, (h, w, 4), dtype=np.uint8)


def test_rgba_roundtrip_is_lossless(tmp_path):
    img = _rgba(64, 48)
    path = tmp_path / "a.png"
    save_png_rgba(path, img)
    loaded = load_image_rgba(path)
    assert (loaded.width, loaded.height) == (64, 48)
    assert np.array_equal(loaded.rgba, img)
    assert len(loaded.sha256) == 64


def test_alpha_is_preserved(tmp_path):
    img = _rgba(32, 32)
    img[..., 3] = np.arange(32, dtype=np.uint8)[None, :] * 8
    path = tmp_path / "alpha.png"
    save_png_rgba(path, img)
    loaded = load_image_rgba(path)
    assert np.array_equal(loaded.rgba[..., 3], img[..., 3])


def test_rgb_png_becomes_opaque_rgba(tmp_path):
    rgb = _rgba(20, 16)[..., :3]
    path = tmp_path / "rgb.png"
    _write_png(path, rgb)
    loaded = load_image_rgba(path)
    assert loaded.rgba.shape == (16, 20, 4)
    assert np.all(loaded.rgba[..., 3] == 255)


def test_grayscale_png_expands(tmp_path):
    gray = np.tile(np.arange(24, dtype=np.uint8), (18, 1))
    path = tmp_path / "gray.png"
    _write_png(path, gray)
    loaded = load_image_rgba(path)
    assert loaded.rgba.shape == (18, 24, 4)
    assert np.all(loaded.rgba[..., 3] == 255)


def test_default_size_limit_is_1200(tmp_path, monkeypatch):
    img = np.zeros((1201, 40, 4), np.uint8)
    path = tmp_path / "big.png"
    save_png_rgba(path, img)
    with pytest.raises(ImageLoadError, match="1200"):
        load_image_rgba(path)
    # Non-default higher limit accepts it (used only for tests).
    loaded = load_image_rgba(path, max_long_edge=2000)
    assert loaded.height == 1201


def test_non_png_is_rejected(tmp_path):
    path = tmp_path / "a.jpg"
    path.write_bytes(b"not an image")
    with pytest.raises(ImageLoadError):
        load_image_rgba(path)


def test_corrupt_png_is_rejected(tmp_path):
    path = tmp_path / "bad.png"
    path.write_bytes(b"\x89PNG\r\n\x1a\nnonsense")
    with pytest.raises(ImageLoadError):
        load_image_rgba(path)


def test_mesh_json_rejects_wrong_size(tmp_path):
    mesh = ControlMesh(5, 4, 200, 160)
    path = tmp_path / "m.json"
    save_mesh_json(path, mesh)
    with pytest.raises(MeshError, match="200x160"):
        load_mesh_json(path, width=201, height=160)


def test_mesh_json_rejects_tampered_topology(tmp_path):
    import json

    mesh = ControlMesh(5, 4, 200, 160)
    path = tmp_path / "m.json"
    save_mesh_json(path, mesh)
    doc = json.loads(path.read_text())
    doc["triangles"][0] = [0, 1, 5]  # real first triangle is (0, 1, 6)
    path.write_text(json.dumps(doc))
    with pytest.raises(MeshError, match="triangulation"):
        load_mesh_json(path, width=200, height=160)


def test_mesh_json_rejects_non_regular_source(tmp_path):
    import json

    mesh = ControlMesh(5, 4, 200, 160)
    path = tmp_path / "m.json"
    save_mesh_json(path, mesh)
    doc = json.loads(path.read_text())
    doc["source_points"][0] = [5.0, 5.0]
    path.write_text(json.dumps(doc))
    with pytest.raises(MeshError, match="regular lattice"):
        load_mesh_json(path, width=200, height=160)


def test_mesh_json_rejects_invalid_target_pose(tmp_path):
    import json

    mesh = ControlMesh(5, 4, 200, 160)
    path = tmp_path / "m.json"
    save_mesh_json(path, mesh)
    doc = json.loads(path.read_text())
    p = mesh.index(2, 1)
    doc["target_points"][p] = [doc["source_points"][p][0] + 300.0, doc["source_points"][p][1]]
    path.write_text(json.dumps(doc))
    with pytest.raises(MeshError):
        load_mesh_json(path, width=200, height=160)


def test_mesh_json_rejects_hash_mismatch(tmp_path):
    from mesh_warp.io import LoadedImage

    img = _rgba(200, 160)
    mesh = ControlMesh(5, 4, 200, 160)
    path = tmp_path / "m.json"
    save_mesh_json(path, mesh, LoadedImage(img, path, "abc"))
    with pytest.raises(MeshError, match="different image content"):
        load_mesh_json(path, width=200, height=160, image_sha256="def")
    # Same digest loads.
    load_mesh_json(path, width=200, height=160, image_sha256="abc")
