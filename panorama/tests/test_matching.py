"""错误匹配拒绝：重复纹理、不相干图片、退化几何、失真结果必须被拒。"""
from __future__ import annotations

import numpy as np
from panorama import geometry as geo
from panorama.config import Config
from panorama.features import match_pair, extract_features


def test_unrelated_photo_is_excluded(engine_with_unrelated):
    """不相干图片不能为凑数硬贴进画布，必须单独排除。"""
    eng = engine_with_unrelated
    rep = eng.rebuild()
    assert rep.ok
    unrelated_pid = eng.photos[-1].pid
    assert unrelated_pid in rep.excluded
    assert unrelated_pid not in rep.layout.globals_H
    # 任何涉及不相干图片的配对都不得被接受
    for (a, b), m in rep.pair_matches.items():
        if unrelated_pid in (a, b):
            assert not m.accepted
            assert m.reasons  # 必须给出拒绝原因


def test_adjacent_frames_accepted_with_high_confidence(engine_with_scene):
    eng = engine_with_scene
    rep = eng.rebuild()
    assert rep.ok
    for k in range(eng.n - 1):
        m = rep.pair_matches[(k, k + 1)]
        assert m.accepted
        assert m.confidence >= 0.5
        assert m.rmse < Config().max_final_rmse_px


def test_degenerate_homography_rejected(cfg):
    """极端尺度/透视的单应必须被 sanity 检查拦截。"""
    H_extreme = np.diag([20.0, 20.0, 1.0])
    report = geo.check_homography_sanity(H_extreme, 640, 520, cfg)
    assert not report.ok
    assert any("尺度" in r for r in report.reasons)

    H_persp = np.eye(3)
    H_persp[2, 0] = 0.05  # 远超 max_persp
    report2 = geo.check_homography_sanity(H_persp, 640, 520, cfg)
    assert not report2.ok


def test_normal_homography_passes_sanity(cfg):
    H = np.array([[1.0, 0.02, 300], [0.0, 1.0, 50], [0, 0, 1]])
    assert geo.check_homography_sanity(H, 640, 520, cfg).ok


def test_low_texture_pair_with_too_few_inliers_rejected(tmp_path, cfg):
    """两张几乎无特征的图无法建立可信关系，必须拒绝而非硬凑。"""
    import cv2

    rng = np.random.default_rng(0)
    flat_a = np.full((400, 500, 3), 120, np.uint8)
    flat_b = np.full((400, 500, 3), 128, np.uint8)
    # 加极少量随机噪点，避免完全 0 特征但仍不足以稳健估计
    for img in (flat_a, flat_b):
        for _ in range(8):
            x, y = rng.integers(0, 490), rng.integers(0, 390)
            cv2.circle(img, (int(x), int(y)), 3, (255, 255, 255), -1)
    fa = extract_features(flat_a, cfg)
    fb = extract_features(flat_b, cfg)
    m = match_pair(0, 1, flat_a, flat_b, fa, fb, cfg)
    assert not m.accepted
    assert m.reasons
    assert m.confidence == 0.0


def test_inlier_ratio_gate_rejects_majority_outliers(cfg):
    """构造 4 个正确 + 大量错误对应，验证比例门槛而非数量门槛。"""
    rng = np.random.default_rng(1)
    H_true = np.array([[1.0, 0.05, 120], [0.0, 1.0, -40], [0, 0, 1]])
    good_src = rng.uniform(50, 400, (6, 2))
    good_dst = geo.warp_points(H_true, good_src)
    # 30 个随机错误点
    bad_src = rng.uniform(0, 500, (30, 2))
    bad_dst = rng.uniform(0, 500, (30, 2))
    src = np.concatenate([good_src, bad_src])
    dst = np.concatenate([good_dst, bad_dst])
    H, mask = geo.homography_from_correspondences(src, dst, cfg)
    # RANSAC 应只保留少量真点，整体内点比例很低
    ratio = mask.sum() / len(src)
    assert ratio < cfg.min_inlier_ratio
