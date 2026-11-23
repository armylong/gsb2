"""UI behaviour that is easy to regress: manual regions on the right lane."""

from __future__ import annotations

import os

import pytest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
pytest.importorskip("PySide6")

from PySide6.QtWidgets import QApplication  # noqa: E402


@pytest.fixture(scope="module")
def qapp():
    app = QApplication.instance() or QApplication([])
    yield app


@pytest.fixture
def window(qapp, tmp_path):
    from PySide6.QtCore import QSettings

    from clipmend.ui.main_window import MainWindow

    settings = QSettings(str(tmp_path / "s.ini"), QSettings.Format.IniFormat)
    settings.clear()
    win = MainWindow(settings=settings)
    win.samples_dir = tmp_path / "samples"
    win.show()
    yield win
    win.player.stop()
    win.close()


def test_manual_region_lands_on_right_channel_without_table_selection(window):
    window._load_sample("short_peak")
    window._last_region_channel = 1
    window.waveform.set_selection(2000, 2100)
    window._add_selected_region()
    added = [r for r in window.doc.records if (r.start, r.end) == (2000, 2100)]
    assert added and added[0].channel == 1


def test_checkbox_uncheck_excludes_and_keeps_row(window):
    from PySide6.QtCore import Qt

    window._load_sample("short_peak")
    rows = window.table.rowCount()
    item = window.table.item(0, 0)
    item.setCheckState(Qt.CheckState.Unchecked)
    assert window.table.rowCount() == rows
    assert window.doc.segments[0].status == "excluded"
    item = window.table.item(0, 0)
    item.setCheckState(Qt.CheckState.Checked)
    assert window.doc.segments[0].status != "excluded"


def test_polarity_filter_narrows_both_table_and_summary(window):
    window._load_sample("short_peak")
    window.polarity_combo.setCurrentText("只看正削顶")
    positives = [s for s in window.doc.segments if s.polarity > 0]
    assert window.table.rowCount() == len(positives)
    assert "正削顶" in window.seg_summary.text()
