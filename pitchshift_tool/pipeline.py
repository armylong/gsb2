"""保时长移调核心管线 (numpy 实现, 可取消)。

流程: 相位声码器时间拉伸 -> 变采样率重采样恢复原长度。
  1. time_stretch: STFT -> 相位积分的 phase vocoder (思路同 librosa phase_vocoder,
     逐帧实现以便在帧边界检查取消信号并上报进度), ISTFT overlap-add 合成。
  2. resample: 把拉伸后的信号按 sr*rate -> sr 重采样, 长度对齐到原采样点数。

立体声按声道独立处理: 相同的输入经过完全确定性的相同运算, 输出仍相同,
因此左右共有的居中声像不会被移到一侧。
"""

from __future__ import annotations

import math

import numpy as np

try:  # soxr 是首选重采样器; 退化时用线性插值, 保证功能可用
    import soxr

    _HAS_SOXR = True
except Exception:  # pragma: no cover - 环境缺 soxr 时的兜底
    _HAS_SOXR = False


class CancelToken:
    """协作式取消信号, 处理线程在帧/声道边界轮询。"""

    def __init__(self) -> None:
        self._cancelled = False

    def cancel(self) -> None:
        self._cancelled = True

    @property
    def cancelled(self) -> bool:
        return self._cancelled


class CancelledError(Exception):
    """处理被用户取消。"""


def _hann(n: int) -> np.ndarray:
    # 周期性 Hann 窗, 与 STFT/ISTFT 配对使用
    return np.hanning(n).astype(np.float32)


def _stft(y: np.ndarray, n_fft: int, hop: int, window: np.ndarray) -> np.ndarray:
    """正向 STFT, 返回 (freq_bins, frames) 的 complex64 矩阵。"""
    if len(y) < n_fft:
        y = np.pad(y, (0, n_fft - len(y)))
    n_frames = 1 + (len(y) - n_fft) // hop
    shape = (n_fft, n_frames)
    strides = (y.strides[0], hop * y.strides[0])
    frames = np.lib.stride_tricks.as_strided(y, shape=shape, strides=strides)
    return np.fft.rfft(frames * window[:, None], n=n_fft, axis=0)


def _istft(
    stft_matrix: np.ndarray, hop: int, window: np.ndarray, length: int
) -> np.ndarray:
    """逆 STFT, overlap-add 并按窗能量归一化, 截断/补齐到 length。"""
    n_fft = len(window)
    n_frames = stft_matrix.shape[1]
    ifft_frames = np.fft.irfft(stft_matrix, n=n_fft, axis=0) * window[:, None]

    out_len = n_fft + hop * (n_frames - 1)
    y = np.zeros(out_len, dtype=np.float32)
    win_sum = np.zeros(out_len, dtype=np.float32)
    win_sq = window**2
    for i in range(n_frames):
        start = i * hop
        y[start : start + n_fft] += ifft_frames[:, i]
        win_sum[start : start + n_fft] += win_sq

    nonzero = win_sum > 1e-10
    y[nonzero] /= win_sum[nonzero]
    if len(y) >= length:
        return y[:length].astype(np.float32)
    return np.pad(y, (0, length - len(y))).astype(np.float32)


def time_stretch(
    y: np.ndarray,
    rate: float,
    n_fft: int,
    hop: int,
    token: CancelToken | None = None,
    progress_cb=None,
) -> np.ndarray:
    """相位声码器时间拉伸。rate>1 缩短, rate<1 拉长, 不改变音高。"""
    y = np.asarray(y, dtype=np.float32)
    window = _hann(n_fft)

    # 至少要能取两帧, 否则补零
    if len(y) < n_fft + hop:
        y = np.pad(y, (0, n_fft + hop - len(y)))

    stft_matrix = _stft(y, n_fft, hop, window)
    n_frames = stft_matrix.shape[1]
    out_samples = max(1, int(math.ceil(len(y) / rate)))
    n_stretch = max(2, 1 + int(math.ceil((out_samples - n_fft) / hop)))

    phi_advance = np.linspace(0, np.pi * hop, stft_matrix.shape[0], dtype=np.float32)
    phase_angles = np.angle(stft_matrix[:, 0]).astype(np.float32)

    out = np.zeros((stft_matrix.shape[0], n_stretch), dtype=np.complex64)
    out[:, 0] = stft_matrix[:, 0]

    for col in range(1, n_stretch):
        if token is not None and token.cancelled:
            raise CancelledError("时间拉伸被取消")
        if progress_cb is not None and col % 16 == 0:
            progress_cb(col / n_stretch)

        i = int(round(col * rate))
        i = min(max(i, 1), n_frames - 1)

        cur = stft_matrix[:, i]
        prev = stft_matrix[:, i - 1]
        dphase = np.angle(cur) - np.angle(prev) - phi_advance
        dphase = dphase - 2.0 * np.pi * np.round(dphase / (2.0 * np.pi))
        phase_angles = phase_angles + phi_advance + dphase
        out[:, col] = np.abs(cur) * np.exp(1j * phase_angles.astype(np.float32))

    if progress_cb is not None:
        progress_cb(1.0)
    return _istft(out, hop, window, out_samples)


