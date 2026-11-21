"""DSP core for the crossover debug tool.

Two crossover modes:
  - LR4  : Linkwitz-Riley 4th order (cascaded 2nd-order Butterworth, causal IIR).
           Low/high phase are matched, sum is allpass-like (flat magnitude).
  - FIR  : linear-phase low-pass (firwin). High = source - low.
           With delay compensation the low band is aligned (group delay removed),
           giving perfect reconstruction; without it the misalignment shows the
           comb filtering that the compensation delay prevents.
"""
from __future__ import annotations

import numpy as np
from scipy import signal

SR_DEFAULT = 48000


# ---------------------------------------------------------------- generators
def generate(kind: str, dur: float = 2.0, sr: int = SR_DEFAULT):
    """Return (mono float64 signal in [-1,1], sr)."""
    n = int(round(dur * sr))
    t = np.arange(n) / sr
    if kind == "sweep":
        x = signal.chirp(t, f0=20.0, f1=min(20000.0, sr / 2 * 0.95),
                         t1=dur, method="logarithmic")
        fade = int(0.01 * sr)
        x[:fade] *= np.linspace(0, 1, fade)
        x[-fade:] *= np.linspace(1, 0, fade)
        x *= 0.9
    elif kind == "impulse":
        x = np.zeros(n)
        x[n // 4] = 0.95
        x[n // 4 + int(0.5 * sr)] = -0.6   # second, inverted impulse
    elif kind == "dual":
        x = 0.45 * np.sin(2 * np.pi * 220.0 * t) \
            + 0.45 * np.sin(2 * np.pi * 3000.0 * t)
    elif kind == "noise":
        rng = np.random.default_rng(14402)
        x = rng.standard_normal(n)
        x = signal.sosfilt(signal.butter(2, [40, 16000], "bandpass",
                                         fs=sr, output="sos"), x)
        x *= 0.8 / np.max(np.abs(x))
    else:
        raise ValueError(f"unknown kind: {kind}")
    return np.asarray(x, dtype=np.float64), sr


# ---------------------------------------------------------------- crossovers
def _butter2(fc, sr, btype):
    return signal.butter(2, fc, btype, fs=sr, output="sos")


def split(x, fc, sr, mode="LR4", numtaps=513, compensate=True):
    """Split mono signal -> (low, high, info)."""
    if mode == "LR4":
        sos_lo = _butter2(fc, sr, "lowpass")
        sos_hi = _butter2(fc, sr, "highpass")
        low = signal.sosfilt(sos_lo, signal.sosfilt(sos_lo, x))
        high = signal.sosfilt(sos_hi, signal.sosfilt(sos_hi, x))
        info = {"comp_delay_samples": 0.0, "comp_delay_ms": 0.0}
    elif mode == "FIR":
        h = signal.firwin(numtaps, fc, fs=sr)
        d = (numtaps - 1) / 2.0
        if compensate:
            low = signal.fftconvolve(x, h, mode="same")   # group delay removed
        else:
            low = signal.fftconvolve(x, h)[: len(x)]      # causal, delayed by d
        high = x - low
        info = {"comp_delay_samples": 0.0 if compensate else d,
                "comp_delay_ms": 0.0 if compensate else 1000.0 * d / sr,
                "fir_group_delay_samples": d,
                "fir_group_delay_ms": 1000.0 * d / sr}
    else:
        raise ValueError(mode)
    return low, high, info


def apply_polarity(low, high, invert_low=False, invert_high=False):
    if invert_low:
        low = -low
    if invert_high:
        high = -high
    return low, high


def recombine(low, high):
    return low + high


# ---------------------------------------------------------------- responses
def responses(fc, sr, mode="LR4", numtaps=513, compensate=True,
              invert_low=False, invert_high=False, nfft=8192):
    """Complex responses of the two bands and their sum.

    Returns dict with freqs, H_low, H_high, H_sum (complex arrays),
    plus compensation delay info.
    """
    w = np.linspace(1e-6, np.pi, nfft)          # rad/sample
    freqs = w * sr / (2 * np.pi)
    if mode == "LR4":
        _, h_lo = signal.sosfreqz(_butter2(fc, sr, "lowpass"), worN=w)
        _, h_hi = signal.sosfreqz(_butter2(fc, sr, "highpass"), worN=w)
        H_low, H_high = h_lo ** 2, h_hi ** 2
        comp = 0.0
    else:
        h = signal.firwin(numtaps, fc, fs=sr)
        _, H = signal.freqz(h, worN=w)
        d = (numtaps - 1) / 2.0
        if compensate:
            H_low = H * np.exp(1j * w * d)      # aligned to source timeline
        else:
            H_low = H
        H_high = 1.0 - H_low
        comp = 0.0 if compensate else d
    s_lo = -1.0 if invert_low else 1.0
    s_hi = -1.0 if invert_high else 1.0
    H_sum = s_lo * H_low + s_hi * H_high
    return {"freqs": freqs, "H_low": H_low, "H_high": H_high, "H_sum": H_sum,
            "comp_delay_samples": comp,
            "comp_delay_ms": 1000.0 * comp / sr}


def group_delay_ms(H, freqs, sr):
    """Group delay of a complex response, in ms."""
    phase = np.unwrap(np.angle(H))
    gd = -np.gradient(phase, freqs) / (2 * np.pi)   # seconds
    return gd * 1000.0


def db(x, floor=-120.0):
    return np.maximum(20 * np.log10(np.maximum(np.abs(x), 1e-12)), floor)


def overshoot_peaks(freqs, mag_db, threshold_db=0.1):
    """Indices of local maxima where the summed magnitude exceeds threshold."""
    above = mag_db > threshold_db
    idx = []
    for i in range(1, len(mag_db) - 1):
        if above[i] and mag_db[i] >= mag_db[i - 1] and mag_db[i] >= mag_db[i + 1]:
            idx.append(i)
    # merge neighbours, keep the strongest of each run
    merged = []
    for i in idx:
        if merged and i - merged[-1] <= 3:
            if mag_db[i] > mag_db[merged[-1]]:
                merged[-1] = i
        else:
            merged.append(i)
    return merged


# ---------------------------------------------------------------- validation
def _band_energy(x, sr, f_lo, f_hi):
    X = np.abs(np.fft.rfft(x))
    freqs = np.fft.rfftfreq(len(x), 1 / sr)
    m = (freqs >= f_lo) & (freqs < f_hi)
    return float(np.sum(X[m] ** 2))


def validate(source, low, high, total, sr, fc):
    """Check lengths, reconstruction and typical band content.

    Returns (ok, report_text).
    """
    lines, ok = [], True

    def check(name, cond, detail=""):
        nonlocal ok
        ok = ok and cond
        lines.append(f"[{'PASS' if cond else 'FAIL'}] {name} {detail}")

    n = len(source)
    check("lengths equal",
          len(low) == len(high) == len(total) == n,
          f"(n={n}, {n / sr:.3f} s)")

    err = np.max(np.abs(low + high - total)) if n else 0.0
    check("low+high == sum track", err < 1e-9, f"(max err {err:.2e})")

    # band separation: each band's energy should live on its side of fc
    lo_in = _band_energy(low, sr, 20, fc * 0.5)
    lo_out = _band_energy(low, sr, fc * 2.0, sr / 2 * 0.95)
    hi_in = _band_energy(high, sr, fc * 2.0, sr / 2 * 0.95)
    hi_out = _band_energy(high, sr, 20, fc * 0.5)
    check("low band rejects highs", lo_in > 100 * lo_out,
          f"(in/out {10 * np.log10(max(lo_in, 1e-30) / max(lo_out, 1e-30)):.1f} dB)")
    check("high band rejects lows", hi_in > 100 * hi_out,
          f"(in/out {10 * np.log10(max(hi_in, 1e-30) / max(hi_out, 1e-30)):.1f} dB)")

    # reconstruction vs source: compare band-averaged magnitude (phase-agnostic,
    # valid for both the allpass LR4 sum and the perfect FIR sum)
    S = np.abs(np.fft.rfft(source)) + 1e-12
    T = np.abs(np.fft.rfft(total)) + 1e-12
    freqs = np.fft.rfftfreq(n, 1 / sr)
    dev = []
    for f_lo, f_hi in [(40, fc * 0.5), (fc * 2.0, min(16000, sr / 2 * 0.9))]:
        m = (freqs >= f_lo) & (freqs < f_hi)
        if m.any():
            dev.append(np.max(np.abs(20 * np.log10(T[m] / S[m]))))
    max_dev = max(dev) if dev else 0.0
    check("sum matches source in passbands", max_dev < 0.5,
          f"(max deviation {max_dev:.3f} dB)")

    return ok, "\n".join(lines)
