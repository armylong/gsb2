"""GUI 接线冒烟测试: 在 offscreen 平台下端到端跑通主窗口逻辑。

本机运行: QT_QPA_PLATFORM=offscreen pytest tests/test_gui_smoke.py
"""

import os

import numpy as np
import pytest

pytest.importorskip("PySide6")
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtCore import QEventLoop, QTimer  # noqa: E402
from PySide6.QtWidgets import QApplication  # noqa: E402

from pitchshift_tool.analysis import find_clip_regions  # noqa: E402
from pitchshift_tool.audio import AudioData, load_wav, save_wav  # noqa: E402
from pitchshift_tool.main_window import MainWindow  # noqa: E402
from pitchshift_tool.synth import TEST_SR, build_test_signal  # noqa: E402


@pytest.fixture(scope="module")
def app():
    existing = QApplication.instance()
    yield existing or QApplication([])


def _wait_worker(win, app, timeout_ms=120000):
    """基于 finished 信号可靠等待当前 worker 结束 (避免 isRunning 竞态)。"""
    app.processEvents()
    worker = win.worker
    if worker is None:
        return
    loop = QEventLoop()
    worker.finished.connect(loop.quit)
    QTimer.singleShot(timeout_ms, loop.quit)
    if worker.isRunning():
        loop.exec()
    app.processEvents()


def _start_now(win, app):
    win._debounce.stop()
    win._start_worker()
    _wait_worker(win, app)


def test_full_gui_workflow(app, tmp_path):
    win = MainWindow()
    win._generate_test()  # 同时预置持续音/起音片段
    sig = win.audio.samples
    assert win.audio.channels == 2

    # 1) 正常处理: 形状/采样点数完全一致
    win.spin_semi.setValue(3)
    _start_now(win, app)
    assert win.result is not None
    assert win.result.samples.shape == sig.shape
    assert win.rb_result.isEnabled() and win.btn_export.isEnabled()

    win.rb_result.setChecked(True)
    win._version_toggled()
    html = win.txt_analysis.toHtml()
    assert "一致" in html and "主频" in html

    # 2) 削波标记
    clips = find_clip_regions(np.clip(win.result.samples * 3, -1, 1), TEST_SR)
    assert len(clips) >= 1 and any(c.hard for c in clips)

    # 3) 频繁改参数: 旧 worker 作废, 结果只认最新 config id
    win.spin_semi.setValue(5)
    win._debounce.stop()
    win._start_worker()
    win.spin_semi.setValue(7)
    win._debounce.stop()
    win._start_worker()
    _wait_worker(win, app)
    assert win.completed_config_id == win.config_seq
    assert abs(win.completed_semitones - 7.0) < 1e-9

    # 4) 取消: 上次完成结果保留
    win.spin_semi.setValue(-4)
    win._debounce.stop()
    win._start_worker()
    win._cancel_worker()
    _wait_worker(win, app)
    assert win.completed_semitones == 7.0
    assert win.result is not None

    # 5) 音分细调
    win.spin_semi.setValue(0)
    win.spin_cents.setValue(40)
    _start_now(win, app)
    assert win.result.samples.shape == sig.shape
    assert abs(win.completed_semitones - 0.4) < 1e-9

    # 6) 导出往返: 采样率/声道/点数不变
    out = tmp_path / "out.wav"
    save_wav(out, win.result.samples, win.result.sr)
    back = load_wav(out)
    assert back.sr == TEST_SR
    assert back.samples.shape == sig.shape


def test_zero_shift_marks_completed_and_exportable(app):
    win = MainWindow()
    win._generate_test()
    win.spin_semi.setValue(0)
    win.spin_cents.setValue(0)
    _start_now(win, app)
    # 零偏移快速通道: 逐采样相等
    assert np.array_equal(win.result.samples, win.audio.samples)
    assert win.btn_export.isEnabled()
