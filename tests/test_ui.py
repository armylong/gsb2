"""UI-level tests, run headless with the Qt offscreen platform."""
from __future__ import annotations

import os

import numpy as np
import pytest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

QApplication = pytest.importorskip(
    "PySide6.QtWidgets", reason="PySide6 not installed"
).QApplication

from maskdiff import samples  # noqa: E402
from maskdiff.core import Roi  # noqa: E402


@pytest.fixture(scope="session")
def qapp():
    app = QApplication.instance() or QApplication([])
    yield app


@pytest.fixture()
def win(qapp):
    from maskdiff.app import MainWindow

    w = MainWindow()
    w.resize(1280, 820)
    w.show()
    qapp.processEvents()
    yield w
    w.close()


def test_examples_load_and_fill_tables(win, qapp):
    win._load_example("notch")
    qapp.processEvents()
    assert win.diff is not None
    assert win.stats_table.rowCount() > 0
    assert win.worst_table.rowCount() > 0
    assert win.region_table.rowCount() >= 1
    # The notch verdict must mention the area/boundary disagreement.
    assert "面积" in win.compare_label.text()


def test_translation_and_notch_reach_opposite_conclusions(win, qapp):
    win._load_example("translation")
    qapp.processEvents()
    t = win.compare_label.text()
    win._load_example("notch")
    qapp.processEvents()
    n = win.compare_label.text()
    assert "结论不同" in t
    assert "结论不同" in n


def test_modes_render_without_error(win, qapp):
    win._load_example("notch")
    qapp.processEvents()
    for i in range(win.mode_combo.count()):
        win.mode_combo.setCurrentIndex(i)
        qapp.processEvents()
        pix = win.view.grab()
        assert not pix.isNull()
    # Back to masks.
    win.mode_combo.setCurrentIndex(0)
    qapp.processEvents()


def test_direction_switch_updates_stats(win, qapp):
    win._load_example("notch")
    qapp.processEvents()
    a_to_b = win.diff.stats("a_to_b").maximum
    win.dir_combo.setCurrentIndex(1)  # B -> A
    qapp.processEvents()
    assert win.diff.stats("b_to_a").maximum < a_to_b
    assert win.worst_table.rowCount() > 0


def test_calibration_change_recomputes(win, qapp):
    win._load_example("notch")
    qapp.processEvents()
    before = win.diff.stats("a_to_b").maximum
    win.row_spin.setValue(0.5)
    qapp.processEvents()
    assert win.diff.stats("a_to_b").maximum == pytest.approx(before * 0.5)
    win.row_spin.setValue(1.0)


def test_roi_roundtrip(win, qapp):
    win._load_example("translation")
    qapp.processEvents()
    full = win.diff.stats("a_to_b").n
    win._set_roi(Roi(50, 190, 70, 170))
    qapp.processEvents()
    assert win.diff.stats("a_to_b").n < full
    assert "行 50:190" in win.roi_label.text()
    win._set_roi(None)
    qapp.processEvents()
    assert win.diff.stats("a_to_b").n == full


def test_empty_input_shows_explanation(win, qapp):
    win.a = np.zeros((40, 40), bool)
    win.b = np.zeros((40, 40), bool)
    win.a_path, win.b_path = "a.png", "b.png"
    win._refresh_all()
    qapp.processEvents()
    assert win.banner.isVisible() or not win.banner.isHidden()
    assert "空图" in win.banner.text()
    assert win.colorbar._empty


def test_one_sided_input_explains(win, qapp):
    win.a = samples.translation()[0]
    win.b = np.zeros_like(win.a)
    win.a_path, win.b_path = "a.png", "b.png"
    win._refresh_all()
    qapp.processEvents()
    assert "只有 A 有内容" in win.banner.text()


def test_select_sample_centers_and_reports(win, qapp):
    win._load_example("notch")
    qapp.processEvents()
    info = win.view.select_sample(0, center=True)
    assert info is not None
    assert info["distance"] >= 0
    win._show_sample(info)
    assert "距离" in win.cursor_label.text()


def test_worst_table_activation_selects(win, qapp):
    win._load_example("notch")
    qapp.processEvents()
    win._on_worst_activated(0, 0)
    qapp.processEvents()
    assert win.view.selected is not None


