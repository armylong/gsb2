# -*- coding: utf-8 -*-
"""WAV 文件读写与统一的音频数据结构。

内部统一使用 float32, 取值范围 [-1.0, 1.0]:
- 单声道形状 (N,), 立体声形状 (N, 2)
- 不做任何响度归一化, 读写只做 PCM <-> float 的位宽换算
"""
from __future__ import annotations

import os
import wave
from dataclasses import dataclass, field
from typing import Optional

import numpy as np
from scipy.io import wavfile

from . import ALLOWED_INPUT_RATES, MAX_DURATION_SEC


@dataclass
class Track:
    """一路音频(原始 / 线性插值 / 高质量)。"""

    name: str
    sr: int
    samples: np.ndarray                       # float32, (N,) 或 (N,2)
    kind: str = "general"                     # general | tone | result
    tone_specs: list = field(default_factory=list)
    source_name: str = ""
    note: str = ""

    @property
    def channels(self) -> int:
        return 1 if self.samples.ndim == 1 else self.samples.shape[1]

    @property
    def num_frames(self) -> int:
        return int(self.samples.shape[0])

    @property
    def duration(self) -> float:
        return self.num_frames / float(self.sr)

    def mono(self, channel: int = 0) -> np.ndarray:
        """取单通道数据用于绘图/测量。"""
        if self.samples.ndim == 1:
            return self.samples
        return self.samples[:, channel]


def _pcm24_to_float32(raw: bytes, n_frames: int, n_ch: int) -> np.ndarray:
    """24bit PCM(小端) -> float32。"""
    a = np.frombuffer(raw, dtype=np.uint8).reshape(-1, 3)
    # 拼成带符号 32bit
    i32 = (
        a[:, 0].astype(np.int32)
        | (a[:, 1].astype(np.int32) << 8)
        | (a[:, 2].astype(np.int32) << 16)
    )
    i32 = np.where(i32 & 0x800000, i32 - 0x1000000, i32)
    x = i32.astype(np.float32) / float(1 << 23)
    return x.reshape(n_frames, n_ch) if n_ch > 1 else x


def load_wav(path: str) -> Track:
    """读取单声道/立体声 WAV。

    限制: 采样率仅 44.1/48 kHz, 时长 <= 10 秒。
    注意: 只读取真实采样数据; 仅改写文件头里的采样率字段不构成转换,
    本工具从不采用那种做法。
    """
    path = os.path.abspath(path)
    with wave.open(path, "rb") as wf:
        n_ch = wf.getnchannels()
        sw = wf.getsampwidth()
        sr = wf.getframerate()
        n_frames = wf.getnframes()
        comp = wf.getcomptype()
        if comp != "NONE":
            raise ValueError(f"不支持压缩 WAV: {comp}")
        if n_ch not in (1, 2):
            raise ValueError(f"仅支持单声道或立体声, 当前声道数={n_ch}")
        if sr not in ALLOWED_INPUT_RATES:
            raise ValueError(
                f"输入采样率仅支持 {ALLOWED_INPUT_RATES} Hz, 当前={sr} Hz"
            )
        duration = n_frames / float(sr)
        if duration > MAX_DURATION_SEC + 1e-9:
            raise ValueError(
                f"音频时长 {duration:.3f}s 超过上限 {MAX_DURATION_SEC:.0f}s"
            )
        raw = wf.readframes(n_frames)

    if sw == 3:  # scipy 不支持 24bit, 自行解析
        data = _pcm24_to_float32(raw, n_frames, n_ch)
    else:
        rate, data = wavfile.read(path)
        assert rate == sr
        if np.issubdtype(data.dtype, np.integer):
            max_amp = float(1 << (8 * sw - 1))
            data = data.astype(np.float32) / max_amp
        elif data.dtype == np.float32:
            data = data.astype(np.float32)
        elif data.dtype == np.float64:
            data = data.astype(np.float32)
        else:
            raise ValueError(f"不支持的采样位宽/格式: {data.dtype}")
        if data.ndim == 2 and n_ch == 1:
            data = data[:, 0]

    data = np.ascontiguousarray(data, dtype=np.float32)
    peak = float(np.max(np.abs(data))) if data.size else 0.0
    if peak > 1.0:
        data = data / peak  # 极端超幅保护, 不改变正常文件响度

    return Track(
        name=os.path.basename(path),
        sr=sr,
        samples=data,
        kind="general",
        source_name=path,
        note=f"{n_ch}ch, {sw * 8}bit",
    )


def read_wav_any_rate(path: str) -> Track:
    """回读导出文件: 不限制采样率(允许 16kHz 等目标率), 仅校验声道数。

    与 load_wav 的输入限制(仅 44.1/48k、≤10s)区分开:
    用户输入走 load_wav, 自己导出的结果回读走这里。
    """
    path = os.path.abspath(path)
    with wave.open(path, "rb") as wf:
        n_ch = wf.getnchannels()
        sw = wf.getsampwidth()
        sr = wf.getframerate()
        n_frames = wf.getnframes()
        comp = wf.getcomptype()
        if comp != "NONE":
            raise ValueError(f"不支持压缩 WAV: {comp}")
        if n_ch not in (1, 2):
            raise ValueError(f"仅支持单声道或立体声, 当前声道数={n_ch}")
        raw = wf.readframes(n_frames)

    if sw == 3:
        data = _pcm24_to_float32(raw, n_frames, n_ch)
    else:
        rate, data = wavfile.read(path)
        assert rate == sr
        if np.issubdtype(data.dtype, np.integer):
            max_amp = float(1 << (8 * sw - 1))
            data = data.astype(np.float32) / max_amp
        else:
            data = data.astype(np.float32)
        if data.ndim == 2 and n_ch == 1:
            data = data[:, 0]

    data = np.ascontiguousarray(data, dtype=np.float32)
    return Track(
        name=os.path.basename(path),
        sr=sr,
        samples=data,
        kind="general",
        source_name=path,
        note=f"回读 {n_ch}ch, {sw * 8}bit",
    )


def save_wav(path: str, samples: np.ndarray, sr: int) -> None:
    """导出 16bit PCM WAV。两路导出使用完全相同的位深与换算, 不做响度处理。"""
    x = np.asarray(samples, dtype=np.float32)
    x = np.clip(x, -1.0, 1.0)
    pcm16 = np.round(x * 32768.0).astype(np.int16)
    # scipy 对 -32768 的 clamp 与 stereo 形状都能正确处理
    wavfile.write(path, int(sr), pcm16)
