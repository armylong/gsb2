"""Core signal processing for the phase/cancellation listening bench.

The UI, audio preview and WAV export all call :func:`apply_alignment`, so the
boundary rule cannot diverge between preview and export.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Tuple

import numpy as np

try:  # soundfile is the only file IO dependency; keep import errors readable.
    import soundfile as sf
except Exception:  # pragma: no cover - exercised only when dependency is absent
    sf = None


EPS = 1e-12
SILENCE_DBFS = -92.0
AUDIBLE_DBFS = -72.0


@dataclass(frozen=True)
class AudioData:
    """A stereo-ish source with two synchronized microphone channels."""

    samples: np.ndarray  # float64, shape (n, 2)
    sample_rate: int
    name: str
    known_delay: int | None = None
    notes: str = ""

    def __post_init__(self) -> None:
        samples = np.asarray(self.samples, dtype=np.float64)
        if samples.ndim != 2 or samples.shape[1] != 2:
            raise ValueError("AudioData expects an (n, 2) array")
        object.__setattr__(self, "samples", samples)


def load_wav(path: str | Path) -> AudioData:
    """Load a WAV containing at least two synchronized channels.

    Channels beyond the first two are ignored rather than silently mixed.
    """

    if sf is None:
        raise RuntimeError("缺少 soundfile，无法读取 WAV；请先安装 requirements.txt")

    path = Path(path)
    data, sr = sf.read(str(path), always_2d=True, dtype="float64")
    if data.ndim != 2 or data.shape[1] < 2:
        raise ValueError("这个 WAV 至少需要两路同步麦克风（双声道）")
    if data.shape[1] > 2:
        original_channels = int(data.shape[1])
        data = data[:, :2]
        notes = f"文件有 {original_channels} 路，已使用前两路"
    else:
        notes = ""
    return AudioData(samples=np.ascontiguousarray(data[:, :2]), sample_rate=int(sr), name=path.name, notes=notes)


@dataclass(frozen=True)
class Alignment:
    samples: np.ndarray  # shape (n, 2), always the original timeline length
    delay: int
    invert_second: bool
    valid: np.ndarray  # bool shape (n, 2); False = boundary zero fill

    @property
    def boundary_rule(self) -> str:
        return (
            "固定原长度：正延时把第 2 路向右移，开头补零、右端移出样本丢弃；"
            "负延时相反。预览、分析和导出使用同一结果。"
        )


def apply_alignment(samples: np.ndarray, delay: int, invert_second: bool = False) -> Alignment:
    """Apply the only delay/polarity rule used by playback and export.

    ``delay > 0`` means channel 2 occurs later.  The output keeps the source's
    sample count.  Samples that cannot be represented after the shift are
    discarded at the opposite edge; newly exposed edge samples are exact zeros
    and marked invalid in :attr:`Alignment.valid`.
    """

    x = np.asarray(samples, dtype=np.float64)
    if x.ndim != 2 or x.shape[1] != 2:
        raise ValueError("apply_alignment expects an (n, 2) array")

    n = int(x.shape[0])
    d = int(delay)
    out = np.zeros((n, 2), dtype=np.float64)
    valid = np.zeros((n, 2), dtype=bool)

    out[:, 0] = x[:, 0]
    valid[:, 0] = True

    sign = -1.0 if invert_second else 1.0
    if n == 0:
        return Alignment(out, d, bool(invert_second), valid)

    if d >= 0:
        m = max(0, min(n, n - d))
        if m:
            out[d : d + m, 1] = sign * x[:m, 1]
            valid[d : d + m, 1] = True
    else:
        a = -d
        if a < n:
            m = n - a
            out[:m, 1] = sign * x[a : a + m, 1]
            valid[:m, 1] = True

    return Alignment(out, d, bool(invert_second), valid)


def amplitude_db(x: float | np.ndarray, floor_db: float = -120.0) -> float | np.ndarray:
    """20 log10 of an RMS/amplitude-like quantity."""

    return np.maximum(20.0 * np.log10(np.maximum(np.abs(x), 10.0 ** (floor_db / 20.0))), floor_db)


def power_db(power: float | np.ndarray, floor_db: float = -120.0) -> float | np.ndarray:
    """10 log10 of an RMS-squared/power-like quantity."""

    return np.maximum(10.0 * np.log10(np.maximum(power, 10.0 ** (floor_db / 10.0))), floor_db)


@dataclass
class SpectrumAnalysis:
    selection: Tuple[int, int]
    sample_rate: int
    n_fft: int
    hop: int
    fft_size: int
    frequencies: np.ndarray
    p11: np.ndarray
    p22: np.ndarray
    psum: np.ndarray
    phase: np.ndarray
    coherence: np.ndarray
    confidence: np.ndarray
    frame_starts: np.ndarray
    window_sum: float
    global_rms1_db: float
    global_rms2_db: float

    @property
    def frame_ends(self) -> np.ndarray:
        return self.frame_starts + self.n_fft

    @property
    def n_frames(self) -> int:
        return int(len(self.frame_starts))


def _bin_confidence(coherence: np.ndarray, p11: np.ndarray, p22: np.ndarray, n_frames: int) -> np.ndarray:
    level_db = power_db(np.maximum(p11, p22))
    coherence_score = np.clip((coherence - 0.30) / 0.50, 0.0, 1.0)
    frame_factor = min(1.0, n_frames / 4.0)
    level_score = np.clip((level_db + 95.0) / 25.0, 0.0, 1.0)
    return coherence_score * frame_factor * level_score


def analyze_spectrum(
    aligned_samples: np.ndarray,
    sample_rate: int,
    selection: Tuple[int, int] | None = None,
) -> SpectrumAnalysis | None:
    """Frame the selected interval and estimate spectra, phase and coherence.

    Every FFT frame is a real Hann-windowed span inside ``selection``.  The
    absolute starts are retained so the UI can highlight exactly these samples.
    Returns ``None`` when the selection is shorter than 32 samples.
    """

    x = np.asarray(aligned_samples, dtype=np.float64)
    if x.ndim != 2 or x.shape[1] != 2:
        raise ValueError("analyze_spectrum expects an (n, 2) aligned array")

    n = int(x.shape[0])
    if selection is None:
        a, b = 0, n
    else:
        a0, b0 = selection
        a = max(0, min(n, int(a0)))
        b = max(0, min(n, int(b0)))
        if b < a:
            a, b = b, a

    length = b - a
    if length < 32:
        return None

    preferred = int(2 ** int(np.clip(round(np.log2(0.09 * sample_rate)), 7, 14)))
    largest_pow2 = int(2 ** int(np.floor(np.log2(length))))
    n_fft = max(32, min(preferred, largest_pow2))
    hop = max(1, n_fft // 4)

    starts = np.arange(a, b - n_fft + 1, hop, dtype=int)
    if len(starts) == 0:
        return None

    window = np.hanning(n_fft)
    # Zero-padding interpolates the displayed bin grid so a null lying between
    # native DFT bins is not under-reported.  It does not add time samples:
    # frame_starts/n_fft remain the exact time-domain data used.
    fft_size = n_fft * 2
    bin_count = fft_size // 2 + 1
    offsets = np.arange(n_fft)
    window_sum = float(window.sum())
    scale = 2.0 / (window_sum * window_sum)

    # Chunk the FFTs so a multi-minute WAV does not allocate one huge
    # frames-by-bins complex array.  Only averaged spectra remain resident.
    sum11 = np.zeros(bin_count, dtype=np.float64)
    sum22 = np.zeros(bin_count, dtype=np.float64)
    sum_sum = np.zeros(bin_count, dtype=np.float64)
    sum12 = np.zeros(bin_count, dtype=np.complex128)
    frame_count = len(starts)
    chunk_frames = 96

    for first in range(0, frame_count, chunk_frames):
        last = min(frame_count, first + chunk_frames)
        frame_index = starts[first:last, None] + offsets[None, :]
        frames = x[frame_index, :] * window[None, :, None]
        spectrum = np.fft.rfft(frames, n=fft_size, axis=1)
        z1 = spectrum[..., 0]
        z2 = spectrum[..., 1]

        sum11 += np.sum(np.abs(z1) ** 2, axis=0)
        sum22 += np.sum(np.abs(z2) ** 2, axis=0)
        sum_sum += np.sum(np.abs(z1 + z2) ** 2, axis=0)
        sum12 += np.sum(z1 * np.conj(z2), axis=0)

    p11 = scale * sum11 / frame_count
    p22 = scale * sum22 / frame_count
    psum = scale * sum_sum / frame_count
    s12 = scale * sum12 / frame_count

    coherence = np.clip(np.abs(s12) ** 2 / (p11 * p22 + EPS), 0.0, 1.0)
    phase = np.angle(s12)
    confidence = _bin_confidence(coherence, p11, p22, frame_count)

    selected = x[a:b]
    rms1 = float(np.sqrt(np.mean(selected[:, 0] ** 2) + EPS))
    rms2 = float(np.sqrt(np.mean(selected[:, 1] ** 2) + EPS))

    return SpectrumAnalysis(
        selection=(a, b),
        sample_rate=int(sample_rate),
        n_fft=n_fft,
        hop=hop,
        fft_size=fft_size,
        frequencies=np.fft.rfftfreq(fft_size, d=1.0 / sample_rate),
        p11=p11,
        p22=p22,
        psum=psum,
        phase=phase,
        coherence=coherence,
        confidence=confidence,
        frame_starts=starts,
        window_sum=window_sum,
        global_rms1_db=float(amplitude_db(rms1)),
        global_rms2_db=float(amplitude_db(rms2)),
    )


@dataclass
class BandMetrics:
    low_hz: float
    high_hz: float
    center_hz: float
    bin_indices: np.ndarray
    rms1_db: float
    rms2_db: float
    sum_db: float
    cancel_db: float
    coherence: float
    confidence: float
    confidence_label: str
    reason_code: str
    reason: str
    phase_rad: float
    phase_deg: float
    opposition: float
    phase_focus: float | None
    delay_estimate_samples: float | None
    n_frames: int
    frame_starts: np.ndarray
    frame_ends: np.ndarray
    frame_weights: np.ndarray


def _confidence_label(score: float) -> str:
    if score <= 0.02:
        return "不足"
    if score < 0.40:
        return "低"
    if score < 0.72:
        return "中"
    return "高"


def compute_frame_weights(
    aligned_samples: np.ndarray,
    analysis: SpectrumAnalysis,
    bin_indices: np.ndarray,
) -> np.ndarray:
    """Recompute each frame's cross-power weight for one selected band."""

    x = np.asarray(aligned_samples, dtype=np.float64)
    starts = analysis.frame_starts
    n_fft = analysis.n_fft
    window = np.hanning(n_fft)
    offsets = np.arange(n_fft)
    weights = np.zeros(analysis.n_frames, dtype=np.float64)
    chunk_frames = 96

    for first in range(0, analysis.n_frames, chunk_frames):
        last = min(analysis.n_frames, first + chunk_frames)
        frame_index = starts[first:last, None] + offsets[None, :]
        frames = x[frame_index, :] * window[None, :, None]
        spectrum = np.fft.rfft(frames, n=analysis.fft_size, axis=1)
        z1 = spectrum[:, bin_indices, 0]
        z2 = spectrum[:, bin_indices, 1]
        weights[first:last] = np.sum(np.abs(z1 * np.conj(z2)), axis=1)

    return weights / (float(np.max(weights)) + EPS)