def test_visibility_toggles_rebuild(win, qapp):
    win._load_example("notch")
    qapp.processEvents()
    key_before = win.view._key()
    win.chk_b.setChecked(False)
    qapp.processEvents()
    assert win.view._key() != key_before
    pix = win.view.grab()
    assert not pix.isNull()
    win.chk_b.setChecked(True)
    qapp.processEvents()


def test_hole_tab_lists_pinhole(win, qapp):
    from maskdiff.samples import pinhole

    win.a, win.b = pinhole((80, 80), 1)
    win.a_path, win.b_path = "a.png", "b.png"
    win._refresh_all()
    qapp.processEvents()
    assert win.hole_table.rowCount() == 1


def test_ignore_holes_checkbox(win, qapp):
    from maskdiff.samples import pinhole

    win.a, win.b = pinhole((80, 80), 1)
    win.a_path, win.b_path = "a.png", "b.png"
    win._refresh_all()
    qapp.processEvents()
    assert win.diff.stats("a_to_b").maximum > 10
    win.chk_ignore_holes.setChecked(True)
    qapp.processEvents()
    assert win.diff.stats("a_to_b").maximum == pytest.approx(0.0)
    win.chk_ignore_holes.setChecked(False)


def test_export_paths_without_dialog(win, qapp, tmp_path, monkeypatch):
    from maskdiff.export import export_difference_png, export_hole_csv, export_region_csv, export_summary_csv

    win._load_example("notch")
    qapp.processEvents()
    d = win.diff
    assert export_difference_png(d, tmp_path / "d.png").exists()
    assert export_summary_csv(d, tmp_path / "s.csv").exists()
    assert export_region_csv(d, tmp_path / "r.csv").exists()
    assert export_hole_csv(d, tmp_path / "h.csv").exists()


def test_load_png_through_dialog(win, qapp, tmp_path, monkeypatch):
    from PySide6.QtWidgets import QFileDialog

    from maskdiff.io import save_mask_png

    a, b = samples.notch()
    pa = save_mask_png(a, tmp_path / "a.png")
    pb = save_mask_png(b, tmp_path / "b.png")

    answers = iter([str(pa), str(pb)])
    monkeypatch.setattr(
        QFileDialog, "getOpenFileName", staticmethod(lambda *a, **k: (next(answers), ""))
    )
    win._load_side("A")
    win._load_side("B")
    qapp.processEvents()
    assert win.diff is not None
    assert win.diff.boundary_available
    assert "a.png" in win.a_label.text()
    assert "256×256" in win.a_label.text()


def test_size_mismatch_warns(win, qapp, tmp_path, monkeypatch):
    from PySide6.QtWidgets import QFileDialog, QMessageBox

    from maskdiff.io import save_mask_png

    pa = save_mask_png(np.zeros((20, 20), bool), tmp_path / "a.png")
    pb = save_mask_png(np.zeros((20, 30), bool), tmp_path / "b.png")
    answers = iter([str(pa), str(pb)])
    monkeypatch.setattr(
        QFileDialog, "getOpenFileName", staticmethod(lambda *a, **k: (next(answers), ""))
    )
    warned = []
    monkeypatch.setattr(
        QMessageBox, "warning", staticmethod(lambda *a, **k: warned.append(a[2]))
    )
    win._load_side("A")
    win._load_side("B")
    qapp.processEvents()
    assert len(warned) == 1
    assert "同尺寸" in warned[0]
    # The window must not compute a result, but must stay usable.
    assert win.diff is None
    assert not win.banner.isHidden()


def test_single_mask_visibility_renders_whole_mask(win, qapp):
    win._load_example("translation")
    qapp.processEvents()
    win.chk_b.setChecked(False)
    qapp.processEvents()
    img = win.view._image()
    assert img is not None
    from PySide6.QtGui import QColor

    # Centre of the shape is shared area; it must be painted, not transparent.
    h, w = win.diff.shape
    px = QColor(img.pixel(w // 2, h // 2))
    assert px.alpha() > 0
    win.chk_b.setChecked(True)
    win.chk_a.setChecked(False)
    qapp.processEvents()
    img2 = win.view._image()
    px2 = QColor(img2.pixel(w // 2, h // 2))
    assert px2.alpha() > 0
    win.chk_a.setChecked(True)
