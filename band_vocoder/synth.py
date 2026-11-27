"""合成音源、滤波器组、包络跟随与通道声码器核心。

声码器思路:
  调制声(说话) -> 一组带通 -> 逐带包络跟随(attack/release 两个时间常数)
  载波声(持续音) -> 同一组带通 -> 逐带乘上调制包络 -> 相加
输出里不含任何原调制声成分, 词句只靠各频带能量的时间起伏传递。
"""
from __future__ import annotations

import math

import numpy as np
from scipy.signal import butter, sosfilt

from . import FMAX_HZ, FMIN_HZ


# ---------------------------------------------------------------- 内置音源
def sine_carrier(duration_s: float, sr: int, freq: float = 220.0,
                 phase: float = 0.0) -> np.ndarray:
    """单一频率的持续载波。它在绝大多数声码器频带里天然没有能量。"""
    n = max(1, int(round(duration_s * sr)))
    t = np.arange(n) / sr
    return np.sin(2 * np.pi * freq * t + phase)


def harmonic_carrier(duration_s: float, sr: int, f0: float = 110.0,
                     n_harmonics: int = 24, rolloff: float = 0.7) -> np.ndarray:
    """带一串谐波的持续载波, 谐波幅度按 rolloff 次幂衰减, 覆盖到奈奎斯特频率。"""
    n = max(1, int(round(duration_s * sr)))
    t = np.arange(n) / sr
    out = np.zeros(n, dtype=np.float64)
    for k in range(1, n_harmonics + 1):
        f = f0 * k
        if f >= sr * 0.48:
            break
        out += (k ** (-rolloff)) * np.sin(2 * np.pi * f * t)
    peak = np.max(np.abs(out))
    return out / peak if peak > 0 else out


def alternating_band_modulator(duration_s: float, sr: int,
                               n_bands: int = 8,
                               segment_s: float = 0.25,
                               fmin: float = FMIN_HZ,
                               fmax: float = FMAX_HZ) -> np.ndarray:
    """测试用调制信号: 频带交替发声, 中间留出明确静音段。

    时序为 [b0, b1, ..., bN-1, 静音, bN-1, ..., b1, b0], 每段 segment_s,
    每段两端 5ms 淡化。每个发声段是落在对应频带中央的两个正弦之和。
    这样可以直接验证: 只有对应时间窗、对应频带的包络会抬升, 静音窗全部为零。
    """
    edges = erb_edges(n_bands, sr, fmin, fmax)
    centers = np.sqrt(edges[:-1] * edges[1:])
    n_seg = max(1, int(round(segment_s * sr)))
    order = list(range(n_bands)) + [-1] + list(range(n_bands - 1, -1, -1))
    parts = []
    fade = max(1, int(0.005 * sr))
    ramp = np.linspace(0.0, 1.0, fade)
    for idx in order:
        seg = np.zeros(n_seg, dtype=np.float64)
        if idx >= 0:
            fc = float(centers[idx])
            tt = np.arange(n_seg) / sr
            seg = (0.6 * np.sin(2 * np.pi * fc * tt)
                   + 0.4 * np.sin(2 * np.pi * fc * 1.18 * tt))
            seg[:fade] *= ramp
            seg[-fade:] *= ramp[::-1]
        parts.append(seg)
    out = np.concatenate(parts)
    target_n = int(round(duration_s * sr))
    if len(out) >= target_n:
        return out[:target_n]
    padded = np.zeros(target_n, dtype=np.float64)
    padded[: len(out)] = out
    return padded


# ---------------------------------------------------------------- 滤波器组
def erb_edges(n_bands: int, sr: int,
              fmin: float = FMIN_HZ, fmax: float = FMAX_HZ) -> np.ndarray:
    """按 ERB (Glasberg & Moore 1990) 等听觉带宽划分 n_bands 个频带的边界。"""
    n_bands = int(n_bands)
    if n_bands < 1:
        raise ValueError("n_bands 必须 >= 1")
    hi = min(float(fmax), sr * 0.48)

    def to_erb(f: float) -> float:
        return 21.4 * np.log10(4.37e-3 * f + 1.0)

    def to_hz(e: float) -> float:
        return (10 ** (e / 21.4) - 1.0) / 4.37e-3

    e_lo, e_hi = to_erb(fmin), to_erb(hi)
    return to_hz(np.linspace(e_lo, e_hi, n_bands + 1))


def build_filterbank(n_bands: int, sr: int,
                     fmin: float = FMIN_HZ, fmax: float = FMAX_HZ,
                     order: int = 4) -> tuple[list[np.ndarray], np.ndarray]:
    """返回 (每带的二阶节系数列表, 频带边界)。4 阶 Butterworth 带通级联。"""
    edges = erb_edges(n_bands, sr, fmin, fmax)
    sos_list = []
    for lo, hi in zip(edges[:-1], edges[1:]):
        sos = butter(order, [lo / (sr / 2), hi / (sr / 2)],
                     btype="bandpass", output="sos")
        sos_list.append(sos)
    return sos_list, edges


