"""GUI 冒烟测试（QT_QPA_PLATFORM=offscreen，不发声、不弹窗）。"""

from __future__ import annotations

import os

import numpy as np
import pytest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtWidgets import QApplication  # noqa: E402

from compressor.ui.main_window import MainWindow  # noqa: E402


@pytest.fixture(scope="module")
def app():
    existing = QApplication.instance()
    return existing or QApplication([])


def _pump(app, ms=120):
    """让排队信号与后台 DSP 线程跑完。"""
    import time
    end = time.monotonic() + ms / 1000.0
    while time.monotonic() < end:
        app.processEvents()


def test_window_builds_and_processes_sample(app):
    win = MainWindow()
    _pump(app)
    assert win._result is not None
    assert win._shown_gen == win._gen
    # 四个视图都拿到了当前代数据
    for v in win.views:
        assert v._gen == win._shown_gen
    # 长度/采样率不变
    r = win._result
    assert r.n == win._x.shape[0]
    assert r.fs == win._fs
    win.close()


def test_param_change_reprocesses_and_no_stale_result(app):
    win = MainWindow()
    _pump(app)
    gen_before = win._gen
    win.sp_attack.setValue(40)
    win.sp_release.setValue(300)
    _pump(app)
    assert win._gen > gen_before
    assert win._shown_gen == win._gen  # 显示的就是最新结果
    # 处理中状态结束后，导出按钮状态与超幅一致
    assert win.btn_export.isEnabled() == (not win._result.clipped)
    win.close()


def test_ratio_one_disables_compression(app):
    win = MainWindow()
    _pump(app)
    win.sp_ratio.setValue(1.0)
    _pump(app)
    assert np.all(win._result.gain_reduction_db == 0.0)
    assert np.allclose(win._result.output, win._result.input)
    win.close()


def test_makeup_clipping_blocks_export(app, tmp_path):
    win = MainWindow()
    _pump(app)
    win.sp_makeup.setValue(18.0)
    _pump(app)
    assert win._result.clipped
    assert not win.btn_export.isEnabled()
    # 直接走导出路径同样被阻止
    from compressor.audio_io import ClippingError, export_wav
    with pytest.raises(ClippingError):
        export_wav(str(tmp_path / "clip.wav"), win._result)
    # 降回安全值后恢复可导出
    win.sp_makeup.setValue(0.0)
    _pump(app)
    assert not win._result.clipped
    assert win.btn_export.isEnabled()
    win.close()


def test_cursor_readout_updates(app):
    win = MainWindow()
    _pump(app)
    win.axis.set_cursor(4.0)  # 样例突增段内
    _pump(app)
    assert "光标" in win.lbl_cursor.text()
    assert "dBFS" in win.lbl_in.text()
    assert "dB" in win.lbl_gr.text()
    win.close()


def test_selection_zoom_changes_view_range(app):
    win = MainWindow()
    _pump(app)
    win.axis.set_selection((3.4, 3.7))
    win._zoom_selection()
    t0, t1 = win.axis.view_range()
    assert t0 == pytest.approx(3.4) and t1 == pytest.approx(3.7)
    win.axis.reset_zoom()
    t0, t1 = win.axis.view_range()
    assert t0 == pytest.approx(0.0)
    win.close()


def test_open_external_wav_reuses_axis(tmp_path, app):
    import soundfile as sf
    from compressor.audio_io import load_wav
    fs = 44100
    path = str(tmp_path / "ext.wav")
    sf.write(path, 0.2 * np.ones((fs, 2)), fs)
    x, fs2 = load_wav(path)
    win = MainWindow()
    _pump(app)
    axis_before = win.axis
    win._x, win._fs, win._source_path = x, fs2, path
    win.axis.reset(x.shape[0] / fs2)
    win._schedule_process()
    _pump(app)
    assert win.axis is axis_before  # 复用同一模型，未重建
    assert win.axis.duration == pytest.approx(1.0)
    assert win._result.fs == 44100
    assert win._result.n == fs
    win.close()


def test_monitor_switch_does_not_change_export_data(app):
    win = MainWindow()
    _pump(app)
    snapshot = win._result.output.copy()
    # 切到原声试听、选择区间、循环，都不应改动处理结果
    win.rb_input.setChecked(True)
    win.axis.set_selection((2.0, 4.0))
    win.chk_sel.setChecked(True)
    win.chk_loop.setChecked(True)
    start, end = win._play_bounds()
    assert (start, end) == (2.0, 4.0)
    assert np.array_equal(win._result.output, snapshot)
    # 导出始终使用处理结果而非试听的原声
    assert win._result is not None
    win.rb_output.setChecked(True)
    win.close()
