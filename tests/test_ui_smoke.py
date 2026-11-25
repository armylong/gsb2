from __future__ import annotations

import os
import wave
from io import BytesIO

import numpy as np
import pytest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")


@pytest.fixture(scope="module")
def qapp():
    from PySide6.QtWidgets import QApplication

    app = QApplication.instance() or QApplication([])
    yield app


def test_main_window_smoke_and_state_switching(qapp):
    from phase_bench.examples import EXAMPLE_INDEPENDENT, EXAMPLE_ONE_SIDED, make_example
    from phase_bench.main_window import MainWindow

    window = MainWindow()
    window.resize(1200, 800)
    qapp.processEvents()

    assert window.analysis is not None
    assert window.band_metrics is not None
    assert window.cards["verdict"].value.text() in {"反相相消", "可能相消"}
    assert window.waveform.frame_starts.shape == window.band_metrics.frame_starts.shape

    # Compensating the built-in 120-sample reflection must remove opposition.
    window.delay_spin.setValue(-120)
    qapp.processEvents()
    window.refresh_analysis()
    window.update_band_analysis()
    assert window.band_metrics.cancel_db > 4.0

    # Independent example must fall into the explicit low-confidence state.
    window.load_audio(make_example(EXAMPLE_INDEPENDENT))
    qapp.processEvents()
    assert window.band_metrics.reason_code == "unstable"
    assert "不足" in window.cards["confidence"].value.text()

    # One-sided example and a tail selection must produce readable states.
    window.load_audio(make_example(EXAMPLE_ONE_SIDED))
    window.on_band_selected(500.0, 1500.0)
    window.update_band_analysis()
    assert window.band_metrics.reason_code == "only_first"
    assert window.cards["phase"].value.text() == "—"

    sr = window.audio.sample_rate
    window.waveform.set_selection(int(3.2 * sr), int(3.9 * sr))
    window.refresh_analysis()
    window.update_band_analysis()
    assert window.band_metrics.reason_code == "silence"

    # Exact band entry should not crash and should update all plots.
    window.low_spin.setValue(300.0)
    window.high_spin.setValue(900.0)
    window.on_band_spin()
    qapp.processEvents()
    assert window.spectrum_plot.band == window.phase_plot.band


def test_preview_wav_is_valid_mono_pcm():
    from phase_bench.audio import render_preview_wav

    samples = 0.2 * np.sin(2 * np.pi * 440 * np.arange(4800) / 48_000)
    data = render_preview_wav(samples, 48_000)
    assert data[:4] == b"RIFF"
    with wave.open(BytesIO(data), "rb") as wav:
        assert wav.getnchannels() == 1
        assert wav.getframerate() == 48_000
        assert wav.getsampwidth() == 2
        assert wav.getnframes() == len(samples)
