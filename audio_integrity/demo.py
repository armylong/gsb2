from __future__ import annotations

from pathlib import Path

import numpy as np

from .analysis import default_bands
from .audio_io import AudioData, write_wav

DEMO_SR = 22050
DEMO_DURATION = 9.6

CASE_LABELS = {
    "composite": "综合：频带断裂+整路缺音+安静",
    "band": "专题：多个频带突然断裂",
    "channel": "专题：左右整路缺音",
}


def _band_noise(n: int, sr: int, low: float, high: float, rng: np.random.Generator) -> np.ndarray:
    noise = rng.standard_normal(n).astype(np.float32)
    spectrum = np.fft.rfft(noise)
    freqs = np.fft.rfftfreq(n, 1.0 / sr)
    width = max(20.0, (high - low) * 0.08)
    mask = np.zeros_like(freqs)
    inside = (freqs >= low) & (freqs <= high)
    mask[inside] = 1.0
    # Smooth shoulders avoid the demo generator itself creating edge clicks.
    for edge, direction in ((low, 1), (high, -1)):
        near = (freqs > edge - width) & (freqs < edge + width)
        ramp = 0.5 + 0.5 * np.cos(np.pi * (freqs[near] - edge) / width)
        if direction == 1:
            mask[near] = np.maximum(mask[near], 1.0 - ramp)
        else:
            mask[near] = np.maximum(mask[near], ramp)
    filtered = np.fft.irfft(spectrum * mask, n).astype(np.float32)
    rms = float(np.sqrt(np.mean(filtered**2)) + 1e-12)
    return filtered / rms


def _smooth_gate(t: np.ndarray, intervals: list[tuple[float, float]], feather: float = 0.03) -> np.ndarray:
    gate = np.zeros_like(t)
    for start, end in intervals:
        gate[(t >= start) & (t <= end)] = 1.0
    if feather > 0:
        k = max(3, int(feather * 44100))
        kernel = np.hanning(k * 2 + 1)
        kernel /= kernel.sum()
        gate = np.convolve(gate, kernel, mode="same")
    return np.clip(gate, 0.0, 1.0)


def _envelope(n: int, sr: int) -> np.ndarray:
    t = np.arange(n) / sr
    # Gentle syllable movement inside phrases. Deep troughs here would make
    # the synthetic fault intervals harder to interpret; the explicit phrase
    # gap below is what demonstrates a normal quiet region.
    pulse = (0.5 + 0.5 * np.sin(2 * np.pi * 3.15 * t + 0.7 * np.sin(2 * np.pi * 0.41 * t))) ** 1.4
    syllable = 0.66 + 0.34 * pulse
    phrases = _smooth_gate(t, [(0.15, 2.55), (2.75, 5.75), (6.95, 9.35)], feather=0.045)
    env = syllable * phrases
    return env.astype(np.float32)


def _base_voice(n: int, sr: int, seed: int = 15423) -> np.ndarray:
    rng = np.random.default_rng(seed)
    # Fixed musical-ish bands used by the default analysis configuration.
    ranges = [(80, 300), (300, 1000), (1000, 3000), (3000, 6000), (6000, 8500)]
    weights = np.array([0.95, 1.0, 0.82, 0.62, 0.38], dtype=np.float32)
    voice = np.zeros(n, dtype=np.float32)
    for (lo, hi), weight in zip(ranges, weights):
        if hi >= sr / 2:
            hi = sr / 2 * 0.92
        part = _band_noise(n, sr, lo, hi, rng) * weight
        # Independent slow movement makes band-energy curves less mechanical.
        voice += part.astype(np.float32)

    # Add a harmonic buzzy source so the result is closer to voiced speech.
    t = np.arange(n) / sr
    f0 = 118.0 + 18.0 * np.sin(2 * np.pi * 0.53 * t) + 7.0 * np.sin(2 * np.pi * 1.7 * t)
    phase = 2 * np.pi * np.cumsum(f0) / sr
    buzz = np.zeros(n, dtype=np.float32)
    for h in range(1, 25):
        buzz += (np.sin(h * phase) / h**1.25).astype(np.float32)
    buzz /= max(float(np.sqrt(np.mean(buzz**2))), 1e-6)
    voice += 0.72 * buzz

    env = _envelope(n, sr)
    voice *= env
    voice_rms = float(np.sqrt(np.mean(voice**2)) + 1e-12)
    target_rms = 10 ** (-20.0 / 20.0)
    voice = voice * (target_rms / voice_rms)

    # Room tone is always present at roughly -58 dBFS RMS.
    room = rng.standard_normal(n).astype(np.float32)
    room_rms = float(np.sqrt(np.mean(room**2)) + 1e-12)
    room *= (10 ** (-58.0 / 20.0)) / room_rms
    return (voice + room).astype(np.float32)


