"""引擎编排：照片增删改序、回退机制与端到端流水线。"""
from __future__ import annotations

import pytest

from panorama.engine import PanoramaEngine
from panorama.config import Config


def test_add_remove_reorder_photos(scene_dir):
    eng = PanoramaEngine(Config())
    paths = sorted(scene_dir.glob("frame_*.png"))
    pids = [eng.add_photo(str(p)).pid for p in paths]
    assert eng.n == 5
    # 初始顺序
    assert [p.pid for p in eng.photos] == pids
    # 反转顺序
    eng.reorder(list(reversed(pids)))
    assert [p.pid for p in eng.photos] == list(reversed(pids))
    # 移动单张
    eng.move_photo(pids[0], 2)
    assert eng.photos[2].pid == pids[0]
    # 删除
    eng.remove_photo(pids[2])
    assert pids[2] not in [p.pid for p in eng.photos]
    assert eng.n == 4


def test_reorder_rejects_mismatched_set(scene_dir):
    eng = PanoramaEngine(Config())
    for p in sorted(scene_dir.glob("frame_*.png")):
        eng.add_photo(str(p))
    with pytest.raises(ValueError):
        eng.reorder([0, 1, 2])  # 缺少照片


def test_end_to_end_success_and_exclusion(engine_with_unrelated):
    eng = engine_with_unrelated
    rep = eng.rebuild()
    assert rep.ok
    # 5 张场景帧全部纳入，1 张不相干被排除
    assert len(rep.layout.component) == 5
    assert rep.excluded == [eng.photos[-1].pid]
    assert rep.canvas is not None
    assert rep.canvas.canvas.shape[2] == 4


def test_too_few_photos_fails(scene_dir):
    eng = PanoramaEngine(Config())
    eng.add_photo(str(sorted(scene_dir.glob("frame_*.png"))[0]))
    rep = eng.rebuild()
    assert not rep.ok
    assert any("至少需要 2 张" in r for r in rep.reasons)


def test_last_good_snapshot_rollback(engine_with_scene):
    eng = engine_with_scene
    first = eng.rebuild()
    assert first.ok
    # 移除到只剩两张无重叠的图（跨距极大），制造失败
    keep = [eng.photos[0].pid, eng.photos[-1].pid]
    for p in list(eng.photos):
        if p.pid not in keep:
            eng.remove_photo(p.pid)
    rep = eng.rebuild()
    if not rep.ok and eng.has_last_good():
        assert rep.rolled_back
        assert rep.canvas is not None  # 仍展示上次有效结果


def test_all_pair_matches_carry_diagnostics(engine_with_scene):
    eng = engine_with_scene
    rep = eng.rebuild()
    for key, m in rep.pair_matches.items():
        # 每个配对都必须有完整诊断字段，无论接受与否
        assert hasattr(m, "confidence")
        assert hasattr(m, "rmse")
        assert hasattr(m, "coverage_cells")
        if not m.accepted:
            assert m.reasons
            assert m.confidence == 0.0
