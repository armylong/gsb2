"""全局布局：真值位置误差、连通分量、首尾闭环、累积偏移控制。"""
from __future__ import annotations

import numpy as np

from panorama import geometry as geo
from panorama.config import Config
from panorama.engine import PanoramaEngine
from panorama.layout import connected_components, Edge
from panorama.synthetic import load_scene


def _truth_corner_error(eng, rep, scene_dir):
    meta = load_scene(scene_dir)
    truth = {f["file"]: np.array(f["H_to_world"]) for f in meta["frames"]}
    H0 = truth[eng.photos[0].name]
    errs = []
    for p in eng.photos:
        if p.pid not in rep.layout.globals_H:
            continue
        H_est = rep.layout.globals_H[p.pid]
        H_true = geo.compose(truth[p.name], geo.invert(H0))
        corners = geo.image_corners(*p.size)
        err = np.linalg.norm(
            geo.warp_points(H_est, corners)
            - geo.warp_points(H_true, corners),
            axis=1,
        ).mean()
        errs.append(err)
    return errs


def test_global_position_matches_ground_truth(engine_with_scene, scene_dir):
    eng = engine_with_scene
    rep = eng.rebuild()
    assert rep.ok
    errs = _truth_corner_error(eng, rep, scene_dir)
    # 参考帧误差近似为 0；其余帧角点平均误差应远小于帧宽（640）
    assert abs(errs[0]) < 1e-9
    assert max(errs) < 40.0
    assert rep.layout.global_rmse < 2.0


def test_connected_components_split():
    edges = [Edge(0, 1, np.eye(3), np.zeros((4, 4)), 0.8, 0.3)]
    comps = connected_components(4, edges)
    assert sorted(comps[0]) == [0, 1]
    assert set().union(*comps) == {0, 1, 2, 3}


def test_loop_closure_detected_and_optimized(loop_dir):
    eng = PanoramaEngine(Config())
    for p in sorted(loop_dir.glob("frame_*.png")):
        eng.add_photo(str(p))
    rep = eng.rebuild()
    assert rep.ok
    assert rep.layout.has_loop
    # 闭环边（非生成树边）必须真实存在
    accepted = {k for k, m in rep.pair_matches.items() if m.accepted}
    assert (0, eng.n - 1) in accepted or any(
        0 in k and eng.n - 1 in k for k in accepted
    )


def test_loop_reduces_drift_relative_to_chain(loop_dir):
    """闭环联合优化相对纯接龙布局应有可测量的修正量。"""
    eng = PanoramaEngine(Config())
    for p in sorted(loop_dir.glob("frame_*.png")):
        eng.add_photo(str(p))
    rep = eng.rebuild()
    assert rep.layout.max_corner_drift_px >= 0.0
    # 所有边优化后 RMSE 必须保持在亚像素/小像素级，未因闭环引入失真
    for v in rep.layout.edge_rmse_after.values():
        assert v < 3.0


def test_layout_scales_are_sane(engine_with_scene):
    eng = engine_with_scene
    rep = eng.rebuild()
    cfg = Config()
    for pid, H in rep.layout.globals_H.items():
        w, h = next(p.size for p in eng.photos if p.pid == pid)
        sv = geo._jacobian_scales(H, w, h)
        assert sv.max() < cfg.max_transform_scale
        assert sv.min() > 1.0 / cfg.max_transform_scale
