from __future__ import annotations

import os
from pathlib import Path

import pytest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

pytest.importorskip("PySide6")

from PySide6.QtWidgets import QApplication

from mkv_tool.gui import MainWindow


@pytest.fixture(scope="module")
def qapp() -> QApplication:
    app = QApplication.instance() or QApplication([])
    yield app  # type: ignore[misc]


def test_changing_selection_does_not_reset_edits(
    qapp: QApplication, sample_path: Path
) -> None:
    window = MainWindow()
    window.load_path(sample_path)
    assert window.session is not None
    assert window.table.rowCount() == 7

    def row_for(index: int) -> int:
        for row in range(window.table.rowCount()):
            item = window.table.item(row, window.COL_SOURCE)
            if item and int(item.data(0x0100)) == index:  # Qt.UserRole = 0x0100
                return row
        raise AssertionError(index)

    row1 = row_for(1)
    window.table.selectRow(row1)

    # Inline title edit commits through itemChanged into the edit session.
    title_item = window.table.item(row1, window.COL_TITLE)
    title_item.setText("My persistent title")
    assert window.session.find(1).title == "My persistent title"

    # Editable language combo writes directly to the same session.
    combo = window.table.cellWidget(row1, window.COL_LANG)
    combo.setCurrentText("kor")
    assert window.session.find(1).language == "kor"

    # Make source #2 the unique audio default via the checkbox.  The queued
    # repopulate reads session state, not the selected row's old widgets.
    row2 = row_for(2)
    default_item = window.table.item(row2, window.COL_DEFAULT)
    default_item.setCheckState(__import__("PySide6").QtCore.Qt.CheckState.Checked)
    qapp.processEvents()
    qapp.processEvents()

    assert window.session.default_track("audio") is not None
    assert window.session.default_track("audio").source_index == 2
    assert window.session.find(1).is_default is False

    # Move selection through several rows and back.  This must not reload or
    # overwrite TrackDraft values.
    for index in (3, 5, 2, 6, 1):
        window.table.selectRow(row_for(index))
        window.on_selection_changed()
        qapp.processEvents()

    track1 = window.session.find(1)
    assert track1.title == "My persistent title"
    assert track1.language == "kor"
    assert track1.is_default is False
    assert window.session.default_track("audio").source_index == 2

    # The visible table was rebuilt from the session after the default click;
    # ensure its title editor still shows the persisted value after reselection.
    row1_after = row_for(1)
    assert window.table.item(row1_after, window.COL_TITLE).text() == "My persistent title"
    combo_after = window.table.cellWidget(row1_after, window.COL_LANG)
    assert combo_after.currentText() == "kor"


def test_expectation_panel_explains_independent_default_and_forced(
    qapp: QApplication, sample_path: Path
) -> None:
    window = MainWindow()
    window.load_path(sample_path)
    assert window.session is not None
    window.session.set_default(4, True)
    window.session.set_forced(3, True)
    window.refresh_expectations()
    text = window.expected_view.toPlainText()
    assert "字幕默认项" in text
    assert "源#4" in text
    assert "强制字幕" in text
    assert "源#3" in text
    assert "默认字幕通常会自动显示" in text
