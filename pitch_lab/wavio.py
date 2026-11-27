"""短单声道 WAV 读取（支持 8/16/24/32 bit PCM 与 32-bit float）。"""

from __future__ import annotations

import numpy as np
from scipy.io import wavfile


def load_wav(path: str) -> tuple[np.ndarray, int]:
    """返回 (float64 单声道信号, 采样率)。多声道混缩为单声道。"""
    fs, data = wavfile.read(path)
    if data.ndim == 2:
        data = data.mean(axis=1)
    data = np.asarray(data)

    if data.dtype == np.uint8:
        x = (data.astype(np.float64) - 128.0) / 128.0
    elif np.issubdtype(data.dtype, np.integer):
        max_val = float(2 ** (8 * data.dtype.itemsize - 1))
        x = data.astype(np.float64) / max_val
    elif data.dtype == np.float32 or data.dtype == np.float64:
        x = data.astype(np.float64)
    else:
        raise ValueError(f"不支持的 WAV 采样格式: {data.dtype}")

    x = np.nan_to_num(x, nan=0.0, posinf=0.0, neginf=0.0)
    if x.size == 0:
        raise ValueError("WAV 文件为空")
    peak = float(np.max(np.abs(x)))
    if peak > 1.0:
        x /= peak
    return x, int(fs)
