"""界面层测试（offscreen）：参数重分割、筛选与人工忽略、点击命中、导出。

这些测试验证控件事件驱动的是真实分割结果，而不只是界面上有数字。
"""
from __future__ import annotations

import csv
from pathlib import Path

import numpy as np
import pytest

from ccstats.models import FilterReason

pytest.importorskip("PySide6")


@pytest.fixture(scope="module")
def app():
    from PySide6.QtWidgets import QApplication
    inst = QApplication.instance()
    if inst is None:
        inst = QApplication([])
    yield inst


@pytest.fixture()
def win(app):
    from ccstats.qt_app import MainWindow
    w = MainWindow()
    w.show()
    app.processEvents()
    yield w
    w.close()


def _select_demo(win, key, app):
    from ccstats.demos import DEMO_ORDER
    win.demo_combo.setCurrentIndex(DEMO_ORDER.index(key))
    app.processEvents()


def _settle(win, app):
    win._recompute(force=True)
    app.processEvents()


def test_initial_state_is_first_demo_with_defaults(win, app):
    assert win._demo_key == "circular"
    assert win._result.total_count == 4
    assert win._params().connectivity.value == 8
    assert win._params().threshold.fixed_value == 128
    assert win.cb_polarity.currentData() == "dark"
    assert win.spin_despeckle.value() == 0 and win.spin_fill.value() == 0
    assert win.lbl_counts.text().startswith("全部区域 4 · 当前计入 4")


def test_connectivity_switch_really_resegments(win, app):
    _select_demo(win, "diagonal", app)
    assert win._result.total_count == 2
    win.rb4.setChecked(True)
    _settle(win, app)
    assert win._result.total_count == 3
    assert [r.stats.area for r in win._result.regions] == [100, 100, 100]
    win.rb8.setChecked(True)
    _settle(win, app)
    assert win._result.total_count == 2
    assert sorted(r.stats.area for r in win._result.regions) == [100, 200]


def test_threshold_slider_and_reversal_change_mask(win, app):
    _select_demo(win, "circular", app)
    win.spin_fixed.setValue(200)          # 背景 235 仍高于阈值，深色零件仍为前景
    _settle(win, app)
    assert win._result.total_count == 4
    win.cb_polarity.setCurrentIndex(win.cb_polarity.findData("bright"))
    _settle(win, app)
    # 浅色背景变成前景：主背景一块（4 个深色零件成为它的孔洞），
    # 板上两个浅色圆孔各自成为独立前景块。
    assert win._result.total_count == 3
    main = win._result.regions[0]
    assert main.stats.touches_border
    assert main.stats.hole_count == 4
    assert sorted(r.stats.area for r in win._result.regions) == [317, 317, 114213]


def test_binary_view_and_range_description_visible(win, app):
    assert "整幅图像" in win.lbl_range_desc.text()
    assert "420×300" in win.lbl_range_desc.text() or "300×420" in win.lbl_range_desc.text()
    win.spin_despeckle.setValue(3)
    win.spin_fill.setValue(4)
    app.processEvents()
    assert "29 px" in win.lbl_despeckle.text()      # disk_area(3)=29
    assert "49 px" in win.lbl_fill.text()           # disk_area(4)=49
    assert "固定阈值 128" in win.lbl_threshold_desc.text()


def test_canvas_click_selects_and_background_clears(win, app):
    _select_demo(win, "diagonal", app)
    win._on_canvas_click(55, 55)          # 第一块方块内部
    assert win._selected_label == 1
    assert win.table.currentIndex().row() == 0
    win._on_canvas_click(5, 5)            # 背景
    assert win._selected_label == 0
    assert not win.table.selectionModel().hasSelection()
    win._on_canvas_click(65, 65)          # 第二块（8 邻接下与第一块同属 #1）
    assert win._selected_label == 1
    win._on_canvas_click(95, 55)          # 独立块
    assert win._selected_label == 2


def test_click_on_hole_does_not_select_owner(win, app):
    _select_demo(win, "circular", app)
    # 板上的两个圆孔位于 (320,150) 与 (360,150)，孔内点击应取消高亮
    win._on_canvas_click(320, 150)
    assert win._selected_label == 0
    win._on_canvas_click(300, 120)        # 板体
    assert win._selected_label == 4


