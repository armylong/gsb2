"""offscreen GUI 冒烟测试: 窗口构建、交互刷新、重开对话框。"""

from __future__ import annotations

import os

import pytest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtWidgets import QApplication  # noqa: E402

from pixel_rot.app import MainWindow, ReviewDialog  # noqa: E402
from pixel_rot.core import FORWARD_NN, INVERSE_NN, SSAA  # noqa: E402
from pixel_rot.exporting import export_batch, load_manifest  # noqa: E402


@pytest.fixture(scope="module")
def app():
    qapp = QApplication.instance() or QApplication([])
    yield qapp


@pytest.fixture
def win(app):
    w = MainWindow()
    w.show()
    app.processEvents()
    yield w
    w.close()


def test_window_builds_with_sample(win, app):
    assert win.src_img.size == (18, 18)
    assert win.results["A"] is not None
    assert win.results["B"] is not None
    assert win.panel_a.method_box.currentData() == FORWARD_NN
    assert win.panel_b.method_box.currentData() == SSAA


def test_angle_and_method_switch(win, app):
    win.spn_angle.setValue(37.5)
    app.processEvents()
    assert win.results["A"].angle == 37.5
    win.panel_b.method_box.setCurrentIndex(1)
    app.processEvents()
    assert win.results["B"].method == INVERSE_NN


def test_fixed_canvas_marks_outside(win, app):
    win.cmb_canvas.setCurrentIndex(1)
    win.spn_angle.setValue(30)
    app.processEvents()
    assert win.results["A"].outside_pixels > 0
    win.cmb_canvas.setCurrentIndex(0)
    app.processEvents()
    assert win.results["A"].outside_pixels == 0


def test_center_presets_and_manual(win, app):
    win.cmb_center.setCurrentIndex(1)  # 像素中心
    app.processEvents()
    assert win.current_center() == (9.5, 9.5)
    win.cmb_center.setCurrentIndex(0)  # 角点
    app.processEvents()
    assert win.current_center() == (9.0, 9.0)
    win.spn_cx.setValue(3.0)
    app.processEvents()
    assert win.results["A"].center[0] == 3.0


def test_record_trial(win, app):
    n = len(win.trials)
    win.action_record()
    assert len(win.trials) == n + 2  # A 与 B 各一条


def test_roi_add_delete(win, app):
    n = len(win.rois)
    win.rois.append(("手工", __import__("numpy").array(
        [(0, 0), (2, 0), (2, 2), (0, 2)], dtype=float)))
    win._refresh_roi_list()
    win.refresh_all()
    assert len(win.rois) == n + 1
    win.lst_rois.setCurrentRow(len(win.rois) - 1)
    win.action_del_roi()
    assert len(win.rois) == n


def test_review_dialog(win, app, tmp_path):
    out = tmp_path / "exported"
    export_batch(
        win.src_img, out, [0, 90], methods=[FORWARD_NN, SSAA],
        center=win.current_center(), rois=win.current_rois(),
    )
    bundle = load_manifest(out)
    dlg = ReviewDialog(bundle)
    app.processEvents()
    assert dlg.cmb_entry.count() == 4
    dlg.cmb_entry.setCurrentIndex(1)
    app.processEvents()
    assert dlg.view_exp.image is not None
    dlg.close()


def test_roundtrip_action_core(win):
    from pixel_rot.core import roundtrip_check

    for method in (FORWARD_NN, INVERSE_NN, SSAA):
        rep = roundtrip_check(win.src_img, method, win.current_center())
        assert rep.ok
