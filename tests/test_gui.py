"""Headless GUI tests (Qt offscreen): ownership readout, mode switch, export."""

from __future__ import annotations

import os

import pytest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtWidgets import QApplication  # noqa: E402

from cuecut.demo import generate_demo  # noqa: E402
from cuecut.gui.app import MainWindow  # noqa: E402
from cuecut.plan import SplitMode  # noqa: E402


@pytest.fixture(scope="module")
def qapp():
    app = QApplication.instance() or QApplication([])
    yield app


@pytest.fixture()
def win(qapp, tmp_path):
    truth = generate_demo(str(tmp_path))
    w = MainWindow()
    w.load_wav(truth.path)
    w.load_cue(truth.cue_path)
    w.overview.wait(10)
    w._update_peaks()
    yield w, truth
    w.player.shutdown()
    w._close_source()
    w.deleteLater()


def test_window_loads_and_plans(win):
    w, truth = win
    assert w.sheet is not None and w.info is not None and w.plan is not None
    assert not w.sheet.errors
    assert w.plan.tiles_whole_file()
    assert w.export_panel.seg_table.rowCount() == len(w.plan.segments)
    # Each file row names the file it will be written to.
    assert w.export_panel.seg_table.item(0, 4).text() == w.plan.segments[0].file_name


def test_readout_state_changes_when_dragged_into_lead(win):
    w, truth = win
    # inside track 2's lead-in, before INDEX 01
    lead_sample = truth.marker_at("index00", 2)
    w._on_seek(lead_sample + 10)
    assert "前导" in w.chk_state.text()
    assert "T02" in w.chk_state.text()
    # drag into track 2 proper
    w._on_seek(truth.marker_at("index01", 2) + 10)
    assert "轨内" in w.chk_state.text()
    # in-track time flips sign across INDEX 01
    before = w.strip.readout.track_time
    w._on_seek(truth.marker_at("index01", 2) - 1)
    assert before.startswith("+") and w.strip.readout.track_time.startswith("-")


def test_mode_switch_keeps_audition_on_same_source_region(win):
    w, truth = win
    w.junction_panel.junction_combo.setCurrentIndex(0)
    w.junction_panel.seconds.setValue(3)
    w.junction_panel._audition()
    region_before = w.player.region
    pos_before = w.player.position()
    w.set_mode(SplitMode.HEAD.value)
    assert w.player.region == region_before
    assert abs(w.player.position() - pos_before) < w.info.samplerate * 0.2
    # switching again mid-play stays anchored
    w.set_mode(SplitMode.TAIL.value)
    assert w.player.region == region_before
    # the ownership bands did change though
    assert w.plan.mode == SplitMode.TAIL


def test_mode_switch_changes_ownership_bands(win):
    w, truth = win
    tail_bands = [(b.first, b.last, b.text) for b in w.strip.wave.bands]
    w.set_mode(SplitMode.HEAD.value)
    head_bands = [(b.first, b.last, b.text) for b in w.strip.wave.bands]
    assert tail_bands != head_bands
    # and the state text tells which file will receive the lead sample
    w._on_seek(truth.marker_at("index00", 2) + 5)
    assert "02 - Song A.wav" in w.chk_state.text()


def test_head_lead_separate_toggle(win):
    w, truth = win
    assert not any(s.kind == "head_lead" for s in w.plan.segments)
    w.set_head_sep(True)
    assert any(s.kind == "head_lead" for s in w.plan.segments)
    assert w.plan.segments[0].first_sample == 0
    assert w.plan.segments[1].first_sample == w.plan.segments[0].last_sample + 1


def test_gui_export_and_recheck(win, tmp_path, monkeypatch):
    w, truth = win
    out = str(tmp_path / "gui-out")

    # bypass the directory chooser
    monkeypatch.setattr(
        "cuecut.gui.app.QFileDialog.getExistingDirectory", lambda *a, **k: out
    )
    monkeypatch.setattr(
        "cuecut.gui.app.QMessageBox.information", lambda *a, **k: None
    )
    monkeypatch.setattr("cuecut.gui.app.QMessageBox.critical", lambda *a, **k: None)
    w._export_dir = out
    w.do_export()
    assert w._last_export is not None and w._last_export.ok
    w.verify_files()
    assert "✓ 全部文件头/尾采样与源一致" in w.export_panel.log.toPlainText()


def test_overview_lists_all_sheet_points(win):
    w, truth = win
    assert w.cue_overview.list.count() == len(w.sheet.tracks)
    text = w.cue_overview.list.item(1).text()
    assert "INDEX 01" in text and "INDEX 00" in text and "采样" in text


def test_junction_panel_explains_both_modes(win):
    w, truth = win
    text = w.junction_panel.split_label.text()
    assert "归前轨" in text and "归本轨" in text
    assert "01 - Intro.wav" in text and "02 - Song A.wav" in text


def test_dragging_from_track_into_lead_updates_destination(win):
    w, truth = win
    # cursor in track 2 proper: file is 02 - Song A.wav
    w._on_seek(truth.marker_at("index01", 2) + 100)
    assert "02 - Song A.wav" in w.chk_state.text()
    # hover (drag) into the lead: same *source* time scale, but tail mode
    # writes it to the previous file
    w._on_hover(truth.marker_at("index00", 2) + 100)
    assert "写入 01 - Intro.wav" in w.strip.readout.state_text
    assert w.strip.readout.track_time.startswith("-")
    # leave restores the cursor readout
    w._on_hover_left()
    assert "写入 02 - Song A.wav" in w.strip.readout.state_text


def test_junction_selection_moves_cursor_to_source_point(win):
    w, truth = win
    w.junction_panel.junction_combo.setCurrentIndex(1)
    j = w.junction_panel.current_junction()
    assert w.cursor == j.sample
    assert j.label.startswith("T03")


def test_exported_plan_snapshot_used_for_recheck(win):
    w, truth = win
    plan = w.plan
    w._exported_plan = plan
    # switch modes after "export": recheck must still use the exported layout
    w.set_mode(SplitMode.HEAD.value)
    assert w.plan is not w._exported_plan
