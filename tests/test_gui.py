"""界面冒烟测试：离屏创建主窗口，切样例、选候选、手调对齐、导出。"""

import os

import pytest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

pytest.importorskip("PySide6")


@pytest.fixture(scope="module")
def app():
    from PySide6.QtWidgets import QApplication

    instance = QApplication.instance() or QApplication([])
    yield instance


def test_window_loads_and_switches_presets(app):
    from tdoa_lab.gui import MainWindow

    win = MainWindow()
    win.show()
    app.processEvents()
    assert win.analysis is not None
    assert win.table.rowCount() >= 1

    win.load_preset("inverted")
    app.processEvents()
    assert win.analysis["result"].polarity == -1
    assert "反相" in win.lbl_badges.text()

    win.load_preset("rhythmic")
    app.processEvents()
    assert any(p.ambiguous for p in win.analysis["result"].peaks[1:])
    assert "多候选" in win.lbl_badges.text()


def test_manual_peak_selection_changes_alignment(app):
    from tdoa_lab.gui import MainWindow

    win = MainWindow()
    win.load_preset("rhythmic")
    app.processEvents()
    main_lag = win.analysis["selected"].lag
    candidates = [p.lag for p in win.analysis["result"].peaks]
    other_row = next(i for i, p in enumerate(win.analysis["result"].peaks) if p.lag != main_lag)
    win.table.selectRow(other_row)
    app.processEvents()
    assert win.analysis["selected"].lag == candidates[other_row]
    assert abs(win.align_amount - win.analysis["selected"].refined_lag) < 1e-9
    win.table.selectRow(0)
    app.processEvents()
    assert win.analysis["selected"].lag == main_lag


def test_manual_align_and_reset(app):
    from tdoa_lab.gui import MainWindow

    win = MainWindow()
    win.load_preset("clean")
    app.processEvents()
    base = win.align_spin.value()
    win._nudge(0.25)
    app.processEvents()
    assert abs(win.align_amount - (base + 0.25)) < 1e-4
    assert win._manual_align
    win._snap_align()
    app.processEvents()
    assert abs(win.align_amount - win.analysis["selected"].refined_lag) < 1e-9
    assert not win._manual_align


def test_export_from_window(app, tmp_path):
    from tdoa_lab.gui import MainWindow
    from tdoa_lab.report import export_alignment, verify_aligned_wav

    win = MainWindow()
    win.load_preset("low_snr")
    app.processEvents()
    win._update_report_line()
    a = win.analysis
    paths = export_alignment(
        str(tmp_path), "gui", a["ch0"], a["ch1"], a["sr"],
        win.align_amount, a["result"].polarity, win.report,
    )
    chk = verify_aligned_wav(paths["aligned_wav"])
    assert abs(chk["lag"]) < 0.5
    assert chk["polarity"] == 1


def test_import_stereo_wav(app, tmp_path):
    import numpy as np

    from tdoa_lab.dsp import write_wav
    from tdoa_lab.gui import MainWindow
    from tdoa_lab.synth import make_preset

    s = make_preset("inverted")
    path = tmp_path / "stereo.wav"
    write_wav(str(path), np.stack([s.ch0, s.ch1], axis=1), s.sr)

    win = MainWindow()
    err = win.load_wav_file(str(path))
    app.processEvents()
    assert err is None
    assert win.sample.sr == s.sr
    assert win._current_truth() is None          # 导入文件不假设真值
    assert win.analysis["result"].polarity == -1
    assert abs(win.analysis["selected"].refined_lag - 4.0) < 0.3


def test_import_rejects_mono(app, tmp_path):
    import numpy as np

    from tdoa_lab.dsp import write_wav
    from tdoa_lab.gui import MainWindow

    path = tmp_path / "mono.wav"
    write_wav(str(path), np.zeros(4800), 48000)
    win = MainWindow()
    err = win.load_wav_file(str(path))
    assert err and "通道" in err