def _apply_band_gain(
    stereo: np.ndarray,
    sr: int,
    start: float,
    end: float,
    low: float,
    high: float,
    gain: float = 0.0,
    channel: int | None = None,
) -> None:
    n = stereo.shape[0]
    i0 = max(0, int(start * sr))
    i1 = min(n, int(end * sr))
    if i1 <= i0:
        return
    channels = range(stereo.shape[1]) if channel is None else (channel,)
    feather = int(0.012 * sr)
    for c in channels:
        x = stereo[i0:i1, c].copy()
        spectrum = np.fft.rfft(x)
        freqs = np.fft.rfftfreq(x.size, 1.0 / sr)
        width = min(max(18.0, (high - low) * 0.035), 70.0)
        keep = np.ones_like(freqs)
        core = (freqs >= low + width) & (freqs <= high - width)
        keep[core] = gain
        low_ramp = (freqs >= low) & (freqs < low + width)
        if np.any(low_ramp):
            frac = (freqs[low_ramp] - low) / width
            keep[low_ramp] = 1.0 + (gain - 1.0) * frac
        high_ramp = (freqs > high - width) & (freqs <= high)
        if np.any(high_ramp):
            frac = (high - freqs[high_ramp]) / width
            keep[high_ramp] = 1.0 + (gain - 1.0) * frac
        y = np.fft.irfft(spectrum * keep, x.size).astype(np.float32)
        if feather > 1 and y.size > 2 * feather:
            ramp = np.linspace(0.0, 1.0, feather, dtype=np.float32)
            y[:feather] = x[:feather] * (1 - ramp) + y[:feather] * ramp
            y[-feather:] = x[-feather:] * ramp[::-1] + y[-feather:] * (1 - ramp[::-1])
        stereo[i0:i1, c] = y


def _apply_channel_gain(stereo: np.ndarray, sr: int, start: float, end: float, channel: int, gain: float = 0.0) -> None:
    i0 = max(0, int(start * sr))
    i1 = min(stereo.shape[0], int(end * sr))
    if i1 <= i0:
        return
    feather = min(int(0.008 * sr), (i1 - i0) // 4)
    original = stereo[i0:i1, channel].copy()
    changed = original * gain
    if feather > 1:
        ramp = np.linspace(0.0, 1.0, feather, dtype=np.float32)
        changed[:feather] = original[:feather] * (1 - ramp) + changed[:feather] * ramp
        changed[-feather:] = original[-feather:] * ramp[::-1] + changed[-feather:] * (1 - ramp[::-1])
    stereo[i0:i1, channel] = changed


def make_demo_audio(case: str = "composite", sample_rate: int = DEMO_SR) -> AudioData:
    """Create a copyright-free synthetic voice-like diagnostic recording."""
    n = int(DEMO_DURATION * sample_rate)
    mono = _base_voice(n, sample_rate)
    rng = np.random.default_rng(20261125)
    # Highly correlated stereo, with a little independent microphone/room noise.
    extra_l = rng.standard_normal(n).astype(np.float32) * 0.0025
    extra_r = rng.standard_normal(n).astype(np.float32) * 0.0025
    stereo = np.column_stack([
        mono * 0.96 + extra_l,
        mono * 1.02 + extra_r,
    ]).astype(np.float32)

    if case == "composite":
        bands = {b.key: b for b in default_bands(sample_rate)}
        presence = bands["b4"]
        low_mid = bands["b2"]
        # 2.8–3.75: one complete analysis band disappears on the left only.
        _apply_band_gain(stereo, sample_rate, 2.80, 3.75, presence.low_hz, presence.high_hz, 0.0, channel=0)
        # 4.25–5.55: entire left route is gone; right keeps talking.
        _apply_channel_gain(stereo, sample_rate, 4.25, 5.55, 0, 0.0)
        # 6.0–6.9: intended natural pause/quiet. Envelope already has a gate
        # gap there; lower residual syllable/noise further to room tone.
        q0, q1 = int(6.0 * sample_rate), int(6.9 * sample_rate)
        stereo[q0:q1] *= 0.08
        # 7.35–8.45: a complete low-mid band disappears on both channels.
        _apply_band_gain(stereo, sample_rate, 7.35, 8.45, low_mid.low_hz, low_mid.high_hz, 0.0, channel=None)
    elif case == "band":
        bands = {b.key: b for b in default_bands(sample_rate)}
        _apply_band_gain(stereo, sample_rate, 2.7, 3.55, bands["b4"].low_hz, bands["b4"].high_hz, 0.0)
        _apply_band_gain(stereo, sample_rate, 4.35, 5.25, bands["b3"].low_hz, bands["b3"].high_hz, 0.0)
        _apply_band_gain(stereo, sample_rate, 6.35, 7.35, bands["b1"].low_hz, bands["b1"].high_hz, 0.0, channel=1)
    elif case == "channel":
        _apply_channel_gain(stereo, sample_rate, 2.8, 4.0, 0, 0.0)
        _apply_channel_gain(stereo, sample_rate, 5.0, 6.2, 1, 0.0)
        _apply_channel_gain(stereo, sample_rate, 7.0, 8.1, 0, 0.05)
    else:
        raise ValueError(f"未知内置案例: {case}")

    peak = float(np.max(np.abs(stereo)))
    if peak > 0.98:
        stereo *= 0.98 / peak
    return AudioData(stereo.astype(np.float32), sample_rate, path=f"<内置案例:{CASE_LABELS.get(case, case)}>", format_description="synthetic demo")


def export_demo_wav(path: str | Path, case: str = "composite") -> Path:
    audio = make_demo_audio(case)
    return write_wav(path, audio)


def _main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(description="Generate built-in diagnostic WAV cases")
    parser.add_argument("--out", default="examples", help="output directory (default: examples)")
    parser.add_argument("--case", choices=[*CASE_LABELS, "all"], default="all")
    args = parser.parse_args(argv)

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    cases = list(CASE_LABELS) if args.case == "all" else [args.case]
    for case in cases:
        path = out_dir / f"audio_integrity_{case}.wav"
        export_demo_wav(path, case)
        print(path)
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
