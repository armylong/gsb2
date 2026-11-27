"""导出回读、PNG 编解码与重打光一致性测试."""
import numpy as np

from photostereo import encoding
from photostereo.geometry import ring_rig
from photostereo.solver import relight, solve_photometric
from photostereo.synthetic import render


def test_png_roundtrip_gray_and_rgb(tmp_path):
    rng = np.random.default_rng(0)
    gray = rng.integers(0, 256, (37, 51), dtype=np.uint8)
    rgb = rng.integers(0, 256, (37, 51, 3), dtype=np.uint8)
    gp = tmp_path / "g.png"
    rp = tmp_path / "c.png"
    encoding.write_png(gp, gray)
    encoding.write_png(rp, rgb)
    assert np.array_equal(encoding.read_png(gp), gray)
    assert np.array_equal(encoding.read_png(rp), rgb)


def test_png_filters_decode(tmp_path):
    # 构造容易触发 Sub/Up/Average/Paeth 的渐变与阶跃图
    x = np.linspace(0, 255, 64, dtype=np.uint8)
    grad = np.repeat(x[None, :], 64, axis=0)
    step = np.zeros((64, 64), np.uint8)
    step[:, 32:] = 200
    for img in (grad, step, grad.T, (grad + step).astype(np.uint8)):
        p = tmp_path / "f.png"
        encoding.write_png(p, img)
        assert np.array_equal(encoding.read_png(p), img)


def test_normal_export_roundtrip(rendered_hemi, hemi, tmp_path):
    r = rendered_hemi
    res = solve_photometric(r.images, r.directions, r.strengths, saturation=r.saturation)
    files = encoding.export_result(tmp_path, "hemi", res, low_conf_threshold=0.35)
    n_back, valid_back = encoding.import_normal_map(files["normals"], files["mask"])
    valid = hemi.mask & valid_back
    assert valid.sum() > 0.8 * hemi.mask.sum()
    dot = np.sum(n_back * res.normals, axis=-1)
    # 8 位量化误差: 方向夹角应小于 ~1 度
    ang = np.rad2deg(np.arccos(np.clip(dot[valid], -1, 1)))
    assert ang.max() < 1.5
    # 掩膜外必须为零向量
    assert np.all(n_back[~valid_back] == 0.0)


def test_export_sidecar_records_convention(rendered_plate, tmp_path):
    import json

    r = rendered_plate
    res = solve_photometric(r.images, r.directions, r.strengths, saturation=r.saturation)
    files = encoding.export_result(tmp_path, "plate", res)
    meta = json.loads(files["sidecar"].read_text(encoding="utf-8"))
    assert "R" in meta["convention"] and "B" in meta["convention"]
    assert meta["shape"] == [r.images.shape[1], r.images.shape[2]]
    # npz 里也能回读出相同法线
    data = np.load(files["data"])
    assert np.allclose(data["normals"], res.normals)
    assert np.array_equal(data["valid"], res.valid & (res.confidence >= 0.35))


def test_relight_matches_held_out_image(rng, hemi):
    """留一灯并排检查: 用其余灯估计, 重打光留出的方向, 应接近真实渲染."""
    dirs = ring_rig(9, elevation_deg=45.0, start_azimuth_deg=10.0)
    r = render(hemi, dirs, np.ones(9), rng=rng)
    held = 4
    keep = np.ones(9, bool)
    keep[held] = False
    res = solve_photometric(
        r.images[keep], dirs[keep], r.strengths[keep], saturation=r.saturation
    )
    predicted = relight(res, dirs[held])
    actual = r.images[held]
    region = hemi.mask & res.valid
    err = np.abs(predicted[region] - actual[region])
    assert np.median(err) < 0.04
    assert np.percentile(err, 90) < 0.09
    # 无效点在重打光图里被置零, 便于叠加标记
    assert np.all(predicted[~res.valid] == 0.0)
