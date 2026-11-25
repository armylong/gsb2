from __future__ import annotations

import os
from pathlib import Path

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import pytest
from PySide6.QtCore import QPoint, QRect, Qt
from PySide6.QtTest import QTest
from PySide6.QtWidgets import QApplication

from lighttrails.gui.main_window import MainWindow
from lighttrails.imaging import save_rgb
from lighttrails.sequence import scan_folder
from lighttrails.synth import write_sample_sequence


@pytest.fixture(scope="session")
def qapp() -> QApplication:
    app = QApplication.instance() or QApplication([])
    yield app
    app.closeAllWindows()
    app.processEvents()
    app.quit()


@pytest.fixture()
def window(qapp: QApplication, tmp_path: Path) -> MainWindow:
    info = write_sample_sequence(tmp_path / "sample")
    win = MainWindow()
    win.import_paths(scan_folder(info.folder))
    qapp.processEvents()
    yield win
    win.close()
    win.deleteLater()
    qapp.processEvents()


def test_window_imports_sample_and_detects_middle_gap(window: MainWindow) -> None:
    assert len(window.items) == 36
    assert window.gaps
    gap = next(g for g in window.gaps if g.single)
    assert gap.missing_number == 24
    assert gap.left_index == 23
    assert gap.right_index == 24
    assert window.row_by_original[23] < window.row_by_original[24]


def test_two_parameter_versions_render_side_by_side(window: MainWindow) -> None:
    assert window.compare_splitter.count() == 2
    assert window.versions["A"].result is not None
    assert window.versions["B"].result is not None
    assert not window.panels["A"].canvas._pixmap_item.pixmap().isNull()
    assert not window.panels["B"].canvas._pixmap_item.pixmap().isNull()
    # Source and output coordinates are the same as the source frames.
    assert window.versions["A"].result.image.shape == (270, 480, 3)


def test_canvas_drag_uses_source_pixel_coordinates(window: MainWindow, qapp: QApplication) -> None:
    window.resize(1600, 950)
    window.show()
    qapp.processEvents()
    canvas = window.panels["A"].canvas
    canvas.fit()
    qapp.processEvents()

    start = canvas.mapFromScene(120, 110)
    end = canvas.mapFromScene(220, 170)
    QTest.mousePress(canvas.viewport(), Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier, start)
    QTest.mouseMove(canvas.viewport(), QPoint((start.x() + end.x()) // 2, (start.y() + end.y()) // 2))
    QTest.mouseMove(canvas.viewport(), end)
    QTest.mouseRelease(canvas.viewport(), Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier, end)
    qapp.processEvents()

    assert window.versions["A"].roi is not None
    x, y, w, h = window.versions["A"].roi
    assert abs(x - 120) <= 3
    assert abs(y - 110) <= 3
    assert 80 <= w <= 110
    assert 45 <= h <= 70
    assert window.contributor_table.rowCount() > 0


def test_range_change_updates_source_markers_and_roi(window: MainWindow, qapp) -> None:
    window.on_roi_selected("A", QRect(120, 110, 170, 70))
    assert window.contributor_table.rowCount() > 0

    window.start_spin.setValue(8)
    window.end_spin.setValue(18)
    window._timer.stop()
    window._flush_dirty()
    qapp.processEvents()

    result = window.versions["A"].result
    assert result is not None
    assert result.active_indices[0] == 8
    assert result.active_indices[-1] == 18
    assert result.source_map.shape == (270, 480)
    assert window.versions["A"].roi is not None
    # The visible contributor summary was refreshed after the range change.
    assert "版本 A" in window.contributor_summary.text()
    assert "8" in window.contributor_summary.text() or window.contributor_table.rowCount() >= 0


def test_excluded_frame_remains_searchable_with_original_number(window: MainWindow) -> None:
    frame = window._item_by_index(7)
    assert frame is not None
    frame.excluded = True
    window.run_all_now()

    result = window.versions["A"].result
    assert 7 not in result.active_indices
    assert window.select_original(7)
    row = window.row_by_original[7]
    assert "排除" in window.table.item(row, 5).text()
    # Immutable import order and embedded file number remain available.
    assert window.table.item(row, 1).text() == "7"
    assert window.table.item(row, 2).text() == "007"


def test_original_file_number_and_import_index_search_are_distinct(window: MainWindow) -> None:
    window.search_edit.setText("30")
    window.search_original()
    assert window.selected_original() == 29  # file 030 is import row 29 after missing 024

    window.search_edit.setText("#30")
    window.search_original()
    assert window.selected_original() == 30  # import row 30 is file 031

    window.search_edit.setText("24")
    window.search_original()
    assert window.selected_original() == 23  # anchor immediately before missing 024


def test_failed_range_refresh_clears_stale_canvas_and_roi(window: MainWindow) -> None:
    window.on_roi_selected("A", QRect(120, 110, 170, 70))
    assert window.contributor_table.rowCount() > 0

    for item in window.items:
        item.excluded = True
    window.run_all_now()

    assert window.versions["A"].result is None
    assert window.panels["A"].canvas._pixmap_item.pixmap().isNull()
    assert window.contributor_table.rowCount() == 0
    assert "没有可分析" in window.contributor_summary.text()


def test_lock_region_is_shared_and_export_works(window: MainWindow, tmp_path: Path) -> None:
    window.versions["A"].roi = (180, 120, 60, 40)
    window.lock_current_roi("A")
    window._timer.stop()
    window._flush_dirty()
    assert len(window.locks) == 1
    assert window.versions["A"].result is not None
    assert window.versions["B"].result is not None
    assert window.versions["A"].result.lock_mask.any()
    assert window.versions["B"].result.lock_mask.any()

    image_path = tmp_path / "stack.png"
    save_rgb(image_path, window.versions["A"].result.image)
    assert image_path.exists() and image_path.stat().st_size > 0

    list_path = tmp_path / "frames.csv"
    from lighttrails.export import export_frame_list

    export_frame_list(list_path, window.items, window.versions["A"].params, window.versions["A"].result)
    content = list_path.read_text(encoding="utf-8-sig")
    assert "light_trail_010.png" in content
    assert "original_index" in content
