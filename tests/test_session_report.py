import csv
import json
from pathlib import Path

import pytest

from mosaic_studio import generator, projectio, report, render
from mosaic_studio.session import MosaicSession


@pytest.fixture()
def solved_session(tmp_path: Path) -> MosaicSession:
    tile_dir = generator.generate_tiles(tmp_path / "tiles", count=40)
    assert len(tile_dir) >= 30
    base_path = generator.generate_demo_base(tmp_path / "base.png", w=480, h=640)
    s = MosaicSession()
    s.params.cell_size = 40
    s.params.seed = 20261126
    s.load_base(base_path)
    s.load_tile_folder(tmp_path / "tiles")
    s.solve()
    return s


def test_solve_and_export_records(solved_session: MosaicSession, tmp_path: Path):
    s = solved_session
    assert s.result is not None
    assert s.result.unmatched_count == 0

    img_path = tmp_path / "out" / "poster.png"
    out, cell_px, size = render.export_final_image(s, img_path, long_edge=1200)
    assert out.exists() and size[0] > 0

    paths = report.export_records(s, img_path)
    for p in paths.values():
        assert p.exists()

    with open(paths["cells_csv"], encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))
    assert len(rows) == s.grid.count
    assert {"行", "列", "状态", "样块ID", "裁切左", "相似度"} <= set(rows[0])
    # 裁切框四元组必须合法。
    x0, y0, x1, y1 = (int(rows[0][k]) for k in
                      ("裁切左", "裁切上", "裁切右", "裁切下"))
    assert x1 > x0 and y1 > y0

    data = json.loads(paths["json"].read_text(encoding="utf-8"))
    assert data["seed"] == 20261126
    assert len(data["cells"]) == s.grid.count
    assert data["summary"]["unmatched_count"] == 0


def test_project_roundtrip_reproduces_layout(
        solved_session: MosaicSession, tmp_path: Path):
    s = solved_session
    # 手动固定一个格子再保存。
    tid = s.tiles[3].id
    s.set_fixed(10, tid)
    s.solve()
    before = list(s.result.choice)

    proj = tmp_path / "plan.json"
    projectio.save_project(s, proj)

    s2 = MosaicSession()
    projectio.apply_project(s2, proj, solve=True)
    assert s2.fixed == s.fixed
    assert s2.params.seed == s.params.seed
    assert s2.result.choice == before


def test_regrid_migrates_fixed_cells(solved_session: MosaicSession):
    s = solved_session
    s.set_fixed(0, s.tiles[1].id)
    s.set_fixed(s.grid.cols + 2, s.tiles[2].id)
    old_fixed = dict(s.fixed)
    s.regrid(28)
    # 迁移后固定格数量不变，且都在新网格范围内。
    assert len(s.fixed) == len(old_fixed)
    for idx in s.fixed:
        assert 0 <= idx < s.grid.count
    s.solve()
    for idx, tid in s.fixed.items():
        assert s.result.choice[idx] == s.tile_by_id[tid].ordinal


def test_quota_conflict_example_is_real(tmp_path: Path):
    root = tmp_path / "qc"
    scenario = generator.generate_quota_conflict_example(root)
    assert (root / "scenario.json").exists()

    s = MosaicSession()
    projectio.apply_project(s, root / "scenario.json", solve=True)

    assert s.grid.cols == 5 and s.grid.rows == 4
    assert s.grid.count == 20
    # 5 块样块 × 配额 2 = 10 总容量；扣除固定后自由配额缺口为 10。
    assert s.result.free_deficit == 10
    assert s.result.unmatched_count >= 10
    unmatched = [o for o in s.result.outcomes if o.status == "unmatched"]
    assert all(o.reason for o in unmatched)
    # scenario 里固定的 (0,0) 必须被尊重。
    qc1 = next(t.ordinal for t in s.tiles if t.id == "qc_01_red")
    assert s.result.choice[0] == qc1 and s.result.is_fixed[0]

    # 例子也要能直接导出记录。
    paths = report.export_records(s, root / "output" / "conflict.png")
    assert paths["json"].exists()
