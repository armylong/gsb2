"""自生成测试样例：稳态、突然增强、突然减弱、静音、立体声不平衡。"""

from __future__ import annotations

import numpy as np

from .dsp import db_to_amp

FS = 48000


def _tone(fs: int, t0: float, t1: float, freq: float, level_db: float,
          phase: float = 0.0) -> np.ndarray:
    n0, n1 = int(round(t0 * fs)), int(round(t1 * fs))
    t = np.arange(n0, n1) / fs
    return db_to_amp(np.array(level_db)) * np.sin(
        2 * np.pi * freq * t + phase)


def make_sample(fs: int = FS) -> np.ndarray:
    """12 秒立体声样例，分段边界不加淡入淡出，便于观察起音/恢复。

    分段（秒）：
      0.0–1.0  静音
      1.0–3.5  稳态 -24 dBFS（220 Hz）
      3.5–6.0  突然增强到 -12 dBFS（440 Hz）
      6.0–8.5  突然减弱回 -24 dBFS（220 Hz）
      8.5–10.0 静音
     10.0–12.0 立体声不平衡：左 -18 / 右 -12 dBFS（验证 link 同比例衰减）
    """
    total = int(round(12.0 * fs))
    left = np.zeros(total, dtype=np.float64)
    right = np.zeros(total, dtype=np.float64)

    segs = [
        # (t0, t1, freq, level_db)
        (1.0, 3.5, 220.0, -24.0),
        (3.5, 6.0, 440.0, -12.0),
        (6.0, 8.5, 220.0, -24.0),
    ]
    for t0, t1, freq, level in segs:
        n0, n1 = int(round(t0 * fs)), int(round(t1 * fs))
        tone = _tone(fs, t0, t1, freq, level)
        left[n0:n1] = tone
        right[n0:n1] = tone

    n0 = int(round(10.0 * fs))
    left[n0:] = _tone(fs, 10.0, 12.0, 330.0, -18.0)
    right[n0:] = _tone(fs, 10.0, 12.0, 330.0, -12.0)

    return np.stack([left, right], axis=1)
