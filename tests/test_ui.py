"""Headless Qt tests for the window: sync markers, zoom invariance, export and
reload lighting consistency, and green-convention behaviour in both modes.

Qt runs on the offscreen platform so no display is required.
"""

from __future__ import annotations

import os

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import numpy as np
import pytest

pytest.importorskip("PySide6")

from PySide6.QtWidgets import QApplication

from normalmap_tool.model import GREEN_Y_DOWN, GREEN_Y_UP
from normalmap_tool.presets import PRESET_FLAT, PRESET_HORIZONTAL, PRESET_VERTICAL


@pytest.fixture(scope="module")
def app():
    app = QApplication.instance() or QApplication([])
    yield app


@pytest.fixture()
def win(app):
    from normalmap_tool.ui.window import MainWindow

    w = MainWindow()
    yield w
    w.close()


def test_default_window_builds_all_views(win):
    win.load_preset(PRESET_HORIZONTAL)
    assert win.rgb.shape[2] == 3
    assert win.lit.shape == win.rgb.shape[:2]
    assert win.flat_lit.shape == win.rgb.shape[:2]


def test_pixel_selection_syncs_readout_and_all_canvases(win):
    win.load_preset(PRESET_VERTICAL)
    win.on_pixel_picked(100, 40)
    assert win.selection == (100, 40)
    txt = win.lbl_readout.text()
    assert "列 40" in txt and "行 100" in txt
    assert "强度" in txt and "N·L" in txt
    for cb in win.all_canvases():
        assert cb.canvas._selection == (100, 40)


def test_zoom_does_not_change_height_or_lighting(win):
    win.load_preset(PRESET_HORIZONTAL)
    before_rgb = win.rgb.copy()
    before_lit = win.lit.copy()
    idx = win.combo_zoom.findData(8)
    win.combo_zoom.setCurrentIndex(idx)
    assert np.array_equal(win.rgb, before_rgb)
    assert np.array_equal(win.lit, before_lit)
    assert win.canvas_material.canvas.zoom == 8


def test_generated_mode_green_toggle_keeps_lighting(win):
    win.load_preset(PRESET_VERTICAL)
    win.combo_green.setCurrentIndex(win.combo_green.findData(GREEN_Y_UP))
    before = win.lit.copy()
    g_up = win.rgb[..., 1].copy()
    win.combo_green.setCurrentIndex(win.combo_green.findData(GREEN_Y_DOWN))
    after = win.lit.copy()
    assert np.array_equal(g_up, 255 - win.rgb[..., 1])
    assert np.allclose(before, after, atol=1e-12)
    # geometry unchanged
    win.spin_strength.setValue(win.spin_strength.value() + 1.0)
    assert win.build.params.green == GREEN_Y_DOWN


def test_light_controls_change_readout_and_picture(win):
    win.load_preset(PRESET_FLAT)
    win.on_pixel_picked(128, 128)
    win.spin_lx.setValue(-0.9)
    win.spin_ly.setValue(0.0)
    a = float(win.lit[128, 128])
    win.spin_lx.setValue(0.9)
    b = float(win.lit[128, 128])
    # flat material is brighter when the lamp is closer to +x side
    assert b > a
    assert "强度" in win.lbl_readout.text()


def test_export_then_reload_reproduces_lighting(win, tmp_path):
    from normalmap_tool.io import load_normal_png

    win.load_preset(PRESET_HORIZONTAL)
    win.spin_strength.setValue(41.0)
    win.spin_lx.setValue(0.55)
    win.spin_ly.setValue(-0.2)
    win.spin_lh.setValue(1.3)
    lit_before = win.lit.copy()
    rgb_before = win.rgb.copy()

    path = str(tmp_path / "exported.png")
    from normalmap_tool.io import save_normal_png

    save_normal_png(
        path, win.build.rgb, green=win.params.green,
        boundary=win.params.boundary, strength=win.params.strength,
        smoothing=win.params.smoothing, width=win.build.width,
        height=win.build.height, light=win.light,
    )
    win.load_normal_path(path)
    assert win.mode == "loaded"
    assert np.array_equal(win.rgb, rgb_before)
    assert np.allclose(win.lit, lit_before, atol=1e-12)
    loaded = load_normal_png(path)
    assert loaded.meta["height_strength"] == pytest.approx(41.0)
    assert win.spin_strength.value() == pytest.approx(41.0)


def test_loaded_mode_green_switch_flips_green_interpretation(win, tmp_path):
    from normalmap_tool.io import save_normal_png

    win.load_preset(PRESET_VERTICAL)
    win.combo_green.setCurrentIndex(win.combo_green.findData(GREEN_Y_UP))
    path = str(tmp_path / "v.png")
    save_normal_png(
        path, win.build.rgb, green=GREEN_Y_UP, boundary="extend",
        strength=win.params.strength, smoothing=0.0,
        width=win.build.width, height=win.build.height,
    )
    win.load_normal_path(path)
    n_up = win.decoded.unit.copy()
    win.combo_green.setCurrentIndex(win.combo_green.findData(GREEN_Y_DOWN))
    n_down = win.decoded.unit
    assert np.allclose(n_up[..., 1], -n_down[..., 1], atol=2e-3)
    # the stored bytes did not change while reinterpreting
    assert np.array_equal(win.rgb, win.loaded_rgb)


def test_preset_check_reports_expected_normal(win):
    win.load_preset(PRESET_HORIZONTAL)
    text = win.lbl_check.text()
    assert "期望法线" in text and "实际法线" in text and "固定灯位读数" in text


def test_loaded_mode_keeps_height_and_can_return(win, tmp_path):
    from normalmap_tool.io import save_normal_png

    win.load_preset(PRESET_HORIZONTAL)
    before = win.build.rgb.copy()
    path = str(tmp_path / "rt.png")
    save_normal_png(path, before, green="y_up", boundary="extend",
                    strength=32.0, smoothing=0.0, width=256, height=256)
    win.load_normal_path(path)
    assert win.height is not None
    win._return_to_height()
    assert win.mode == "generated"
    assert np.array_equal(win.build.rgb, before)
