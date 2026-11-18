"""纯 NumPy/SciPy 的时频选区处理核心。

设计要点
========
1. 所有处理都在 STFT 域进行, 但最终通过**时域交叉淡化**把修改限制在选区
   时间范围 (含过渡) 内, 因此选区外的样本与输入逐样本相同 (浮点误差内)。
2. 选框用绝对样本/绝对频率 (Hz) 表示, 与显示缩放完全解耦 —— 缩放视图
   不会改变实际选区。
3. 时间边界与频率边界都做柔和过渡 (时域 crossfade + 频域软掩码),
   避免边界爆音与频谱竖线/横线伪影。
4. 两种处理:
   - attenuate (局部衰减): 压低选区内窄带干扰, 保留残余信号;
   - inpaint  (邻域修补): 用选区外上下相邻频带的 STFT 插值替换选区
     内容, 仅适用于有足够有效邻域参考的情形。
   本工具不做生成式补全, 不能恢复已完全丢失的原始声音。
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy import signal as scipy_signal


# ---------------------------------------------------------------------------
# 数据结构
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Selection:
    """时频选区, 全部使用绝对单位 (样本号 / Hz), 与显示缩放无关。

    边界为半开区间 [start_sample, end_sample), [f0, f1)。
    channels: 需要处理的通道索引元组; 立体声联动时为 (0, 1)。
    """

    start_sample: int
    end_sample: int
    f0: float
    f1: float
    channels: tuple[int, ...]

    def clamp(self, n_samples: int, sr: int) -> "Selection":
        """把越界选区夹紧到合法范围; 完全非法时返回 None 由调用方反馈。"""
        s = max(0, min(self.start_sample, n_samples))
        e = max(0, min(self.end_sample, n_samples))
        lo = max(0.0, min(self.f0, sr / 2.0))
        hi = max(0.0, min(self.f1, sr / 2.0))
        return Selection(s, e, lo, hi, self.channels)

    @property
    def is_empty(self) -> bool:
        return self.end_sample <= self.start_sample or self.f1 <= self.f0

    def overlaps_time(self, start: int, end: int) -> bool:
        return self.start_sample < end and self.end_sample > start


class SelectionError(ValueError):
    """选区为空或越界等用户可理解的错误。"""


class InpaintError(ValueError):
    """邻域修补缺少有效参考等错误。"""


# ---------------------------------------------------------------------------
# STFT 参数与变换
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class STFTParams:
    n_fft: int = 2048
    hop: int = 512
    win_length: int = 2048

    @property
    def n_overlap(self) -> int:
        return self.n_fft - self.hop


def _as_2d(x: np.ndarray) -> tuple[np.ndarray, bool]:
    """统一成 (n_samples, n_channels)。返回 (数组, 是否原本单声道)。"""
    if x.ndim == 1:
        return x[:, None], True
    if x.ndim == 2:
        return x, False
    raise ValueError(f"期望 1D/2D 音频数组, 得到 ndim={x.ndim}")


def stft(x: np.ndarray, p: STFTParams) -> np.ndarray:
    """单通道 STFT, 返回 (n_freq, n_frames) 复数谱。"""
    freqs, frames, Z = scipy_signal.stft(
        x,
        nperseg=p.win_length,
        noverlap=p.n_overlap,
        nfft=p.n_fft,
        boundary="zeros",
        padded=True,
    )
    return Z


def istft(Z: np.ndarray, p: STFTParams, n_samples: int) -> np.ndarray:
    """逆 STFT 并截回原长度。"""
    _, y = scipy_signal.istft(
        Z,
        nperseg=p.win_length,
        noverlap=p.n_overlap,
        nfft=p.n_fft,
        boundary=True,
    )
    # 数值上可能差 1 个样本, 统一对齐
    if y.shape[0] >= n_samples:
        return y[:n_samples]
    out = np.zeros(n_samples, dtype=y.dtype)
    out[: y.shape[0]] = y
    return out


# ---------------------------------------------------------------------------
# 软掩码 (频率方向 + 时间方向的余弦渐变)
# ---------------------------------------------------------------------------

def _frequency_weight(freqs: np.ndarray, f0: float, f1: float,
                      transition_hz: float) -> np.ndarray:
    """每个频点的权重: 选区内为 1, 边界 transition_hz 内余弦渐变到 0。"""
    w = np.zeros(freqs.shape, dtype=np.float64)
    if f1 <= f0:
        return w
    t = max(transition_hz, 1e-9)
    # 上升沿
    rise = (freqs - f0) / t
    w = np.clip(rise, 0.0, 1.0)
    # 下降沿
    fall = (f1 - freqs) / t
    w = np.minimum(w, np.clip(fall, 0.0, 1.0))
    # 余弦缓动, 保证导数连续
    return 0.5 - 0.5 * np.cos(np.pi * w)


def _time_weight(times: np.ndarray, t0: float, t1: float,
                 transition_s: float) -> np.ndarray:
    """每个 STFT 帧的时间权重, 余弦渐变。"""
    if t1 <= t0:
        return np.zeros(times.shape, dtype=np.float64)
    t = max(transition_s, 1e-12)
    a = np.clip((times - t0) / t, 0.0, 1.0)
    b = np.clip((t1 - times) / t, 0.0, 1.0)
    w = np.minimum(a, b)
    return 0.5 - 0.5 * np.cos(np.pi * w)


# ---------------------------------------------------------------------------
# 邻域修补
# ---------------------------------------------------------------------------

def _neighbor_inpaint(Z: np.ndarray, freqs: np.ndarray,
                      k_lo: int, k_hi: int, fr_lo: int, fr_hi: int,
                      min_bands_each_side: int = 2) -> np.ndarray:
    """用选区上下相邻频带 (时间上取选区外上下文帧) 的谱插值替换选区。

    做法: 对每个选区帧, 参考谱取上下邻带在 [fr_lo, fr_hi) 全部帧的
    中位数 (对短暂异常稳健), 再沿频率方向在两条参考谱之间线性插值。
    要求上下两侧都至少有 min_bands_each_side 个有效频带, 否则拒绝。
    """
    n_freq = Z.shape[0]
    if k_lo < min_bands_each_side or (n_freq - k_hi) < min_bands_each_side:
        raise InpaintError(
            "选区频率边界离频谱顶端/底端太近, 上下邻域缺少足够的有效参考频带, "
            "无法进行邻域修补; 请收窄频率选区或改用局部衰减。"
        )

    lo_band = Z[k_lo - min_bands_each_side:k_lo, fr_lo:fr_hi]
    hi_band = Z[k_hi:k_hi + min_bands_each_side, fr_lo:fr_hi]
    # 中位数参考谱 (对时间维取中位数, 抑制异常帧影响)。
    # NumPy 的 partition 不支持复数, 实部/虚部分别取中位数再合成。
    ref_lo = (np.median(lo_band.real, axis=1)
              + 1j * np.median(lo_band.imag, axis=1))
    ref_hi = (np.median(hi_band.real, axis=1)
              + 1j * np.median(hi_band.imag, axis=1))
    spec_lo = np.mean(ref_lo)            # 复数平均: 下边界参考
    spec_hi = np.mean(ref_hi)            # 上边界参考

    width = k_hi - k_lo
    out = Z.copy()
    for j in range(fr_lo, fr_hi):
        for k in range(k_lo, k_hi):
            alpha = (k - k_lo + 1) / (width + 1)
            out[k, j] = (1.0 - alpha) * spec_lo + alpha * spec_hi
    return out


# ---------------------------------------------------------------------------
# 主入口
# ---------------------------------------------------------------------------

@dataclass
class ProcessOptions:
    mode: str = "attenuate"          # "attenuate" | "inpaint"
    strength: float = 0.8            # 0..1, 衰减强度/修补混合强度
    time_transition_ms: float = 8.0  # 时间边界过渡时长 (毫秒)
    freq_transition_hz: float = 80.0 # 频率边界过渡带宽 (Hz)


def process_selection(audio: np.ndarray, sr: int, sel: Selection,
                      options: ProcessOptions,
                      params: STFTParams | None = None) -> np.ndarray:
    """对选区执行修复, 返回与输入同形状、同采样率、同长度的数组。

    不修改输入数组。选区外样本保证逐样本不变 (经时域 crossfade 约束)。
    """
    if params is None:
        params = STFTParams()
    x, was_mono = _as_2d(np.asarray(audio, dtype=np.float64))
    n_samples, n_channels = x.shape

    clamped = sel.clamp(n_samples, sr)
    if clamped.is_empty:
        raise SelectionError(
            "选区为空或完全越界: 请在频谱上框选一个非空的时间/频率区域。"
        )
    bad_ch = [c for c in clamped.channels if c < 0 or c >= n_channels]
    if bad_ch:
        raise SelectionError(f"选区通道越界: {bad_ch}, 当前音频只有 {n_channels} 个通道。")
    if not 0.0 <= options.strength <= 1.0:
        raise ValueError("strength 必须在 [0, 1] 区间内。")

    out = x.copy()
    # 强度为 0 语义上等于 "不处理": 直接返回副本, 连 STFT 往返误差都不引入
    if options.strength == 0.0:
        return out[:, 0] if was_mono else out
    frame_period = params.hop / sr
    trans_s = min(options.time_transition_ms / 1000.0,
                  max((clamped.end_sample - clamped.start_sample) / sr / 3.0,
                      frame_period))
    trans_hz = min(options.freq_transition_hz,
                   max((clamped.f1 - clamped.f0) / 3.0, 1.0))

    for ch in clamped.channels:
        Z = stft(x[:, ch], params)
        n_freq, n_frames = Z.shape
        freqs = np.linspace(0, sr / 2.0, n_freq)
        times = np.arange(n_frames) * frame_period

        t0 = clamped.start_sample / sr
        t1 = clamped.end_sample / sr
        fw = _frequency_weight(freqs, clamped.f0, clamped.f1, trans_hz)
        tw = _time_weight(times, t0, t1, trans_s)
        mask2d = fw[:, None] * tw[None, :]

        if options.mode == "attenuate":
            # 强度 s: 选区内目标增益从 1 (s=0) 到 0.02 (s=1)
            floor_gain = 0.02
            gain = 1.0 - options.strength * (1.0 - floor_gain)
            Z_new = Z * (1.0 - mask2d + mask2d * gain)
        elif options.mode == "inpaint":
            k_lo = int(np.searchsorted(freqs, clamped.f0, side="left"))
            k_hi = int(np.searchsorted(freqs, clamped.f1, side="right"))
            # 上下文帧: 选区前后各取与选区等长 (至少 2 帧), 用于估计邻带参考
            dur_frames = max(
                int(np.ceil((t1 - t0) / frame_period)), 1)
            ctx = max(dur_frames, 2)
            fr_lo = max(
                int(np.floor(t0 / frame_period)) - ctx, 0)
            fr_hi = min(
                int(np.ceil(t1 / frame_period)) + ctx, n_frames)
            k_lo = max(k_lo, 1)
            k_hi = min(k_hi, n_freq - 1)
            if k_hi <= k_lo:
                raise SelectionError("频率选区不足一个 FFT 频点宽度。")
            Z_inp = _neighbor_inpaint(Z, freqs, k_lo, k_hi, fr_lo, fr_hi)
            # 强度控制修补混入比例, 配合软掩码
            mix = options.strength * mask2d
            Z_new = Z * (1.0 - mix) + Z_inp * mix
        else:
            raise ValueError(f"未知处理模式: {options.mode!r}")

        y_full = istft(Z_new, params, n_samples)

        # ---- 时域交叉淡化: 把修改严格限制在 [cf0, cf1) ----
        cf0 = max(0, clamped.start_sample - params.n_fft)
        cf1 = min(n_samples, clamped.end_sample + params.n_fft)
        fade_len = min(
            params.n_fft,
            max(params.hop, int(round(trans_s * sr))),
            max((cf1 - cf0) // 2, 1),
        )
        y_ch = x[:, ch].copy()
        region = slice(cf0, cf1)
        n_region = cf1 - cf0
        ramp = 0.5 - 0.5 * np.cos(
            np.pi * np.clip(np.arange(n_region) / max(fade_len, 1), 0, 1)
        )
        # 两端都要淡入淡出
        ramp_in = ramp
        ramp_out = ramp[::-1]
        blend = np.minimum(ramp_in, ramp_out)
        y_ch[region] = x[region, ch] * (1.0 - blend) + y_full[region] * blend
        out[:, ch] = y_ch

    return out[:, 0] if was_mono else out


def outside_region_unchanged(orig: np.ndarray, proc: np.ndarray,
                             sel: Selection, sr: int,
                             params: STFTParams | None = None) -> np.ndarray:
    """返回严格位于时域 crossfade 区域之外的样本差 (供测试使用)。"""
    if params is None:
        params = STFTParams()
    pad = params.n_fft
    n = orig.shape[0]
    cf0 = max(0, sel.start_sample - pad)
    cf1 = min(n, sel.end_sample + pad)
    diff = np.abs(orig - proc)
    diff[cf0:cf1] = 0.0
    return diff
