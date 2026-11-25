from __future__ import annotations

import numpy as np
import pytest
import soundfile as sf

from phase_bench.dsp import (
    analyze_band,
    analyze_spectrum,
    apply_alignment,
    comb_notch_frequencies,
    estimate_relative_delay,
    load_wav,
)
from phase_bench.examples import (
    EXAMPLE_INDEPENDENT,
    EXAMPLE_ONE_SIDED,
    make_example,
    make_reflection_example,
)


def test_alignment_positive_negative_polarity_and_valid_mask():
    x = np.arange(10, dtype=float).reshape(5, 2)
    # Column 1 is [1, 3, 5, 7, 9].
    pos = apply_alignment(x, 2, False)
    assert pos.samples[:, 1].tolist() == [0.0, 0.0, 1.0, 3.0, 5.0]
    assert pos.valid[:, 1].tolist() == [False, False, True, True, True]
    assert pos.samples[:, 0].tolist() == [0.0, 2.0, 4.0, 6.0, 8.0]

    neg = apply_alignment(x, -2, False)
    assert neg.samples[:, 1].tolist() == [5.0, 7.0, 9.0, 0.0, 0.0]
    assert neg.valid[:, 1].tolist() == [True, True, True, False, False]

    inverted = apply_alignment(x, 1, True)
    assert inverted.samples[1, 1] == -x[0, 1]
    assert inverted.invert_second is True


def test_comb_notch_family_swaps_with_polarity():
    same = comb_notch_frequencies(120, 48_000, False, f_min=20, f_max=1300)
    assert np.allclose(same[:3], [200, 600, 1000])

    flipped = comb_notch_frequencies(120, 48_000, True, f_min=20, f_max=1300)
    assert np.allclose(flipped[:2], [400, 800])

    # Adding +30 samples moves the first same-polarity null downward.
    moved = comb_notch_frequencies(150, 48_000, False, f_min=20, f_max=500)
    assert moved[0] == pytest.approx(160.0)


def test_reflection_example_shows_stable_opposition_and_alignment_fixes_it():
    audio = make_reflection_example()
    sr = audio.sample_rate
    selection = (int(0.5 * sr), int(3.5 * sr))

    aligned = apply_alignment(audio.samples, 0)
    analysis = analyze_spectrum(aligned.samples, sr, selection)
    assert analysis is not None and analysis.n_frames >= 20

    band = analyze_band(analysis, 180, 220, aligned_samples=aligned.samples)
    assert band is not None
    assert band.coherence > 0.90
    assert band.confidence > 0.80
    assert band.cancel_db < -7.0
    assert abs(band.phase_deg) > 150.0
    assert len(band.frame_starts) == band.n_frames
    assert len(band.frame_weights) == band.n_frames
    assert band.frame_weights.max() == pytest.approx(1.0)
    assert np.any(band.frame_weights > 0.2)

    compensated = apply_alignment(audio.samples, -120)
    fixed = analyze_spectrum(compensated.samples, sr, selection)
    fixed_band = analyze_band(fixed, 180, 220)
    assert fixed_band is not None
    assert fixed_band.cancel_db > 4.5
    assert abs(fixed_band.phase_deg) < 25.0


def test_extra_delay_moves_predicted_and_measured_null_lower():
    audio = make_reflection_example()
    sr = audio.sample_rate
    selection = (int(0.5 * sr), int(3.5 * sr))

    shifted = apply_alignment(audio.samples, 120)  # effective acoustic lag = 240
    analysis = analyze_spectrum(shifted.samples, sr, selection)
    band = analyze_band(analysis, 82, 118)  # predicted first null = 100 Hz
    assert band is not None
    assert band.coherence > 0.85
    assert band.cancel_db < -5.0


def test_independent_example_has_low_confidence():
    audio = make_example(EXAMPLE_INDEPENDENT)
    analysis = analyze_spectrum(audio.samples, audio.sample_rate)
    band = analyze_band(analysis, 300, 3000)
    assert band is not None
    assert band.coherence < 0.25
    assert band.confidence < 0.40
    assert band.reason_code in {"unstable", "short"}


def test_one_channel_and_silence_are_explicit_states():
    audio = make_example(EXAMPLE_ONE_SIDED)
    sr = audio.sample_rate

    active = analyze_spectrum(audio.samples, sr, (int(0.3 * sr), int(1.8 * sr)))
    active_band = analyze_band(active, 500, 2000)
    assert active_band.reason_code == "only_first"
    assert active_band.rms2_db <= -115.0

    silent = analyze_spectrum(audio.samples, sr, (int(3.15 * sr), int(3.9 * sr)))
    silent_band = analyze_band(silent, 300, 3000)
    assert silent_band.reason_code == "silence"
    assert silent_band.rms1_db <= -115.0
    assert silent_band.rms2_db <= -115.0


def test_estimate_relative_delay_finds_known_lag():
    audio = make_reflection_example()
    sr = audio.sample_rate
    a, b = int(0.5 * sr), int(3.5 * sr)
    delay, strength = estimate_relative_delay(
        audio.samples[a:b, 0], audio.samples[a:b, 1], sr, max_lag_ms=5
    )
    assert abs(delay - 120) <= 1
    assert strength > 0.90


def test_load_wav_requires_two_channels_and_roundtrips(tmp_path):
    sr = 16_000
    stereo = np.zeros((sr // 4, 2), dtype=np.float64)
    stereo[:, 0] = 0.1 * np.sin(2 * np.pi * 440 * np.arange(len(stereo)) / sr)
    path = tmp_path / "two_mics.wav"
    sf.write(path, stereo, sr)

    loaded = load_wav(path)
    assert loaded.sample_rate == sr
    assert loaded.samples.shape[1] == 2
    assert loaded.samples.shape[0] == len(stereo)

    mono_path = tmp_path / "mono.wav"
    sf.write(mono_path, stereo[:, 0], sr)
    with pytest.raises(ValueError):
        load_wav(mono_path)
