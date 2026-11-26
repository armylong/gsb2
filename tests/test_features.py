import numpy as np
import pytest

from cuefinder.features import EmptyAudioError, extract_features


def _tone(freq=440.0, dur=0.5, fs=16000, amp=0.5):
    t = np.arange(int(dur * fs)) / fs
    return amp * np.sin(2 * np.pi * freq * t)


def test_silence_rejected():
    with pytest.raises(EmptyAudioError):
        extract_features(np.zeros(16000))


def test_near_silence_rejected():
    rng = np.random.default_rng(0)
    with pytest.raises(EmptyAudioError):
        extract_features(1e-6 * rng.normal(size=16000))


def test_active_span_trims_padding():
    silence = np.zeros(int(0.3 * 16000))
    f = extract_features(np.concatenate([silence, _tone(dur=0.4), silence]))
    # 帧窗 25 ms，激活起点会略早于真实起点（落在窗内即算有能量）
    assert 0.27 <= f.onset_sec <= 0.31
    assert f.active_end_sec < 0.75
    assert f.active_duration > 0.35


def test_gain_invariance():
    x = _tone(dur=0.5)
    f1 = extract_features(x)
    f2 = extract_features(0.1 * x)
    cos = np.sum(f1.feats * f2.feats, axis=0)
    assert np.allclose(cos, 1.0, atol=1e-6)


def test_flatness_discriminates_noise():
    rng = np.random.default_rng(1)
    tone = extract_features(_tone(dur=0.6))
    noise = extract_features(0.5 * rng.normal(size=int(0.6 * 16000)))
    assert tone.flatness < 0.05
    assert noise.flatness > 0.25


def test_deterministic():
    x = _tone(dur=0.4)
    a = extract_features(x)
    b = extract_features(x.copy())
    assert np.array_equal(a.feats, b.feats)
