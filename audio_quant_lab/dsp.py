"""DSP primitives for integer-depth quantization comparisons.

All scheme functions take the *original* floating-point signal.  Switching a
method or changing a parameter therefore never quantizes an already quantized
buffer.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

import numpy as np

MethodName = Literal["direct", "dither", "noise_shaped"]

METHOD_KEYS: tuple[MethodName, ...] = ("direct", "dither", "noise_shaped")
METHOD_LABELS: dict[str, str] = {
    "direct": "直接量化",
    "dither": "随机抖动 (TPDF)",
    "noise_shaped": "噪声整形",
    "original": "原始输入（旁路）",
}

DB_FLOOR = -160.0


@dataclass(frozen=True)
class QuantParams:
    """Parameters shared by the three schemes.

    ``dither_strength=1`` is the standard TPDF sum of two U(-0.5, +0.5)
    generators in LSB/code units.  Its total peak-to-peak span is two LSB.
    """

    bits: int = 8
    seed: int = 15411
    dither_strength: float = 1.0
    ns_order: int = 2
    ns_dither_strength: float = 0.0

    def __post_init__(self) -> None:
        if not 1 <= int(self.bits) <= 32:
            raise ValueError("bits must be between 1 and 32")
        if not 0.0 <= float(self.dither_strength) <= 8.0:
            raise ValueError("dither_strength must be in [0, 8]")
        if int(self.ns_order) not in (1, 2, 3):
            raise ValueError("noise shaping order must be 1, 2 or 3")

    @property
    def target_levels(self) -> int:
        return 1 << int(self.bits)


@dataclass
class QuantResult:
    method: str
    params: QuantParams
    codes: np.ndarray
    y: np.ndarray
    error: np.ndarray
    clipped_samples: int
    rail_samples: int
    unique_codes: np.ndarray = field(repr=False)

    @property
    def bits(self) -> int:
        return self.params.bits

    @property
    def target_levels(self) -> int:
        return 1 << self.params.bits

    @property
    def used_levels(self) -> int:
        return int(self.unique_codes.size)

    @property
    def step(self) -> float:
        return 1.0 / float(1 << (self.params.bits - 1))


@dataclass
class AudioData:
    samples: np.ndarray
    sample_rate: int
    channels: int = 1
    source_bits: int | None = None
    name: str = "未命名"
    is_float_source: bool = False

    def __post_init__(self) -> None:
        self.samples = np.asarray(self.samples, dtype=np.float64)
        if self.samples.ndim != 1:
            raise ValueError("AudioData.samples must be mono (1-D)")
        if self.sample_rate <= 0:
            raise ValueError("sample_rate must be positive")


def quantizer_limits(bits: int) -> tuple[int, int, int]:
    """Return scale and signed code limits for a two's-complement depth."""
    scale = 1 << (bits - 1)
    return scale, -scale, scale - 1


def count_rails(codes: np.ndarray, qmin: int, qmax: int) -> int:
    return int(np.count_nonzero((codes == qmin) | (codes == qmax)))


def quantize_direct(x: np.ndarray, params: QuantParams) -> QuantResult:
    """Round each original sample independently to the target integer depth."""
    x = np.asarray(x, dtype=np.float64)
    scale, qmin, qmax = quantizer_limits(params.bits)
    scaled = x * scale
    raw = np.floor(scaled + 0.5)
    clipped = int(np.count_nonzero((raw < qmin) | (raw > qmax)))
    codes = np.clip(raw, qmin, qmax).astype(np.int64)
    y = codes.astype(np.float64) / scale
    return _make_result(x, "direct", params, codes, y, clipped, qmin, qmax)


def make_tpdf(n: int, seed: int, strength: float = 1.0) -> np.ndarray:
    """Deterministic triangular-PDF dither in target-LSB units."""
    if n <= 0 or strength == 0.0:
        return np.zeros(max(0, n), dtype=np.float64)
    rng = np.random.default_rng(int(seed) & 0xFFFFFFFF)
    # Two independent rectangular generators, each spanning one code step.
    a = rng.random(n) - 0.5
    b = rng.random(n) - 0.5
    return (a + b) * float(strength)


