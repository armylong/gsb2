"""界面冒烟测试：全部在 offscreen 下跑，不要求声卡。"""
import os

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import pytest

from PySide6.QtWidgets import QApplication

from cuefinder.synth import build_query, build_reference_set


@pytest.fixture(scope="session")
def app():
    return QApplication.instance() or QApplication([])


@pytest.fixture
def window(app, tmp_path):
    from cuefinder.audio import write_wav
    from cuefinder.ui.main_window import MainWindow

    refs = build_reference_set()
    for name, sig in refs.items():
        write_wav(tmp_path / f"{name}.wav", sig, 16000)
    win = MainWindow()
    for p in sorted(tmp_path.glob("*.wav")):
        win.index.add(str(p))
    win.ref_table.populate(win.index.all())
    return win, refs


def test_window_builds(window):
    win, refs = window
    assert win.ref_table.rowCount() == len(refs)
    assert win.lbl_index_state.text()
    from cuefinder.synth import CASE_QUERIES
    assert win.combo_builtin_query.count() == len(CASE_QUERIES) + 1


def test_search_then_remove_clears_candidates(window):
    win, refs = window
    win.query_samples = build_query("correct_start", refs)
    win.run_search()
    assert win.outcome.status == "match"
    best = win.outcome.best.path
    win.index.remove(best)
    win.ref_table.populate(win.index.all())
    win._invalidate_results("参考集合已变化")
    assert win.outcome is None
    win.run_search()
    assert all(c.path != best for c in win.outcome.candidates)


def test_threshold_change_updates_candidates(window):
    win, refs = window
    win.query_samples = build_query("correct_start", refs)
    win.run_search()
    low = len(win.outcome.candidates)
    win.slider.setValue(30)
    assert win.threshold == pytest.approx(0.30)
    assert len(win.outcome.candidates) >= low


def test_alignment_view_populated(window):
    win, refs = window
    win.query_samples = build_query("end_overrun", refs)
    win.run_search()
    assert win._detail_alignment is not None
    assert win.wave_view._query.size > 0
    assert win.feat_view._cos is not None
    assert "末尾" in win.lbl_detail.text()


def test_replaced_file_reanalysed_before_search(window, tmp_path):
    from cuefinder.audio import write_wav
    win, refs = window
    target = next(r for r in win.index.all() if r.label == "cue_c_bell")
    write_wav(target.path, refs["cue_b_trill"], 16000)
    win.query_samples = build_query("correct_start", refs)
    changed = win._sync_replaced_files()
    assert "cue_c_bell" in changed
    win.run_search()
    assert win.outcome.generation == win.index.generation
    assert win.outcome.index_signature == win.index.signature()


def test_bad_file_in_table_not_ready(window, tmp_path):
    bad = tmp_path / "bad.wav"
    bad.write_bytes(b"nope")
    win, refs = window
    ref = win.index.add(str(bad))
    win.ref_table.populate(win.index.all())
    assert not ref.ready
    assert win.ref_table.rowCount() == len(refs) + 1
    win.query_samples = build_query("correct_start", refs)
    win.run_search()
    assert win.outcome.status == "match"
