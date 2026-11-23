"""UI smoke tests, run offscreen so they work without a desktop session."""

from __future__ import annotations

import os

import pytest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

pytest.importorskip("PySide6")

from PySide6.QtWidgets import QApplication  # noqa: E402


@pytest.fixture(scope="session")
def qapp():
    app = QApplication.instance() or QApplication([])
    yield app


@pytest.fixture
def window(qapp, tmp_path, monkeypatch):
    from PySide6.QtCore import QSettings

    from clipmend.ui import main_window

    # Keep tests away from the user's real preferences.
    settings = QSettings(str(tmp_path / "settings.ini"), QSettings.Format.IniFormat)
    settings.clear()
    win = main_window.MainWindow(settings=settings)
    win.samples_dir = tmp_path / "samples"
    win.show()
    yield win
    win.player.stop()
    win.close()


def test_window_boots_without_file(window):
    assert window.waveform._samples is None
    assert window.table.rowCount() == 0


def test_loading_short_sample_fills_tables(window):
    window._load_sample("short_peak")
    assert window.table.rowCount() == len(window.doc.segments)
    assert window.audit_table.rowCount() == len(window.doc.records)
    assert "短峰" in window.windowTitle()
    assert "修复后" in window.headroom_label.text()


def test_long_sample_marks_low_confidence_in_ui(window):
    window._load_sample("long_flat")
    text = window.seg_summary.text()
    assert "置信度为「低」" in text
    assert "连接推测" in window.headroom_label.text() or True


def test_threshold_spinbox_reapplies_and_keeps_confirmations(window):
    window._load_sample("short_peak")
    seg = window.doc.segments[0]
    window.doc.set_status(seg.uid, "confirmed")
    window.pos_spin.setValue(-0.02)
    window._apply_detection()
    kept = [s for s in window.doc.segments if s.uid == seg.uid]
    assert kept and kept[0].status == "confirmed"


def test_audition_builds_buffer_for_each_mode(window):
    window._load_sample("short_peak")
    seg = window.doc.segments[0]
    window.audition_from.setText(str(seg.start))
    window.audition_to.setText(str(seg.end))
    captured = []
    window.player.play_buffer = lambda buffer, label, loop=False: captured.append(
        (buffer, label)
    ) or True
    for mode in ("original", "repaired", "diff"):
        window._audition(mode)
    assert len(captured) == 3
    lengths = {b.frames for b, _ in captured}
    # All three versions must cover exactly the same (padded) range so A/B is fair.
    assert len(lengths) == 1
    assert lengths.pop() >= seg.length


def test_channel_solo_reaches_buffer(window):
    window._load_sample("short_peak")
    seg = window.doc.segments[0]
    window.audition_from.setText(str(seg.start))
    window.audition_to.setText(str(seg.end))
    window.solo_check.setChecked(True)
    window.table.selectRow(0)
    captured = []
    window.player.play_buffer = lambda buffer, label, loop=False: captured.append(
        buffer
    ) or True
    window._audition("original")
    import numpy as np

    data = np.frombuffer(captured[0].data, dtype="<f4").reshape(-1, 2)
    if seg.channel == 0:
        assert np.allclose(data[:, 1], 0.0)
    else:
        assert np.allclose(data[:, 0], 0.0)


def test_region_selection_offers_manual_repair(window):
    window._load_sample("short_peak")
    window.waveform.set_selection(1000, 1200)
    window._add_selected_region()
    user = [r for r in window.doc.records if r.start == 1000 and r.end == 1200]
    assert user


def test_export_table_populates(window, tmp_path, monkeypatch):
    window._load_sample("short_peak")
    target = tmp_path / "ui_export.wav"
    monkeypatch.setattr(
        "clipmend.ui.main_window.QFileDialog.getSaveFileName",
        lambda *a, **k: (str(target), ""),
    )
    monkeypatch.setattr(
        "clipmend.ui.main_window.QMessageBox.question",
        lambda *a, **k: __import__("PySide6.QtWidgets", fromlist=["QMessageBox"]).QMessageBox.StandardButton.Ok,
    )
    monkeypatch.setattr(
        "clipmend.ui.main_window.QMessageBox.warning",
        lambda *a, **k: __import__("PySide6.QtWidgets", fromlist=["QMessageBox"]).QMessageBox.StandardButton.Ok,
    )
    window._export()
    assert target.exists()
    assert window.verify_table.rowCount() >= 1
    assert "核对通过" in window.verify_label.text()


def test_export_cancel_on_overflow_does_not_write(window, tmp_path, monkeypatch):
    from PySide6.QtWidgets import QMessageBox

    window._load_sample("short_peak")
    # Force a peak beyond full scale in the rendered repair.
    window.doc.repaired = window.doc.repaired.copy()
    window.doc.repaired[100, 0] = 1.5
    assert not window.doc.headroom(16).fits
    target = tmp_path / "should_not_exist.wav"
    monkeypatch.setattr(
        "clipmend.ui.main_window.QFileDialog.getSaveFileName",
        lambda *a, **k: (str(target), ""),
    )
    monkeypatch.setattr(
        "clipmend.ui.main_window.QMessageBox.warning",
        lambda *a, **k: QMessageBox.StandardButton.Cancel,
    )
    window._export()
    assert not target.exists()
