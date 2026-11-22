"""WAV 读写: 统一转 float32 [-1, 1], 导出单声道 int16。"""
from __future__ import annotations

import numpy as np
from scipy.io import wavfile


def read_wav(path: str):
    """读取 wav, 返回 (data float32 [样本, 声道], sample_rate)。

    支持 8/16/24/32-bit PCM 与 32/64-bit float。单声道返回形状 [n, 1]。
    """
    sr, raw = wavfile.read(path)
    if raw.ndim == 1:
        raw = raw[:, None]

    if np.issubdtype(raw.dtype, np.floating):
        data = raw.astype(np.float32, copy=True)
    else:
        max_val = float(np.iinfo(raw.dtype).max)
        # uint8 等无符号类型先平移
        if np.issubdtype(raw.dtype, np.unsignedinteger):
            raw = raw.astype(np.int16) - 128
            max_val = 128.0
        data = raw.astype(np.float32) / max_val

    data = np.clip(data, -1.0, 1.0)
    return data, int(sr)


def write_wav_mono(path: str, mono: np.ndarray, sr: int) -> None:
    """把单声道 float 波形写成 int16 PCM wav。"""
    mono = np.asarray(mono, dtype=np.float64)
    if mono.ndim != 1:
        raise ValueError("导出只支持单声道")
    clipped = np.clip(mono, -1.0, 1.0)
    pcm16 = np.round(clipped * 32767.0).astype(np.int16)
    wavfile.write(path, int(sr), pcm16)