def analyze_band(
    analysis: SpectrumAnalysis | None,
    low_hz: float,
    high_hz: float,
    aligned_samples: np.ndarray | None = None,
) -> BandMetrics | None:
    """Aggregate bins in a selected frequency interval and trace frame weights."""

    if analysis is None:
        return None

    f = analysis.frequencies
    nyquist = float(f[-1]) if len(f) else 0.0
    lo = max(0.0, min(float(low_hz), nyquist))
    hi = max(0.0, min(float(high_hz), nyquist))
    if hi < lo:
        lo, hi = hi, lo
    if hi - lo < EPS:
        hi = min(nyquist, lo + max(2.0, analysis.sample_rate / analysis.n_fft))

    indices = np.where((f >= lo - EPS) & (f <= hi + EPS))[0]
    if len(indices) == 0:
        center = int(np.argmin(np.abs(f - 0.5 * (lo + hi))))
        indices = np.array([center], dtype=int)

    idx = indices
    p1 = float(np.sum(analysis.p11[idx]) + EPS)
    p2 = float(np.sum(analysis.p22[idx]) + EPS)
    ps = float(np.sum(analysis.psum[idx]) + EPS)
    rms1_db = float(power_db(p1))
    rms2_db = float(power_db(p2))
    sum_db = float(power_db(ps))

    reference = 0.5 * (p1 + p2)
    cancel_db = float(10.0 * np.log10((ps + EPS) / (reference + EPS)))

    weights = np.sqrt(analysis.p11[idx] * analysis.p22[idx]) + EPS
    coherence = float(np.sum(weights * analysis.coherence[idx]) / np.sum(weights))

    center_hz = float(np.sqrt(max(lo, EPS) * max(hi, EPS))) if lo > 0 else 0.5 * (lo + hi)
    center_idx = int(idx[np.argmin(np.abs(f[idx] - center_hz))])
    phase_rad = float(analysis.phase[center_idx])
    opposition = float(0.5 * (1.0 - np.cos(phase_rad)))

    # Circular focus tells whether one phase representative is meaningful.
    phase_weights = weights
    circular_mean = np.sum(phase_weights * np.exp(1j * analysis.phase[idx])) / np.sum(phase_weights)
    phase_focus = float(abs(circular_mean)) if len(idx) > 1 else 1.0

    delay_est = None
    good = idx[analysis.coherence[idx] > 0.45]
    if len(good) >= 3:
        fg = f[good]
        pg = np.unwrap(analysis.phase[good])
        wg = np.sqrt(analysis.p11[good] * analysis.p22[good]) + EPS
        try:
            slope = float(np.polyfit(fg, pg, 1, w=wg)[0])
            delay_est = slope * analysis.sample_rate / (2.0 * np.pi)
        except (np.linalg.LinAlgError, ValueError):
            delay_est = None

    if aligned_samples is None:
        # Unit weights keep pure-DSP callers/tests usable; the GUI always
        # supplies samples and therefore computes true band-specific weights.
        frame_weights = np.ones(analysis.n_frames, dtype=np.float64)
    else:
        frame_weights = compute_frame_weights(aligned_samples, analysis, idx)

    n_frames = analysis.n_frames
    frame_factor = min(1.0, n_frames / 4.0)
    coherence_score = np.clip((coherence - 0.30) / 0.50, 0.0, 1.0)
    confidence = float(coherence_score * frame_factor)

    reason_code = "ok"
    reason = "有稳定共同信号"
    channel_gap_db = rms1_db - rms2_db
    max_channel_db = max(rms1_db, rms2_db)
    if n_frames == 0:
        reason_code = "no_frames"
        reason = "选区内没有完整分析帧"
        confidence = 0.0
    elif max_channel_db < SILENCE_DBFS:
        reason_code = "silence"
        reason = "两路在该频带都接近静音"
        confidence = 0.0
    elif rms2_db < AUDIBLE_DBFS - 6.0 and channel_gap_db >= 18.0:
        reason_code = "only_first"
        reason = "这个频带主要只有第 1 路有声"
        confidence = min(confidence, 0.12)
    elif rms1_db < AUDIBLE_DBFS - 6.0 and -channel_gap_db >= 18.0:
        reason_code = "only_second"
        reason = "这个频带主要只有第 2 路有声"
        confidence = min(confidence, 0.12)
    elif n_frames < 3:
        reason_code = "short"
        reason = "选区太短，只有很少 FFT 帧，无法核对相位稳定性"
        confidence = min(confidence, 0.25)
    elif coherence < 0.35:
        reason_code = "unstable"
        reason = "相干性低：两路在该频带没有稳定共同信号或相位关系"
        confidence = min(confidence, 0.20)
    elif coherence < 0.62:
        reason_code = "moderate"
        reason = "共同信号稳定性中等，凹点/相位读数需谨慎"

    return BandMetrics(
        low_hz=float(lo),
        high_hz=float(hi),
        center_hz=center_hz,
        bin_indices=idx,
        rms1_db=rms1_db,
        rms2_db=rms2_db,
        sum_db=sum_db,
        cancel_db=cancel_db,
        coherence=coherence,
        confidence=float(np.clip(confidence, 0.0, 1.0)),
        confidence_label=_confidence_label(confidence),
        reason_code=reason_code,
        reason=reason,
        phase_rad=phase_rad,
        phase_deg=float(np.degrees(phase_rad)),
        opposition=opposition,
        phase_focus=phase_focus,
        delay_estimate_samples=None if delay_est is None or not np.isfinite(delay_est) else delay_est,
        n_frames=n_frames,
        frame_starts=analysis.frame_starts.copy(),
        frame_ends=analysis.frame_ends.copy(),
        frame_weights=frame_weights,
    )


