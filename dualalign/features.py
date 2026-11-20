"""音频特征与匹配打分.

分析链:
    原始 wav (可不同采样率) -> 单声道 16 kHz -> 频带通 -> STFT -> 梅尔对数能量
    逐频带做时间维标准化, 逐帧去均值并 L2 归一化
    -> 每个 "待对齐录音窗口" 与参考录音所有可能起点做滑动余弦相似度
    -> 取若干局部峰作为候选对应关系

这里的所有时间量单位为秒, 帧索引与秒的换算统一由 :class:`FeatureSet` 负责。
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy import signal

from .audio import AudioClip

ANALYSIS_SR = 16_000
HOP_S = 0.01
NFFT = 512
N_MELS = 64
MEL_FMIN = 60.0
MEL_FMAX = 7_000.0


class AlignmentError(RuntimeError):
    """无法给出可靠对齐时抛出的用户可读错误。"""


def resample_to(x: np.ndarray, sr_in: int, sr_out: int = ANALYSIS_SR) -> np.ndarray:
    """有理数重采样; 输入为 float64 单声道。"""

    if abs(sr_in - sr_out) < 1e-9:
        return np.asarray(x, dtype=np.float64)
    g = int(np.gcd(int(sr_in), int(sr_out)))
    up = int(sr_out) // g
    down = int(sr_in) // g
    return signal.resample_poly(np.asarray(x, dtype=np.float64), up, down)


def band_limit(x: np.ndarray, sr: int = ANALYSIS_SR) -> np.ndarray:
    nyq = sr / 2.0
    hi = min(7_200.0, nyq * 0.92)
    lo = min(60.0, hi * 0.5)
    sos = signal.butter(4, [lo / nyq, hi / nyq], btype="band", output="sos")
    return signal.sosfilt(sos, np.asarray(x, dtype=np.float64))


def _hz_to_mel(f):
    return 2595.0 * np.log10(1.0 + np.asarray(f, dtype=np.float64) / 700.0)


def _mel_to_hz(m):
    return 700.0 * (10.0 ** (np.asarray(m, dtype=np.float64) / 2595.0) - 1.0)


def mel_filterbank(sr: int = ANALYSIS_SR, nfft: int = NFFT, n_mels: int = N_MELS,
                   fmin: float = MEL_FMIN, fmax: float = MEL_FMAX) -> np.ndarray:
    fmax = min(fmax, sr * 0.5 - 100.0)
    hz = _mel_to_hz(np.linspace(_hz_to_mel(fmin), _hz_to_mel(fmax), n_mels + 2))
    bins = np.floor((nfft + 1) * hz / sr).astype(np.int64)
    fb = np.zeros((n_mels, nfft // 2 + 1), dtype=np.float64)
    for i in range(n_mels):
        lo, ce, hi = int(bins[i]), int(bins[i + 1]), int(bins[i + 2])
        ce = max(ce, lo + 1)
        hi = max(hi, ce + 1)
        fb[i, lo:ce] = np.linspace(0.0, 1.0, ce - lo, endpoint=False)
        fb[i, ce:hi] = np.linspace(1.0, 0.0, hi - ce, endpoint=False)
    return fb


_FB = mel_filterbank()


@dataclass
class FeatureSet:
    """单个录音的分析特征。"""

    features: np.ndarray  # (frames, n_mels), 已逐帧归一化
    energy: np.ndarray  # (frames,), RMS 能量
    hop_s: float
    sr: int
    duration_s: float
    signal: np.ndarray  # 频带通后的 16 kHz 单声道信号, 用于波形级微调

    @property
    def frames(self) -> int:
        return int(self.features.shape[0])

    def time_of_frame(self, frame: int) -> float:
        return float(frame) * self.hop_s

    def frame_of_time(self, t: float) -> int:
        return int(round(float(t) / self.hop_s))


def extract_features(clip: AudioClip, sr: int = ANALYSIS_SR) -> FeatureSet:
    mono = resample_to(clip.mono(), clip.sample_rate, sr)
    sig = band_limit(mono, sr)
    hop = int(round(HOP_S * sr))
    _, _, z = signal.stft(
        sig,
        fs=sr,
        window="hann",
        nperseg=NFFT,
        noverlap=NFFT - hop,
        nfft=NFFT,
        boundary=None,
        padded=False,
    )
    power = np.abs(z) ** 2
    mel = np.log1p((power.T @ _FB.T) * 100.0)
    # 每个梅尔频带沿时间标准化: 抑制固定频谱形状, 突出随时间变化的内容
    mu = mel.mean(axis=0, keepdims=True)
    sd = mel.std(axis=0, keepdims=True) + 1e-6
    norm = np.clip((mel - mu) / sd, -3.0, 3.0)
    norm -= norm.mean(axis=1, keepdims=True)
    norm /= np.linalg.norm(norm, axis=1, keepdims=True) + 1e-9
    energy = np.sqrt(np.mean(power, axis=0))
    return FeatureSet(features=norm, energy=energy, hop_s=HOP_S, sr=sr,
                      duration_s=len(sig) / float(sr), signal=sig)


def window_scores(ref_feat: FeatureSet, take_feat: FeatureSet,
                  take_start_frame: int, window_frames: int) -> np.ndarray:
    """待对齐录音一个窗口对参考录音每个起点的平均帧余弦相似度。"""

    if window_frames <= 0:
        raise ValueError("window_frames 必须为正")
    a = ref_feat.features
    b = take_feat.features[take_start_frame:take_start_frame + window_frames]
    if b.shape[0] < 1:
        return np.zeros(0, dtype=np.float64)
    w = b.shape[0]
    n = a.shape[0]
    if n < w:
        return np.zeros(0, dtype=np.float64)
    need = n + w
    nfft = 1
    while nfft < need:
        nfft *= 2
    af = np.fft.rfft(a, nfft, axis=0)
    bf = np.fft.rfft(b[::-1], nfft, axis=0)
    corr = np.fft.irfft(np.sum(af * bf, axis=1), nfft)
    return corr[w - 1:w - 1 + (n - w + 1)] / float(w)


def _parabolic_peak(curve: np.ndarray, idx: int) -> tuple[float, float]:
    """对峰附近做抛物线插值, 返回 (亚采样偏移, 峰值)。"""

    if idx <= 0 or idx >= len(curve) - 1:
        return 0.0, float(curve[idx])
    y0, y1, y2 = float(curve[idx - 1]), float(curve[idx]), float(curve[idx + 1])
    denom = y0 - 2.0 * y1 + y2
    if abs(denom) < 1e-12:
        return 0.0, y1
    delta = 0.5 * (y0 - y2) / denom
    delta = float(np.clip(delta, -0.5, 0.5))
    return delta, y1 - 0.25 * (y0 - y2) * delta


def local_peaks(curve: np.ndarray, min_sep_frames: int, top_k: int,
                abs_threshold: float = 0.03) -> list[tuple[int, float, float]]:
    """返回局部峰 [(帧, 亚帧偏移, 峰值)], 按得分从高到低。"""

    if curve.size == 0:
        return []
    work = np.array(curve, dtype=np.float64, copy=True)
    out: list[tuple[int, float, float]] = []
    for _ in range(top_k):
        idx = int(np.argmax(work))
        value = float(work[idx])
        if value < abs_threshold:
            break
        delta, peak = _parabolic_peak(curve, idx)
        out.append((idx, delta, float(peak)))
        lo = max(0, idx - min_sep_frames)
        hi = min(len(work), idx + min_sep_frames + 1)
        work[lo:hi] = -9.0
    return out


def refine_with_waveform(ref_sig: np.ndarray, take_sig: np.ndarray, sr: int,
                         take_time: float, ref_time: float,
                         window_s: float = 0.30, search_s: float = 0.060) -> tuple[float, float]:
    """在特征级估计附近用带通波形的归一化互相关做毫秒级微调。

    返回 (修正后的参考时间, 归一化相关系数)。若窗口越界或匹配很弱,
    返回原参考时间与 0。
    """

    w = int(round(window_s * sr))
    s = int(round(search_s * sr))
    t0 = int(round(take_time * sr)) - w // 2
    r0 = int(round(ref_time * sr)) - w // 2
    if t0 < 0 or t0 + w > len(take_sig):
        return ref_time, 0.0
    r_start = r0 - s
    r_end = r0 + w + s
    if r_start < 0 or r_end > len(ref_sig):
        return ref_time, 0.0
    take_seg = np.asarray(take_sig[t0:t0 + w], dtype=np.float64)
    ref_seg = np.asarray(ref_sig[r_start:r_end], dtype=np.float64)
    take_seg = take_seg - take_seg.mean()
    ref_seg = ref_seg - ref_seg.mean()
    t_norm = np.linalg.norm(take_seg)
    if t_norm < 1e-9:
        return ref_time, 0.0
    corr = signal.correlate(ref_seg, take_seg, mode="valid", method="fft")
    # 每个 lag 下参考窗口的能量
    csum = np.concatenate([[0.0], np.cumsum(ref_seg ** 2)])
    energy = np.sqrt(np.maximum(csum[w:] - csum[:-w], 0.0))
    ncc = corr / (energy * t_norm + 1e-12)
    if ncc.size == 0:
        return ref_time, 0.0
    k = int(np.argmax(ncc))
    delta, peak = _parabolic_peak(ncc, k)
    if peak < 0.30 or k <= 0 or k >= len(ncc) - 1:
        return ref_time, float(peak)
    lag = (k + delta) - s  # 相对特征级估计的样本偏移
    if abs(lag) > s:
        return ref_time, float(peak)
    return ref_time + lag / float(sr), float(peak)


def detect_silent_frames(energy: np.ndarray, rel_threshold: float = 0.02,
                         noise_floor_multiplier: float = 2.0,
                         min_run: int = 40) -> np.ndarray:
    """返回布尔掩码: True 表示静音/极低电平帧。

    判据同时考虑峰值与噪声底: 低于峰值的 ``rel_threshold`` 且接近本录音
    自身的噪声底才算静音。这样既不会把安静的底噪当静音, 也不会因为素材
    整体音量小就整段判成静音。
    """

    if energy.size == 0:
        return np.zeros(0, dtype=bool)
    peak = float(np.max(energy))
    if peak <= 1e-12:
        return np.ones_like(energy, dtype=bool)
    floor = float(np.percentile(energy, 10.0))
    quiet = (energy < peak * rel_threshold) & (energy < floor * noise_floor_multiplier)
    if not quiet.any():
        return quiet
    # 只保留连续长度 >= min_run 的静音段, 避免单个弱帧被误判
    out = np.zeros_like(quiet, dtype=bool)
    start = None
    for i, q in enumerate(quiet):
        if q and start is None:
            start = i
        elif not q and start is not None:
            if i - start >= min_run:
                out[start:i] = True
            start = None
    if start is not None and len(quiet) - start >= min_run:
        out[start:] = True
    return out
