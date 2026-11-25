"""内置声音生成: 间歇噪声 / 窄带噪声背景, 以及几类典型提示音。

所有生成结果峰值归一到 0.9, 实际响度交给界面上的电平推子,
这样各路的相对电平只由推子决定, 不会被生成参数隐式改变。
"""

from __future__ import annotations

import numpy as np


def _normalize_peak(x: np.ndarray, peak: float = 0.9) -> np.ndarray:
    m = float(np.max(np.abs(x))) if x.size else 0.0
    if m > 1e-9:
        return x * (peak / m)
    return x


def apply_fades(x: np.ndarray, sr: int, fade_ms: float = 8.0) -> np.ndarray:
    """首尾余弦淡入淡出, 避免循环/截断产生咔哒声。"""
    n = max(1, int(sr * fade_ms / 1000.0))
    n = min(n, max(1, x.size // 2))
    ramp = 0.5 - 0.5 * np.cos(np.linspace(0.0, np.pi, n))
    y = x.copy()
    y[:n] *= ramp
    y[-n:] *= ramp[::-1]
    return y


def band_limited_noise(
    sr: int,
    n: int,
    f_low: float,
    f_high: float,
    rng: np.random.Generator | None = None,
) -> np.ndarray:
    """用 FDF 掩码在频域做带限白噪声 (实信号, 共轭对称)。"""
    rng = rng or np.random.default_rng()
    spec = np.zeros(n // 2 + 1, dtype=np.complex128)
    freqs = np.fft.rfftfreq(n, 1.0 / sr)
    mask = (freqs >= f_low) & (freqs <= f_high)
    n_bins = int(mask.sum())
    if n_bins == 0:
        return np.zeros(n)
    mag = rng.rayleigh(size=n_bins)
    phase = np.exp(1j * rng.uniform(0.0, 2.0 * np.pi, n_bins))
    spec[mask] = mag * phase
    y = np.fft.irfft(spec, n)
    return _normalize_peak(y)


def intermittent_noise(
    sr: int = 22050,
    duration: float = 6.0,
    f_low: float = 400.0,
    f_high: float = 900.0,
    on_ms: float = 450.0,
    off_ms: float = 550.0,
    seed: int = 7,
) -> np.ndarray:
    """间歇宽带/带限噪声: 周期性门控的噪声团, 模拟办公室一阵一阵的说话/设备声。"""
    rng = np.random.default_rng(seed)
    n = int(round(sr * duration))
    base = band_limited_noise(sr, n, f_low, f_high, rng)
    gate = np.zeros(n)
    on = max(1, int(sr * on_ms / 1000.0))
    off = max(1, int(sr * off_ms / 1000.0))
    pos = 0
    while pos < n:
        end = min(pos + on, n)
        gate[pos:end] = 1.0
        pos += on + off
    # 每个门的边沿加 20ms 余弦斜坡
    edge = max(1, int(sr * 0.02))
    gated = base * gate
    for start in range(0, n, on + off):
        s0, s1 = start, min(start + edge, n)
        if s1 > s0:
            gated[s0:s1] *= 0.5 - 0.5 * np.cos(np.linspace(0, np.pi, s1 - s0))
        e0, e1 = max(0, min(start + on - edge, n)), min(start + on, n)
        if e1 > e0:
            gated[e0:e1] *= 0.5 - 0.5 * np.cos(np.linspace(np.pi, 0, e1 - e0))
    return apply_fades(_normalize_peak(gated), sr)


def narrowband_noise(
    sr: int = 22050,
    duration: float = 6.0,
    center: float = 2000.0,
    width: float = 240.0,
    am_hz: float = 3.0,
    seed: int = 23,
) -> np.ndarray:
    """窄带噪声 + 慢速幅度调制: 模拟空调/风扇那种持续但忽强忽弱的嗡嗡声。"""
    rng = np.random.default_rng(seed)
    n = int(round(sr * duration))
    y = band_limited_noise(sr, n, center - width / 2, center + width / 2, rng)
    t = np.arange(n) / sr
    am = 0.5 + 0.5 * np.cos(2.0 * np.pi * am_hz * t)
    return apply_fades(_normalize_peak(y * am), sr)


def tone_cue(
    sr: int = 22050,
    duration: float = 0.9,
    freq: float = 1200.0,
    vibrato_hz: float = 0.0,
    seed: int = 1,
) -> np.ndarray:
    """单频提示音 (可选小幅颤音)。"""
    n = int(round(sr * duration))
    t = np.arange(n) / sr
    phase = 2.0 * np.pi * freq * t
    if vibrato_hz > 0:
        phase += 0.004 * sr / (2 * np.pi * vibrato_hz) * (
            1.0 - np.cos(2 * np.pi * vibrato_hz * t)
        )
    y = np.sin(phase)
    return apply_fades(_normalize_peak(y), sr, fade_ms=10.0)


def two_tone_cue(
    sr: int = 22050,
    duration: float = 0.9,
    f1: float = 880.0,
    f2: float = 1320.0,
    seed: int = 2,
) -> np.ndarray:
    """双音提示: 前半 f1, 后半 f2, 中间 30ms 交叉。"""
    n = int(round(sr * duration))
    half = n // 2
    cross = max(1, int(sr * 0.03))
    t = np.arange(n) / sr
    y = np.zeros(n)
    y[:half] = np.sin(2 * np.pi * f1 * t[:half])
    y[half:] = np.sin(2 * np.pi * f2 * t[half:])
    lo, hi = max(0, half - cross), min(n, half + cross)
    if hi > lo:
        ramp = 0.5 - 0.5 * np.cos(np.linspace(0, np.pi, hi - lo))
        y[lo:hi] = y[lo:hi] * (1.0 - ramp) + y[lo:hi] * ramp  # 保持连续
    return apply_fades(_normalize_peak(y), sr, fade_ms=10.0)


def chirp_cue(
    sr: int = 22050,
    duration: float = 1.0,
    f_start: float = 500.0,
    f_end: float = 2600.0,
    seed: int = 3,
) -> np.ndarray:
    """线性扫频提示音。"""
    n = int(round(sr * duration))
    t = np.arange(n) / sr
    phase = 2 * np.pi * (f_start * t + 0.5 * (f_end - f_start) * t**2 / duration)
    y = np.sin(phase)
    return apply_fades(_normalize_peak(y), sr, fade_ms=10.0)


def narrowband_cue(
    sr: int = 22050,
    duration: float = 0.8,
    center: float = 2500.0,
    width: float = 160.0,
    seed: int = 4,
) -> np.ndarray:
    """窄带噪声提示音: 和纯音提示做可分辨性对比用。"""
    rng = np.random.default_rng(seed)
    n = int(round(sr * duration))
    y = band_limited_noise(sr, n, center - width / 2, center + width / 2, rng)
    return apply_fades(_normalize_peak(y), sr, fade_ms=10.0)
