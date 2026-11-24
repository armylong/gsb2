import numpy as np

from audio_integrity.playback import apply_channel_mode, bandpass_samples, to_pcm16_bytes


def test_bandpass_preserves_length_and_attenuates_out_of_band_energy():
    sr = 8000
    n = sr // 2
    t = np.arange(n) / sr
    low_tone = np.sin(2 * np.pi * 200 * t)[:, None]
    high_tone = np.sin(2 * np.pi * 3000 * t)[:, None]
    x = (0.5 * low_tone + 0.5 * high_tone).astype(np.float32)
    y = bandpass_samples(x, sr, 100, 500)
    assert y.shape == x.shape
    middle = slice(int(0.1 * sr), int(0.4 * sr))
    low_rms = np.sqrt(np.mean(y[middle] ** 2))
    assert low_rms > 0.1

    # Measure the 3 kHz bin directly; time-domain RMS of y is dominated by
    # the retained 200 Hz tone and is therefore not an out-of-band estimate.
    spectrum = np.abs(np.fft.rfft(y[:, 0]))
    freqs = np.fft.rfftfreq(y.shape[0], 1 / sr)
    bin_3k = np.argmin(np.abs(freqs - 3000))
    assert spectrum[bin_3k] < 0.05 * y.shape[0]
    assert np.max(np.abs(y)) <= 1.0


def test_channel_mute_and_pcm_bytes():
    x = np.array([[0.5, -0.25], [-1.0, 1.0]], dtype=np.float32)
    left_only = apply_channel_mode(x, "left")
    assert left_only[0, 1] == 0
    assert left_only[1, 1] == 0
    pcm = to_pcm16_bytes(left_only)
    assert len(pcm) == left_only.size * 2
