"""Deterministic built-in examples used to verify delay and polarity behavior."""

from __future__ import annotations

import numpy as np

from .dsp import AudioData


EXAMPLE_REFLECTION = "reflection"
EXAMPLE_INDEPENDENT = "independent"
EXAMPLE_ONE_SIDED = "one_sided"


def _pink_noise(n: int, rng: np.random.Generator) -> np.ndarray:
    """Simple spectrally shaped pseudo-pink noise via randomized Fourier phases."""

    freqs = np.fft.rfftfreq(n)
    magnitude = np.zeros_like(freqs)
    positive = freqs > 0
    magnitude[positive] = 1.0 / np.sqrt(freqs[positive] * n + 1e-6)
    phases = rng.uniform(0.0, 2.0 * np.pi, size=len(freqs))
    spectrum = magnitude * np.exp(1j * phases)
    y = np.fft.irfft(spectrum, n=n)
    y -= np.mean(y)
    y /= np.max(np.abs(y)) + 1e-12
    return y


def _pluck_note(freq: float, duration: float, sr: int, rng: np.random.Generator) -> np.ndarray:
    n = int(duration * sr)
    t = np.arange(n) / sr
    note = np.zeros(n)
    for harmonic in range(1, 10):
        # Slight inharmonicity keeps the synthetic pluck from sounding organ-like.
        hf = freq * harmonic * np.sqrt(1.0 + 0.00008 * harmonic * harmonic)
        amplitude = 1.0 / harmonic ** 1.25
        decay = np.exp(-t * (2.4 + 0.55 * harmonic))
        note += amplitude * decay * np.sin(2.0 * np.pi * hf * t + rng.uniform(0, 2 * np.pi))

    attack = max(1, int(0.006 * sr))
    note[:attack] *= np.linspace(0.0, 1.0, attack)
    release = max(1, int(0.03 * sr))
    note[-release:] *= np.linspace(1.0, 0.0, release)
    peak = np.max(np.abs(note)) + 1e-12
    return 0.55 * note / peak


def _musical_bed(seed: int, frequencies: tuple[float, ...], duration: float, sr: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    n = int(duration * sr)
    bed = np.zeros(n)
    beat = 0.30
    for step in range(int(duration / beat) + 1):
        start = int(step * beat * sr)
        if start >= n:
            break
        freq = frequencies[(step * 3 + (step // 4)) % len(frequencies)]
        note_dur = min(1.1, duration - start / sr)
        note = _pluck_note(freq, note_dur, sr, rng)
        end = min(n, start + len(note))
        bed[start:end] += note[: end - start]

    # A quiet common noise floor gives broadband energy around every comb null.
    noise = _pink_noise(n, np.random.default_rng(seed + 9000))
    pulse = 0.72 + 0.28 * np.sin(2 * np.pi * 0.5 * np.arange(n) / sr + seed)
    bed += 0.16 * noise * pulse
    return bed


def _finish_stereo(left: np.ndarray, right: np.ndarray, sr: int, name: str, delay: int | None, notes: str) -> AudioData:
    stereo = np.column_stack([left, right]).astype(np.float64)
    fade = max(1, int(0.012 * sr))
    fade_curve = np.linspace(0.0, 1.0, fade)
    stereo[:fade, :] *= fade_curve[:, None]
    stereo[-fade:, :] *= fade_curve[::-1, None]

    peak = float(np.max(np.abs(stereo)))
    if peak > 1e-12:
        stereo *= 0.89 / peak
    return AudioData(stereo, sr, name, known_delay=delay, notes=notes)


def make_reflection_example() -> AudioData:
    """Near source in mic 1 and a 120-sample delayed reflection in mic 2."""

    sr = 48_000
    duration = 4.0
    source = _musical_bed(7, (110.0, 164.81, 220.0, 277.18, 329.63), duration, sr)

    delay = 120  # 2.5 ms; comb period = 400 Hz, first same-polarity null = 200 Hz.
    n = len(source)
    near = 0.78 * source
    reflected = np.zeros(n)
    reflected[delay:] = 0.78 * source[: n - delay]

    # Very low independent air noise prevents mathematically perfect FFT bins.
    rng = np.random.default_rng(17)
    near += 0.0008 * rng.normal(0, 1, n)
    reflected += 0.0007 * np.random.default_rng(18).normal(0, 1, n)

    return _finish_stereo(
        near,
        reflected,
        sr,
        "内置：近声 + 120 采样延迟反射",
        delay,
        "同相延迟副本；零追加延时时，预测凹点从 200、600、1000 Hz 开始。",
    )


def make_independent_example() -> AudioData:
    """Two unrelated beds with independent noise; coherence should stay low."""

    sr = 48_000
    duration = 4.0
    left = _musical_bed(101, (130.81, 196.0, 261.63, 392.0), duration, sr)
    right = _musical_bed(202, (98.0, 146.83, 246.94, 369.99), duration, sr)

    # Different rhythmic envelopes make the lack of shared stable phase obvious.
    n = int(duration * sr)
    t = np.arange(n) / sr
    left *= 0.78 + 0.22 * np.sin(2 * np.pi * 0.75 * t)
    right *= 0.70 + 0.30 * np.sin(2 * np.pi * 0.53 * t + 1.7)

    return _finish_stereo(
        left,
        right,
        sr,
        "内置：两路无关信号",
        None,
        "两路没有稳定共同相位；多数频带应显示相干性/置信不足，延时不会移动规则凹点。",
    )


def make_one_sided_example() -> AudioData:
    """One active channel followed by a genuinely silent tail."""

    sr = 48_000
    duration = 4.0
    n = int(duration * sr)
    first = _musical_bed(303, (220.0, 277.18, 329.63, 440.0), 2.2, sr)
    left = np.zeros(n)
    left[: len(first)] = first

    # The final 0.8 s is intentionally digital silence on both channels.
    return _finish_stereo(
        left,
        np.zeros(n),
        sr,
        "内置：仅第 1 路有声 + 尾部静音",
        None,
        "前半段应提示只有一路有声；尾部应提示两路静音，相位读数不断言。",
    )


def make_example(key: str) -> AudioData:
    if key == EXAMPLE_REFLECTION:
        return make_reflection_example()
    if key == EXAMPLE_INDEPENDENT:
        return make_independent_example()
    if key == EXAMPLE_ONE_SIDED:
        return make_one_sided_example()
    raise KeyError(f"unknown example: {key}")
