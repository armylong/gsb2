"""WAV 读写与播放。"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np
import soundfile as sf

from . import MAX_DURATION_SEC


@dataclass
class AudioData:
    samples: np.ndarray  # float32, 1D 单声道或 (n, 2) 立体声, 范围 [-1, 1]
    sr: int
    path: str | None = None

    @property
    def channels(self) -> int:
        return 1 if self.samples.ndim == 1 else self.samples.shape[1]

    @property
    def duration(self) -> float:
        return len(self.samples) / self.sr

    def mono(self) -> np.ndarray:
        if self.samples.ndim == 1:
            return self.samples
        return self.samples.mean(axis=1)

    def channel_view(self, which: str) -> np.ndarray:
        """which: 'L' | 'R' | 'mix'。单声道时一律返回自身。"""
        if self.samples.ndim == 1:
            return self.samples
        if which == "L":
            return self.samples[:, 0]
        if which == "R":
            return self.samples[:, 1]
        return self.samples.mean(axis=1)


def load_wav(path: str | Path) -> AudioData:
    """读取 wav, 限制 60 秒以内; 统一转 float32, 单声道/立体声皆可。"""
    info = sf.info(str(path))
    if info.duration > MAX_DURATION_SEC + 1e-6:
        raise ValueError(
            f"音频时长 {info.duration:.1f}s 超过 {MAX_DURATION_SEC:.0f}s 上限, "
            "当前版本只支持一分钟以内的 wav"
        )
    if info.channels not in (1, 2):
        raise ValueError(f"只支持单声道或立体声 wav, 当前声道数={info.channels}")
    if "WAV" not in info.format:
        raise ValueError(f"只支持 wav 文件, 当前格式={info.format}")

    data, sr = sf.read(str(path), dtype="float32", always_2d=False)
    if data.ndim == 2 and data.shape[1] == 1:
        data = data[:, 0]
    return AudioData(samples=np.ascontiguousarray(data), sr=sr, path=str(path))


def save_wav(path: str | Path, samples: np.ndarray, sr: int) -> None:
    """原样参数写回: 同采样率、同声道布局、同采样点数。"""
    sf.write(str(path), samples, sr, subtype="PCM_16", format="WAV")
