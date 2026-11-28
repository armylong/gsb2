"""核心算法测试: 几何、估计、采样、平铺与导出。"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

from repeatcell import estimator, sampler, synth, tiling
from repeatcell.geometry import (
    CellBasis,
    choose_complete_cell,
    clip_polygon_to_rect,
    coverage_fraction,
    det2,
    fully_inside_cells,
    normalize_basis,
    polygon_area,
    snap_vectors_to_lattice,
)


# ---------------------------------------------------------------------------
# 几何
# ---------------------------------------------------------------------------

def test_det_and_solve():
    assert det2((1, 0), (0, 1)) == pytest.approx(1.0)
    B = estimator.solve_basis((2, 0), (0, 3))
    assert np.allclose(B @ np.array([1, 1]), [2, 3])


def test_corners_local_roundtrip():
    b = CellBasis((10.0, 20.0), (30.0, 4.0), (-7.0, 22.0))
    local = b.to_local(b.corners())
    assert np.allclose(local, [[0, 0], [1, 0], [1, 1], [0, 1]], atol=1e-9)
    back = b.to_world(local)
    assert np.allclose(back, b.corners(), atol=1e-9)


def test_polygon_clip_area():
    square = [(0, 0), (10, 0), (10, 10), (0, 10)]
    clipped = clip_polygon_to_rect(square, 0, 0, 4, 4)
    assert polygon_area(clipped) == pytest.approx(16.0)
    # 旋转 45° 的正方形, 角伸出边界的部分应被裁掉
    diamond = [(5, -5), (15, 5), (5, 15), (-5, 5)]
    frac = coverage_fraction(np.array(diamond), 10, 10)
    assert 0.0 < frac < 1.0


def test_coverage_full_and_none():
    b = CellBasis((10.0, 10.0), (20.0, 0.0), (0.0, 20.0))
    assert coverage_fraction(b.corners(), 100, 100) == pytest.approx(1.0)
    b2 = CellBasis((-50.0, -50.0), (20.0, 0.0), (0.0, 20.0))
    assert coverage_fraction(b2.corners(), 100, 100) == pytest.approx(0.0)


def test_fully_inside_and_choose_complete():
    b = CellBasis((0.0, 0.0), (64.0, 0.0), (0.0, 64.0))
    cells = fully_inside_cells(b, 512, 512)
    assert len(cells) == 64
    chosen = choose_complete_cell(b, 512, 512, prefer_point=(250, 250))
    assert chosen is not None
    # 单元中心落在 (32+64k); 离 (250, 250) 最近的是 (224, 224)
    assert np.allclose(chosen.corners().mean(axis=0), (224, 224))
    assert coverage_fraction(chosen.corners(), 512, 512) == pytest.approx(1.0)


def test_snap_vectors_prefers_short_equivalent_basis():
    # 斜条纹的一组等价基矢应被换成两根都更短、且张成同一点阵的写法
    a, b = snap_vectors_to_lattice((24.0, -24.0), (14.0, 14.0))
    assert max(np.hypot(*a), np.hypot(*b)) <= np.hypot(24.0, 24.0) + 1e-6
    M = np.linalg.inv(np.array([[24.0, 14.0], [-24.0, 14.0]])) \
        @ np.array([[a[0], b[0]], [a[1], b[1]]])
    assert np.allclose(M, np.round(M), atol=1e-6)
    assert abs(abs(np.linalg.det(M)) - 1.0) < 1e-6


def test_normalize_basis_keeps_lattice():
    b = normalize_basis((0.0, 0.0), (50.0, 0.0), (0.0, 50.0), 512, 512)
    inv = np.linalg.inv(b.matrix)
    delta = (np.array(b.origin) - np.array([0.0, 0.0])) @ inv.T
    assert np.allclose(delta, np.round(delta), atol=1e-6)
    assert b.area == pytest.approx(2500.0)


# ---------------------------------------------------------------------------
# 示例纹理
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("key", ["square", "diagonal", "stagger",
                                 "stripes", "stripes_frac", "defect"])
def test_examples_are_reproducible(key):
    a = synth.generate_example(key)
    b = synth.generate_example(key)
    assert np.array_equal(a.image, b.image)
    assert a.image.dtype == np.float32
    assert a.image.shape[2] == 3
    assert 0.0 <= float(a.image.min()) and float(a.image.max()) <= 1.0


def test_example_regions_are_inside():
    for key, _title in synth.list_examples():
        ex = synth.generate_example(key)
        h, w = ex.image.shape[:2]
        x, y, rw, rh = ex.region
        assert 0 <= x and 0 <= y and x + rw <= w and y + rh <= h


# ---------------------------------------------------------------------------
# 估算
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("key", ["square", "diagonal", "stagger", "defect"])
def test_estimate_matches_truth_lattice(key):
    ex = synth.generate_example(key)
    x, y, w, h = ex.region
    an = estimator.estimate_periodicity(ex.image[y:y + h, x:x + w])
    assert an.groups, "至少要有一组候选"
    g = an.groups[0]
    assert synth.lattice_equivalent(g.t1, g.t2, ex.truth_t1, ex.truth_t2,
                                    tol=0.06), (key, g, ex.truth_t1, ex.truth_t2)


def test_estimate_stripes_finds_stitch_direction():
    ex = synth.generate_example("stripes")
    x, y, w, h = ex.region
    an = estimator.estimate_periodicity(ex.image[y:y + h, x:x + w])
    g = an.groups[0]
    # 条纹周期方向沿 (1,1); 只要有一根向量近似沿对角线就算找到
    diagonals = [abs(abs(v[0]) - abs(v[1])) / max(np.hypot(*v), 1e-9)
                 for v in (g.t1, g.t2)]
    assert min(diagonals) < 0.15


def test_half_step_is_rejected_on_square():
    ex = synth.generate_example("square")
    x, y, w, h = ex.region
    an = estimator.estimate_periodicity(ex.image[y:y + h, x:x + w])
    advice = estimator.assess_basis(an, (32.0, 0.0), (0.0, 64.0))
    assert advice.preferred == "longer"
    assert advice.suggested_basis is not None
    assert abs(advice.suggested_basis[0][0] - 64.0) < 1.0


def test_selecting_true_basis_is_endorsed():
    ex = synth.generate_example("square")
    x, y, w, h = ex.region
    an = estimator.estimate_periodicity(ex.image[y:y + h, x:x + w])
    advice = estimator.assess_basis(an, (64.0, 0.0), (0.0, 64.0))
    assert advice.preferred == "selected"
    assert advice.suggested_basis is None


def test_double_basis_advises_shortening():
    ex = synth.generate_example("square")
    x, y, w, h = ex.region
    an = estimator.estimate_periodicity(ex.image[y:y + h, x:x + w])
    advice = estimator.assess_basis(an, (128.0, 0.0), (0.0, 128.0))
    assert advice.preferred == "shorter"


def test_two_candidate_groups_are_offered():
    ex = synth.generate_example("square")
    x, y, w, h = ex.region
    an = estimator.estimate_periodicity(ex.image[y:y + h, x:x + w])
    assert len(an.groups) == 2
    assert {g.kind for g in an.groups} >= {"primitive"}


def test_estimate_handles_downscaled_analysis():
    """大图会降采样分析; 周期必须换算回原图像素。"""
    from PIL import Image
    ex = synth.generate_example("square")
    img = np.asarray(
        Image.fromarray((ex.image * 255).astype(np.uint8)).resize((1200, 1200),
                                                                  Image.BILINEAR)
    ).astype(np.float32) / 255.0
    an = estimator.estimate_periodicity(img)
    g = an.groups[0]
    # 64 * (1200/512) = 150
    assert abs(np.hypot(*g.t1) - 150.0) < 6.0 or abs(np.hypot(*g.t2) - 150.0) < 6.0


def test_estimate_rejects_featureless_region():
    flat = np.full((96, 96, 3), 0.5, dtype=np.float32)
    with pytest.raises(ValueError):
        estimator.estimate_periodicity(flat)


# ---------------------------------------------------------------------------
# 采样
# ---------------------------------------------------------------------------

def test_sample_cell_maps_pixel_centres():
    b = CellBasis((10.0, 20.0), (40.0, 0.0), (0.0, 40.0))
    img = np.zeros((128, 128, 3), dtype=np.float32)
    img[20, 10] = [1.0, 0.0, 0.0]
    s = sampler.sample_cell(img, b, n=40)
    assert s.rgb[0, 0, 0] > 0.9
    assert s.coverage == pytest.approx(1.0)


def test_sample_cell_marks_outside_as_invalid():
    b = CellBasis((-10.0, -10.0), (40.0, 0.0), (0.0, 40.0))
    img = np.random.default_rng(0).random((64, 64, 3)).astype(np.float32)
    s = sampler.sample_cell(img, b, n=40)
    assert 0.0 < s.coverage < 1.0
    assert not s.valid[0, 0]


def test_gather_samples_are_same_position():
    ex = synth.generate_example("square")
    b = CellBasis((0.0, 0.0), (64.0, 0.0), (0.0, 64.0))
    samples = sampler.gather_samples(ex.image, b, n=64, max_samples=5)
    assert len(samples) >= 2
    for s in samples:
        assert s.coverage == pytest.approx(1.0)


def test_clean_unit_rejects_outlier_sample():
    base = np.full((24, 24, 3), 0.5, dtype=np.float32)
    samples = []
    for _ in range(5):
        samples.append(sampler.CellSample(base.copy(), np.ones((24, 24), bool),
                                          CellBasis((0, 0), (1, 0), (0, 1))))
    dirty = base.copy()
    dirty[:, :12] = 0.05
    samples.append(sampler.CellSample(dirty, np.ones((24, 24), bool),
                                      CellBasis((0, 0), (1, 0), (0, 1))))
    clean = sampler.clean_unit(samples, method="median")
    assert float(clean.rgb.mean()) == pytest.approx(0.5, abs=0.02)


def test_stats_report_wear_as_sample_difference():
    samples = []
    for k, val in enumerate((0.50, 0.52, 0.48)):
        arr = np.full((16, 16, 3), val, dtype=np.float32)
        samples.append(sampler.CellSample(arr, np.ones((16, 16), bool),
                                          CellBasis((0, 0), (1, 0), (0, 1))))
    stats = sampler.sample_stats(samples)
    assert stats["count"] == 3
    assert stats["max_pair_rms"] > 0
    assert len(stats["color_offsets"]) == 3


# ---------------------------------------------------------------------------
# 平铺 / 导出
# ---------------------------------------------------------------------------

def test_tile_region_reproduces_source_pixels():
    """按真值基矢铺回去, 应与原图逐像素接近。"""
    ex = synth.generate_example("square")
    img = ex.image
    h, w = img.shape[:2]
    b = CellBasis((0.0, 0.0), (64.0, 0.0), (0.0, 64.0))
    cell = choose_complete_cell(b, w, h, prefer_point=(256, 256))
    assert cell is not None
    s = sampler.sample_cell(img, cell, n=64)
    tiled = tiling.tile_region(s.rgb, cell, (0.0, 0.0, float(w), float(h)),
                               unit_mask=s.valid)
    err = float(np.abs(tiled - img).mean())
    assert err < 0.03
    # 原点在单元整数格点上时, 角落也必须对上
    for (yy, xx) in ((64, 0), (300, 1), (7, 400)):
        assert np.abs(tiled[yy, xx] - img[yy, xx]).mean() < 0.05


def test_tile_region_fractional_lattice():
    ex = synth.generate_example("stripes_frac")
    img = ex.image
    h, w = img.shape[:2]
    b = CellBasis((0.0, 0.0), ex.truth_t1, ex.truth_t2)
    cells = fully_inside_cells(b, w, h)
    assert cells
    s = sampler.sample_cell(img, cells[0], n=64)
    tiled = tiling.tile_region(s.rgb, cells[0], (0.0, 0.0, float(w), float(h)))
    assert float(np.abs(tiled - img).mean()) < 0.05


def test_unit_mask_gap_is_marked_in_tiling():
    img = np.random.default_rng(3).random((64, 64, 3)).astype(np.float32)
    b = CellBasis((-10.0, -10.0), (40.0, 0.0), (0.0, 40.0))
    s = sampler.sample_cell(img, b, n=40)
    tiled = tiling.tile_region(s.rgb, b, (0.0, 0.0, 64.0, 64.0),
                               unit_mask=s.valid)
    # 缺口处应出现洋红类颜色 (R 高, G 低, B 较高)
    gap_like = (tiled[..., 0] > 0.4) & (tiled[..., 1] < 0.2)
    assert gap_like.any()


def test_export_writes_files_and_preserves_fractional_corners(tmp_path: Path):
    ex = synth.generate_example("stripes_frac")
    img = ex.image
    b = CellBasis((5.7, 21.7), ex.truth_t1, ex.truth_t2)
    s = sampler.sample_cell(img, b, n=64)
    res = tiling.export_cell(tmp_path / "out", s.rgb, s.valid, b, img, "x")
    assert res.unit_path.exists()
    assert res.compare_path.exists()
    assert res.json_path.exists()
    assert res.unit_alpha_path.exists()
    data = json.loads(res.json_path.read_text(encoding="utf-8"))
    assert data["corners_fractional"] is True
    assert data["t1"] == pytest.approx(list(b.t1))
    assert data["t2"] == pytest.approx(list(b.t2))
    # 小数角点必须原样保留, 不能取整
    corner = data["corners"][0]
    assert abs(corner[0] - round(corner[0])) > 1e-6 or abs(corner[1] - round(corner[1])) > 1e-6


def test_export_records_gap_warning(tmp_path: Path):
    ex = synth.generate_example("square")
    img = ex.image
    b = CellBasis((-20.0, -20.0), (64.0, 0.0), (0.0, 64.0))
    s = sampler.sample_cell(img, b, n=64)
    res = tiling.export_cell(tmp_path / "gap", s.rgb, s.valid, b, img, "sq")
    assert any("图外" in w for w in res.warnings)
    data = json.loads(res.json_path.read_text(encoding="utf-8"))
    assert data["unit"]["coverage"] < 1.0


def test_wrap_error_small_for_true_period():
    ex = synth.generate_example("square")
    b = CellBasis((0.0, 0.0), (64.0, 0.0), (0.0, 64.0))
    s = sampler.sample_cell(ex.image, b, n=64)
    err = tiling.wrap_error(s.rgb)
    assert err["vertical"] < 0.12
    assert err["horizontal"] < 0.12
