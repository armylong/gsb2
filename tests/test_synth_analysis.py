import numpy as np

from pitchshift_tool.analysis import (
    dominant_frequency,
    find_clip_regions,
    onset_times,
)
from pitchshift_tool.synth import (
    COMMON_FREQ,
    ONSET_TIMES,
    SUSTAIN_FREQ_L,
    SUSTAIN_FREQ_R,
    TEST_SR,
    build_test_signal,
)


def test_test_signal_shape_and_peak():
    sig = build_test_signal()
    assert sig.shape == (int(TEST_SR * 8.0), 2)
    assert sig.dtype == np.float32
    assert np.max(np.abs(sig)) <= 0.8 + 1e-6


def test_test_signal_is_deterministic():
    a = build_test_signal()
    b = build_test_signal()
    assert np.array_equal(a, b)


def test_sustain_frequencies_per_channel():
    sig = build_test_signal()
    # 6s 之后没有音头, 只剩持续音
    f_l = dominant_frequency(sig[:, 0], TEST_SR, 6.2, 7.5)
    f_r = dominant_frequency(sig[:, 1], TEST_SR, 6.2, 7.5)
    assert abs(f_l - SUSTAIN_FREQ_L) < 1.0
    assert abs(f_r - SUSTAIN_FREQ_R) < 1.0
    # 共有成分在两声道都存在
    f_mix = dominant_frequency(sig.mean(axis=1), TEST_SR, 6.2, 7.5)
    assert abs(f_mix - COMMON_FREQ) < 1.0


def test_onsets_detected_at_known_times():
    sig = build_test_signal()
    picks = onset_times(sig.mean(axis=1), TEST_SR, 0.0, 8.0)
    assert len(picks) == len(ONSET_TIMES)
    for got, expected in zip(picks, ONSET_TIMES):
        assert abs(got - expected) < 0.05


def test_pure_sustained_tone_has_no_false_onset():
    t = np.arange(TEST_SR) / TEST_SR
    pure = (0.5 * np.sin(2 * np.pi * 440 * t)).astype(np.float32)
    assert onset_times(pure, TEST_SR) == []


def test_onsets_survive_pitch_shift_without_false_positives():
    from pitchshift_tool.pipeline import pitch_shift

    sig = build_test_signal()
    for semi in (-5.0, -2.0, 2.0, 5.0, 7.0):
        shifted = pitch_shift(sig, TEST_SR, semi)
        picks = onset_times(shifted.mean(axis=1), TEST_SR, 0.0, 8.0)
        # 大偏移下也只能检出 4 个真实音头, 不能被相位声码器纹波带偏
        assert len(picks) == len(ONSET_TIMES), f"semi={semi}: {picks}"
        for got, expected in zip(picks, ONSET_TIMES):
            assert abs(got - expected) < 0.03


def test_clip_detection_flags_overload_only():
    sig = build_test_signal()
    assert find_clip_regions(sig, TEST_SR) == []
    overloaded = sig * 2.0
    regions = find_clip_regions(overloaded, TEST_SR)
    assert len(regions) >= 1
    assert all(r.peak >= 0.97 for r in regions)
    assert any(r.hard for r in regions)
