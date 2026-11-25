"""GUI 离屏冒烟：在 QT_QPA_PLATFORM=offscreen 下驱动主窗口完整流程。"""
import os
from pathlib import Path

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import pytest

pytest.importorskip("PySide6")

from PySide6.QtWidgets import QApplication  # noqa: E402

from mosaic_studio import generator  # noqa: E402
from mosaic_studio.gui.main_window import MainWindow  # noqa: E402


@pytest.fixture(scope="module")
def qapp():
    app = QApplication.instance() or QApplication([])
    yield app


@pytest.fixture()
def window(qapp, tmp_path: Path):
    w = MainWindow()
    w.show()
    qapp.processEvents()
    tiles = generator.generate_tiles(tmp_path / "tiles", count=40)
    base = generator.generate_demo_base(tmp_path / "base.png", w=440, h=600)
    w.load_assets(base, tmp_path / "tiles")
    qapp.processEvents()
    yield w
    w.close()


def test_window_loads_and_renders(window: MainWindow):
    assert window.session.result is not None
    assert window.stack.currentIndex() == 1  # 切到预览页
    assert window.preview.cols > 0
    assert window.quota_table.rowCount() == len(window.session.tiles)


def test_click_cell_lists_candidates_and_fixes(window: MainWindow, qapp):
    n = window.session.grid.count
    target = min(7, n - 1)
    window.select_cell(target)
    qapp.processEvents()
    assert window.candidate_list.count() == len(window.session.tiles)

    from PySide6.QtCore import Qt
    tile_id = window.candidate_list.item(0).data(Qt.ItemDataRole.UserRole)
    window.fix_cell_to_tile(target, tile_id)
    qapp.processEvents()

    assert window.session.fixed[target] == tile_id
    assert window.session.result.choice[target] == \
        window.session.tile_by_id[tile_id].ordinal
    # 固定后候选列表仍可刷新。
    window.select_cell(target)
    assert "固定" in window.cell_info.text()

    # 取消固定后该格不再是 fixed 状态（但可能仍自动选到同一块）。
    window.unfix_selected_cell()
    qapp.processEvents()
    assert target not in window.session.fixed


def test_view_modes_and_highlight(window: MainWindow, qapp):
    window.set_view_mode("similarity")
    qapp.processEvents()
    window.worst_spin.setValue(8)
    qapp.processEvents()
    window.set_view_mode("source")
    qapp.processEvents()

    # 定位某一块样块。
    window.quota_table.selectRow(0)
    tile_id = window._selected_quota_tile_id()
    window.locate_selected_tile()
    qapp.processEvents()
    assert window._tile_highlight == tile_id
    window.clear_highlight()
    assert window._tile_highlight is None


def test_quota_override_triggers_recompute(window: MainWindow, qapp):
    window.quota_table.selectRow(1)
    tile_id = window._selected_quota_tile_id()
    window.tile_quota_spin.setValue(0)  # 禁用该样块
    window.apply_tile_quota()
    qapp.processEvents()
    j = window.session.tile_by_id[tile_id].ordinal
    assert window.session.result.usage[j] == 0
    window.reset_all_quotas()
    qapp.processEvents()


def test_export_and_save_plan(window: MainWindow, tmp_path: Path, qapp):
    img = tmp_path / "export" / "m.png"
    image_path, px, size, records = window.export_to(img, long_edge=900)
    assert Path(image_path).exists()
    assert records["json"].exists()
    plan = window.save_plan_to(tmp_path / "plan.json")
    assert plan.exists()


def test_quota_conflict_example_in_gui(qapp, tmp_path: Path):
    # 把自带例子生成到仓库（ensure_bundled_assets 指向 REPO_ROOT），
    # 这里直接用生成器在 tmp 建例子，再走 scenario 打开逻辑的核心部分。
    from mosaic_studio import projectio
    from mosaic_studio.gui.main_window import REPO_ROOT
    generator.ensure_bundled_assets(REPO_ROOT)

    w = MainWindow()
    w.show()
    res = w.open_quota_conflict()
    qapp.processEvents()
    assert res is not None and res.unmatched_count >= 10
    assert w.issue_list.count() > 0
    w.jump_issue(1)
    qapp.processEvents()
    assert w.selected_cell is not None
    shot = tmp_path / "qc_window.png"
    w.grab().save(str(shot))
    assert shot.exists() and shot.stat().st_size > 10000
    w.close()