def _sosfilt_safe(sos: np.ndarray, x: np.ndarray) -> np.ndarray:
    # sosfilt 对短信号也能直接工作(零初始状态, 起振瞬态由首尾淡化兜底)。
    return sosfilt(sos, x)


def filter_bank(x: np.ndarray,
                sos_list: list[np.ndarray]) -> np.ndarray:
    """返回 (n_bands, n_samples) 的分带信号。"""
    return np.vstack([_sosfilt_safe(sos, x) for sos in sos_list])


def follow_envelopes(bands: np.ndarray, sr: int,
                     attack_ms: float, release_ms: float,
                     gate_ratio: float = 0.01) -> np.ndarray:
    """逐带包络跟随。

    整流后用 attack/release 两个一阶低通(时间常数即输入的毫秒数),
    实现经典的快攻快放/慢攻慢放效果; 输出与分带信号同形状, 恒非负。
    带噪声门: 整流输入低于该带峰值的 gate_ratio 时强制归零,
    保证调制声的天然静音段不会被长 release 拖出尾巴。
    """
    a_tau = max(1e-4, attack_ms / 1000.0)
    r_tau = max(1e-4, release_ms / 1000.0)
    a_coef = math.exp(-1.0 / (sr * a_tau))
    r_coef = math.exp(-1.0 / (sr * r_tau))
    rect = np.abs(bands)
    gate = rect.max(axis=1, keepdims=True) * gate_ratio
    open_gate = rect > gate
    env = np.zeros_like(rect)
    prev = np.zeros(bands.shape[0])
    one_minus_a, one_minus_r = 1.0 - a_coef, 1.0 - r_coef
    for i in range(rect.shape[1]):
        cur = rect[:, i]
        up = cur > prev
        prev = np.where(
            up,
            a_coef * prev + one_minus_a * cur,
            r_coef * prev + one_minus_r * cur,
        )
        prev = np.where(open_gate[:, i], prev, 0.0)
        env[:, i] = prev
    return env


# ---------------------------------------------------------------- 声码器
def vocode(modulator: np.ndarray, carrier: np.ndarray, sr: int,
           n_bands: int, attack_ms: float, release_ms: float,
           fmin: float = FMIN_HZ, fmax: float = FMAX_HZ
           ) -> dict:
    """通道声码器主流程。

    返回 dict:
      output            合成结果 (未经响度归一化, 交给保存/试听环节统一处理)
      mod_bands         调制声分带 (n_bands, n)
      car_bands         载波分带
      envelopes         调制包络 (n_bands, n)
      band_outputs      每带对输出的贡献 (n_bands, n), 供界面看"怎样影响输出"
      edges             频带边界
      carrier_energy    每带载波 RMS, 供界面显示"该带载波本来有没有能量"
    """
    if len(modulator) != len(carrier):
        raise ValueError("调制声与载波必须先对齐到同样长度")
    n_bands = int(n_bands)
    sos_list, edges = build_filterbank(n_bands, sr, fmin, fmax)

    mod_bands = filter_bank(modulator, sos_list)
    car_bands = filter_bank(carrier, sos_list)
    envelopes = follow_envelopes(mod_bands, sr, attack_ms, release_ms)

    # 逐带增益 = 包络按自身 RMS 归一化, 这样每带的输出强度由"调制起伏的形状"
    # 决定, 与该带调制声绝对幅度无关; 再按 1/sqrt(N) 等功率相加,
    # 频带数变化时整体响度保持可比。载波无能量的带 RMS 为 0, 自然保持静音,
    # 不靠混回原调制声补偿。
    car_rms = np.sqrt(np.mean(car_bands ** 2, axis=1, keepdims=True))
    env_rms = np.sqrt(np.mean(envelopes ** 2, axis=1, keepdims=True))
    safe_env = np.where(env_rms > 1e-8, envelopes / np.maximum(env_rms, 1e-8), 0.0)
    band_gain = safe_env * car_rms / math.sqrt(n_bands)
    band_outputs = car_bands * band_gain
    output = band_outputs.sum(axis=0)

    carrier_energy = car_rms.ravel()
    return {
        "output": output,
        "mod_bands": mod_bands,
        "car_bands": car_bands,
        "envelopes": envelopes,
        "band_outputs": band_outputs,
        "edges": edges,
        "carrier_energy": carrier_energy,
    }


def downsample_mean(y: np.ndarray, max_points: int = 2048) -> np.ndarray:
    """非负曲线(包络、能量)绘图降采样: 分块取均值。"""
    y = np.asarray(y, dtype=np.float64)
    if len(y) <= max_points:
        return y
    return np.array([np.mean(b) for b in np.array_split(y, max_points)])


def downsample_minmax(y: np.ndarray, max_points: int = 2048
                      ) -> tuple[np.ndarray, np.ndarray]:
    """带符号波形绘图降采样: 每块返回 (最小值, 最大值), 保留峰谷形态。"""
    y = np.asarray(y, dtype=np.float64)
    if len(y) <= max_points:
        return y, y
    blocks = np.array_split(y, max_points)
    lo = np.array([np.min(b) for b in blocks])
    hi = np.array([np.max(b) for b in blocks])
    return lo, hi