def interpret_band(band: BandMetrics | None) -> tuple[str, str, str]:
    """Return (category, headline, explanation) in Chinese."""

    if band is None:
        return ("empty", "请选择更长的时域选区", "至少需要 32 个样本；拖宽波形选区后再估计。")

    if band.reason_code in {"silence", "only_first", "only_second", "short", "unstable"}:
        hints = {
            "silence": "这里两路都没有可测能量；频谱贴底、相位点无意义，不能判断相消。",
            "only_first": "相消必须由两路共同信号形成。请检查第 2 路、极性或延时，而不是把小电平读成凹点。",
            "only_second": "相消必须由两路共同信号形成。请检查第 1 路、极性或延时，而不是把小电平读成凹点。",
            "short": "请横向拖宽时域选区，使多个 Hann/FFT 帧参与平均。",
            "unstable": "即使某一帧偶尔反相，也不是稳定窄带凹点；调延时后不应出现规则移动的凹点栅格。",
        }
        return ("low_confidence", band.reason, hints[band.reason_code])

    if band.confidence < 0.40:
        return ("low_confidence", "置信不足", band.reason)

    if band.cancel_db <= -8.0 and band.opposition >= 0.78:
        return (
            "cancellation",
            "高置信：窄频段反相相消",
            (
                f"合并能量比两路能量参考低 {band.cancel_db:.1f} dB，"
                f"中心相对相位 {band.phase_deg:+.0f}°，接近 ±180°。"
                "这是干涉凹点；两路自身在该频带仍有能量，不是整体电平小。"
            ),
        )

    if band.cancel_db <= -5.0 and band.opposition >= 0.65:
        return (
            "weak_cancellation",
            "存在相消倾向，但证据不够强",
            f"相消量 {band.cancel_db:.1f} dB、相位 {band.phase_deg:+.0f}°。缩窄频带或微调 1–2 个采样再核对。",
        )

    if band.sum_db < -48.0 and max(band.rms1_db, band.rms2_db) < -45.0 and band.cancel_db > -5.0:
        return (
            "low_level",
            "更像整体电平小",
            (
                f"两路频带电平为 {band.rms1_db:.1f}/{band.rms2_db:.1f} dBFS，"
                f"合并 {band.sum_db:.1f} dBFS；没有明显低于两路参考（{band.cancel_db:+.1f} dB），"
                "也没有稳定反相证据。"
            ),
        )

    return (
        "normal",
        "没有典型反相相消",
        (
            f"合并相对两路参考为 {band.cancel_db:+.1f} dB，"
            f"相干 γ²={band.coherence:.2f}，中心相位 {band.phase_deg:+.0f}°。"
            "可在频谱上拖选更窄的凹点，或微调延时观察凹点移动。"
        ),
    )


