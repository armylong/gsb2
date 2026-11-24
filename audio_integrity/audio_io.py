from __future__ import annotations

import struct
import wave
from dataclasses import dataclass
from pathlib import Path

import numpy as np


@dataclass
class AudioData:
    """Float audio samples with shape ``(frame_count, channel_count)``."""

    samples: np.ndarray
    sample_rate: int
    path: str | None = None
    format_description: str = ""

    def __post_init__(self) -> None:
        if self.samples.ndim == 1:
            self.samples = self.samples[:, None]
        self.samples = np.ascontiguousarray(self.samples, dtype=np.float32)
        if self.sample_rate <= 0:
            raise ValueError("采样率必须为正数")
        if self.samples.shape[1] not in (1, 2):
            # The observation desk is intentionally focused on mono/stereo.
            if self.samples.shape[1] > 2:
                self.samples = self.samples[:, :2]

    @property
    def n_frames(self) -> int:
        return int(self.samples.shape[0])

    @property
    def n_channels(self) -> int:
        return int(self.samples.shape[1])

    @property
    def duration(self) -> float:
        return self.n_frames / self.sample_rate if self.sample_rate else 0.0

    def channel(self, index: int) -> np.ndarray:
        if self.n_channels == 1:
            index = 0
        return self.samples[:, index]

    def segment_samples(self, start: float, end: float) -> tuple[int, int]:
        start_index = max(0, int(round(start * self.sample_rate)))
        end_index = min(self.n_frames, int(round(end * self.sample_rate)))
        if end_index < start_index:
            end_index = start_index
        return start_index, end_index


def _read_chunks(raw: bytes) -> tuple[bytes | None, bytes | None]:
    if len(raw) < 12 or raw[:4] != b"RIFF" or raw[8:12] != b"WAVE":
        raise ValueError("不是标准 RIFF/WAVE 文件")
    offset = 12
    fmt: bytes | None = None
    data: bytes | None = None
    size_total = len(raw)
    while offset + 8 <= size_total:
        chunk_id = raw[offset:offset + 4]
        (chunk_size,) = struct.unpack_from("<I", raw, offset + 4)
        body_start = offset + 8
        body_end = min(size_total, body_start + chunk_size)
        body = raw[body_start:body_end]
        if chunk_id == b"fmt ":
            fmt = body
        elif chunk_id == b"data" and data is None:
            data = body
        # Chunks are word-aligned; use the declared size when advancing.
        # A zero-length chunk still advances by its 8-byte header below.
        offset = body_start + chunk_size + (chunk_size & 1)
    if fmt is None:
        raise ValueError("WAV 缺少 fmt 块")
    if data is None:
        raise ValueError("WAV 缺少 data 块")
    return fmt, data


def _decode_pcm(data: bytes, channels: int, bits: int, audio_format: int) -> np.ndarray:
    if bits == 8 and audio_format == 1:
        arr = np.frombuffer(data, dtype=np.uint8).astype(np.float32)
        arr = (arr - 128.0) / 128.0
    elif bits == 16 and audio_format == 1:
        arr = np.frombuffer(data, dtype="<i2").astype(np.float32) / 32768.0
    elif bits == 24 and audio_format == 1:
        usable = (len(data) // 3) * 3
        packed = np.frombuffer(data[:usable], dtype=np.uint8).reshape(-1, 3)
        i32 = (
            packed[:, 0].astype(np.int32)
            | (packed[:, 1].astype(np.int32) << 8)
            | (packed[:, 2].astype(np.int32) << 16)
        )
        i32 = np.where(i32 & 0x800000, i32 - (1 << 24), i32)
        arr = i32.astype(np.float32) / 8388608.0
    elif bits == 32 and audio_format == 3:
        arr = np.frombuffer(data, dtype="<f4").astype(np.float32)
    elif bits == 64 and audio_format == 3:
        arr = np.frombuffer(data, dtype="<f8").astype(np.float32)
    elif bits == 32 and audio_format == 1:
        arr = np.frombuffer(data, dtype="<i4").astype(np.float32) / 2147483648.0
    else:
        raise ValueError(f"暂不支持的 WAV 编码：format={audio_format}, bits={bits}")

    frames = arr.size // channels
    if frames == 0:
        raise ValueError("WAV 中没有音频采样")
    arr = arr[: frames * channels].reshape(frames, channels)
    return np.clip(arr, -1.0, 1.0).astype(np.float32)


def load_wav(path: str | Path) -> AudioData:
    """Load a short mono/stereo PCM or IEEE-float WAV using only stdlib+numpy."""
    path = Path(path).expanduser()
    raw = path.read_bytes()
    fmt, data = _read_chunks(raw)
    assert fmt is not None and data is not None

    if len(fmt) < 16:
        raise ValueError("fmt 块长度不足")
    audio_format, channels, sample_rate, _, _, bits = struct.unpack_from(
        "<HHIIHH", fmt, 0
    )
    if audio_format == 0xFFFE and len(fmt) >= 24:
        # WAVEFORMATEXTENSIBLE's SubFormat begins with the ordinary format code.
        audio_format = struct.unpack_from("<I", fmt, 24)[0] & 0xFFFF

    if channels not in (1, 2):
        # Keep the desk usable for unusual files by taking the first pair.
        if channels <= 0:
            raise ValueError("WAV 声道数无效")

    samples = _decode_pcm(data, channels, bits, audio_format)
    if channels > 2:
        samples = samples[:, :2]
        channels = 2

    format_name = {1: "PCM", 3: "IEEE float"}.get(audio_format, str(audio_format))
    desc = f"{format_name}/{bits}bit/{sample_rate}Hz/{channels}ch"
    return AudioData(
        samples=samples,
        sample_rate=int(sample_rate),
        path=str(path),
        format_description=desc,
    )


def write_wav(path: str | Path, audio: AudioData | np.ndarray, sample_rate: int | None = None) -> Path:
    """Write a 16-bit PCM WAV; mainly used by tests and the demo exporter."""
    path = Path(path)
    if isinstance(audio, AudioData):
        samples = audio.samples
        sample_rate = audio.sample_rate
    else:
        if sample_rate is None:
            raise ValueError("直接写入数组时必须提供 sample_rate")
        samples = np.asarray(audio, dtype=np.float32)
        if samples.ndim == 1:
            samples = samples[:, None]

    clipped = np.clip(samples, -1.0, 1.0)
    pcm16 = np.round(clipped * 32767.0).astype("<i2")
    channels = pcm16.shape[1]
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(channels)
        wf.setsampwidth(2)
        wf.setframerate(int(sample_rate))
        wf.writeframes(pcm16.tobytes())
    return path
