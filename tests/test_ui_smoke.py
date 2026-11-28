"""界面冒烟测试 (offscreen), 验证主要流程可走通并产出文件。"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

pytest.importorskip("PySide6")

from PySide6.QtCore import QRectF  # noqa: E402
from PySide6.QtWidgets import QApplication  # noqa: E402

from repeatcell.ui.mainwindow import MainWindow  # noqa: E402


@pytest.fixture(scope="module")
def app():
    instance = QApplication.instance() or QApplication([])
    yield instance


@pytest.mark.parametrize("example_index", [0, 3, 5])
def test_main_window_flow(app, tmp_path: Path, example_index: int):
    win = MainWindow()
    win.example_combo.setCurrentIndex(example_index)
    win.load_example()
    app.processEvents()

    win.estimate()
    app.processEvents()
    assert win.analysis is not None
    assert win.analysis.groups

    win.use_complete_cell()
    app.processEvents()
    assert win.basis is not None

    win.build_clean_unit()
    app.processEvents()
    assert win.clean is not None
    assert win.clean.rgb.shape[0] == win.clean.rgb.shape[1]

    unit = win._export_unit()
    assert unit is not None
    from repeatcell.tiling import export_cell
    res = export_cell(tmp_path / "out", unit[0], unit[1], win.basis,
                      win.image, "smoke")
    assert res.unit_path.exists()
    data = json.loads(res.json_path.read_text(encoding="utf-8"))
    assert len(data["t1"]) == 2 and len(data["t2"]) == 2

    win.close()


def test_region_selection_changes_estimate(app):
    win = MainWindow()
    win.example_combo.setCurrentIndex(0)
    win.load_example()
    app.processEvents()
    h, w = win.image.shape[:2]
    win.view.set_region(QRectF(w * 0.1, h * 0.1, w * 0.5, h * 0.5))
    win.estimate()
    app.processEvents()
    assert win.analysis is not None
    rect = win._analysis_rect
    assert rect[2] <= w and rect[3] <= h
    win.close()


def test_manual_vector_edit_updates_advice(app):
    win = MainWindow()
    win.example_combo.setCurrentIndex(0)  # square: 周期 64
    win.load_example()
    app.processEvents()
    win.estimate()
    app.processEvents()
    win.t1x.setValue(128.0)
    win.t1y.setValue(0.0)
    win.t2x.setValue(0.0)
    win.t2y.setValue(64.0)
    app.processEvents()
    text = win.advice_view.toPlainText()
    assert "缩短" in text or "半步" in text
    win.close()
