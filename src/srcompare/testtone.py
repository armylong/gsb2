# -*- coding: utf-8 -*-
"""程序生成测试音, 无需用户提供录音。

三个预设:
1. stereo_independence : 左右不同 —— L=1k+2k+12k, R=1k。
   - 1kHz 通带(左右共有): 通带幅度变化
   - 12kHz(仅左, 高于 16k 目标奈奎斯特): 折叠到 4kHz 的混叠测量
   - 2kHz(仅左, 始终在任何目标率通带内): 左右串音测量
2. mixed_tones         : 高频混合 —— 1kHz + 12kHz, 双声道同内容。
3. low_tone            : 低频 —— 400Hz, 双声道同内容。

信号首尾各 20ms 余弦淡入淡出, 避免起止瞬态污染频谱。
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .audioio import Track


@dataclass(frozen=True)
class ToneSpec:
    """一个单音分量的定义。"""

    freq: float          # Hz
    amplitude: float     # 线性幅度
    channels: tuple      # 出现在哪些声道, 例如 (0,) 或 (0, 1)
    label: str = ""


FADE_SEC = 0.02
TONE_PRESETS = {
    "stereo_independence": {
        "title": "左右不同 (L:1k+2k+12k / R:1k)",
        "specs": [
            ToneSpec(1000.0, 0.35, (0, 1), "通带 1kHz, 左右都有"),
            ToneSpec(2000.0, 0.30, (0,), "通带 2kHz, 仅左声道(测串音)"),
            ToneSpec(12000.0, 0.35, (0,), "高频 12kHz, 仅左声道(测混叠)"),
        ],
    },
    "mixed_tones": {
        "title": "高频混合 (1kHz + 12kHz)",
        "specs": [
            ToneSpec(1000.0, 0.35, (0, 1), "通带 1kHz"),
            ToneSpec(12000.0, 0.35, (0, 1), "高频 12kHz"),
        ],
    },
    "low_tone": {
        "title": "低频 (400Hz)",
        "specs": [
            ToneSpec(400.0, 0.5, (0, 1), "低频 400Hz"),
        ],
    },
}


def make_test_tone(preset_key: str, sr: int, duration: float = 2.0) -> Track:
    """按预设生成 float32 测试音, 立体声形状 (N, 2)。"""
    if preset_key not in TONE_PRESETS:
        raise KeyError(f"未知测试音预设: {preset_key}")
    preset = TONE_PRESETS[preset_key]
    n = int(round(sr * duration))
    t = np.arange(n, dtype=np.float64) / float(sr)
    x = np.zeros((n, 2), dtype=np.float64)

    for spec in preset["specs"]:
        wave_ = spec.amplitude * np.sin(2.0 * np.pi * spec.freq * t)
        for ch in spec.channels:
            x[:, ch] += wave_

    n_fade = max(1, int(round(FADE_SEC * sr)))
    n_fade = min(n_fade, n // 4)
    fade = 0.5 - 0.5 * np.cos(np.linspace(0.0, np.pi, n_fade))
    x[:n_fade] *= fade[:, None]
    x[-n_fade:] *= fade[::-1][:, None]

    peak = float(np.max(np.abs(x)))
    if peak > 0.95:  # 等比例整体保护, 不属于响度归一化
        x = x * (0.95 / peak)

    return Track(
        name=f"测试音/{preset['title']} @ {sr/1000:.1f}kHz",
        sr=sr,
        samples=np.ascontiguousarray(x, dtype=np.float32),
        kind="tone",
        tone_specs=list(preset["specs"]),
        source_name=f"generated:{preset_key}",
        note="程序生成",
    )
