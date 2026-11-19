"""跨层验证：渲染队列、导出回读、UI 状态同步。"""

from __future__ import annotations

import os
import time

import numpy as np
import pytest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from reverb_tool.audio_io import load_dry, load_impulse, write_wav
from reverb_tool.dsp import ReverbParams, render


def test_stale_render_is_discarded():
    """连续提交时，旧序号的结果不会被当作最新。"""
    from reverb_tool.render import RenderWorker

    results: list[int] = []
    worker = RenderWorker()
    worker.on_result = lambda request, result: results.append(request.serial)
    worker.start()
    try:
        import tempfile
        from pathlib import Path

        tmp = Path(tempfile.mkdtemp())
        dry_file = tmp / "dry.wav"
        ir_file = tmp / "ir.wav"
        write_wav(dry_file, np.random.default_rng(0).standard_normal(48000 * 3) * 0.1, 48000)
        write_wav(ir_file, np.random.default_rng(1).standard_normal(48000) * 0.1, 48000)
        dry = load_dry(dry_file)
        ir = load_impulse(ir_file)
        jobs = []
        for mix in (0.1, 0.2, 0.3, 0.4, 0.5):
            jobs.append(worker.submit(dry, ir, ReverbParams(mix=mix)))
            time.sleep(0.01)
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline and not results:
            time.sleep(0.02)
        time.sleep(0.2)
        assert results, "没有收到结果"
        assert results[-1] == jobs[-1].serial
        assert worker.is_latest(jobs[-1])
        assert not worker.is_latest(jobs[0])
        for serial in results[:-1]:
            assert serial < results[-1]
    finally:
        worker.shutdown()


def test_export_roundtrip_keeps_length_and_peak(sample_dir, tmp_path):
    dry = load_dry(sample_dir / "dry_stereo_48k.wav")
    ir = load_impulse(sample_dir / "ir_echoes_48k.wav")
    result = render(dry, ir, ReverbParams(mix=0.7, predelay_ms=15.0, protection=True))
    out = tmp_path / "export.wav"
    write_wav(out, result.samples, result.dry_sample_rate)

    from reverb_tool.audio_io import _read_raw

    data, sample_rate, channels = _read_raw(out)
    assert sample_rate == result.dry_sample_rate
    assert channels == 2
    assert data.shape[0] == result.frames
    assert np.allclose(data, result.samples, atol=1e-7)
    assert float(np.max(np.abs(data))) == pytest.approx(result.output_peak, rel=1e-6)


def test_export_mono_downmix(sample_dir, tmp_path):
    dry = load_dry(sample_dir / "dry_stereo_48k.wav")
    ir = load_impulse(sample_dir / "ir_echoes_48k.wav")
    result = render(dry, ir, ReverbParams(mix=0.5))
    mono = np.mean(result.samples, axis=1, keepdims=True)
    out = tmp_path / "mono.wav"
    write_wav(out, mono, result.dry_sample_rate)
    from reverb_tool.audio_io import _read_raw

    data, _, channels = _read_raw(out)
    assert channels == 1
    assert data.shape[0] == result.frames
    expected_peak = float(np.max(np.abs(mono)))
    assert float(np.max(np.abs(data))) == pytest.approx(expected_peak, rel=1e-6)


# ---------------------------------------------------------------- UI 层
def _make_window(qt_app):
    from reverb_tool.app import MainWindow
    from reverb_tool.player import Player

    class FakePlayer(Player):
        """不碰声卡的播放器替身，只记录收到的快照。"""

        def __init__(self) -> None:
            super().__init__()
            self.played: list = []

        @property
        def active(self) -> bool:
            return False

        def play(self, clip, device=None) -> None:
            self.played.append(clip)

        def stop(self) -> None:
            pass

    window = MainWindow(player=FakePlayer())
    return window


@pytest.fixture(scope="session")
def qt_app():
    from PySide6.QtWidgets import QApplication

    app = QApplication.instance() or QApplication([])
    yield app


@pytest.fixture()
def window(qt_app):
    keep = []

    win = _make_window(qt_app)
    keep.append(win)
    yield win
    for w in keep:
        w.close()
        w._render_controller.shutdown()


