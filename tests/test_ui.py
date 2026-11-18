"""UI 冒烟测试（offscreen）：加载、参数联动、统计、导出核对与单声道禁用。"""

import os

import numpy as np
import pytest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtWidgets import QApplication  # noqa: E402

from mstool.audio_engine import (  # noqa: E402
    make_antiphase_signal,
    make_distinct_ms_signal,
    make_in_phase_signal,
    write_wav,
)
from mstool.main_window import MainWindow  # noqa: E402

SR = 48000


@pytest.fixture(scope="module")
def app():
    existing = QApplication.instance()
    yield existing or QApplication([])


@pytest.fixture
def win(app, tmp_path, monkeypatch):
    # 模态消息框在 offscreen 下会阻塞事件循环，测试中统一自动关闭
    monkeypatch.setattr(
        "mstool.main_window.QMessageBox.exec", lambda self: 0)
    monkeypatch.setattr(
        "mstool.main_window.QMessageBox.warning",
        staticmethod(lambda *a, **k: None))
    monkeypatch.setattr(
        "mstool.main_window.QMessageBox.information",
        staticmethod(lambda *a, **k: None))
    w = MainWindow()
    yield w
    w.close()
    w.deleteLater()
    app.processEvents()


def _write(tmp_path, name, sig):
    path = tmp_path / name
    write_wav(path, sig, SR, "PCM_16")
    return str(path)


def test_open_and_display(win, tmp_path):
    path = _write(tmp_path, "a.wav", make_distinct_ms_signal(SR))
    win._on_open_path(path)
    assert win._audio is not None and not win._audio.is_mono
    assert str(SR) in win._lbl_file.text()       # 采样率与采样点数显示
    assert win._wave._samples is not None


def test_unity_is_original_and_side_zero(win, tmp_path):
    path = _write(tmp_path, "b.wav", make_distinct_ms_signal(SR))
    win._on_open_path(path)
    src = win._audio.samples
    np.testing.assert_allclose(win._product, src, atol=1e-12)
    # 侧边拖到 0
    win._sld_side.setValue(0)
    win._on_gain_changed()
    assert np.max(np.abs(win._product[:, 0] - win._product[:, 1])) < 1e-12


def test_antiphase_shows_minus_one_and_mono_cancel(win, tmp_path):
    path = _write(tmp_path, "c.wav", make_antiphase_signal(SR))
    win._on_open_path(path)
    assert "−1.0000" in win._lbl_corr.text() or "-1.0000" in win._lbl_corr.text()
    assert "反相" in win._lbl_corr.text()
    assert "0.0000" in win._lbl_mono.text()  # 合听峰值为 0


def test_silence_shows_invalid_correlation(win, tmp_path):
    path = _write(tmp_path, "silent.wav",
                  np.zeros((SR // 2, 2)))
    win._on_open_path(path)
    assert "无有效值" in win._lbl_corr.text()


def test_clip_warning_blocks_export_until_adjusted(win, tmp_path, monkeypatch):
    path = _write(tmp_path, "d.wav", make_distinct_ms_signal(SR))
    win._on_open_path(path)
    win._sld_side.setValue(2000)  # 侧边 ×2，超幅
    win._on_gain_changed()
    assert not win._lbl_clip.isHidden()
    # 保护关闭时拦截导出（不弹文件对话框：直接断言提前返回）
    monkeypatch.setattr(
        "mstool.main_window.QFileDialog.getSaveFileName",
        lambda *a, **k: ("", ""))
    assert win._btn_export.isEnabled()
    win._on_export()  # 不应产生文件
    assert not list(tmp_path.glob("*_ms.wav"))
    # 开启保护后可导出
    win._chk_protect.setChecked(True)
    export_path = str(tmp_path / "ok_ms.wav")
    monkeypatch.setattr(
        "mstool.main_window.QFileDialog.getSaveFileName",
        lambda *a, **k: (export_path, ""))
    win._on_export()
    assert os.path.exists(export_path)
    assert np.max(np.abs(win._product)) <= 1.0 + 1e-9


def test_solo_mode_does_not_change_gains(win, tmp_path):
    path = _write(tmp_path, "e.wav", make_distinct_ms_signal(SR))
    win._on_open_path(path)
    win._sld_mid.setValue(1300)
    win._sld_side.setValue(1700)
    win._on_gain_changed()
    g = (win._params.mid_gain, win._params.side_gain)
    win._rb_mid.setChecked(True)
    win._on_mode_changed()
    win._rb_side.setChecked(True)
    win._on_mode_changed()
    assert (win._params.mid_gain, win._params.side_gain) == g
    win._rb_stereo.setChecked(True)
    win._on_mode_changed()
    assert (win._params.mid_gain, win._params.side_gain) == g


def test_mono_file_disables_controls(win, tmp_path):
    t = np.arange(SR) / SR
    mono = (0.4 * np.sin(2 * np.pi * 440 * t))[:, np.newaxis]
    path = _write(tmp_path, "mono.wav", mono)
    win._on_open_path(path)
    assert win._audio.is_mono
    assert not win._lbl_mono_warn.isHidden()
    assert not win._btn_export.isEnabled()
    assert not win._sld_mid.isEnabled()
    assert not win._rb_side.isEnabled()


def test_region_selection_updates_stats_scope(win, tmp_path):
    path = _write(tmp_path, "f.wav", make_in_phase_signal(SR))
    win._on_open_path(path)
    win._wave.set_region(1000, 20000)
    assert "1000–20000" in win._lbl_scope.text()
    win._wave.clear_region()
    assert "整段" in win._lbl_scope.text()


def test_seek_updates_cursor_without_player(win, tmp_path):
    path = _write(tmp_path, "g.wav", make_distinct_ms_signal(SR))
    win._on_open_path(path)
    assert win._player is None
    win._on_seek(1234)
    assert win._wave._pos == 1234
    assert "1234" in win._lbl_pos.text()
