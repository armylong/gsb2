"""PySide6 界面层冒烟与交互测试 (offscreen 平台)."""
import os

import numpy as np
import pytest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

pytest.importorskip("PySide6")
from PySide6.QtWidgets import QApplication  # noqa: E402

from photostereo.app import MainWindow  # noqa: E402
from photostereo.solver import OK, reason_text  # noqa: E402


@pytest.fixture(scope="module")
def app():
    app = QApplication.instance() or QApplication([])
    yield app


@pytest.fixture
def win(app):
    w = MainWindow()
    yield w
    w.close()


def test_all_scene_rig_combinations_solve(win):
    for s in range(win.scene_combo.count()):
        win.scene_combo.setCurrentIndex(s)
        for r in range(win.rig_combo.count()):
            win.rig_combo.setCurrentIndex(r)
            assert win.result is not None
            assert win.result.normals.shape == win.scene.normals.shape


def test_degenerate_rig_marks_low_confidence(win):
    win.rig_combo.setCurrentIndex(2)  # 灯方向过于接近
    from photostereo.solver import NEAR_PARALLEL

    assert (win.result.status == NEAR_PARALLEL).any()
    # 低可信点在可信度图上必须被红叉掩膜覆盖
    assert win.views["conf"]._invalid[win.result.status == NEAR_PARALLEL].all()


def test_click_inspector_reports_per_light_usage(win):
    win.scene_combo.setCurrentIndex(0)
    win.rig_combo.setCurrentIndex(0)
    h, w = win.scene.height.shape
    win.on_pixel_clicked(h // 2, w // 2)
    text = win.inspector.toPlainText()
    assert "状态:" in text and "各灯观测" in text
    assert "✓" in text  # 至少有一盏灯被用上
    # 真值对照行只在表面区域出现
    assert "真值法线" in text


def test_disabling_light_recomputes(win):
    win.rig_combo.setCurrentIndex(0)
    k = win.render.images.shape[0]
    before = win.result.confidence.copy()
    win.light_checks[1].setChecked(False)
    assert not win.result.used[1].any()
    assert win.light_checks[1].text().endswith("")  # 控件仍在
    # 重核后大部分中心区域仍有效
    h, w = win.scene.height.shape
    inner = np.zeros((h, w), bool)
    inner[30:-30, 30:-30] = True
    inner &= win.scene.mask
    assert win.result.valid[inner].mean() > 0.8
    win.light_checks[1].setChecked(True)
    assert np.allclose(win.result.confidence, before, atol=1e-12)


def test_dial_relight_updates(win):
    win.rig_combo.setCurrentIndex(0)
    d = np.array([0.3, -0.4, 0.866])
    win.on_dial_changed(d)
    img = win.views["relight"]._pixmap
    assert img is not None and not img.isNull()
    assert "新光源" in win.dial_label.text()


def test_held_out_side_by_side_exists(win):
    win.scene_combo.setCurrentIndex(0)
    win.rig_combo.setCurrentIndex(0)  # 8+1 留出灯
    assert win.views["heldout"]._pixmap is not None
    assert win.views["diff"]._pixmap is not None


def test_export_roundtrip_from_ui(win, tmp_path):
    win.scene_combo.setCurrentIndex(0)
    win.rig_combo.setCurrentIndex(0)
    from photostereo import encoding

    files = encoding.export_result(tmp_path, "ui_export", win.result)
    n_back, valid_back = encoding.import_normal_map(files["normals"], files["mask"])
    valid = win.result.valid & valid_back
    assert valid.sum() > 0
    ang = np.rad2deg(
        np.arccos(np.clip(np.sum(n_back * win.result.normals, -1), -1, 1))
    )
    assert ang[valid].max() < 1.5
    assert (files["sidecar"]).exists()


def test_invalid_pixels_are_zero_in_views(win):
    win.rig_combo.setCurrentIndex(2)
    res = win.result
    # 无效像素法线与反照率必须为零, 不会凭空出现凸点
    assert np.all(res.normals[~res.valid] == 0.0)
    assert np.all(res.albedo[~res.valid] == 0.0)
    assert reason_text(int(res.status[~res.valid][0])) != "有效"