def comb_notch_frequencies(
    delay_samples: int,
    sample_rate: int,
    inverted_second: bool,
    f_min: float = 20.0,
    f_max: float | None = None,
) -> np.ndarray:
    """Predicted comb-filter null frequencies for a pure two-copy delay."""

    tau = abs(int(delay_samples))
    nyquist = sample_rate / 2.0
    if f_max is None:
        f_max = nyquist
    f_max = min(float(f_max), nyquist)
    f_min = max(0.0, float(f_min))

    if tau == 0:
        # With inverted polarity every frequency cancels; callers draw a banner,
        # not an infinite set of markers.
        return np.array([], dtype=float)

    period = sample_rate / tau
    if inverted_second:
        first = period  # k=0 is DC; first positive null is period.
    else:
        first = 0.5 * period

    if first > f_max:
        return np.array([], dtype=float)
    k_max = int(np.floor((f_max - first) / period))
    freqs = first + np.arange(max(0, k_max) + 1) * period
    return freqs[(freqs >= f_min) & (freqs <= f_max)]


def estimate_relative_delay(
    first: np.ndarray,
    second: np.ndarray,
    sample_rate: int,
    max_lag_ms: float = 20.0,
) -> tuple[int, float]:
    """Estimate signed lag D where second[n] resembles first[n-D].

    Returns ``(delay_samples, signed_strength)``.  A negative strength suggests
    polarity inversion.  The estimate is deliberately simple and local; the
    manual spin box remains authoritative.
    """

    x1 = np.asarray(first, dtype=np.float64)
    x2 = np.asarray(second, dtype=np.float64)
    n = min(len(x1), len(x2))
    if n < 64:
        return 0, 0.0
    x1 = x1[:n] - np.mean(x1[:n])
    x2 = x2[:n] - np.mean(x2[:n])

    max_lag = max(1, min(n - 1, int(round(max_lag_ms / 1000.0 * sample_rate))))
    fft_size = 1
    while fft_size < 2 * n:
        fft_size *= 2

    # R = X2 * conj(X1); IFFT peak at positive D means x2 is D samples later.
    spectrum = np.fft.fft(x2, fft_size) * np.conj(np.fft.fft(x1, fft_size))
    correlation = np.real(np.fft.ifft(spectrum))
    candidates = np.r_[0 : max_lag + 1, fft_size - max_lag : fft_size]
    values = correlation[candidates]
    peak_local = int(np.argmax(np.abs(values)))
    bin_index = int(candidates[peak_local])
    if bin_index > fft_size // 2:
        delay = bin_index - fft_size
    else:
        delay = bin_index

    # Normalized signed correlation on the overlapping samples.
    d = int(np.clip(delay, -(n - 1), n - 1))
    if d >= 0:
        a = x1[: n - d] if d < n else x1[:0]
        b = x2[d:] if d < n else x2[:0]
    else:
        q = -d
        a = x1[q:]
        b = x2[: n - q]
    m = min(len(a), len(b))
    if m < 16:
        return d, 0.0
    a, b = a[:m], b[:m]
    denom = float(np.sqrt(np.sum(a * a) * np.sum(b * b)) + EPS)
    strength = float(np.sum(a * b) / denom)
    return d, strength
