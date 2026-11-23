"""离线扫频测量 DSP 核心。

参考信号为程序生成的指数正弦扫频(ESS),录音经互相关自动对齐后
做正则化频域反卷积得到脉冲响应,加窗后得到频响。
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from scipy import signal


# ---------------------------------------------------------------- 扫频参考

@dataclass
class SweepSpec:
    fs: int = 48000
    f1: float = 20.0       # 起始频率 Hz
    f2: float = 20000.0    # 终止频率 Hz
    duration: float = 3.0  # 秒
    amp: float = 0.9
    fade_s: float = 0.02   # 两端淡入淡出


def generate_sweep(spec: SweepSpec) -> np.ndarray:
    """指数正弦扫频, 两端升余弦淡入淡出, 峰值 spec.amp。"""
    n = int(round(spec.duration * spec.fs))
    t = np.arange(n) / spec.fs
    k = np.log(spec.f2 / spec.f1)
    phase = 2.0 * np.pi * spec.f1 * spec.duration / k * (
        np.exp(t / spec.duration * k) - 1.0)
    x = spec.amp * np.sin(phase)
    nf = min(n // 2, max(1, int(round(spec.fade_s * spec.fs))))
    ramp = 0.5 * (1.0 - np.cos(np.pi * np.arange(nf) / nf))
    x[:nf] *= ramp
    x[-nf:] *= ramp[::-1]
    return x


# ---------------------------------------------------------------- 录音检查

def _runs(mask: np.ndarray):
    idx = np.flatnonzero(mask)
    if idx.size == 0:
        return []
    return np.split(idx, np.flatnonzero(np.diff(idx) > 1) + 1)


def detect_clipping(x: np.ndarray, fs_thresh: float = 0.9999,
                    min_run: int = 3):
    """返回 (削顶样本数, 最长连续削顶样本数)。

    判据: 触及满幅; 或出现与全局最大值精确相等的平台
    (削顶后所有被削样本取同一值, 未削顶信号不会连续重复同一采样值)。
    """
    ax = np.abs(x)
    if ax.size == 0:
        return 0, 0
    m = float(ax.max())
    mask = ax >= fs_thresh
    if m > 0.3:
        plateau = ax >= m * (1.0 - 1e-9)
        for r in _runs(plateau):
            if len(r) >= min_run:
                mask[r] = True
    runs = _runs(mask)
    if not runs:
        return 0, 0
    return int(sum(len(r) for r in runs)), int(max(len(r) for r in runs))


def find_sweep_start(rec: np.ndarray, sweep: np.ndarray):
    """互相关找扫频在录音中的起点样本(允许录音开头有任意空白)。"""
    corr = signal.fftconvolve(rec, sweep[::-1])
    k = int(np.argmax(np.abs(corr)))
    return k - (len(sweep) - 1), float(np.abs(corr[k]))


# ---------------------------------------------------------------- 反卷积

def _nfft_for(n: int) -> int:
    return 1 << (2 * n - 1).bit_length()


def deconvolve(rec_seg: np.ndarray, sweep: np.ndarray, eps_rel: float = 1e-4):
    """正则化频域反卷积: H = Y·conj(X) / (|X|^2 + eps)。

    rec_seg 为对齐后截取的一段(长度 = len(sweep), 不足补零)。
    返回 (ir, nfft), 直达声在 ir[0] 附近。
    """
    n = len(sweep)
    nfft = _nfft_for(n)
    X = np.fft.rfft(sweep, nfft)
    Y = np.fft.rfft(rec_seg, nfft)
    denom = np.abs(X) ** 2
    eps = eps_rel * float(denom.max())
    H = Y * np.conj(X) / (denom + eps)
    return np.fft.irfft(H, nfft), nfft


@dataclass
class AnalysisResult:
    fs: int
    offset: int                 # 扫频起点在录音中的样本位置
    ir: np.ndarray              # 绝对校准脉冲响应(恒等通道 → 0 dB)
    peak_idx: int               # 主到达在 ir 中的样本位置
    peak: float                 # 主峰幅值(供显示归一化)
    nfft: int
    warnings: list = field(default_factory=list)
    truncated_s: float = 0.0
    clip_count: int = 0
    clip_run: int = 0


def analyze(rec: np.ndarray, rec_fs: int, sweep: np.ndarray,
            ir_search_s: float = 0.5, eps_rel: float = 1e-4) -> AnalysisResult:
    """对齐 + 反卷积 + 质量检查。

    IR 不做峰值归一化: H = Y/X 对已知参考是绝对校准的,
    恒等通道的频响即为 0 dB, 不同时间窗共用同一幅值基准。
    """
    if rec_fs <= 0:
        raise ValueError("无效的采样率")
    warnings: list[str] = []
    n = len(sweep)
    offset, _ = find_sweep_start(rec, sweep)

    seg = np.zeros(n)
    src0 = max(0, offset)
    src1 = min(len(rec), offset + n)
    if src1 > src0:
        seg[src0 - offset: src1 - offset] = rec[src0:src1]
    truncated_s = 0.0
    if offset < 0:
        truncated_s = -offset / rec_fs
        warnings.append(
            f"扫频开头在录音开始之前, 头部缺少约 {truncated_s * 1000:.0f} ms, 结果不可靠")
    elif src1 < offset + n:
        truncated_s = (offset + n - src1) / rec_fs
        warnings.append(
            f"录音在扫频结束前停止, 尾部缺少约 {truncated_s * 1000:.0f} ms, 结果不可靠")

    clip_n, clip_run = detect_clipping(rec)
    if clip_n:
        warnings.append(
            f"检测到削顶: {clip_n} 个样本触及限幅电平(最长连续 {clip_run} 个), "
            "频响会产生非线性失真")

    ir, nfft = deconvolve(seg, sweep, eps_rel)
    search = min(len(ir), int(ir_search_s * rec_fs))
    peak = int(np.argmax(np.abs(ir[:search])))
    scale = abs(ir[peak])
    if scale < 1e-9:
        raise ValueError("未能在录音中找到参考扫频, 请确认录音与扫频参数一致")
    return AnalysisResult(
        fs=rec_fs, offset=offset, ir=ir, peak_idx=peak, peak=float(scale),
        nfft=nfft, warnings=warnings, truncated_s=truncated_s,
        clip_count=clip_n, clip_run=clip_run)


# ---------------------------------------------------------------- 频响

def windowed_fr(ir: np.ndarray, peak_idx: int, t0_ms: float, t1_ms: float,
                fs: int, nfft: int = 16384, taper_ms: float = 2.0):
    """对 IR 取 [t0,t1] ms(相对主峰)的窗, 两端升余弦收边, 返回 (freqs, mag_dB)。

    主峰前的样本按模索引环绕取用(线性反卷积下主峰前的响应
    位于数组末尾); 收边斜坡绝不压到主峰。
    """
    r0 = int(round(t0_ms * 1e-3 * fs))
    r1 = int(round(t1_ms * 1e-3 * fs))
    if r1 <= r0:
        r1 = r0 + 8
    idx = np.mod(peak_idx + np.arange(r0, r1), len(ir))
    seg = ir[idx].copy()
    nseg = len(seg)
    p = -r0  # 主峰在窗内位置(<0 表示峰在窗之前)
    nt = min(nseg // 2, max(1, int(round(taper_ms * 1e-3 * fs))))
    nl = min(nt, p) if p >= 0 else nt
    nr = min(nt, nseg - 1 - p) if p < nseg else nt
    w = np.ones(nseg)
    if nl > 0:
        w[:nl] = 0.5 * (1.0 - np.cos(np.pi * np.arange(nl) / nl))
    if nr > 0:
        w[nseg - nr:] *= 0.5 * (1.0 + np.cos(np.pi * np.arange(nr) / nr))
    seg *= w
    H = np.fft.rfft(seg, nfft)
    freqs = np.fft.rfftfreq(nfft, 1.0 / fs)
    mag = 20.0 * np.log10(np.abs(H) + 1e-12)
    return freqs, mag


def reference_valid_mask(sweep: np.ndarray, fs: int, freqs: np.ndarray,
                         f1: float, f2: float, thresh_db: float = -40.0,
                         smooth_oct: float = 1.0 / 6.0) -> np.ndarray:
    """参考能量足够的频段为 True。

    判据: 频率在标称 [f1, f2] 内, 且 1/6 倍频程平滑后的参考谱
    不低于带内峰值 thresh_db dB(淡出会削弱贴近 f1/f2 的边缘,
    这些位置会被如实标为不可用)。
    """
    nfft = 1 << (len(sweep) - 1).bit_length()
    P = np.abs(np.fft.rfft(sweep, nfft)) ** 2
    fX = np.fft.rfftfreq(nfft, 1.0 / fs)
    lf = np.log10(fX[1:])
    P = P[1:]
    step = lf[1] - lf[0]
    k = max(1, int(round(0.5 * smooth_oct * np.log10(2.0) / step)))
    kern = np.ones(2 * k + 1) / (2 * k + 1)
    Ps = np.convolve(P, kern, mode="same")
    db = 10.0 * np.log10(Ps / Ps.max() + 1e-30)
    mask = np.zeros(freqs.shape, dtype=bool)
    pos = freqs > 0
    di = np.interp(np.log10(freqs[pos]), lf, db, left=-300.0, right=-300.0)
    m = (di >= thresh_db) & (freqs[pos] >= f1) & (freqs[pos] <= f2)
    mask[pos] = m
    return mask


# ---------------------------------------------------------------- 合成通道

@dataclass
class FilterSpec:
    kind: str = "none"   # none / lowpass / highpass / peak
    fc: float = 4000.0
    q: float = 0.707
    gain_db: float = -8.0  # 仅 peak 使用


@dataclass
class SynthSpec:
    delay_ms: float = 5.0        # 通道纯延时(可为小数)
    pre_silence_s: float = 0.30  # 录音起点空白
    filter: FilterSpec = field(default_factory=FilterSpec)
    echo_on: bool = True
    echo_delay_ms: float = 11.0
    echo_gain: float = 0.2
    noise_db: float = -60.0      # 相对满幅的加性噪声 RMS
    clip: bool = False
    clip_level: float = 0.95


def _peaking_sos(fs: int, fc: float, q: float, gain_db: float) -> np.ndarray:
    A = 10.0 ** (gain_db / 40.0)
    w0 = 2.0 * np.pi * fc / fs
    alpha = np.sin(w0) / (2.0 * q)
    b = np.array([1 + alpha * A, -2 * np.cos(w0), 1 - alpha * A])
    a = np.array([1 + alpha / A, -2 * np.cos(w0), 1 - alpha / A])
    return signal.tf2sos(b / a[0], a / a[0])


def _filter_sos(fs: int, f: FilterSpec) -> np.ndarray:
    if f.kind == "lowpass":
        return signal.butter(4, f.fc, "lowpass", fs=fs, output="sos")
    if f.kind == "highpass":
        return signal.butter(4, f.fc, "highpass", fs=fs, output="sos")
    if f.kind == "peak":
        return _peaking_sos(fs, f.fc, f.q, f.gain_db)
    raise ValueError(f"未知滤波类型: {f.kind}")


def synth_channel_ir(fs: int, s: SynthSpec, ir_len: int = 8192) -> np.ndarray:
    """已知设定通道的脉冲响应: 分数延时(窗函数 sinc) + 滤波 + 单次回声。"""
    h = np.zeros(ir_len)
    d = s.delay_ms * 1e-3 * fs
    M = 24
    base = max(0, int(np.floor(d)) - M)
    sinc = np.sinc((base + np.arange(2 * M + 1)) - d) * np.hanning(2 * M + 1)
    h[base: base + 2 * M + 1] += sinc
    if s.filter.kind != "none":
        h = signal.sosfilt(_filter_sos(fs, s.filter), h)
    if s.echo_on and s.echo_gain != 0.0:
        ne = int(round(s.echo_delay_ms * 1e-3 * fs))
        if 0 < ne < ir_len:
            h[ne:] += s.echo_gain * h[: ir_len - ne]
    return h


def make_synthetic_recording(sweep: np.ndarray, fs: int, s: SynthSpec,
                             seed: int = 0):
    """返回 (录音, 有效通道 IR, 前置空白样本数)。

    录音含空白、噪声, 可演示削顶。有效通道 IR 已并入录音电平缩放,
    与 analyze 估计出的 IR 处于同一幅值基准, 可直接对比。
    """
    h = synth_channel_ir(fs, s)
    y = signal.fftconvolve(sweep, h)
    pre = int(round(s.pre_silence_s * fs))
    rec = np.zeros(pre + len(y) + int(0.05 * fs))
    rec[pre: pre + len(y)] = y
    target_peak = 1.20 if s.clip else 0.80
    scale = target_peak / max(1e-12, float(np.abs(rec).max()))
    rec *= scale
    rng = np.random.default_rng(seed)
    rec += rng.normal(0.0, 10.0 ** (s.noise_db / 20.0), len(rec))
    if s.clip:
        np.clip(rec, -s.clip_level, s.clip_level, out=rec)
    return rec, h * scale, pre