def quantize_dither(x: np.ndarray, params: QuantParams) -> QuantResult:
    """Quantize the original signal plus reproducible TPDF dither."""
    x = np.asarray(x, dtype=np.float64)
    scale, qmin, qmax = quantizer_limits(params.bits)
    dither_codes = make_tpdf(x.size, params.seed, params.dither_strength)
    scaled = x * scale + dither_codes
    raw = np.floor(scaled + 0.5)
    clipped = int(np.count_nonzero((raw < qmin) | (raw > qmax)))
    codes = np.clip(raw, qmin, qmax).astype(np.int64)
    y = codes.astype(np.float64) / scale
    return _make_result(x, "dither", params, codes, y, clipped, qmin, qmax)


def noise_shaping_coefficients(order: int) -> tuple[float, ...]:
    """Feedback weights for NTF ``(1-z**-1)**order``.

    If the polynomial is ``1 + c1 z^-1 + ...``, the feedback weights are
    ``a_k = -c_k`` because the implemented recursion is
    ``v = x - sum(a_k * residual[k])``.
    """
    if order not in (1, 2, 3):
        raise ValueError("order must be 1, 2 or 3")
    poly = np.polynomial.polynomial.polypow(np.array([1.0, -1.0]), order)
    return tuple(float(-c) for c in poly[1:])


def quantize_noise_shaped(x: np.ndarray, params: QuantParams) -> QuantResult:
    """Error-feedback noise shaper, always driven by the original signal."""
    x = np.asarray(x, dtype=np.float64)
    n = x.size
    bits = params.bits
    scale, qmin, qmax = quantizer_limits(bits)
    weights = noise_shaping_coefficients(params.ns_order)
    order = len(weights)

    dither_codes = make_tpdf(n, params.seed + 7919, params.ns_dither_strength)

    codes = np.empty(n, dtype=np.int64)
    history = [0.0] * order
    clipped = 0

    # Short WAV files are the stated scope; this scalar recursion keeps the
    # topology explicit and avoids a SciPy/lfilter dependency.
    for i in range(n):
        feedback = 0.0
        for k, weight in enumerate(weights):
            feedback += weight * history[k]

        scaled = float(x[i]) * scale + dither_codes[i] - feedback
        raw = int(np.floor(scaled + 0.5))
        if raw < qmin or raw > qmax:
            clipped += 1
        code = qmin if raw < qmin else min(raw, qmax)

        residual = float(code) - scaled
        codes[i] = code
        if order > 1:
            for k in range(order - 1, 0, -1):
                history[k] = history[k - 1]
        history[0] = residual

    y = codes.astype(np.float64) / scale
    return _make_result(x, "noise_shaped", params, codes, y, clipped, qmin, qmax)


def quantize_method(x: np.ndarray, method: str, params: QuantParams) -> QuantResult:
    if method == "direct":
        return quantize_direct(x, params)
    if method == "dither":
        return quantize_dither(x, params)
    if method == "noise_shaped":
        return quantize_noise_shaped(x, params)
    raise KeyError(f"unknown quantization method: {method!r}")


def _make_result(
    x: np.ndarray,
    method: str,
    params: QuantParams,
    codes: np.ndarray,
    y: np.ndarray,
    clipped: int,
    qmin: int,
    qmax: int,
) -> QuantResult:
    error = y - np.asarray(x, dtype=np.float64)
    rail = count_rails(codes, qmin, qmax)
    return QuantResult(
        method=method,
        params=params,
        codes=codes,
        y=y,
        error=error,
        clipped_samples=clipped,
        rail_samples=rail,
        unique_codes=np.unique(codes),
    )


def rms_db(x: np.ndarray) -> float:
    x = np.asarray(x, dtype=np.float64)
    if x.size == 0:
        return float("-inf")
    rms = float(np.sqrt(np.mean(x * x)))
    if rms <= 0.0:
        return float("-inf")
    return 20.0 * np.log10(rms)


def peak_db(x: np.ndarray) -> float:
    x = np.asarray(x, dtype=np.float64)
    if x.size == 0:
        return float("-inf")
    peak = float(np.max(np.abs(x)))
    if peak <= 0.0:
        return float("-inf")
    return 20.0 * np.log10(peak)


def snr_db(reference: np.ndarray, output: np.ndarray) -> float:
    reference = np.asarray(reference, dtype=np.float64)
    output = np.asarray(output, dtype=np.float64)
    error = output - reference
    signal_power = float(np.sum(reference * reference))
    error_power = float(np.sum(error * error))
    if error_power == 0.0:
        return float("inf")
    if signal_power == 0.0:
        return float("-inf")
    return 10.0 * np.log10(signal_power / error_power)