def _wait_for_result(window, timeout=10.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if window._result is not None and not window._rendering:
            return window._result
        qt = __import__("PySide6.QtWidgets", fromlist=["QApplication"]).QApplication
        qt.processEvents()
        time.sleep(0.01)
    raise AssertionError("渲染超时")


def test_ui_loads_and_renders(window, sample_dir, qt_app):
    assert window.load_dry(sample_dir / "dry_note_48k.wav")
    assert window.load_ir(sample_dir / "ir_echoes_48k.wav")
    result = _wait_for_result(window)
    assert result.frames == window.output_wave.frames
    assert result.frames == result.dry_frames + result.ir_frames_used - 1


def test_ui_stale_params_never_become_preview(window, sample_dir, qt_app):
    window.load_dry(sample_dir / "dry_note_48k.wav")
    window.load_ir(sample_dir / "ir_echoes_48k.wav")
    first = _wait_for_result(window)
    # 连续改参数；每次修改都应立即清空结果
    window.mix_row.set_value(100)
    assert window._result is None
    window.predelay_row.set_value(30)
    assert window._result is None
    window.gain_row.set_value(-60)
    second = _wait_for_result(window)
    assert second is not None
    assert second.params.mix == pytest.approx(0.1)
    assert second.params.predelay_ms == pytest.approx(30)
    assert second.params.output_gain_db == pytest.approx(-6.0)
    assert second.params.key(second.dry_sample_rate) == window.current_params().key(
        second.dry_sample_rate
    )
    assert first is not second


def test_ui_transport_uses_output_timeline(window, sample_dir, qt_app):
    window.load_dry(sample_dir / "dry_stereo_48k.wav")
    window.load_ir(sample_dir / "ir_echoes_48k.wav")
    result = _wait_for_result(window)
    base = result.frames

    window._play_all()
    clip = window._player.played[-1]
    assert clip.start_frame == 0
    assert clip.frames == base

    window._play_tail()
    clip = window._player.played[-1]
    assert clip.start_frame == result.dry_end_frame
    assert clip.start_frame + clip.frames == result.frames

    window.output_wave.set_selection((100, 500))
    window._on_selection_changed(100, 500)
    window._play_selection()
    clip = window._player.played[-1]
    assert (clip.start_frame, clip.start_frame + clip.frames) == (100, 500)

    # 拖动播放头会先切断旧声音；播放头与输出时间轴是同一坐标
    window._on_seek(777)
    assert window._cursor_frame == 777
    assert window.playhead_label.text().startswith("播放头 0.016")


def test_ui_protection_readout_and_export_guard(window, sample_dir, qt_app, monkeypatch):
    window.load_dry(sample_dir / "dry_stereo_48k.wav")
    window.load_ir(sample_dir / "ir_noise_48k.wav")
    window.gain_row.set_value(200)  # +20 dB，必然超幅
    result = _wait_for_result(window)
    assert result.protection_active or result.raw_peak <= 1.0
    if result.protection_active:
        assert result.output_peak <= 10 ** (-0.1 / 20) + 1e-9
        assert "已统一衰减" in window.overshoot_pill._text

    # 关闭保护后，导出必须弹提示（这里桩掉 QMessageBox 验证走了提示分支）
    window.protect_check.setChecked(False)
    result = _wait_for_result(window)
    assert result.overshoot
    calls = []

    def fake_exec(self):
        calls.append(1)

        return 0

    monkeypatch.setattr("PySide6.QtWidgets.QMessageBox.exec", fake_exec)
    monkeypatch.setattr(
        "PySide6.QtWidgets.QFileDialog.getSaveFileName",
        staticmethod(lambda *a, **k: ("", "")),
    )
    window._export(stereo=True)
    assert calls, "未保护的超幅导出必须提示"


def test_ui_sample_markers_carry_expected_taps(window, sample_dir, qt_app):
    from reverb_tool.samples import impulse_response

    window.load_dry(sample_dir / "dry_note_48k.wav")
    spec = impulse_response(sample_dir / "ir_echoes_48k.wav")
    window.load_ir(spec.path, window._taps_to_markers(spec))
    labels = [m.label for m in window.ir_wave._markers]
    assert any("50ms" in label for label in labels)
    assert any("+0.50" in label or "+0.500" in label for label in labels)
    result = _wait_for_result(window)
    assert result is not None


def test_ui_export_readback_shows_real_length(window, sample_dir, qt_app, tmp_path, monkeypatch):
    import soundfile as sf

    window.load_dry(sample_dir / "dry_note_48k.wav")
    window.load_ir(sample_dir / "ir_echoes_48k.wav")
    window.predelay_row.set_value(10)
    result = _wait_for_result(window)

    target = tmp_path / "ui_export.wav"
    monkeypatch.setattr(
        "PySide6.QtWidgets.QFileDialog.getSaveFileName",
        staticmethod(lambda *a, **k: (str(target), "")),
    )
    monkeypatch.setattr(
        "PySide6.QtWidgets.QMessageBox.information", staticmethod(lambda *a, **k: 0)
    )
    window._export(stereo=True)
    assert target.exists()
    data, rate = sf.read(str(target), always_2d=True)
    assert rate == result.dry_sample_rate
    assert data.shape == (result.frames, 2)
    assert data.shape[0] == result.dry_frames + result.ir_frames_used - 1 + result.predelay_frames
    info = window.export_readback.info.text()
    assert f"{result.frames:,} 点" in info
    assert "一致" in info

    mono = tmp_path / "ui_export_mono.wav"
    monkeypatch.setattr(
        "PySide6.QtWidgets.QFileDialog.getSaveFileName",
        staticmethod(lambda *a, **k: (str(mono), "")),
    )
    window._export(stereo=False)
    mono_data, _ = sf.read(str(mono), always_2d=True)
    assert mono_data.shape == (result.frames, 1)
    assert "1 声道" in window.export_readback.info.text()