def test_manual_ignore_syncs_table_and_counts_without_changing_labels(win, app):
    from PySide6.QtCore import Qt
    _select_demo(win, "circular", app)
    labels_before = win._result.labels.copy()
    win.model.setData(win.model.index(0, 0), Qt.Checked, Qt.CheckStateRole)
    app.processEvents()
    assert win._manual == {1}
    assert win._result.included_count == 3
    assert win._result.regions[0].reason is FilterReason.MANUAL
    assert win._result.included_area == 613 + 317 + 8966
    assert np.array_equal(win._result.labels, labels_before)
    assert "当前计入 3" in win.lbl_counts.text()
    # 取消勾选恢复
    win.model.setData(win.model.index(0, 0), Qt.Unchecked, Qt.CheckStateRole)
    app.processEvents()
    assert win._manual == set()
    assert win._result.included_count == 4


def test_criteria_change_keeps_manual_but_threshold_change_clears_it(win, app):
    from PySide6.QtCore import Qt
    _select_demo(win, "circular", app)
    win.model.setData(win.model.index(1, 0), Qt.Checked, Qt.CheckStateRole)
    app.processEvents()
    assert win._manual == {2}
    win.spin_min.setValue(1000)           # 只改筛选
    app.processEvents()
    assert win._manual == {2}             # 人工忽略保留
    assert win._result.total_count == 4
    assert win._result.included_count == 2   # 8966 计入 + 2 被人工忽略；其余两个小于下限
    assert not win.lbl_notice.isVisible()
    # 改阈值 -> 清除人工忽略并提示
    win.spin_fixed.setValue(120)
    _settle(win, app)
    assert win._manual == set()
    assert win.lbl_notice.isVisible()
    assert "清除 1 个人工忽略" in win.lbl_notice.text()


def test_demo_switch_restores_default_parameters(win, app):
    _select_demo(win, "diagonal", app)
    win.spin_fixed.setValue(30)
    win.spin_despeckle.setValue(5)
    win.spin_fill.setValue(5)
    win.rb4.setChecked(True)
    win.spin_min.setValue(500)
    win.chk_border.setChecked(True)
    _settle(win, app)
    _select_demo(win, "noise", app)
    p = win._params()
    assert p.threshold.fixed_value == 128
    assert p.connectivity.value == 8
    assert p.despeckle_radius == 0 and p.fill_radius == 0
    assert win.spin_min.value() == 0 and not win.chk_border.isChecked()
    assert win._result.total_count == 6


def test_shown_areas_match_masks(win, app):
    _select_demo(win, "noise", app)
    for rec in win._result.regions:
        assert int((win._result.labels == rec.stats.label_id).sum()) == rec.stats.area
    win.spin_despeckle.setValue(2)
    _settle(win, app)
    assert sorted(r.stats.area for r in win._result.regions) == [96, 1564]


def test_export_from_window_writes_consistent_files(win, app, tmp_path):
    _select_demo(win, "circular", app)
    win.spin_max.setValue(700)            # 筛掉两个大区域，但导出仍应包含
    app.processEvents()
    from ccstats.export import export_all
    paths = export_all(win._result, win._original_bgr, tmp_path, "gui", win._info)
    import cv2
    back = cv2.imread(str(paths["label_png"]), cv2.IMREAD_UNCHANGED)
    assert back is not None
    assert set(np.unique(back).tolist()) == {0, 1, 2, 3, 4}
    assert back.shape == win._gray.shape
    with open(paths["csv"], encoding="utf-8-sig") as f:
        rows = [r for r in csv.DictReader(f) if r["编号"] and not r["编号"].startswith("#")]
    assert len(rows) == 4
    assert [r["是否计入"] for r in rows] == ["否", "是", "是", "否"]
    assert [r["排除原因"] for r in rows] == ["面积大于上限", "计入", "计入", "面积大于上限"]
    assert all(Path(p).exists() for p in paths.values())
