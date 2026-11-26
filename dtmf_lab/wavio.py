"""本地 wav 读写 (scipy.io.wavfile), 统一转成 float32 单声道."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np
from scipy.io import wavfile


@dataclass
class AudioClip:
    samples: np.ndarray
    sample_rate: int
    source: str = ""

    @property
    def duration(self) -> float:
        return len(self.samples) / float(self.sample_rate)


def _to_mono_float(data: np.ndarray) -> np.ndarray:
    if data.dtype.kind == "i":
        info = np.iinfo(data.dtype)
        scale = float(max(abs(info.min), info.max))
        out = data.astype(np.float64) / scale
    elif data.dtype.kind == "u":
        info = np.iinfo(data.dtype)
        mid = (info.max + 1) / 2.0
        out = (data.astype(np.float64) - mid) / mid
    elif data.dtype.kind == "f":
        out = data.astype(np.float64)
    else:
        raise ValueError(f"不支持的 wav 数据类型: {data.dtype}")
    if out.ndim == 2:
        out = out.mean(axis=1)
    return out.astype(np.float32)


def load_wav(path: str | Path) -> AudioClip:
    path = Path(path)
    if not path.is_file():
        raise FileNotFoundError(f"找不到音频文件: {path}")
    rate, data = wavfile.read(str(path), mmap=False)
    if data.size == 0:
        raise ValueError(f"音频文件是空的: {path.name}")
    return AudioClip(samples=_to_mono_float(np.asarray(data)), sample_rate=int(rate), source=str(path))


def save_wav(path: str | Path, samples: np.ndarray, sample_rate: int) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    arr = np.asarray(samples, dtype=np.float64)
    if arr.ndim != 1:
        raise ValueError("只写出单声道 wav")
    peak = float(np.max(np.abs(arr))) if arr.size else 0.0
    if peak > 1.0:
        arr = arr / peak
    pcm = np.clip(np.round(arr * 32767.0), -32768, 32767).astype(np.int16)
    wavfile.write(str(path), int(sample_rate), pcm)
