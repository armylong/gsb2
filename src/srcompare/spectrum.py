# -*- coding: utf-8 -*-
"""频谱分析: 真实赫兹坐标的 Welch 功率谱与单音能量测量。

所有频率坐标均为物理赫兹(Hz), 不使用归一化频率或 bin 序号。
"""
from __future__ import annotations

import numpy as np

from . import EDGE_DISCARD_SEC, TONE_BANDWIDTH_HZ


def welch_spectrum(
    x: np.ndarray, sr: int, nperseg: int = 4096
) -> tuple[np.ndarray, np.ndarray]:
    """计算单边功率谱密度 (PSD)。

    返回 (freqs_hz, psd)。加 Hann 窗、50% 重叠、段间平均。
    分段长度若超过信号长度则自动缩短到 2 的幂。
    """
    x = np.asarray(x, dtype=np.float64)
    n = len(x)
    seg = min(nperseg, 1 << (n - 1).bit_length())
    seg = max(8, seg)
    hop = seg // 2
    window = np.hanning(seg)
    # Hann 窗相干/非相干增益修正
    coherent = np.sum(window)
    energy_gain = np.sum(window**2)

    psd_acc = np.zeros(seg // 2 + 1)
    n_seg = 0
    for start in range(0, n - seg + 1, hop):
        seg_x = x[start : start + seg] * window
        spec = np.fft.rfft(seg_x, n=seg)
        psd_acc += (np.abs(spec) ** 2) / (sr * energy_gain)
        n_seg += 1
    if n_seg == 0:  # 极短信号兜底
        seg_x = x * window[:n]
        spec = np.fft.rfft(seg_x, n=seg)
        psd_acc = (np.abs(spec) ** 2) / (sr * np.sum(window[:n] ** 2))
        n_seg = 1
    psd = psd_acc / n_seg
    # 单边谱: 直流与奈奎斯特不翻倍, 其余能量 x2
    if seg > 1:
        psd[1:-1] *= 2.0
    freqs = np.fft.rfftfreq(seg, d=1.0 / sr)
    return freqs, psd


def psd_to_db(psd: np.ndarray, eps: float = 1e-15) -> np.ndarray:
    """PSD 转 dB(10log10), 仅用于相对比较与显示。"""
    return 10.0 * np.log10(np.maximum(psd, eps))


def alias_frequency(f_in: float, target_sr: int) -> float:
    """输入频率 f_in 经目标采样率采样后折叠到的真实频率(Hz)。"""
    fn = target_sr / 2.0
    if f_in <= fn:
        return f_in
    # 三角折叠: |f - k*fs| 取最小
    k = round(f_in / target_sr)
    f_alias = abs(f_in - k * target_sr)
    return float(min(f_alias, fn))


def tone_level_db(
    x: np.ndarray,
    sr: int,
    freq: float,
    bandwidth: float = TONE_BANDWIDTH_HZ,
    edge_discard_sec: float = EDGE_DISCARD_SEC,
) -> tuple[float, int, int]:
    """测量指定频率附近的单音能量(dB, 线性幅度参考)。

    测量区间: 舍弃首尾各 edge_discard_sec(滤波过渡/加窗瞬态),
    对剩余整段加 Hann 窗做一次长 FFT, 在 freq ± bandwidth Hz 内积分功率。
    返回 (level_db, 实际参与的样本起始下标, 结束下标)。
    """
    x = np.asarray(x, dtype=np.float64)
    n_trim = min(int(round(edge_discard_sec * sr)), len(x) // 4)
    i0, i1 = n_trim, len(x) - n_trim
    seg = x[i0:i1]
    n = len(seg)
    if n < 16:
        i0, i1 = 0, len(x)
        seg = x
        n = len(seg)

    window = np.hanning(n)
    # 归一化到"等效正弦幅度": FFT 幅度 / 窗相干增益
    coherent = np.sum(window)
    spec = np.fft.rfft(seg * window, n=n) / coherent
    freqs = np.fft.rfftfreq(n, d=1.0 / sr)
    mag2 = np.abs(spec) ** 2
    band = (freqs >= freq - bandwidth) & (freqs <= freq + bandwidth)
    power = float(np.sum(mag2[band]))  # 单边近似, 频点很窄时误差可忽略
    if n > 1 and freq > 0:
        power *= 2.0
    level = 10.0 * np.log10(max(power, 1e-20))
    return level, i0, i1


def measurement_window_text(sr: int) -> str:
    """测量区间与边界舍弃范围的文字说明。"""
    n_trim = int(round(EDGE_DISCARD_SEC * sr))
    return (
        f"测量区间: 舍弃首尾各 {EDGE_DISCARD_SEC*1000:.0f}ms ({n_trim} 个样本 @ {sr}Hz),"
        f" 剩余整段加 Hann 窗长 FFT, 单音积分半带宽 ±{TONE_BANDWIDTH_HZ:g}Hz"
    )