def make_fading_tone(
    seconds: float = 8.0,
    sample_rate: int = 48_000,
    frequency: float = 1_000.0,
    start_peak: float = 0.5,
    end_peak: float = 1e-5,
) -> AudioData:
    """Create a logarithmically fading sine used to expose low-level artifacts."""
    n = max(1, round(seconds * sample_rate))
    t = np.arange(n, dtype=np.float64) / sample_rate
    ratio = max(end_peak, 1e-12) / max(start_peak, 1e-12)
    amplitude = start_peak * ratio ** (t / max(seconds, 1e-9))
    tone = amplitude * np.sin(2.0 * np.pi * frequency * t)

    # Avoid a click at the first sample without changing the long fade.
    fade_n = min(n, max(1, int(0.010 * sample_rate)))
    if fade_n > 1:
        tone[:fade_n] *= np.linspace(0.0, 1.0, fade_n, dtype=np.float64)

    return AudioData(
        samples=tone,
        sample_rate=sample_rate,
        channels=1,
        source_bits=None,
        name=f"衰减测试音 {frequency:g} Hz / {seconds:g} s",
        is_float_source=True,
    )


def compute_spectrum(
    x: np.ndarray,
    sample_rate: int,
    fft_size: int = 2048,
    max_segment: int = 2048,
) -> tuple[np.ndarray, np.ndarray, int, int]:
    """Average one-sided amplitude spectrum with safe handling of tiny arrays.

    Returns ``(frequencies_hz, magnitude_dbfs, segment_length, fft_size)``.
    Short inputs use every available sample and are zero-padded to
    ``fft_size`` only for a smooth display; ``segment_length`` reports the
    actual analysis resolution.
    """
    x = np.asarray(x, dtype=np.float64)
    n = x.size
    fft_size = int(fft_size)
    if n == 0 or sample_rate <= 0:
        return np.zeros(0), np.zeros(0), 0, fft_size

    segment_length = min(int(max_segment), n)
    segment_length = max(segment_length, 1)
    if segment_length < 16:
        window = np.ones(segment_length, dtype=np.float64)
    else:
        window = np.hanning(segment_length)

    step = max(1, segment_length // 2)
    last_start = n - segment_length
    starts = list(range(0, last_start + 1, step))
    if not starts:
        starts = [0]
    elif starts[-1] != last_start:
        # Include the tail even when it does not land on a 50%-overlap grid.
        starts.append(last_start)

    nfft = max(fft_size, int(1 << (segment_length - 1).bit_length()))
    window_sum = float(np.sum(window))
    amplitude_scale = 2.0 / window_sum if window_sum else 1.0
    power_sum = None

    for start in starts:
        segment = x[start : start + segment_length]
        if segment.size < segment_length:
            padded = np.zeros(segment_length, dtype=np.float64)
            padded[: segment.size] = segment
            segment = padded
        spectrum = np.fft.rfft(segment * window, n=nfft)
        power = (np.abs(spectrum) * amplitude_scale) ** 2
        power_sum = power if power_sum is None else power_sum + power

    assert power_sum is not None
    magnitude = np.sqrt(power_sum / len(starts))
    # One-sided FFT factor 2 applies only to non-DC/non-Nyquist bins.
    magnitude[0] /= 2.0
    if magnitude.size > 2:
        magnitude[-1] /= 2.0
    magnitude = np.maximum(magnitude, 10.0 ** (DB_FLOOR / 20.0))
    magnitude_db = 20.0 * np.log10(magnitude)
    freqs = np.fft.rfftfreq(nfft, d=1.0 / sample_rate)
    return freqs, magnitude_db, segment_length, nfft


def analysis_slice(
    n: int,
    mode: str,
    position: int,
    window: int = 2048,
) -> slice:
    """Choose the spectrum slice for whole-file, tail or playhead tracking."""
    if n <= 0:
        return slice(0, 0)
    length = min(int(window), n)
    if mode == "tail":
        return slice(n - length, n)
    if mode == "follow":
        center = int(np.clip(position, 0, n - 1))
        start = center - length // 2
        start = max(0, min(start, n - length))
        return slice(start, start + length)
    return slice(0, n)