def _resample(y: np.ndarray, rate: float, target_len: int) -> np.ndarray:
    """把时间拉伸后的信号 (长度 n/rate) 重采样回 target_len=n 个采样点。

    输出第 j 点取输入第 j/rate 点, 即 in_rate=1, out_rate=rate:
    rate<1 时下采样, 频率乘以 1/rate = 2^(半音/12), 方向与移调一致。
    """
    if _HAS_SOXR:
        # soxr 接受浮点采样率比, 质量高且无伪音
        shifted = soxr.resample(y.astype(np.float32), 1.0, rate)
    else:  # pragma: no cover - 兜底路径
        idx_out = np.arange(target_len, dtype=np.float64) / rate
        shifted = np.interp(idx_out, np.arange(len(y)), y).astype(np.float32)

    if len(shifted) >= target_len:
        return shifted[:target_len].astype(np.float32)
    return np.pad(shifted, (0, target_len - len(shifted))).astype(np.float32)


def _fft_params(sr: int) -> tuple[int, int]:
    """窗长取约 46ms 的 2 次幂, hop 为 1/4, 限制在 [512, 4096]。"""
    n_fft = 2 ** int(round(math.log2(max(1, sr * 0.046))))
    n_fft = int(np.clip(n_fft, 512, 4096))
    return n_fft, n_fft // 4


def pitch_shift_channel(
    y: np.ndarray,
    sr: int,
    semitones: float,
    token: CancelToken | None = None,
    progress_cb=None,
) -> np.ndarray:
    """单声道保时长移调。semitones 可为小数 (含音分细调)。"""
    y = np.asarray(y, dtype=np.float32)
    n = len(y)

    # 零偏移原样返回 (精确对照, 不经过任何重采样)
    if abs(semitones) < 1e-9:
        if progress_cb is not None:
            progress_cb(1.0)
        return y.copy()

    rate = 2.0 ** (-semitones / 12.0)
    n_fft, hop = _fft_params(sr)

    stretched = time_stretch(
        y, rate, n_fft, hop, token,
        None if progress_cb is None else lambda p: progress_cb(0.05 + 0.9 * p),
    )
    if token is not None and token.cancelled:
        raise CancelledError("移调被取消")
    out = _resample(stretched, rate, n)
    if progress_cb is not None:
        progress_cb(1.0)
    return out


def pitch_shift(
    samples: np.ndarray,
    sr: int,
    semitones: float,
    token: CancelToken | None = None,
    progress_cb=None,
) -> np.ndarray:
    """对单声道 (1D) 或立体声 (2D, shape=(n,2)) 做保时长移调。

    输出与输入同采样率、同声道数、同采样点数; 零偏移时逐采样相等。
    progress_cb 接收 0..1 的总进度。
    """
    if samples.ndim == 1:
        return pitch_shift_channel(samples, sr, semitones, token, progress_cb)

    if samples.ndim != 2 or samples.shape[1] not in (1, 2):
        raise ValueError(f"不支持的声道形状: {samples.shape}")

    n_ch = samples.shape[1]
    out = np.zeros_like(samples, dtype=np.float32)
    for ch in range(n_ch):
        if token is not None and token.cancelled:
            raise CancelledError("移调被取消")
        base = ch / n_ch

        def sub(p, _b=base, _c=n_ch):
            if progress_cb is not None:
                progress_cb(_b + p / _c)

        out[:, ch] = pitch_shift_channel(
            samples[:, ch], sr, semitones, token, sub
        )
    return out
