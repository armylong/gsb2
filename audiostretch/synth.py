"""内置样例合成与校验: 固定音高的立体声样例 + 主频/时长测量."""
from __future__ import annotations

import numpy as np


def make_demo(sr: int = 44100, sec: float = 2.0, f0: float = 220.0) -> tuple[np.ndarray, int]:
    """生成带固定音高的环境音样例: f0 基频 + 泛音 + 慢起伏 + 少量噪声, 立体声。"""
    t = np.arange(int(sr * sec), dtype=np.float32) / sr
    env = 0.6 + 0.4 * np.sin(2 * np.pi * 0.7 * t)          # 慢起伏制造纹理
    left = (np.sin(2 * np.pi * f0 * t)
            + 0.5 * np.sin(2 * np.pi * 2 * f0 * t)
            + 0.25 * np.sin(2 * np.pi * 3 * f0 * t)) * env
    right = (np.sin(2 * np.pi * f0 * t + 0.3)               # 固定相位差, 保持立体声对应
             + 0.5 * np.sin(2 * np.pi * 2 * f0 * t + 0.1)
             + 0.25 * np.sin(2 * np.pi * 3 * f0 * t)) * env
    rng = np.random.default_rng(1234)
    noise = rng.normal(0, 0.02, len(t)).astype(np.float32)
    audio = np.stack([left, right], axis=1) * 0.5 + noise[:, None]
    # 首尾 10ms 淡出, 避免样例自身爆音
    fade = int(0.01 * sr)
    ramp = np.linspace(1.0, 0.0, fade, dtype=np.float32)[:, None]
    audio[-fade:] *= ramp
    return audio.astype(np.float32), sr


def dominant_freq(x: np.ndarray, sr: int) -> float:
    """FFT 峰值主频(抛物线插值), 单声道输入或立体声取左声道。"""
    if x.ndim == 2:
        x = x[:, 0]
    n = len(x)
    spec = np.abs(np.fft.rfft(x * np.hanning(n)))
    k = int(np.argmax(spec[1:])) + 1
    if 0 < k < len(spec) - 1:
        a, b, c = spec[k - 1], spec[k], spec[k + 1]
        denom = a - 2 * b + c  # 峰值处为负
        if abs(denom) > 1e-12:
            k = k + 0.5 * (a - c) / denom
    return k * sr / n
