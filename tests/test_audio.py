import numpy as np
import pytest

from cuefinder.audio import AudioLoadError, TARGET_SR, load_audio, write_wav


def test_load_stereo_and_resample(tmp_path):
    fs = 22050
    t = np.arange(int(0.5 * fs)) / fs
    left = 0.5 * np.sin(2 * np.pi * 440 * t)
    right = 0.2 * np.sin(2 * np.pi * 880 * t)
    stereo = np.stack([left, right], axis=1)
    p = tmp_path / "stereo.wav"
    write_wav(p, stereo, fs)          # 先按 mono 写出会报错，因此这里手写
    # write_wav 只接受 mono，改用手工 scipy 写
    from scipy.io import wavfile
    wavfile.write(str(p), fs, (stereo * 32767).astype(np.int16))

    audio = load_audio(p)
    assert audio.channels == 2
    assert audio.sample_rate == fs
    assert abs(audio.duration - 0.5) < 0.01
    assert len(audio.samples) == pytest.approx(0.5 * TARGET_SR, abs=2)


def test_load_24bit(tmp_path):
    import wave
    fs = 16000
    n = int(0.3 * fs)
    t = np.arange(n) / fs
    sig = (0.6 * np.sin(2 * np.pi * 500 * t) * 8388607).astype(np.int32)
    b = np.zeros((n, 3), dtype=np.uint8)
    b[:, 0] = (sig & 0xFF)
    b[:, 1] = ((sig >> 8) & 0xFF)
    b[:, 2] = ((sig >> 16) & 0xFF)
    p = tmp_path / "pcm24.wav"
    with wave.open(str(p), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(3)
        wf.setframerate(fs)
        wf.writeframes(b.tobytes())
    audio = load_audio(p)
    assert len(audio.samples) == pytest.approx(n, abs=2)
    assert np.max(np.abs(audio.samples)) > 0.2


def test_broken_file_raises(tmp_path):
    p = tmp_path / "broken.wav"
    p.write_bytes(b"NOT A WAV")
    with pytest.raises(AudioLoadError):
        load_audio(p)


def test_missing_file_raises(tmp_path):
    with pytest.raises(AudioLoadError):
        load_audio(tmp_path / "absent.wav")


def test_non_wav_extension_rejected(tmp_path):
    p = tmp_path / "clip.mp3"
    p.write_bytes(b"ID3")
    with pytest.raises(AudioLoadError):
        load_audio(p)


def test_very_short_wav_padded(tmp_path):
    p = tmp_path / "tiny.wav"
    write_wav(p, np.array([0.0, 0.5, -0.5]), 16000)
    audio = load_audio(p)
    assert len(audio.samples) == 3
