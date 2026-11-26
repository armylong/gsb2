"""程序生成的 AmbiX 四声道样例: 一个固定方位声源 + 一个绕圈声源。"""

from __future__ import annotations

import numpy as np

from .dsp import IDX_W, IDX_X, IDX_Y, SQRT3, plane_wave

DURATION = 8.0


def _tone(t: np.ndarray, f0: float, harmonics=(1.0, 0.4, 0.15)) -> np.ndarray:
    out = np.zeros_like(t)
    for k, amp in enumerate(harmonics, start=1):
        out += amp * np.sin(2 * np.pi * f0 * k * t)
    return out / sum(harmonics)


def make_sample(sr: int = 48000, duration: float = DURATION) -> np.ndarray:
    """返回 (N,4) AmbiX/SN3D float64。

    声源 A: 固定在左前方 60°(+60°, 即 +X 与 +Y 之间), 440 Hz 复合音。
    声源 B: 在水平面匀速绕圈, 每 4 秒一圈(逆时针), 720 Hz 颤音。
    """
    n = int(round(sr * duration))
    t = np.arange(n, dtype=np.float64) / sr

    # 端点淡入淡出, 避免咔哒声
    fade = int(0.05 * sr)
    env = np.ones(n)
    env[:fade] = np.linspace(0, 1, fade)
    env[-fade:] = np.linspace(1, 0, fade)

    # 声源 A —— 固定 +60°
    sig_a = 0.5 * _tone(t, 440.0) * (0.85 + 0.15 * np.sin(2 * np.pi * 0.7 * t))
    b = plane_wave(60.0, sig_a)

    # 声源 B —— 绕圈, 0.25 Hz 逆时针, 从正前方出发
    az_b = 2 * np.pi * 0.25 * t
    sig_b = 0.4 * np.sin(2 * np.pi * 720.0 * t) * (0.7 + 0.3 * np.sin(2 * np.pi * 5.0 * t))
    b[:, IDX_W] += sig_b
    b[:, IDX_Y] += SQRT3 * sig_b * np.sin(az_b)
    b[:, IDX_X] += SQRT3 * sig_b * np.cos(az_b)
    # Z 恒为 0: 两个声源都在水平面内

    b *= env[:, None]
    return b


def source_azimuth_b(t: float) -> float:
    """样例中绕圈声源 B 在 t 秒的理论方位(度), 供校验与界面参考。"""
    return (360.0 * 0.25 * t) % 360.0
