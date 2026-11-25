"""STFT 与频带时变能量分析 (numpy 实现, 无 scipy 依赖)。

频带按对数等距划分, 能量用带内 FFT bin 的平均功率表示,
这样不同频带、不同声源之间的 dB 值可以直接横向比较。
"""

from __future__ import annotations

import numpy as np

N_FFT = 1024
HOP = 256
N_BANDS = 8
F_LOW = 80.0
DB_FLOOR = -90.0


def stft(x: np.ndarray, n_fft: int = N_FFT, hop: int = HOP) -> np.ndarray:
    """返回帧数 x (n_fft//2+1) 的功率谱。

    帧数不足一帧时右侧零填, 保证极短提示音也能出至少一帧。
    帧时间由调用方按 hop/sr 计算, 这里不持有采样率状态。
    """
    x = np.asarray(x, dtype=np.float64)
    if x.size < n_fft:
        x = np.pad(x, (0, n_fft - x.size))
    n_frames = 1 + (x.size - n_fft) // hop
    win = 0.5 - 0.5 * np.cos(2 * np.pi * np.arange(n_fft) / n_fft)  # Hann
    win_sq_sum = float(np.sum(win**2))
    shape = (n_frames, n_fft)
    strides = (x.strides[0] * hop, x.strides[0])
    frames = np.lib.stride_tricks.as_strided(x, shape=shape, strides=strides)
    spec = np.fft.rfft(frames * win[None, :], n_fft, axis=1)
    return (np.abs(spec) ** 2) / max(win_sq_sum, 1e-12)


def stft_for_sr(x: np.ndarray, sr: int, n_fft: int = N_FFT, hop: int = HOP):
    power = stft(x, n_fft, hop)
    times = (np.arange(power.shape[0]) * hop + n_fft / 2.0) / sr
    freqs = np.fft.rfftfreq(n_fft, 1.0 / sr)
    return power, times, freqs


def band_edges(sr: int, n_bands: int = N_BANDS, f_low: float = F_LOW) -> np.ndarray:
    """对数等距频带边界, 上限取奈奎斯特频率。"""
    f_high = sr / 2.0
    return np.geomspace(f_low, f_high, n_bands + 1)


def band_power(
    power: np.ndarray,
    freqs: np.ndarray,
    edges: np.ndarray,
) -> np.ndarray:
    """把逐 bin 功率聚合成 (帧数 x 频带数) 的带内平均功率。"""
    out = np.zeros((power.shape[0], len(edges) - 1))
    for b in range(len(edges) - 1):
        mask = (freqs >= edges[b]) & (freqs < edges[b + 1])
        if b == len(edges) - 2:  # 最后一带含上边界
            mask = (freqs >= edges[b]) & (freqs <= edges[b + 1])
        if mask.any():
            out[:, b] = power[:, mask].mean(axis=1)
    return out


def to_db(power: np.ndarray, floor: float = DB_FLOOR) -> np.ndarray:
    return 10.0 * np.log10(np.maximum(power, 10.0 ** (floor / 10.0)))


def heatmap_matrix(
    power: np.ndarray,
    freqs: np.ndarray,
    n_rows: int = 64,
    f_low: float = F_LOW,
) -> np.ndarray:
    """把线性频率 bin 重映射成对数频率行, 得到 (n_rows x 帧数) 矩阵。"""
    f_high = freqs[-1]
    row_edges = np.geomspace(max(f_low, freqs[1]), f_high, n_rows + 1)
    mat = np.zeros((n_rows, power.shape[0]))
    for r in range(n_rows):
        mask = (freqs >= row_edges[r]) & (freqs < row_edges[r + 1])
        if r == n_rows - 1:
            mask = (freqs >= row_edges[r]) & (freqs <= row_edges[r + 1])
        if mask.any():
            mat[r, :] = power[:, mask].mean(axis=1)
    return mat


def analyze(x: np.ndarray, sr: int):
    """一次算齐界面需要的全部分析量。"""
    power, times, freqs = stft_for_sr(x, sr)
    edges = band_edges(sr)
    bp = band_power(power, freqs, edges)
    heat = heatmap_matrix(power, freqs)
    return {
        "power": power,
        "times": times,
        "freqs": freqs,
        "edges": edges,
        "band_db": to_db(bp),
        "heat_db": to_db(heat),
        "heat_f_edges": np.geomspace(max(F_LOW, freqs[1]), freqs[-1], heat.shape[0] + 1),
    }
