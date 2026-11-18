"""程序生成的测试音: 多频正弦混合与左右独立测试信号。供界面试听与自动测试共用。"""
from __future__ import annotations

import numpy as np

# 代表性频点 (Hz), 覆盖低架 / 峰值 / 高架各段区域
TEST_FREQS = [60, 120, 250, 500, 1000, 2000, 4000, 8000, 12000, 16000]


def multitone(sr: int, dur: float, freqs=None, amp: float = 0.5) -> np.ndarray:
    """等幅多频正弦混合, 峰值归一到 amp。频点对齐到 FFT  bin 以便稳态测量。"""
    if freqs is None:
        freqs = [f for f in TEST_FREQS if f < 0.45 * sr]
    n = int(sr * dur)
    t = np.arange(n) / sr
    x = np.zeros(n)
    for f in freqs:
        x += np.sin(2 * np.pi * f * t)
    x /= np.max(np.abs(x))
    return (x * amp).astype(np.float32)


def stereo_test(sr: int, dur: float = 5.0) -> np.ndarray:
    """左右独立测试音: 左声道低频混合, 右声道高频混合, 便于验证声道独立处理。"""
    left = multitone(sr, dur, freqs=[80, 200, 500], amp=0.4)
    right = multitone(sr, dur, freqs=[1000, 3000, 9000], amp=0.4)
    return np.stack([left, right], axis=1)


def sine(sr: int, dur: float, freq: float, amp: float = 0.5) -> np.ndarray:
    n = int(sr * dur)
    t = np.arange(n) / sr
    return (amp * np.sin(2 * np.pi * freq * t)).astype(np.float32)
