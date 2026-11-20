"""Qt-level tests using the offscreen platform.

They check the behaviours that only exist in the window: nearest-neighbour
zoom, grid toggle, pixel selection, and that panning/zooming the *view*
never regenerates or alters the pixel content of the comparison panes.
"""

from __future__ import annotations

import os

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import pytest

pytest.importorskip("PySide6")

from PySide6.QtCore import QPointF, QSize  # noqa: E402
from PySide6.QtWidgets import QApplication  # noqa: E402

from palettizer.demo import demo_rgba  # noqa: E402
from palettizer.ui.main_window import MainWindow  # noqa: E402
from palettizer.ui.view import ZOOM_LEVELS  # noqa: E402


@pytest.fixture(scope="module")
def app():
    application = QApplication.instance() or QApplication([])
    yield application


@pytest.fixture()
def window(app):
    w = MainWindow()
    w.resize(900, 700)
    w.show()
    app.processEvents()
    w.load_rgba(demo_rgba("gradient_corners"), "demo")
    app.processEvents()
    yield w
    w.close()


def test_image_is_not_resampled_on_load(window):
    assert window.session.size == (192, 192)
    assert window.views["source"].image.size() == QSize(192, 192)
    for mode in ("none", "ordered", "diffusion"):
        assert window.views[mode].image.size() == QSize(192, 192)


def test_zoom_and_pan_do_not_change_pixel_content(window):
    snapshots = {}
    for mode in ("none", "ordered", "diffusion"):
        img = window.views[mode].image
        snapshots[mode] = bytes(img.constBits())

    for zoom in (1, 2, 5, 12, 32):
        window.view.set_zoom(zoom)
        window.view.set_pan(QPointF(37 * zoom, -21 * zoom))
        QApplication.processEvents()
        for mode in ("none", "ordered", "diffusion"):
            assert bytes(window.views[mode].image.constBits()) == snapshots[mode]
    # Zoom is clamped to the documented integer levels.
    window.view.set_zoom(1000)
    assert window.view.zoom == ZOOM_LEVELS[-1]


def test_grid_toggle_is_a_display_only_change(window):
    before = bytes(window.views["ordered"].image.constBits())
    window.grid_btn.setChecked(False)
    QApplication.processEvents()
    assert window.views["ordered"].show_grid is False
    window.grid_btn.setChecked(True)
    QApplication.processEvents()
    assert window.views["ordered"].show_grid is True
    assert bytes(window.views["ordered"].image.constBits()) == before


def test_click_selects_pixel_and_inspector_shows_three_modes(window):
    window.view.select(20, 30)
    window._update_inspector()
    assert window.inspector_table.rowCount() == 3
    text = window.inspector_title.text()
    assert "(20, 30)" in text
    labels = [window.inspector_table.item(r, 0).text() for r in range(3)]
    assert labels == ["不抖动", "有序抖动", "误差扩散"]


def test_switching_export_mode_keeps_palette(window):
    palette_before = list(window.session.palette.colors)
    window.mode_combo.setCurrentIndex(2)  # diffusion
    window._on_export_mode_changed(2)
    assert window.export_mode == "diffusion"
    assert window.session.palette.colors == palette_before
    window.mode_combo.setCurrentIndex(1)
    window._on_export_mode_changed(1)
    assert window.session.palette.colors == palette_before


def test_strength_and_threshold_update_all_panes(window):
    counts = {}
    for mode in ("none", "ordered", "diffusion"):
        counts[mode] = bytes(window.views[mode].image.constBits())
    window.strength_slider.setValue(95)
    QApplication.processEvents()
    window.recompute()
    # Dither strength affects the dithered panes, not the undithered one.
    assert bytes(window.views["none"].image.constBits()) == counts["none"]
    assert bytes(window.views["ordered"].image.constBits()) != counts["ordered"]

    window.alpha_slider.setValue(40)
    QApplication.processEvents()
    window.recompute()
    assert int(window._results["none"].visible_mask.sum()) > 0
    assert window.session.settings.alpha_threshold == 40


def test_export_writes_indexed_png_and_reads_back(window, tmp_path, monkeypatch):
    from palettizer.pngio import read_indexed_png, readback_matches

    window.mode_combo.setCurrentIndex(2)
    window._on_export_mode_changed(2)
    window.recompute()

    # Drive the Save dialog non-interactively.
    target = tmp_path / "export.png"

    def fake_save(*args, **kwargs):
        return str(target), "PNG 图片 (*.png)"

    monkeypatch.setattr(
        "palettizer.ui.main_window.QFileDialog.getSaveFileName", fake_save
    )
    monkeypatch.setattr(
        "palettizer.ui.main_window.QMessageBox.information", lambda *a, **k: None
    )
    monkeypatch.setattr(
        "palettizer.ui.main_window.QMessageBox.warning", lambda *a, **k: None
    )
    window.export_png()
    assert target.exists()
    assert target.with_suffix(".json").exists()
    result = window._results["diffusion"]
    readback = read_indexed_png(target)
    ok, message = readback_matches(result, readback)
    assert ok, message
    assert target.read_bytes()[25] == 3  # indexed PNG


def test_locked_colour_is_untouched_by_generate_button(window, monkeypatch):
    from PySide6.QtWidgets import QMessageBox

    monkeypatch.setattr(QMessageBox, "warning", lambda *a, **k: None)
    palette = window.session.palette
    assert len(palette) >= 2
    locked_rgb = palette.colors[0]
    window.toggle_lock(0, True)
    window.count_spin.setValue(6)
    window.generate_palette()
    QApplication.processEvents()
    assert window.session.palette.colors[0] == locked_rgb
    assert window.session.palette.locked[0] is True
    # Regeneration keeps the same palette used by all three panes.
    for result in window._results.values():
        assert result.visible_color_count == len(window.session.palette)


def test_delete_locked_colour_is_refused(window, monkeypatch):
    from PySide6.QtWidgets import QMessageBox

    shown = {}
    monkeypatch.setattr(
        QMessageBox, "information", lambda *a, **k: shown.setdefault("info", a[1:])
    )
    window.toggle_lock(0, True)
    before = list(window.session.palette.colors)
    window.delete_color(0)
    assert window.session.palette.colors == before
    assert "info" in shown


def test_semi_transparent_mask_preview_does_not_change_results(window):
    before = {
        mode: bytes(window.views[mode].image.constBits())
        for mode in ("none", "ordered", "diffusion")
    }
    window.alpha_preview_btn.setChecked(True)
    QApplication.processEvents()
    for mode in ("none", "ordered", "diffusion"):
        assert bytes(window.views[mode].image.constBits()) == before[mode]
    window.alpha_preview_btn.setChecked(False)
    QApplication.processEvents()
