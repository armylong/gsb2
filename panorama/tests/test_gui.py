"""GUI 离屏冒烟测试（QT_QPA_PLATFORM=offscreen，无需显示器/账号）。"""
from __future__ import annotations

import os

import pytest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

pytest.importorskip("PySide6")
from PySide6.QtCore import Qt  # noqa: E402
from PySide6.QtWidgets import QApplication  # noqa: E402

from panorama.gui.main_window import MainWindow  # noqa: E402
from panorama.gui.match_dialog import MatchDialog  # noqa: E402


@pytest.fixture(scope="module")
def qapp():
    app = QApplication.instance() or QApplication([])
    yield app


def test_main_window_builds_and_renders(qapp, scene_dir):
    win = MainWindow()
    for p in sorted(scene_dir.glob("frame_*.png")):
        win.engine.add_photo(str(p))
    win.engine.add_photo(str(scene_dir / "unrelated.png"))
    win._refresh_photo_list()
    assert win.photo_list.count() == 6
    assert win.ref_combo.count() == 6

    rep = win.engine.rebuild()
    win._on_build_done(rep)
    assert win.pair_list.count() > 0
    assert win.canvas_view._base is not None

    # 三种显示模式都能切换
    for idx, mode in ((0, "blend"), (1, "overlay"), (2, "valid")):
        win.mode_group.button(idx).setChecked(True)
        assert win.canvas_view._mode == mode
    win.chk_border.setChecked(False)
    win.chk_ghost.setChecked(True)
    win.close()


def test_match_dialog_control_point_flow(qapp, scene_dir):
    win = MainWindow()
    for p in sorted(scene_dir.glob("frame_*.png"))[:3]:
        win.engine.add_photo(str(p))
    win._on_build_done(win.engine.rebuild())
    item = win.pair_list.item(0)
    i, j = item.data(Qt.UserRole)
    dlg = MatchDialog(win.engine, i, j)
    assert len(win.engine.controls.get(i, j)) == 0
    dlg._on_add_i(100.0, 120.0)
    dlg._on_add_j(110.0, 125.0)
    assert len(win.engine.controls.get(i, j)) == 1
    dlg._clear()
    assert len(win.engine.controls.get(i, j)) == 0
    dlg.close()
    win.close()


def test_export_blocked_without_valid_result(qapp, tmp_path):
    win = MainWindow()
    # 无任何结果时禁止导出
    assert win._require_canvas() is None
    win.close()
