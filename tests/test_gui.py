"""Offscreen GUI smoke tests (no display required)."""
import os

import pytest

pytest.importorskip("PySide6")
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtWidgets import QApplication  # noqa: E402

from slitscan import synth  # noqa: E402
from slitscan.app import MainWindow, StripView  # noqa: E402


@pytest.fixture(scope="module")
def app():
    a = QApplication.instance() or QApplication([])
    yield a


@pytest.fixture
def window(app, tmp_path):
    win = MainWindow()
    clip = synth.generate("reverse", str(tmp_path / "rev.mp4"),
                          n_frames=24, fps=10)
    win._load(str(clip))
    # wait for the decode worker thread to finish
    if win._thread is not None:
        win._thread.wait(15000)
    app.processEvents()
    assert win.frames is not None
    yield win
    win.close()


def test_window_loads_and_builds(window):
    assert window.tabs.count() >= 1
    view = window._current_view()
    assert isinstance(view, StripView) and view.result is not None
    assert view.result.total_width > 0


def test_click_strip_jumps_source_frame(window):
    view = window._current_view()
    block = view.result.blocks[5]
    window._on_block_clicked(block)
    assert window.current_idx == block.frame_index
    # preview slit follows the frame's interpolated slit position
    assert window.preview.slit_width == window.spin_width.value()


def test_click_padded_block_reports_missing(window):
    # force a fully padded configuration
    window.spin_start.setValue(-999)
    window.spin_end.setValue(-999)
    window.combo_pad.setCurrentIndex(2)  # zero
    window._build_timer.stop()
    window.rebuild()
    view = window._current_view()
    padded = next(b for b in view.result.blocks
                  if not any(c >= 0 for c in b.source_cols))
    window._on_block_clicked(padded)
    assert "无原片像素" in window.lbl_mapping.text()


def test_locate_frame_in_output(window):
    window.rebuild()
    window.frame_slider.setValue(7)
    window._find_current_in_output()
    view = window._current_view()
    assert view.selected is not None
    assert view.selected.frame_index == 7


def test_compare_layouts_creates_two_tabs(window):
    before = window.tabs.count()
    window._compare_layouts()
    assert window.tabs.count() == before + 2


def test_pan_endpoints_affect_preview_slit(window):
    window.spin_start.setValue(10)
    window.spin_end.setValue(140)
    window.frame_slider.setValue(len(window.timestamps) - 1)
    window._update_preview_slit()
    # at the last frame the slit should sit near the end center
    assert window.preview.slit_left > 50


def test_save_outputs_png_and_manifest(window, tmp_path):
    window.rebuild()
    base = tmp_path / "gui_out.png"
    view = window._current_view()
    from slitscan.output import save_result
    pages, manifest = save_result(view.result, window.info.path, base)
    assert all(p.exists() for p in pages)
    assert manifest.exists()
