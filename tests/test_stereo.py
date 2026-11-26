import numpy as np

from stereo_layers.matching import export_npz, match_pair, retention_mask, to_gray
from stereo_layers.synthetic import make_two_layer_pair
from stereo_layers.validate import run_validation


def test_local_validation_suite_passes(tmp_path):
    report = run_validation(output_dir=tmp_path)
    assert report["all_passed"], report


def test_npz_keeps_float_zero_and_masks(tmp_path):
    scene = make_two_layer_pair(width=192, height=128, bg_disp=0, fg_disp=12, seed=3)
    pair = match_pair(to_gray(scene.left), to_gray(scene.right), -2, 16, radius=2)
    kept = retention_mask(pair.left, 0.15, edge_trim=2)
    path = export_npz(tmp_path / "x.npz", pair, kept, depth_coefficient=500.0)

    data = np.load(path, allow_pickle=True)
    d = data["disparity"]
    assert d.dtype == np.float32
    assert np.any(np.abs(d[kept]) < 0.2)
    assert "invalid_mask" in data.files
    assert "metadata_json" in data.files
    assert "reference_side" in str(data["metadata_json"])
    # Invalid mask is semantic; zero is not converted to a sentinel.
    assert np.isfinite(d[kept]).all()
