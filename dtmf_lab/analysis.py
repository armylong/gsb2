"""检测算法: 细包络切段 + 段级双音判读.

整体分两层:

* 包络层: 用 8ms 窗 / 2ms 帧移算一条高分辨率能量包络. 能量连续有声的一段就是一个
  候选; 静音空洞把候选切开, 空白的毫秒数也在这里实测. 用细包络是因为 30ms 窗的
  显示帧会把 20ms 的松手抹平, 判不出"到底松没松开".
* 段级: 对每个候选/段做一次精细判读 (精确峰值频率、两组音各自强度、纯音能量占比、
  频率偏差、扭斜等). 认键、拒绝理由和"确定/待核对"都在这一层给出.

这样"按住同一个键"在包络上就是连续的一段, 不会每帧都冒出一条结果; 两次同键之间如果
确实松开了, 包络上会断开成两段, 再由 min_release_ms 决定是合并成一次按住并标成
待核对, 还是保留成两次按键.
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field
from typing import Literal

import numpy as np
from scipy.signal import get_window

__all__ = [
    "DetectionSettings",
    "DetectionResult",
    "DetectionRun",
    "DiffEntry",
    "SegmentAnalysis",
    "ToneReading",
    "analyze_core",
    "detect",
    "diff_results",
    "diff_summary",
    "export_result_json",
    "export_segments_csv",
    "frame_readout",
    "run_to_dict",
    "settings_as_dict",
    "spectrum_at",
]

from .tones import HIGH_GROUP, KEY_ORDER, KEYPAD, LOW_GROUP

Verdict = Literal["accept", "review", "reject"]

STATUS_LABEL = {"accept": "确定", "review": "待核对", "reject": "拒绝"}

REASON_LABEL = {
    "ok": "双音齐全, 频率与强弱都在范围内",
    "too_short": "按键过短, 时长不足",
    "no_tone": "候选区间里没有稳定的单音",
    "missing_component": "只找到一组音, 缺少另一支",
    "off_frequency": "峰值频率偏离标称值过远",
    "twist": "两支音强弱差过大",
    "noisy": "纯音能量占比低, 背景声过强",
    "weak": "整体电平过低",
    "merged_hold": "同键间隔短于可分辨范围, 按一次按住处理",
    "tight_gap": "键间空白短于可分辨范围, 边界待核对",
    "short_key": "按键时长偏短, 判读待核对",
    "near_limit": "频率/强弱接近门限, 判读待核对",
}


@dataclass(frozen=True)
class DetectionSettings:
    """检测设定. 界面上每个字段都能改, 改完重新识别.

    时长类单位毫秒, 强度类单位 dB, 频率容差同时给了百分比和绝对下限
    (取两者较大值), 因为高组的音本身更宽, 绝对容差要随频率放大.
    """

    frame_ms: float = 30.0
    hop_ms: float = 10.0
    envelope_ms: float = 8.0
    envelope_hop_ms: float = 2.0
    edge_trim_ms: float = 6.0
    min_key_ms: float = 40.0
    min_release_ms: float = 40.0
    min_gap_ms: float = 8.0
    silence_margin_db: float = 9.0
    absolute_floor_dbfs: float = -55.0
    activation_depth_db: float = 12.0
    release_dip_db: float = 6.0
    tone_prominence_db: float = 9.0
    min_snr_db: float = 6.0
    review_snr_db: float = 15.0
    max_twist_db: float = 12.0
    review_twist_db: float = 8.0
    freq_tolerance_pct: float = 1.5
    freq_tolerance_hz: float = 4.0
    review_offset_ratio: float = 0.6
    min_component_amplitude: float = 0.02
    active_drop_db: float = 3.0

    def validate(self) -> None:
        if self.frame_ms < 10:
            raise ValueError("分析窗至少要 10 毫秒")
        if not 2 <= self.hop_ms <= self.frame_ms:
            raise ValueError("帧移需在 2 毫秒到分析窗长之间")
        if self.envelope_ms < 2:
            raise ValueError("能量包络窗至少要 2 毫秒")
        if not 1 <= self.envelope_hop_ms <= self.envelope_ms:
            raise ValueError("包络帧移需在 1 毫秒到包络窗长之间")
        if self.min_key_ms < 10:
            raise ValueError("最短按键时长至少要 10 毫秒")
        if self.min_release_ms < 0:
            raise ValueError("最小释放时长不能为负")
        if self.min_gap_ms < 0:
            raise ValueError("最短可分辨空白不能为负")
        if self.freq_tolerance_pct <= 0 or self.freq_tolerance_hz < 0:
            raise ValueError("频率容差必须为正")
        if self.max_twist_db <= 0:
            raise ValueError("最大强弱差必须为正")

    def tolerance_hz(self, nominal: float) -> float:
        return max(self.freq_tolerance_hz, self.freq_tolerance_pct / 100.0 * nominal)


@dataclass
class ToneReading:
    group: str
    nominal: float
    peak_hz: float
    amplitude: float
    prominence_db: float
    offset_hz: float
    tolerance_hz: float

    @property
    def in_tolerance(self) -> bool:
        return abs(self.offset_hz) <= self.tolerance_hz


@dataclass
class SegmentAnalysis:
    start_s: float
    end_s: float
    key: str | None
    verdict: Verdict
    reason_code: str
    reason: str
    low: ToneReading | None = None
    high: ToneReading | None = None
    snr_db: float = 0.0
    tone_share: float = 0.0
    twist_db: float = 0.0
    rms_dbfs: float = -120.0
    notes: list[str] = field(default_factory=list)
    detail: str = ""
    merged_from: int = 1

    @property
    def duration_ms(self) -> float:
        return (self.end_s - self.start_s) * 1000.0

    @property
    def status_label(self) -> str:
        return STATUS_LABEL[self.verdict]


@dataclass
class DetectionResult:
    settings: DetectionSettings
    sample_rate: int
    duration_s: float
    accepted: list[SegmentAnalysis]
    rejected: list[SegmentAnalysis]
    frame_times: list[float]
    frame_level_db: list[float]
    active_threshold_db: float
    noise_floor_db: float

    @property
    def keys(self) -> str:
        return "".join(s.key or "?" for s in self.accepted)

    @property
    def confirmed(self) -> list[SegmentAnalysis]:
        return [s for s in self.accepted if s.verdict == "accept"]

    @property
    def review(self) -> list[SegmentAnalysis]:
        return [s for s in self.accepted if s.verdict == "review"]

    def all_segments(self) -> list[SegmentAnalysis]:
        return sorted(self.accepted + self.rejected, key=lambda s: s.start_s)


def _prepare_window(n: int) -> np.ndarray:
    return get_window("hann", n, fftbins=True).astype(np.float64)


def _dbfs(value: float) -> float:
    return 20.0 * math.log10(max(value, 1e-12))


def _peak_in_band(
    freqs: np.ndarray, mag: np.ndarray, lo: float, hi: float
) -> tuple[float, float, float]:
    """返回带内峰值 (频率, 幅度, 相对带内中位数的突出度 dB)."""
    mask = (freqs >= lo) & (freqs <= hi)
    if not np.any(mask):
        return 0.5 * (lo + hi), 0.0, -120.0
    band_mag = mag[mask]
    idx = int(np.argmax(band_mag))
    band_freqs = freqs[mask]
    # 对数幅度抛物线插值, 比直接取 bin 中心细得多
    if 0 < idx < len(band_mag) - 1:
        y0, y1, y2 = (
            math.log(max(band_mag[idx - 1], 1e-20)),
            math.log(max(band_mag[idx], 1e-20)),
            math.log(max(band_mag[idx + 1], 1e-20)),
        )
        denom = y0 - 2 * y1 + y2
        delta = 0.5 * (y0 - y2) / denom if abs(denom) > 1e-15 else 0.0
        delta = max(-0.5, min(0.5, delta))
    else:
        delta = 0.0
    step = band_freqs[1] - band_freqs[0] if len(band_freqs) > 1 else 0.0
    peak_f = float(band_freqs[idx] + delta * step)
    peak_mag = float(band_mag[idx])
    floor = float(np.median(band_mag)) + 1e-20
    prominence = 20.0 * math.log10(max(peak_mag / floor, 1e-12))
    return peak_f, peak_mag, prominence


def _matched_amplitude(x: np.ndarray, sr: int, freq: float, window: np.ndarray) -> float:
    """在给定频率上做正交解调, 得到该正弦的振幅估计 (对非整 bin 也准).

    对 x = A·sin(2πft) 有 2·|Σ w·x·e^{-j2πft}| / Σw = A, 与窗型无关.
    """
    t = np.arange(len(x)) / sr
    phase = 2 * np.pi * freq * t
    denom = float(np.sum(window))
    if denom <= 0:
        return 0.0
    a = float(np.sum(window * x * np.cos(phase)))
    b = float(np.sum(window * x * np.sin(phase)))
    return float(2.0 * math.hypot(a, b) / denom)


def _band_lo_hi(group_freqs: tuple[float, ...], sr: int, frame_len: int) -> tuple[float, float]:
    # 搜索范围: 标称范围两端各留出大约两个频率分辨单元
    resolution = sr / max(frame_len, 1)
    pad = max(35.0, 2.5 * resolution)
    return group_freqs[0] - pad, group_freqs[-1] + pad


def analyze_core(
    core: np.ndarray, sr: int, settings: DetectionSettings, *, refine: bool = True
) -> dict:
    """对一段平稳信号做精细判读, 返回字典形式的全部指标.

    这个函数同时服务段级判读和界面上"光标处频率读数", 所以只依赖数据本身.
    """
    n = len(core)
    out: dict = {
        "low": None,
        "high": None,
        "snr_db": -120.0,
        "tone_share": 0.0,
        "twist_db": 0.0,
        "rms_dbfs": -120.0,
    }
    if n < 16:
        return out
    x = np.asarray(core, dtype=np.float64)
    x = x - float(np.mean(x))
    window = _prepare_window(n)
    rms = float(np.sqrt(np.mean(x * x)))
    out["rms_dbfs"] = _dbfs(rms)
    pad = 1
    while pad * 2 < n * 8:
        pad *= 2
    nfft = max(2048, pad)
    spec = np.fft.rfft(x * window, n=nfft)
    mag = np.abs(spec)
    freqs = np.fft.rfftfreq(nfft, d=1.0 / sr)
    lo_bounds = _band_lo_hi(LOW_GROUP, sr, n)
    hi_bounds = _band_lo_hi(HIGH_GROUP, sr, n)

    readings: dict[str, ToneReading | None] = {}
    for group, freqs_group, bounds in (
        ("low", LOW_GROUP, lo_bounds),
        ("high", HIGH_GROUP, hi_bounds),
    ):
        peak_hz, peak_mag, prominence = _peak_in_band(freqs, mag, *bounds)
        nominal = min(freqs_group, key=lambda f: abs(f - peak_hz))
        if refine:
            # 以 FFT 峰为起点, 在一个窄网格上最大化正交解调振幅, 得到更准的频率
            span = 0.5 * sr / n + 6.0
            grid = np.arange(peak_hz - span, peak_hz + span + 1e-9, 0.25)
            best_amp, best_f = -1.0, peak_hz
            for f in grid:
                amp = _matched_amplitude(x, sr, float(f), window)
                if amp > best_amp:
                    best_amp, best_f = amp, float(f)
            peak_hz = best_f
            amplitude = best_amp
            nominal = min(freqs_group, key=lambda f: abs(f - peak_hz))
        else:
            amplitude = _matched_amplitude(x, sr, peak_hz, window)
        tol = settings.tolerance_hz(nominal)
        readings[group] = ToneReading(
            group=group,
            nominal=nominal,
            peak_hz=peak_hz,
            amplitude=float(amplitude),
            prominence_db=float(prominence),
            offset_hz=float(peak_hz - nominal),
            tolerance_hz=tol,
        )
        out[group] = readings[group]

    low = readings["low"]
    high = readings["high"]
    assert low is not None and high is not None
    tone_power = 0.5 * (low.amplitude**2 + high.amplitude**2)
    # 残余用带限 (只算两组音所在频段之外的能量) 而不是"总能量 - 两支音",
    # 否则起了落沿、短段两端不完整的正弦会被当成背景, 信噪比随段落变短而虚降.
    residual_power = _residual_power(x, sr, window, low.peak_hz, high.peak_hz)
    out["snr_db"] = 10.0 * math.log10(max(tone_power, 1e-18) / max(residual_power, 1e-18))
    denom = tone_power + residual_power
    out["tone_share"] = float(min(tone_power / denom, 1.0)) if denom > 0 else 0.0
    if low.amplitude > 1e-12 and high.amplitude > 1e-12:
        out["twist_db"] = 20.0 * math.log10(high.amplitude / low.amplitude)
    else:
        out["twist_db"] = 120.0 if high.amplitude > low.amplitude else -120.0
    # 带内中位数电平 (相对总能量) 也暴露出来, 便于界面解释"背景有多强"
    out["noise_dbfs"] = _dbfs(math.sqrt(max(residual_power, 1e-18)))
    return out


def _residual_power(
    x: np.ndarray, sr: int, window: np.ndarray, low_hz: float, high_hz: float
) -> float:
    """扣除两支音所在窄带后剩下的功率, 带内能量按正弦功率归一化回时域尺度."""
    n = len(x)
    nfft = 1
    while nfft < max(2048, n * 8):
        nfft *= 2
    spec = np.fft.rfft(x * window, n=nfft)
    power = np.abs(spec) ** 2
    freqs = np.fft.rfftfreq(nfft, d=1.0 / sr)
    # 窗能量归一化: 白噪经过该窗后 单边谱 的期望 |X|^2 = σ² · Σw² · nfft/2
    win_energy = float(np.sum(window * window))
    scale = total_time_scale(n, nfft, win_energy)
    excluded = np.zeros_like(freqs, dtype=bool)
    for f in (low_hz, high_hz):
        excluded |= np.abs(freqs - f) <= max(60.0, 6.0 * sr / n)
    residual = float(np.sum(power[~excluded])) / scale
    return max(residual, 1e-18)


def total_time_scale(n: int, nfft: int, win_energy: float) -> float:
    """把单边功率谱求和换算成时域均方值的系数."""
    return max(win_energy * nfft / 2.0, 1e-18)


def evaluate_segment(
    samples: np.ndarray,
    sr: int,
    start_s: float,
    end_s: float,
    settings: DetectionSettings,
    *,
    duration: float | None = None,
    core_start_s: float | None = None,
    core_end_s: float | None = None,
) -> SegmentAnalysis:
    """对一个候选区间给出判读结论和书面理由.

    start_s/end_s 是汇报给用户的起止位置; core_start_s/core_end_s 是实际取指标用的
    子区间 (去掉起落沿), 缺省与起止一致. duration 给定时用它作为"按键时长", 否则
    按 end_s - start_s 计算.
    """
    start_s = max(0.0, start_s)
    end_s = min(len(samples) / sr, end_s)
    dur = max(end_s - start_s, 0.0) if duration is None else max(float(duration), 0.0)
    a = int(round(start_s * sr))
    b = int(round(end_s * sr))
    if b - a < 4:
        return SegmentAnalysis(
            start_s, end_s, None, "reject", "too_short", "候选区间过短, 没有足够样本做判读"
        )
    ca = a if core_start_s is None else int(round(core_start_s * sr))
    cb = b if core_end_s is None else int(round(core_end_s * sr))
    ca = max(0, min(ca, len(samples)))
    cb = max(ca, min(cb, len(samples)))
    if cb - ca < 16:
        ca, cb = a, b
    core = samples[ca:cb].astype(np.float64)
    metrics = analyze_core(core, sr, settings)
    low: ToneReading = metrics["low"]  # type: ignore[assignment]
    high: ToneReading = metrics["high"]  # type: ignore[assignment]
    snr = float(metrics["snr_db"])
    share = float(metrics["tone_share"])
    twist = float(metrics["twist_db"])
    notes: list[str] = []

    key = None
    low_silent = low.prominence_db < settings.tone_prominence_db or low.amplitude < 1e-3
    high_silent = high.prominence_db < settings.tone_prominence_db or high.amplitude < 1e-3

    reason_code = "ok"
    verdict: Verdict = "accept"
    if dur * 1000.0 < settings.min_key_ms:
        verdict, reason_code = "reject", "too_short"
    elif low_silent and high_silent:
        verdict, reason_code = "reject", "no_tone"
    elif low_silent or high_silent:
        verdict, reason_code = "reject", "missing_component"
    else:
        key = _key_from_readings(low, high)
        if abs(low.offset_hz) > low.tolerance_hz or abs(high.offset_hz) > high.tolerance_hz:
            verdict, reason_code = "reject", "off_frequency"
        elif abs(twist) > settings.max_twist_db:
            weak, strong = ("低频组", "高频组") if twist > 0 else ("高频组", "低频组")
            if min(low.amplitude, high.amplitude) < settings.min_component_amplitude:
                verdict, reason_code = "reject", "missing_component"
            else:
                verdict, reason_code = "reject", "twist"
                notes.append(f"{weak}比{strong}弱 {abs(twist):.1f} dB, 超过 {settings.max_twist_db:.1f} dB")
        elif snr < settings.min_snr_db:
            verdict, reason_code = "reject", "noisy"
        elif low.amplitude < settings.min_component_amplitude or high.amplitude < settings.min_component_amplitude:
            verdict, reason_code = "reject", "weak"

        if verdict == "accept":
            # 所有指标都过了硬门槛后再看是否"擦边", 擦边就降级成待核对
            review_bits: list[str] = []
            for reading, group_name in ((low, "低频组"), (high, "高频组")):
                ratio = abs(reading.offset_hz) / reading.tolerance_hz if reading.tolerance_hz else 0.0
                if ratio > settings.review_offset_ratio:
                    review_bits.append(
                        f"{group_name} {reading.peak_hz:.1f} Hz 偏离标称 {reading.nominal:.0f} Hz "
                        f"{reading.offset_hz:+.1f} Hz (容差 {reading.tolerance_hz:.1f} Hz)"
                    )
            if abs(twist) > settings.review_twist_db:
                review_bits.append(f"两支音相差 {abs(twist):.1f} dB, 接近上限 {settings.max_twist_db:.1f} dB")
            if snr < settings.review_snr_db:
                review_bits.append(f"纯音占比 {share * 100:.0f}%, 背景偏高 ({snr:.1f} dB)")
            if dur * 1000.0 < settings.min_key_ms * 1.15:
                review_bits.append(f"时长 {dur * 1000:.0f} ms, 贴近最短门限 {settings.min_key_ms:.0f} ms")
            if review_bits:
                verdict = "review"
                reason_code = "near_limit"
                notes.extend(review_bits)

    detail = _compose_detail(key, dur, low, high, snr, share, twist, reason_code, verdict, notes)
    return SegmentAnalysis(
        start_s=start_s,
        end_s=end_s,
        key=key,
        verdict=verdict,
        reason_code=reason_code,
        reason=REASON_LABEL.get(reason_code, reason_code),
        low=low,
        high=high,
        snr_db=snr,
        tone_share=share,
        twist_db=twist,
        rms_dbfs=float(metrics["rms_dbfs"]),
        notes=notes,
        detail=detail,
    )


def _key_from_readings(low: ToneReading, high: ToneReading) -> str | None:
    for key, (lf, hf) in KEYPAD.items():
        if abs(lf - low.nominal) < 1e-6 and abs(hf - high.nominal) < 1e-6:
            return key
    return None


def _compose_detail(
    key: str | None,
    dur: float,
    low: ToneReading,
    high: ToneReading,
    snr: float,
    share: float,
    twist: float,
    reason_code: str,
    verdict: Verdict,
    notes: list[str],
) -> str:
    parts = [
        f"时长 {dur * 1000:.0f} ms",
        f"低组 {low.peak_hz:.1f} Hz (标称 {low.nominal:.0f}, 偏差 {low.offset_hz:+.1f} Hz, 振幅 {low.amplitude:.3f}, 突出 {low.prominence_db:.1f} dB)",
        f"高组 {high.peak_hz:.1f} Hz (标称 {high.nominal:.0f}, 偏差 {high.offset_hz:+.1f} Hz, 振幅 {high.amplitude:.3f}, 突出 {high.prominence_db:.1f} dB)",
        f"强弱差 {twist:+.1f} dB, 纯音占比 {share * 100:.0f}%, 信噪比 {snr:.1f} dB",
    ]
    head = f"判为键 {key!r}" if key else "未构成有效键"
    if verdict == "reject":
        tail = f"拒绝原因: {REASON_LABEL.get(reason_code, reason_code)}"
    elif verdict == "review":
        tail = "通过门槛但需人工核对"
    else:
        tail = "判读通过"
    text = f"{head}; " + "; ".join(parts) + f". {tail}."
    if notes:
        text += " 备注: " + "; ".join(notes) + "."
    return text


def _activation_threshold(levels: np.ndarray, settings: DetectionSettings) -> float:
    """从一组短时电平里算"这一段算有声"的门限.

    两条线取较大者:
    * 峰值往下退 activation_depth_db —— 干净录音靠这条把空白和按键分开;
    * 底噪往上抬 silence_margin_db —— 背景声很重时靠这条把噪声底排除在外.
    两条都算完再压到峰值以下至少 3 dB, 否则整段电平恒定的声音会被判成"没有声音".
    """
    if len(levels) == 0:
        return settings.absolute_floor_dbfs
    # 按键在一段录音里通常只占几个百分点, 用 95 分位会把"峰值"估成底噪; 取 99 分位,
    # 仍能躲开单个异常尖峰, 又能抓住稀疏的按键.
    peak = float(np.percentile(levels, 99))
    floor = float(np.percentile(levels, 10))
    if not np.isfinite(peak):
        peak = -120.0
    if not np.isfinite(floor):
        floor = -120.0
    threshold = max(
        peak - settings.activation_depth_db,
        floor + settings.silence_margin_db,
    )
    threshold = min(threshold, peak - 3.0)
    return max(settings.absolute_floor_dbfs, threshold)


def _frame_levels(samples: np.ndarray, sr: int, settings: DetectionSettings) -> tuple[np.ndarray, np.ndarray, float, float]:
    """逐帧短时能量 (给界面画曲线用), 以及该曲线上的有声门限与底噪估计."""
    frame_len = max(16, int(round(sr * settings.frame_ms / 1000.0)))
    hop = max(1, int(round(sr * settings.hop_ms / 1000.0)))
    times, levels = _moving_rms_db(samples, frame_len, hop, sr)
    floor = float(np.percentile(levels, 10)) if len(levels) else -120.0
    if not np.isfinite(floor):
        floor = -120.0
    return levels, times, _activation_threshold(levels, settings), floor


def _moving_rms_db(
    samples: np.ndarray, win: int, hop: int, sr: int
) -> tuple[np.ndarray, np.ndarray]:
    """滑动窗均方根 (dBFS) 与窗中心时刻, 用前缀和实现, 长录音也很快."""
    data = np.asarray(samples, dtype=np.float64)
    win = max(1, win)
    if len(data) < win:
        data = np.pad(data, (0, win - len(data)))
    csum = np.concatenate(([0.0], np.cumsum(data * data)))
    means = (csum[win:] - csum[:-win]) / win
    means = means[::hop]
    if len(means) == 0:
        means = np.array([float(np.mean(data * data))])
    levels = 10.0 * np.log10(np.maximum(means, 1e-24))
    n = len(levels)
    times = (np.arange(n) * hop + win / 2.0) / sr
    return times, levels


def _fine_envelope(
    samples: np.ndarray, sr: int, settings: DetectionSettings
) -> tuple[np.ndarray, np.ndarray]:
    """高分辨率能量包络, 用来把按键起止和极短空白量到毫秒级.

    帧级 30 毫秒窗 + 10 毫秒帧移太粗, 20 毫秒的松手在包络上会被抹平; 判时长和
    "到底松没松开"需要另一套细包络.
    """
    win = max(8, int(round(sr * settings.envelope_ms / 1000.0)))
    hop = max(1, int(round(sr * settings.envelope_hop_ms / 1000.0)))
    return _moving_rms_db(samples, win, hop, sr)


def _envelope_threshold(levels: np.ndarray, settings: DetectionSettings) -> float:
    """细包络上的有声门限, 与帧级曲线用同一套规则."""
    return _activation_threshold(levels, settings)


def _active_runs(
    times: np.ndarray, levels: np.ndarray, settings: DetectionSettings
) -> list[tuple[float, float, float]]:
    """细包络上连续有声的区间, 返回 [(起秒, 止秒, 与前一段之间的空白毫秒)].

    空白短于 min_gap_ms 时当作同一段 (按键波形自身的抖动); 否则断开, 这样
    "确实松开了"的短停顿也能被单独看见, 交给后续的合并/待核对逻辑处理.
    """
    threshold = _envelope_threshold(levels, settings)
    active_idx = np.flatnonzero(levels >= threshold)
    if len(active_idx) == 0:
        return []
    runs: list[tuple[float, float, float]] = []
    start = int(active_idx[0])
    prev = int(active_idx[0])
    for idx in active_idx[1:]:
        idx = int(idx)
        gap_ms = (float(times[idx]) - float(times[prev])) * 1000.0
        if gap_ms <= settings.min_gap_ms:
            prev = idx
            continue
        runs.append((float(times[start]), float(times[prev]), float("inf")))
        start = prev = idx
    runs.append((float(times[start]), float(times[prev]), float("inf")))
    # 相邻两段之间的空白 = 后段起点 - 前段终点 (来自同一张包络, 系统偏差一致)
    for k in range(1, len(runs)):
        runs[k] = (runs[k][0], runs[k][1], (runs[k][0] - runs[k - 1][1]) * 1000.0)
    return runs


def _is_noise_blip(seg: SegmentAnalysis, settings: DetectionSettings) -> bool:
    """判断一个候选是否只是底噪抖动出来的碎片.

    条件: 时长短于最短键的一半, 两支音至少有一支不突出, 且整体电平也低 (纯音占比
    很低). 满足就视为噪声, 不作为"被拒绝的候选"列出, 免得背景声大的录音在清单里
    堆出几十条几毫秒的噪声碎片. 真的短键 (哪怕只有十来毫秒) 两支音仍会很突出,
    所以不会被这里吞掉.
    """
    if seg.duration_ms >= 0.5 * settings.min_key_ms:
        return False
    low_quiet = seg.low is None or seg.low.prominence_db < settings.tone_prominence_db
    high_quiet = seg.high is None or seg.high.prominence_db < settings.tone_prominence_db
    return low_quiet and high_quiet


def _blip_core_window(t0: float, t1: float, settings: DetectionSettings) -> float:
    """极短候选在让步段判读时用的最小核心长度 (秒).

    十几毫秒的键本身还有起落沿, 若按比例一裁就只剩几个样本, 频率分辨率和突出度
    都会崩. 对短于分析窗的候选, 不裁边沿, 直接用整段做判读.
    """
    dur = t1 - t0
    if dur <= settings.frame_ms / 1000.0:
        return 0.0
    return min(settings.edge_trim_ms / 1000.0, 0.3 * dur)


def detect(samples: np.ndarray, sr: int, settings: DetectionSettings) -> DetectionResult:
    settings.validate()
    samples = np.asarray(samples, dtype=np.float64)
    if samples.ndim != 1:
        raise ValueError("只支持单声道数据")
    levels, times, threshold, floor = _frame_levels(samples, sr, settings)

    # 起止和空白必须在细包络上量: 30ms 窗 + 10ms 帧移的显示帧会把 20ms 的松手抹平.
    # 帧级粗包络只用于界面画能量曲线和门限, 判读全部基于细包络切出来的段.
    fine_times, fine_levels = _fine_envelope(samples, sr, settings)
    runs = _active_runs(fine_times, fine_levels, settings)

    # 包络时间戳是窗口中心; 首末个越过门限的中心点与真实起止的偏差在同一条包络上
    # 是对称的, 相邻两段相减得到的空白会自然抵消, 所以直接用中心时刻, 不再补偿.
    spans: list[tuple[float, float, float]] = []
    prev_end: float | None = None
    for t0, t1, _gap in runs:
        if t1 <= t0:
            continue
        gap_ms = float("inf") if prev_end is None else (t0 - prev_end) * 1000.0
        spans.append((t0, t1, gap_ms))
        prev_end = t1

    # 段级判读: 认不认键完全由这一段自身决定.
    # 边界那一两毫秒是"前键尾巴 + 后键开头 + 空白"的混合体, 指标会失真; 越短的段越
    # 要多裁一些, 否则 30~40 ms 的键会被这段混合体拖出偏频/低信噪比.
    analyses: list[SegmentAnalysis] = []
    gaps_ms: list[float] = []
    for t0, t1, gap_ms in spans:
        dur = t1 - t0
        head = _blip_core_window(t0, t1, settings)
        seg = evaluate_segment(
            samples,
            sr,
            t0,
            t1,
            settings,
            duration=dur,
            core_start_s=t0 + head,
            core_end_s=t1 - head,
        )
        # 底噪很重时, 包络会在门限上下抖出许多几毫秒的碎片; 它们既短又听不出两支音,
        # 不是"被拒绝的按键候选", 只是噪声, 直接丢弃, 免得清单被灌满无意义的过短项.
        if _is_noise_blip(seg, settings):
            continue
        analyses.append(seg)
        gaps_ms.append(gap_ms)

    # 同键合并: 只有实测空白小于最小可分辨时长才合并, 否则两次同键就是两次.
    order = sorted(range(len(analyses)), key=lambda i: analyses[i].start_s)
    merged: list[SegmentAnalysis] = []
    merged_gap: list[float] = []
    rejected: list[SegmentAnalysis] = []
    for i in order:
        seg = analyses[i]
        gap_ms = gaps_ms[i]
        if seg.verdict == "reject":
            rejected.append(seg)
            continue
        if merged and seg.key == merged[-1].key and gap_ms < settings.min_release_ms:
            prev = merged[-1]
            prev.end_s = seg.end_s
            prev.merged_from += 1
            prev.verdict = "review"
            if prev.reason_code == "ok":
                prev.reason_code = "merged_hold"
                prev.reason = REASON_LABEL["merged_hold"]
            note = (
                f"两次 {seg.key!r} 之间只有 {max(gap_ms, 0):.0f} ms 空白, "
                f"短于可分辨的 {settings.min_release_ms:.0f} ms, 已合并为一次按住"
            )
            if note not in prev.notes:
                prev.notes.append(note)
            prev.detail = prev.detail.rstrip(".") + " 备注: " + note + "."
            continue
        merged.append(seg)
        merged_gap.append(gap_ms)

    # 相邻不同键但实测空白太短: 两条都降为待核对, 提示边界不可信.
    for k in range(1, len(merged)):
        gap_ms = merged_gap[k]
        if gap_ms < settings.min_release_ms:
            note = (
                f"与相邻键的空白仅 {max(gap_ms, 0):.0f} ms, "
                f"短于可分辨的 {settings.min_release_ms:.0f} ms, 边界待核对"
            )
            for item in (merged[k - 1], merged[k]):
                if item.verdict == "accept":
                    item.verdict = "review"
                    if item.reason_code == "ok":
                        item.reason_code = "tight_gap"
                        item.reason = REASON_LABEL["tight_gap"]
                if note not in item.notes:
                    item.notes.append(note)
                item.detail = item.detail.rstrip(".") + " 备注: " + note + "."

    rejected.sort(key=lambda s: s.start_s)
    return DetectionResult(
        settings=settings,
        sample_rate=sr,
        duration_s=len(samples) / sr,
        accepted=merged,
        rejected=rejected,
        frame_times=times.tolist(),
        frame_level_db=levels.tolist(),
        active_threshold_db=threshold,
        noise_floor_db=floor,
    )


def frame_readout(
    samples: np.ndarray, sr: int, t: float, settings: DetectionSettings, window_ms: float | None = None
) -> SegmentAnalysis:
    """光标处的频率读数: 以 t 为中心取一窗, 按同一套判读逻辑给出结论."""
    win_ms = window_ms if window_ms is not None else settings.frame_ms
    n = max(16, int(round(sr * win_ms / 1000.0)))
    center = int(round(t * sr))
    a = max(0, center - n // 2)
    b = min(len(samples), a + n)
    a = max(0, b - n)
    chunk = np.asarray(samples[a:b], dtype=np.float64)
    metrics = analyze_core(chunk, sr, settings)
    low: ToneReading = metrics["low"]  # type: ignore[assignment]
    high: ToneReading = metrics["high"]  # type: ignore[assignment]
    low_silent = low.prominence_db < settings.tone_prominence_db
    high_silent = high.prominence_db < settings.tone_prominence_db
    key = None
    if low_silent and high_silent:
        verdict, code = "reject", "no_tone"
        reason = "这一小段没有突出的单音, 只有背景"
    elif low_silent or high_silent:
        verdict, code = "reject", "missing_component"
        present = high if low_silent else low
        missing = "低频组" if low_silent else "高频组"
        reason = f"只听到 {present.peak_hz:.0f} Hz 一支音, 缺少{missing}音"
    else:
        key = _key_from_readings(low, high)
        if abs(low.offset_hz) > low.tolerance_hz or abs(high.offset_hz) > high.tolerance_hz:
            verdict, code = "reject", "off_frequency"
            reason = (
                f"峰值 {low.peak_hz:.1f}/{high.peak_hz:.1f} Hz 与最近标称 "
                f"{low.nominal:.0f}/{high.nominal:.0f} Hz 偏差超过容差"
            )
        elif abs(float(metrics["twist_db"])) > settings.max_twist_db:
            verdict, code = "reject", "twist"
            reason = f"两支音强弱差 {abs(float(metrics['twist_db'])):.1f} dB, 超过上限"
        elif float(metrics["snr_db"]) < settings.min_snr_db:
            verdict, code = "reject", "noisy"
            reason = "纯音能量被背景声压低, 信噪比不足"
        else:
            verdict, code = "accept", "ok"
            reason = f"两支音齐全, 判为键 {key!r}"
            # 读数窗按设计就比一键短, 所以不套用"最短按键"门槛; 只提示频率擦边.
            if abs(low.offset_hz) > settings.review_offset_ratio * low.tolerance_hz or abs(
                high.offset_hz
            ) > settings.review_offset_ratio * high.tolerance_hz:
                verdict, code = "review", "near_limit"
                reason = f"可判为键 {key!r}, 但频率偏差已接近容差"
            elif abs(float(metrics["snr_db"])) < settings.review_snr_db or abs(
                float(metrics["twist_db"])
            ) > settings.review_twist_db:
                verdict, code = "review", "near_limit"
                reason = f"可判为键 {key!r}, 但强弱/背景接近门限"
    return SegmentAnalysis(
        start_s=a / sr,
        end_s=b / sr,
        key=key,
        verdict=verdict,  # type: ignore[arg-type]
        reason_code=code,
        reason=reason,
        low=low,
        high=high,
        snr_db=float(metrics["snr_db"]),
        tone_share=float(metrics["tone_share"]),
        twist_db=float(metrics["twist_db"]),
        rms_dbfs=float(metrics["rms_dbfs"]),
    )


def spectrum_at(
    samples: np.ndarray, sr: int, t: float, window_ms: float = 60.0
) -> tuple[np.ndarray, np.ndarray]:
    """给界面用的频谱: 不加判读, 就是窗内幅度谱."""
    n = max(32, int(round(sr * window_ms / 1000.0)))
    center = int(round(t * sr))
    a = max(0, center - n // 2)
    b = min(len(samples), a + n)
    a = max(0, b - n)
    chunk = np.asarray(samples[a:b], dtype=np.float64)
    chunk = chunk - float(np.mean(chunk)) if len(chunk) else chunk
    window = _prepare_window(len(chunk)) if len(chunk) >= 2 else np.ones(len(chunk))
    nfft = 1
    while nfft < max(2048, len(chunk) * 8):
        nfft *= 2
    mag = np.abs(np.fft.rfft(chunk * window, n=nfft))
    freqs = np.fft.rfftfreq(nfft, d=1.0 / sr)
    denom = float(np.sum(window)) if len(window) else 1.0
    mag = mag * 2.0 / max(denom, 1e-9)
    return freqs, mag


def settings_as_dict(settings: DetectionSettings) -> dict:
    return asdict(settings)


def export_segments_csv(path: str, result: DetectionResult) -> None:
    """导出键和时间清单, 含被拒绝候选及原因, 并区分确定/待核对."""
    import csv

    with open(path, "w", newline="", encoding="utf-8-sig") as fh:
        writer = csv.writer(fh)
        writer.writerow(
            [
                "序号",
                "类别",
                "按键",
                "状态",
                "开始秒",
                "结束秒",
                "时长毫秒",
                "低组峰值Hz",
                "低组标称Hz",
                "低组偏差Hz",
                "高组峰值Hz",
                "高组标称Hz",
                "高组偏差Hz",
                "强弱差dB",
                "纯音占比",
                "信噪比dB",
                "原因代码",
                "原因",
                "备注",
            ]
        )
        for i, seg in enumerate(result.all_segments(), start=1):
            kind = "拒绝候选" if seg.verdict == "reject" else "按键"
            writer.writerow(
                [
                    i,
                    kind,
                    seg.key or "",
                    seg.status_label,
                    f"{seg.start_s:.3f}",
                    f"{seg.end_s:.3f}",
                    f"{seg.duration_ms:.1f}",
                    f"{seg.low.peak_hz:.1f}" if seg.low else "",
                    f"{seg.low.nominal:.0f}" if seg.low else "",
                    f"{seg.low.offset_hz:+.1f}" if seg.low else "",
                    f"{seg.high.peak_hz:.1f}" if seg.high else "",
                    f"{seg.high.nominal:.0f}" if seg.high else "",
                    f"{seg.high.offset_hz:+.1f}" if seg.high else "",
                    f"{seg.twist_db:+.1f}",
                    f"{seg.tone_share:.3f}",
                    f"{seg.snr_db:.1f}",
                    seg.reason_code,
                    seg.reason,
                    " | ".join(seg.notes),
                ]
            )


def export_result_json(
    path: str,
    result: DetectionResult,
    *,
    history: list[dict] | None = None,
) -> None:
    import json

    payload = {
        "generated_at": __import__("datetime").datetime.now().isoformat(timespec="seconds"),
        "sample_rate": result.sample_rate,
        "duration_s": round(result.duration_s, 4),
        "settings": settings_as_dict(result.settings),
        "keys": result.keys,
        "accepted": [_seg_to_dict(s) for s in result.accepted],
        "rejected": [_seg_to_dict(s) for s in result.rejected],
        "runs": history or [],
    }
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)


def _seg_to_dict(seg: SegmentAnalysis) -> dict:
    data = {
        "start_s": round(seg.start_s, 4),
        "end_s": round(seg.end_s, 4),
        "duration_ms": round(seg.duration_ms, 2),
        "key": seg.key,
        "verdict": seg.verdict,
        "status": seg.status_label,
        "reason_code": seg.reason_code,
        "reason": seg.reason,
        "snr_db": round(seg.snr_db, 2),
        "tone_share": round(seg.tone_share, 4),
        "twist_db": round(seg.twist_db, 2),
        "rms_dbfs": round(seg.rms_dbfs, 2),
        "notes": seg.notes,
        "detail": seg.detail,
        "merged_from": seg.merged_from,
    }
    for group in ("low", "high"):
        reading: ToneReading | None = getattr(seg, group)
        if reading is not None:
            data[group] = {
                "peak_hz": round(reading.peak_hz, 2),
                "nominal_hz": reading.nominal,
                "offset_hz": round(reading.offset_hz, 2),
                "amplitude": round(reading.amplitude, 5),
                "prominence_db": round(reading.prominence_db, 2),
                "tolerance_hz": round(reading.tolerance_hz, 2),
            }
        else:
            data[group] = None
    return data


def run_to_dict(run: "DetectionRun") -> dict:
    return {
        "label": run.label,
        "created_at": run.created_at,
        "audio_name": run.audio_name,
        "settings": settings_as_dict(run.result.settings),
        "keys": run.result.keys,
        "accepted": [_seg_to_dict(s) for s in run.result.accepted],
        "rejected": [_seg_to_dict(s) for s in run.result.rejected],
    }


@dataclass
class DetectionRun:
    label: str
    created_at: str
    audio_name: str
    result: DetectionResult

    def summary(self) -> str:
        confirmed = len(self.result.confirmed)
        review = len(self.result.review)
        rejected = len(self.result.rejected)
        return f"{self.label}: 确定 {confirmed} / 待核对 {review} / 拒绝候选 {rejected}"


@dataclass
class DiffEntry:
    kind: Literal["same", "new", "lost", "changed", "moved"]
    key: str | None
    current: SegmentAnalysis | None
    previous: SegmentAnalysis | None
    note: str = ""


def _overlap(a0: float, a1: float, b0: float, b1: float) -> float:
    inter = max(0.0, min(a1, b1) - max(a0, b0))
    union = max(a1, b1) - min(a0, b0)
    return inter / union if union > 0 else 0.0


def diff_results(current: DetectionResult, previous: DetectionResult) -> list[DiffEntry]:
    """比较两次识别, 重点标出旧结果里有、新结果里丢掉的段落."""
    entries: list[DiffEntry] = []
    used_prev: set[int] = set()
    for cur in current.accepted:
        best_i, best_iou = None, 0.0
        for i, prev in enumerate(previous.accepted):
            if i in used_prev:
                continue
            iou = _overlap(cur.start_s, cur.end_s, prev.start_s, prev.end_s)
            if iou > best_iou:
                best_i, best_iou = i, iou
        if best_i is not None and best_iou >= 0.3:
            prev = previous.accepted[best_i]
            used_prev.add(best_i)
            if prev.key == cur.key:
                if abs(cur.start_s - prev.start_s) > 0.03 or abs(cur.end_s - prev.end_s) > 0.03:
                    entries.append(DiffEntry("moved", cur.key, cur, prev, "时间边界变化"))
                else:
                    entries.append(DiffEntry("same", cur.key, cur, prev))
            else:
                entries.append(
                    DiffEntry(
                        "changed",
                        cur.key,
                        cur,
                        prev,
                        f"旧结果判为 {prev.key!r}, 新结果判为 {cur.key!r}",
                    )
                )
        else:
            entries.append(DiffEntry("new", cur.key, cur, None, "本次新识别"))
    for i, prev in enumerate(previous.accepted):
        if i not in used_prev:
            entries.append(DiffEntry("lost", prev.key, None, prev, "旧结果有, 本次没识别到"))
    return entries


def diff_summary(entries: list[DiffEntry]) -> str:
    counts = {"same": 0, "new": 0, "lost": 0, "changed": 0, "moved": 0}
    for entry in entries:
        counts[entry.kind] += 1
    bits = []
    if counts["new"]:
        bits.append(f"新增 {counts['new']}")
    if counts["lost"]:
        bits.append(f"丢失 {counts['lost']}")
    if counts["changed"]:
        bits.append(f"改判 {counts['changed']}")
    if counts["moved"]:
        bits.append(f"边界移动 {counts['moved']}")
    if not bits:
        return "与旧结果一致"
    return ", ".join(bits) + f"; 相同 {counts['same']}"


# 供界面下拉框使用
KEY_CHOICES = list(KEY_ORDER)
