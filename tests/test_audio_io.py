import numpy as np
import pytest
import soundfile as sf

from pitchshift_tool import MAX_DURATION_SEC
from pitchshift_tool.audio import AudioData, load_wav, save_wav
from pitchshift_tool.synth import TEST_SR, build_test_signal


def test_stereo_roundtrip_preserves_format(tmp_path):
    sig = build_test_signal()
    p = tmp_path / "stereo.wav"
    save_wav(p, sig, TEST_SR)
    audio = load_wav(p)
    assert audio.sr == TEST_SR
    assert audio.channels == 2
    assert audio.samples.shape == sig.shape
    assert audio.duration == pytest.approx(8.0, abs=1e-3)


def test_mono_roundtrip_is_1d(tmp_path):
    mono = (0.5 * np.sin(2 * np.pi * 440 * np.arange(TEST_SR) / TEST_SR)).astype(
        np.float32
    )
    p = tmp_path / "mono.wav"
    save_wav(p, mono, TEST_SR)
    audio = load_wav(p)
    assert audio.samples.ndim == 1
    assert audio.channels == 1
    assert len(audio.samples) == TEST_SR


def test_rejects_file_longer_than_limit(tmp_path):
    sr = 8000
    long_sig = np.zeros(int(sr * (MAX_DURATION_SEC + 2)), dtype=np.float32)
    p = tmp_path / "long.wav"
    sf.write(str(p), long_sig, sr)
    with pytest.raises(ValueError, match="上限"):
        load_wav(p)


def test_channel_views():
    sig = build_test_signal()
    audio = AudioData(sig, TEST_SR)
    assert np.array_equal(audio.channel_view("L"), sig[:, 0])
    assert np.array_equal(audio.channel_view("R"), sig[:, 1])
    assert np.allclose(audio.channel_view("mix"), sig.mean(axis=1))

    mono_audio = AudioData(sig[:, 0].copy(), TEST_SR)
    assert np.array_equal(mono_audio.channel_view("R"), mono_audio.samples)
