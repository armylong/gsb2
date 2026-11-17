"""手动控制点：增删改、矛盾拒绝、不足提示、与自动匹配联合参与布局。"""
from __future__ import annotations


from panorama.config import Config
from panorama.control import ControlPointStore
from panorama.synthetic import load_scene


def _pair_data(scene_dir):
    meta = load_scene(scene_dir)
    pair = next(iter(meta["control_points_true"]))
    true = meta["control_points_true"][pair]
    wrong = meta["control_points_wrong"][pair]
    fa, fb = pair.split("|")
    return fa, fb, true, wrong


def test_insufficient_control_points_rejected(scene_dir):
    fa, fb, true, _ = _pair_data(scene_dir)
    store = ControlPointStore()
    store.add(0, 1, true["src"][0], true["dst"][0])
    store.add(0, 1, true["src"][1], true["dst"][1])
    res = store.solve_manual(0, 1, (520, 640), (520, 640), Config())
    assert not res.ok
    assert any("少于" in r for r in res.reasons)


def test_contradictory_control_points_rejected(scene_dir):
    _, _, _, wrong = _pair_data(scene_dir)
    store = ControlPointStore()
    for s, d in zip(wrong["src"], wrong["dst"]):
        store.add(0, 1, s, d)
    res = store.solve_manual(0, 1, (520, 640), (520, 640), Config())
    assert not res.ok
    assert res.reasons  # 明确指出矛盾/失真原因


def test_correct_control_points_solve_with_low_rmse(scene_dir):
    _, _, true, _ = _pair_data(scene_dir)
    store = ControlPointStore()
    for s, d in zip(true["src"], true["dst"]):
        store.add(0, 1, s, d)
    res = store.solve_manual(0, 1, (520, 640), (520, 640), Config())
    assert res.ok
    assert res.rmse < 2.0


def test_move_and_remove_control_points(scene_dir):
    _, _, true, _ = _pair_data(scene_dir)
    store = ControlPointStore()
    cps = [
        store.add(0, 1, s, d)
        for s, d in zip(true["src"], true["dst"])
    ]
    assert len(store.get(0, 1)) == 6
    # 移动
    target = cps[0]
    store.move(target.pid, "j", (12.0, 34.0))
    assert store.get(0, 1)[0].pt_j == (12.0, 34.0)
    # 删除
    store.remove(target.pid)
    assert len(store.get(0, 1)) == 5
    store.clear_pair(0, 1)
    assert store.get(0, 1) == []


def test_manual_points_participate_in_layout(engine_with_scene, scene_dir):
    """加入正确控制点后重建仍成功，且该配对标记为含手动贡献。"""
    eng = engine_with_scene
    fa, fb, true, _ = _pair_data(scene_dir)
    pid_a = next(p.pid for p in eng.photos if p.name == fa)
    pid_b = next(p.pid for p in eng.photos if p.name == fb)
    for s, d in zip(true["src"], true["dst"]):
        eng.add_control_point(pid_a, pid_b, s, d)
    rep = eng.rebuild()
    assert rep.ok
    assert rep.pair_matches[(pid_a, pid_b)].manual


def test_failed_rebuild_rolls_back_to_last_good(engine_with_scene, scene_dir):
    """失败修改不能污染当前结果：必须保留上次有效全景。"""
    eng = engine_with_scene
    good = eng.rebuild()
    assert good.ok
    # 制造一组几何上不可能的控制点（4 点共线 -> 退化）
    collinear_src = [[10, 10], [20, 10], [30, 10], [40, 10], [50, 10], [60, 10]]
    collinear_dst = [[10, 200], [20, 220], [30, 240], [40, 260], [50, 280], [60, 300]]
    for s, d in zip(collinear_src, collinear_dst):
        eng.add_control_point(0, 1, s, d)
    rep = eng.rebuild()
    # 自动匹配仍可能救场；若整体失败则必须回退且画布仍在
    if not rep.ok:
        assert rep.rolled_back
        assert rep.canvas is not None
        assert eng.has_last_good()
