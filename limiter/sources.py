"""内置测试素材合成：窄脉冲、连续音、立体声，以及短于提前量的样例。"""

from __future__ import annotations

import numpy as np


def gen_pulse(fs: float = 48000.0, duration_ms: float = 60.0,
              amp: float = 0.95) -> tuple[np.ndarray, dict]:
    """单声道窄脉冲：单个全幅采样尖峰 + 一个稍后的次尖峰，背景近乎静音。

    脉冲宽度只有 1 个采样，专门用来检验提前量能否在尖峰到达前压下去。
    """
    n = int(round(fs * duration_ms / 1000.0))
    x = np.zeros(n, dtype=np.float64)
    i1 = n // 3
    i2 = int(n * 0.72)
    x[i1] = amp
    x[i2] = amp * 0.7
    # 极轻的底噪，避免完全静音时图表看起来是死的。
    rng = np.random.default_rng(7)
    x += rng.normal(0, 2e-5, n)
    meta = {"name": "窄脉冲（单声道）", "peaks_idx": [i1, i2]}
    return x, meta


def gen_tone(fs: float = 48000.0, duration_ms: float = 200.0,
             freq: float = 1000.0, amp: float = 0.9) -> tuple[np.ndarray, dict]:
    """单声道连续正弦音，带淡入淡出，稳态幅度恒定。"""
    n = int(round(fs * duration_ms / 1000.0))
    t = np.arange(n) / fs
    x = amp * np.sin(2 * np.pi * freq * t)
    fade = max(1, n // 200)
    x[:fade] *= np.linspace(0, 1, fade)
    x[-fade:] *= np.linspace(1, 0, fade)
    meta = {"name": f"连续音 {freq:g}Hz（单声道）", "peaks_idx": []}
    return x, meta


def gen_stereo(fs: float = 48000.0, duration_ms: float = 200.0
               ) -> tuple[np.ndarray, dict]:
    """立体声素材：左右不同内容 + 仅一侧的尖峰，用于核对联动与声像。

    L 侧 440Hz、R 侧 660Hz；尖峰只打在 R 声道。
    联动模式下 L 也会被一起拉低（声像保持），独立模式下只有 R 被压
    （声像向 L 偏移）—— 切换联动即可在界面上核对这个差别。
    """
    n = int(round(fs * duration_ms / 1000.0))
    t = np.arange(n) / fs
    x = np.column_stack([
        0.30 * np.sin(2 * np.pi * 440.0 * t),
        0.30 * np.sin(2 * np.pi * 660.0 * t),
    ])
    i = int(n * 0.4)
    x[i, 1] = 0.95  # 仅右声道尖峰
    rng = np.random.default_rng(11)
    x += rng.normal(0, 2e-5, x.shape)
    meta = {"name": "立体声（尖峰仅在 R）", "peaks_idx": [i]}
    return x, meta


def gen_short(fs: float = 48000.0, duration_ms: float = 1.0
              ) -> tuple[np.ndarray, dict]:
    """超短文件样例：总时长默认 1ms（48 个采样），刻意短于常用提前量。

    用来验证 lookahead 比文件还长时，窗口最小值传播仍然正确、
    输出等长且尖峰照样被压住（队列在边界处自然处理，无越界）。
    """
    n = max(2, int(round(fs * duration_ms / 1000.0)))
    x = np.zeros(n, dtype=np.float64)
    x[n // 2] = 0.98
    meta = {"name": f"超短脉冲 {n} 采样（短于提前量）", "peaks_idx": [n // 2]}
    return x, meta


SOURCES = {
    "pulse": gen_pulse,
    "tone": gen_tone,
    "stereo": gen_stereo,
    "short": gen_short,
}
