"""单音音高估计。

算法（每帧）：
1. Hann 窗加窗后算 RMS、频谱平坦度（噪声指标）和自相关；
2. 在分析音域 [fmin, fmax] 内找自相关峰，抛物线插值做亚采样精修；
3. 对峰候选以及主候选的 f/2、2f 做“谐波能量评分”，
   综合得分 = 0.6 * 自相关峰高 + 0.4 * 谐波评分；
4. 起音 / 音量过小 / 噪声过大 / 得分不足 / 八度分差太小 等情况标成不确定；
5. 不可靠帧的 f0 为 NaN，绘图时留缺口，绝不跨缺口连线。

频率是客观测量值，基准音高 A4 不参与这里的任何计算。
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy.signal import fftconvolve


@dataclass(frozen=True)
class AnalysisParams:
    fmin: float = 65.0            # 分析音域下限 Hz
    fmax: float = 1400.0          # 分析音域上限 Hz
    frame_ms: float = 46.0        # 帧长（毫秒）
    hop_ms: float = 10.0          # 帧移（毫秒）
    rms_floor: float = 0.012      # 低于该 RMS 视为音量过小
    noise_floor: float = 0.32     # 频谱平坦度高于该值视为偏噪
    score_floor: float = 0.45     # 综合可信分阈值
    octave_margin: float = 0.08   # 主候选与八度候选分差小于它 → 八度存疑
    onset_ms: float = 45.0        # 起音保护时长


@dataclass
class Candidate:
    freq: float          # Hz（客观频率，与 A4 无关）
    ac_peak: float       # 该周期对应的归一化自相关峰高
    harm_score: float    # 谐波能量评分 0..1
    score: float         # 综合分
    source: str          # 'ac' / 'sub' / 'oct'
    f_support: float = 0.0  # 基频谱支持度（相对 2f 处能量）


@dataclass
class FrameResult:
    t: float                 # 帧中心时间 s
    rms: float
    flatness: float          # 频谱平坦度 0..1，越大越像噪声
    f0: float                # 可靠时为 Hz，否则 NaN（缺口）
    f0_est: float            # 不受门槛限制的估计值（不确定时也可能有）
    confidence: float        # 主候选综合分 0..1
    reliable: bool
    uncertain: bool          # reliable=False 但仍有 f0_est 时为 True
    reason: str              # 不确定 / 不可靠的原因，可靠时为 ''
    is_onset: bool
    candidates: list[Candidate]


@dataclass
class AnalysisResult:
    frames: list[FrameResult]
    times: np.ndarray
    f0: np.ndarray              # 不可靠处为 NaN —— 绘图和导出都靠它留缺口
    f0_est: np.ndarray          # 不受门槛限制的估计值（不确定帧也可能有，NaN=完全无估计）
    confidence: np.ndarray
    reliable: np.ndarray       # bool
    uncertain: np.ndarray      # bool
    rms: np.ndarray
    flatness: np.ndarray
    params: AnalysisParams

    @property
    def duration(self) -> float:
        return float(self.times[-1]) if len(self.times) else 0.0

    def frame_at(self, t: float) -> FrameResult | None:
        if not len(self.times):
            return None
        i = int(np.argmin(np.abs(self.times - t)))
        return self.frames[i]


def _spectral_flatness(mag: np.ndarray, min_mag: float) -> float:
    """几何均值 / 算术均值；纯噪声接近 1，纯谐波接近 0。"""
    m = mag[mag > min_mag]
    if m.size < 4:
        return 1.0
    gm = np.exp(np.mean(np.log(m)))
    am = np.mean(m)
    return float(np.clip(gm / (am + 1e-12), 0.0, 1.0))


def _harmonic_score(frame: np.ndarray, f: float, fs: int) -> float:
    """谐波能量占比：f, 2f, 3f... 附近的能量 / 总能量。"""
    n = frame.size
    if not np.isfinite(f) or f <= 0:
        return 0.0
    window = np.hanning(n)
    spec = np.abs(np.fft.rfft(frame * window))
    freqs = np.fft.rfftfreq(n, 1.0 / fs)
    total = float(np.sum(spec) + 1e-12)
    band = max(2.0, fs / n * 1.5)  # 约一个 FFT bin 半宽
    harm = 0.0
    k = 1
    while k * f < fs * 0.45:
        lo = max(0.0, k * f - band)
        hi = min(fs * 0.5, k * f + band)
        sel = (freqs >= lo) & (freqs <= hi)
        harm += float(np.sum(spec[sel]))
        k += 1
    return float(np.clip(harm / total, 0.0, 1.0))


def _fundamental_support(frame: np.ndarray, f: float, fs: int) -> float:
    """f 作为基频在频谱上获得的支持度（相对其二次谐波处的能量）。

    若 f 是真实基频，f 附近应有可测能量；若 f 只是高真实基频的
    “低八度假想”，f 附近会落在谐波间隙里而几乎没有能量。
    """
    n = frame.size
    spec = np.abs(np.fft.rfft(frame * np.hanning(n)))
    freqs = np.fft.rfftfreq(n, 1.0 / fs)
    bin_w = fs / n
    band = max(2.0, bin_w * 1.5)

    def band_energy(center: float) -> float:
        lo, hi = max(0.0, center - band), min(fs * 0.5, center + band)
        return float(np.sum(spec[(freqs >= lo) & (freqs <= hi)]))

    e1 = band_energy(f)
    e2 = band_energy(2.0 * f)
    return float(e1 / (e2 + 1e-12))


def _parabolic_peak(ac: np.ndarray, idx: int) -> tuple[float, float]:
    """自相关峰的抛物线插值，返回 (精修 lag, 精修峰高)。"""
    if 0 < idx < ac.size - 1:
        a, b, c = ac[idx - 1], ac[idx], ac[idx + 1]
        denom = a - 2.0 * b + c
        delta = 0.5 * (a - c) / denom if abs(denom) > 1e-12 else 0.0
        delta = float(np.clip(delta, -1.0, 1.0))
        peak = b - 0.25 * (a - c) * delta
        return idx + delta, float(peak)
    return float(idx), float(ac[idx])


def _ac_peaks(ac: np.ndarray, lag_min: int, lag_max: int) -> list[tuple[float, float]]:
    """自相关在 [lag_min, lag_max] 内的局部极大值，按峰高排序。"""
    lag_max = min(lag_max, ac.size - 2)
    peaks: list[tuple[float, float]] = []
    if lag_max <= lag_min:
        return peaks
    seg = ac[lag_min:lag_max + 1]
    for j in range(1, seg.size - 1):
        if seg[j] > seg[j - 1] and seg[j] >= seg[j + 1] and seg[j] > 0.05:
            lag, peak = _parabolic_peak(ac, lag_min + j)
            peaks.append((lag, peak))
    peaks.sort(key=lambda p: p[1], reverse=True)
    return peaks


def analyze(x: np.ndarray, fs: int, params: AnalysisParams) -> AnalysisResult:
    """对单声道浮点信号做逐帧音高分析。"""
    x = np.asarray(x, dtype=float)
    if x.ndim != 1:
        raise ValueError("analyze 只接受单声道一维信号")

    n_frame = max(256, int(round(fs * params.frame_ms / 1000.0)))
    n_hop = max(64, int(round(fs * params.hop_ms / 1000.0)))
    lag_min = max(1, int(fs / params.fmax))
    lag_max = min(n_frame - 2, int(np.ceil(fs / params.fmin)))
    n_fft = 1
    while n_fft < 2 * n_frame:
        n_fft *= 2
    onset_n = max(1, int(round(params.onset_ms / params.hop_ms)))

    # RMS 包络（未加窗）用于起音判定
    starts = list(range(0, max(1, x.size - n_frame + 1), n_hop))
    if not starts:
        starts = [0]
    rms_env = np.array([
        float(np.sqrt(np.mean(x[s:s + n_frame] ** 2) + 1e-12)) for s in starts
    ])
    rms_med = float(np.median(rms_env)) if rms_env.size else 0.0
    rms_prev = np.concatenate(([rms_env[0]], rms_env[:-1]))

    frames: list[FrameResult] = []
    for i, s in enumerate(starts):
        frame = x[s:s + n_frame]
        if frame.size < n_frame:
            frame = np.pad(frame, (0, n_frame - frame.size))
        t = (s + n_frame / 2.0) / fs
        rms = float(np.sqrt(np.mean(frame ** 2) + 1e-12))

        window = np.hanning(n_frame)
        fw = frame * window
        spec = np.abs(np.fft.rfft(fw, n_fft))
        flatness = _spectral_flatness(spec, float(np.max(spec)) * 1e-5 + 1e-12)

        # 归一化自相关（能量归一，幅度不影响）
        ac = fftconvolve(fw, fw[::-1], mode="full")[n_frame - 1:]
        ac /= (ac[0] + 1e-12)
        peaks = _ac_peaks(ac, lag_min, lag_max)

        # 组装候选：自相关前 3 峰 + 主峰的八度上下假设
        cand_freqs: dict[float, Candidate] = {}

        def add_candidate(lag: float, peak: float, source: str) -> None:
            f = fs / lag
            if not (params.fmin * 0.5 <= f <= params.fmax * 2.0):
                return
            hs = _harmonic_score(frame, f, fs)
            score = 0.6 * peak + 0.4 * hs
            support = _fundamental_support(frame, f, fs)
            key = round(f, 3)
            old = cand_freqs.get(key)
            if old is None or score > old.score:
                cand_freqs[key] = Candidate(f, peak, hs, float(score), source,
                                            support)

        for lag, peak in peaks[:3]:
            add_candidate(lag, peak, "ac")
        if peaks:
            # 八度假设必须用各自 lag 处的真实自相关值，不能借用主峰高度
            lag0, _peak0 = peaks[0]
            for factor, src in ((2.0, "sub"), (0.5, "oct")):
                lag_alt = lag0 * factor
                if lag_min <= lag_alt <= lag_max:
                    idx = int(round(lag_alt))
                    if ac[idx] > 0.0:
                        add_candidate(float(lag_alt), float(ac[idx]), src)

        cands = sorted(cand_freqs.values(), key=lambda c: c.score, reverse=True)
        main = cands[0] if cands else None
        f_est = main.freq if main is not None else float("nan")
        conf = main.score if main is not None else 0.0

        # 起音：RMS 相对前一帧明显跃升，或位于信号最前段
        rising = i < onset_n or (
            rms_prev[i] > 1e-9 and rms > 1.8 * rms_prev[i] and rms > 0.5 * rms_med
        )

        reasons: list[str] = []
        if main is None:
            reasons.append("未检出周期性")
        if rms < params.rms_floor:
            reasons.append("音量过小")
        if flatness > params.noise_floor:
            reasons.append("偏噪(频谱平坦)")
        if main is not None and conf < params.score_floor:
            reasons.append(f"可信分不足({conf:.2f})")
        if rising and main is not None:
            reasons.append("起音段")

        # 八度争议判定（带物理依据）：
        # - 低八度候选只有在它声称的基频处确实有谱能量时才构成威胁，
        #   否则只是自相关的天然次峰，直接剔除；
        # - 高八度候选与主判断分差过小才算存疑。
        oct_dispute = False
        if main is not None:
            for c in cands[1:]:
                ratio = c.freq / main.freq
                if abs(ratio - 0.5) < 0.15:
                    if c.f_support >= 0.12 and \
                            main.score - c.score < params.octave_margin:
                        oct_dispute = True
                elif abs(ratio - 2.0) < 0.15:
                    if main.score - c.score < params.octave_margin:
                        oct_dispute = True
            if oct_dispute:
                reasons.append("八度存疑")

        reliable = main is not None and not reasons
        uncertain = main is not None and not reliable
        f0 = main.freq if reliable else float("nan")
        if not cands:
            cands = []

        frames.append(FrameResult(
            t=t, rms=rms, flatness=flatness, f0=f0, f0_est=f_est,
            confidence=float(conf), reliable=reliable, uncertain=uncertain,
            reason="；".join(reasons), is_onset=rising, candidates=cands,
        ))

    return AnalysisResult(
        frames=frames,
        times=np.array([fr.t for fr in frames]),
        f0=np.array([fr.f0 for fr in frames]),
        f0_est=np.array([fr.f0_est for fr in frames]),
        confidence=np.array([fr.confidence for fr in frames]),
        reliable=np.array([fr.reliable for fr in frames]),
        uncertain=np.array([fr.uncertain for fr in frames]),
        rms=np.array([fr.rms for fr in frames]),
        flatness=np.array([fr.flatness for fr in frames]),
        params=params,
    )
