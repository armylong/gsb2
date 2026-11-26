"""WAV 读取、重采样与写出。

只依赖标准库 + numpy/scipy，不要求 soundfile/ffmpeg。
"""
from __future__ import annotations

import wave
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from scipy.io import wavfile
from scipy.signal import resample_poly

TARGET_SR = 16000
MAX_DURATION_SEC = 60.0


class AudioLoadError(Exception):
    """输入音频无法使用（格式损坏/不支持）。"""


@dataclass
class LoadedAudio:
    samples: np.ndarray  # mono float64, TARGET_SR
    sample_rate: int      # original sample rate
    channels: int
    duration: float       # seconds after resampling
    path: str

    @property
    def raw_duration(self) -> float:
        return self.duration


def _decode_pcm_via_wave(path: Path) -> tuple[np.ndarray, int, int]:
    """wave 模块兜底解码，兼容 24-bit PCM（scipy 不支持 24-bit）。"""
    try:
        with wave.open(str(path), "rb") as wf:
            channels = wf.getnchannels()
            width = wf.getsampwidth()
            sr = wf.getframerate()
            nframes = wf.getnframes()
            raw = wf.readframes(nframes)
    except Exception as exc:  # noqa: BLE001
        raise AudioLoadError(f"无法读取 WAV: {exc}") from exc

    if width == 1:
        data = (np.frombuffer(raw, dtype=np.uint8).astype(np.float64) - 128.0) / 128.0
    elif width == 2:
        data = np.frombuffer(raw, dtype="<i2").astype(np.float64) / 32768.0
    elif width == 3:
        b = np.frombuffer(raw, dtype=np.uint8).reshape(-1, 3)
        vals = (b[:, 0].astype(np.int32)
                | (b[:, 1].astype(np.int32) << 8)
                | (b[:, 2].astype(np.int32) << 16))
        vals = np.where(vals & 0x800000, vals - 0x1000000, vals)
        data = vals.astype(np.float64) / 8388608.0
    elif width == 4:
        data = np.frombuffer(raw, dtype="<i4").astype(np.float64) / 2147483648.0
    else:
        raise AudioLoadError(f"不支持的 PCM 位宽: {width * 8} bit")

    if channels > 1:
        data = data.reshape(-1, channels).mean(axis=1)
    return data, sr, channels


def _read_wav(path: Path) -> tuple[np.ndarray, int, int]:
    try:
        sr, data = wavfile.read(str(path))
        channels = 1
        if data.ndim == 2:
            channels = data.shape[1]
            data = data.mean(axis=1)
        if data.dtype == np.uint8:
            data = (data.astype(np.float64) - 128.0) / 128.0
        elif np.issubdtype(data.dtype, np.integer):
            info = np.iinfo(data.dtype)
            data = data.astype(np.float64) / max(abs(info.min), info.max)
        else:
            data = data.astype(np.float64)
        return data, int(sr), channels
    except Exception:  # noqa: BLE001 - 退回 wave 模块，覆盖 24bit 等情况
        return _decode_pcm_via_wave(path)


def _resample(x: np.ndarray, sr: int) -> np.ndarray:
    if sr == TARGET_SR:
        return x
    from math import gcd

    g = gcd(int(sr), TARGET_SR)
    up, down = TARGET_SR // g, int(sr) // g
    return resample_poly(x, up, down)


def load_audio(path: str | Path, max_duration: float = MAX_DURATION_SEC) -> LoadedAudio:
    p = Path(path)
    if not p.is_file():
        raise AudioLoadError(f"文件不存在: {p}")
    if p.suffix.lower() not in {".wav", ".wave"}:
        raise AudioLoadError(f"仅支持 WAV 文件: {p.name}")

    data, sr, channels = _read_wav(p)
    data = np.asarray(data, dtype=np.float64)
    if data.size == 0:
        raise AudioLoadError("音频为空")
    if not np.all(np.isfinite(data)):
        data = np.nan_to_num(data, nan=0.0, posinf=0.0, neginf=0.0)
    if sr <= 0:
        raise AudioLoadError("采样率无效")
    if sr < 4000:
        raise AudioLoadError(f"采样率过低: {sr} Hz")

    peak = float(np.max(np.abs(data)))
    if peak <= 1e-7:
        # 全静音文件可用，但不要缩放
        pass
    else:
        data = data / peak if peak > 1.0 else data

    data = _resample(data, sr)
    data = data - float(np.mean(data))
    duration = len(data) / TARGET_SR
    if duration > max_duration:
        data = data[: int(max_duration * TARGET_SR)]
        duration = max_duration
    return LoadedAudio(samples=data, sample_rate=sr, channels=channels,
                       duration=duration, path=str(p))


def write_wav(path: str | Path, samples: np.ndarray, sr: int = TARGET_SR) -> None:
    """归一化后写 16-bit PCM WAV，供试听/导出。"""
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    x = np.asarray(samples, dtype=np.float64)
    peak = float(np.max(np.abs(x))) if x.size else 0.0
    if peak > 1e-9:
        x = x / peak * 0.95
    wavfile.write(str(p), sr, (x * 32767).astype(np.int16))


def peak_normalize(x: np.ndarray, target: float = 0.9) -> np.ndarray:
    peak = float(np.max(np.abs(x))) if x.size else 0.0
    if peak <= 1e-9:
        return x.astype(np.float64)
    return np.asarray(x, dtype=np.float64) / peak * target
