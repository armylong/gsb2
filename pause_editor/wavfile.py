"""WAV 读写: 只用标准库 ``wave`` 加 numpy, 不引入 scipy.

读入后内部统一为 ``float64``、取值 ``[-1, 1]``、形状 ``(采样数, 声道数)``。
写回默认按原位深输出 PCM, 超界样本做硬限幅并返回限幅计数。
"""

from __future__ import annotations

import math
import wave
from dataclasses import dataclass

import numpy as np

# 支持的 PCM 位深 -> 每采样字节数
_SUPPORTED_SAMPWIDTH = (1, 2, 3, 4)


@dataclass
class AudioData:
    """一段在内存中的音频。"""

    samples: np.ndarray  # float64, shape (n, channels), [-1, 1]
    sample_rate: int

    @property
    def n_samples(self) -> int:
        return int(self.samples.shape[0])

    @property
    def n_channels(self) -> int:
        return int(self.samples.shape[1])

    @property
    def duration(self) -> float:
        return self.n_samples / self.sample_rate


def read_wav(path: str) -> AudioData:
    """读取 PCM WAV (8/16/24/32-bit, 任意声道)。"""
    with wave.open(path, "rb") as wf:
        n_channels = wf.getnchannels()
        sampwidth = wf.getsampwidth()
        sample_rate = wf.getframerate()
        n_frames = wf.getnframes()
        raw = wf.readframes(n_frames)

    if sampwidth not in _SUPPORTED_SAMPWIDTH:
        raise ValueError(f"暂不支持 {sampwidth * 8}-bit WAV, 请先用 8/16/24/32-bit PCM")
    if n_frames == 0:
        raise ValueError("WAV 文件没有任何采样帧")

    if sampwidth == 1:
        # 8-bit PCM 是无符号的
        flat = (np.frombuffer(raw, dtype=np.uint8).astype(np.float64) - 128.0) / 128.0
    elif sampwidth == 2:
        flat = np.frombuffer(raw, dtype="<i2").astype(np.float64) / 32768.0
    elif sampwidth == 4:
        flat = np.frombuffer(raw, dtype="<i4").astype(np.float64) / 2147483648.0
    else:  # 24-bit, 小端有符号
        b = np.frombuffer(raw, dtype=np.uint8).reshape(-1, 3)
        as32 = b[:, 0].astype(np.int32) | (b[:, 1].astype(np.int32) << 8) | (
            b[:, 2].astype(np.int32) << 16
        )
        # 符号扩展
        as32 = np.where(as32 & 0x800000, as32 - 0x1000000, as32)
        flat = as32.astype(np.float64) / 8388608.0

    samples = flat.reshape(-1, n_channels)
    return AudioData(samples=samples, sample_rate=sample_rate)


def write_wav(path: str, audio: AudioData, sampwidth: int = 2) -> int:
    """写 PCM WAV, 返回被限幅的样本数(按帧计, 任一声道超界即算)。"""
    if sampwidth not in _SUPPORTED_SAMPWIDTH:
        raise ValueError("sampwidth 只支持 1/2/3/4 字节")

    x = np.asarray(audio.samples, dtype=np.float64)
    if x.ndim == 1:
        x = x[:, None]
    clipped = int(np.count_nonzero(np.abs(x) > 1.0))
    x = np.clip(x, -1.0, 1.0)

    if sampwidth == 1:
        q = np.round(x * 128.0 + 128.0).astype(np.uint8)
        raw = q.tobytes()
    elif sampwidth == 2:
        q = np.round(x * 32767.0).astype("<i2")
        raw = q.tobytes()
    elif sampwidth == 4:
        q = np.round(x * 2147483647.0).astype("<i4")
        raw = q.tobytes()
    else:
        q = np.round(x * 8388607.0).astype(np.int32)
        q = np.clip(q, -8388608, 8388607)
        b0 = (q & 0xFF).astype(np.uint8)
        b1 = ((q >> 8) & 0xFF).astype(np.uint8)
        b2 = ((q >> 16) & 0xFF).astype(np.uint8)
        raw = np.stack([b0, b1, b2], axis=-1).reshape(-1).tobytes()

    with wave.open(path, "wb") as wf:
        wf.setnchannels(x.shape[1])
        wf.setsampwidth(sampwidth)
        wf.setframerate(audio.sample_rate)
        wf.writeframes(raw)
    return clipped


def describe_format(path: str) -> str:
    """给界面/日志用的一行格式描述。"""
    with wave.open(path, "rb") as wf:
        return (
            f"{wf.getframerate()} Hz, {wf.getnchannels()} ch, "
            f"{wf.getsampwidth() * 8}-bit PCM, "
            f"{wf.getnframes()} 帧 ({wf.getnframes() / wf.getframerate():.3f}s)"
        )


def time_to_samples(seconds: float, sample_rate: int) -> int:
    return int(round(float(seconds) * sample_rate))


def samples_to_time(n: int, sample_rate: int) -> float:
    return int(n) / sample_rate


def nearest_even(v: float) -> int:
    """返回不大于 v 的最近偶数 (双声道淡入淡出长度等场景用)。"""
    k = int(math.floor(v))
    return k if k % 2 == 0 else max(0, k - 1)
