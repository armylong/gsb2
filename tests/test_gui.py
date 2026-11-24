from __future__ import annotations

import os

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import pytest
from PySide6.QtCore import QPointF, QRectF
from PySide6.QtWidgets import QApplication

from negative_converter.gui import MainWindow
from negative_converter.samples import color_negative_sample


@pytest.fixture(scope="module")
def qapp():
    app = QApplication.instance() or QApplication([])
    yield app


def test_main_window_sample_patches_linked_views_and_delete(qapp):
    window = MainWindow()
    sample = color_negative_sample()
    window.load_program_sample(sample)
    qapp.processEvents()

    assert window.doc is not None
    assert window.patch_list.count() == len(sample.base_rects) + len(sample.neutral_rects)
    assert window.positive_panel._pixmap_item is not None
    assert window.mask_panel._pixmap_item is not None
    assert "中性块 1 个" in window.neutral_summary.text()

    before = len(window.patches)
    window.on_click_requested("base", QPointF(120, 90))
    assert len(window.patches) == before + 1
    new_id = window.patches[-1].id
    assert window.selected_patch_id == new_id

    window.delete_selected_patch()
    assert len(window.patches) == before
    assert all(p.id != new_id for p in window.patches)

    window.on_creation_requested("neutral", QRectF(250, 250, 90, 60))
    assert window.patches[-1].kind == "neutral"

    # Parameter movement and recomputation retains a real image.
    window.white_slider.setValue(1.8)
    window.process_current()
    assert window.last_final is not None
    assert window.last_final.ndim == 3

    # If the dark endpoint crosses the bright endpoint, the effective white
    # point and its slider are pushed together rather than going dead.
    window.black_slider.setValue(2.50)
    window.white_slider.setValue(2.10)
    window.process_current()
    assert window.params.white >= window.params.black + 0.019
    assert window.white_slider.value() == pytest.approx(window.params.white, abs=0.011)

    window.close()
