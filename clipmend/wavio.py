"""WAV reading/writing in float64 numpy form, with strict validation.

Only what the tool needs: PCM 8/16/24/32-bit integer WAV, mono or stereo.
The loader keeps the original sample rate and channel count and reports what it
had to do so the UI can show it instead of silently resampling.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass
from pathlib import Path

import numpy as np

MAX_SECONDS_ALLOWED = 60.0
MAX_BYTES_ALLOWED = 64 * 1024 * 1024


class WavError(Exception):
    """Raised for anything the user should see as a WAV problem."""


@dataclass
class WavData:
    samples: np.ndarray  # shape (frames, channels), float64 in [-1, 1] range
    sample_rate: int
    bits_per_sample: int
    source_format: int  # WAVE_FORMAT_* value from the fmt chunk
    path: Path | None = None

    @property
    def frames(self) -> int:
        return int(self.samples.shape[0])

    @property
    def channels(self) -> int:
        return int(self.samples.shape[1])

    @property
    def duration(self) -> float:
        return self.frames / float(self.sample_rate)


def _read_riff(data: bytes) -> tuple[bytes, bytes]:
    if len(data) < 12 or data[0:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise WavError("不是 RIFF/WAVE 文件")
    fmt = None
    payload = None
    pos = 12
    n = len(data)
    while pos + 8 <= n:
        chunk_id = data[pos : pos + 4]
        (size,) = struct.unpack("<I", data[pos + 4 : pos + 8])
        body_start = pos + 8
        body_end = body_start + size
        if body_end > n:
            # Truncated stream (e.g. a recording interrupted mid-write). Accept
            # the data we actually have rather than refusing the whole file.
            body_end = n
        if chunk_id == b"fmt ":
            fmt = data[body_start:body_end]
        elif chunk_id == b"data":
            payload = data[body_start:body_end]
            if fmt is not None:
                break
        pos = body_end + (size & 1)  # chunks are word aligned
    if fmt is None:
        raise WavError("WAV 缺少 fmt 块")
    if payload is None:
        raise WavError("WAV 缺少 data 块")
    return fmt, payload


def _decode_pcm(payload: bytes, bits: int, channels: int) -> np.ndarray:
    if bits == 8:
        raw = np.frombuffer(payload, dtype=np.uint8).astype(np.float64)
        # 8-bit PCM WAV is unsigned with 128 as zero.
        return (raw - 128.0) / 128.0
    if bits == 16:
        raw = np.frombuffer(payload, dtype="<i2").astype(np.float64)
        return raw / 32768.0
    if bits == 24:
        b = np.frombuffer(payload, dtype=np.uint8)
        if b.size % 3:
            raise WavError("24 位数据长度不是 3 的整数倍")
        b = b.reshape(-1, 3)
        val = (
            b[:, 0].astype(np.int32)
            | (b[:, 1].astype(np.int32) << 8)
            | (b[:, 2].astype(np.int32) << 16)
        )
        # sign extend
        val = np.where(val & 0x800000, val - 0x1000000, val)
        return val.astype(np.float64) / 8388608.0
    if bits == 32:
        raw = np.frombuffer(payload, dtype="<i4").astype(np.float64)
        return raw / 2147483648.0
    raise WavError(f"暂不支持 {bits} 位 PCM")


def load_wav(path: str | Path, max_seconds: float = MAX_SECONDS_ALLOWED) -> WavData:
    p = Path(path)
    try:
        data = p.read_bytes()
    except OSError as exc:
        raise WavError(f"读不出文件: {exc}") from exc
    if len(data) > MAX_BYTES_ALLOWED:
        raise WavError("文件过大 (超过 64 MB)")
    fmt, payload = _read_riff(data)
    if len(fmt) < 16:
        raise WavError("fmt 块太短")
    audio_format, channels, sample_rate, _byte_rate, block_align, bits = struct.unpack(
        "<HHIIHH", fmt[:16]
    )
    if audio_format == 0xFFFE:  # WAVE_FORMAT_EXTENSIBLE: real format in SubFormat GUID
        if len(fmt) < 40:
            raise WavError("extensible fmt 块不完整")
        (audio_format,) = struct.unpack("<H", fmt[24:26])
    if audio_format != 1:
        raise WavError(
            f"只支持整数 PCM WAV (当前 format={audio_format}，可能是浮点或压缩格式)"
        )
    if channels not in (1, 2):
        raise WavError(f"只支持单声道或立体声 (当前 {channels} 声道)")
    if sample_rate <= 0:
        raise WavError("采样率无效")
    expected_align = channels * (bits // 8)
    if expected_align and block_align not in (0, expected_align):
        raise WavError("block align 与声道/位深不一致")
    flat = _decode_pcm(payload, bits, channels)
    usable = (flat.size // channels) * channels
    if usable == 0:
        raise WavError("样本为空")
    samples = flat[:usable].reshape(-1, channels)
    duration = samples.shape[0] / float(sample_rate)
    if duration > max_seconds:
        raise WavError(
            f"音频时长 {duration:.1f} 秒，超过 {max_seconds:.0f} 秒上限 (先裁剪再试听)"
        )
    return WavData(samples, sample_rate, bits, audio_format, p)


def quantize(samples: np.ndarray, bits_per_sample: int) -> np.ndarray:
    """Map float samples to integer PCM codes using a symmetric scale.

    The scale is 2**(bits-1) on both sides so decode -> encode is an identity
    round trip (decode divides by the same power of two).  Range is clipped to
    the representable integer interval.
    """
    samples = np.clip(np.asarray(samples, dtype=np.float64), -1.0, 1.0)
    if bits_per_sample == 8:
        lo, hi = -128, 127
    elif bits_per_sample == 16:
        lo, hi = -(2**15), 2**15 - 1
    elif bits_per_sample == 24:
        lo, hi = -(2**23), 2**23 - 1
    elif bits_per_sample == 32:
        lo, hi = -(2**31), 2**31 - 1
    else:
        raise WavError(f"导出不支持 {bits_per_sample} 位")
    scaled = np.round(samples * float(2 ** (bits_per_sample - 1)))
    return np.clip(scaled, lo, hi).astype(np.int64)


def encode_wav(
    samples: np.ndarray,
    sample_rate: int,
    bits_per_sample: int = 16,
) -> bytes:
    """Encode float samples to integer PCM WAV bytes.

    Values outside [-1, 1] are clipped; callers should check headroom first
    (see analysis.headroom_report) rather than relying on this silently.
    """
    samples = np.asarray(samples, dtype=np.float64)
    if samples.ndim == 1:
        samples = samples[:, None]
    channels = samples.shape[1]
    ints = quantize(samples, bits_per_sample)
    if bits_per_sample == 8:
        data = (ints + 128).astype(np.uint8).tobytes()
    elif bits_per_sample == 16:
        data = ints.astype("<i2").tobytes()
    elif bits_per_sample == 24:
        packed = np.empty((ints.size, 3), dtype=np.uint8)
        u = ints.reshape(-1).astype(np.uint32) & 0xFFFFFF
        packed[:, 0] = (u & 0xFF).astype(np.uint8)
        packed[:, 1] = ((u >> 8) & 0xFF).astype(np.uint8)
        packed[:, 2] = ((u >> 16) & 0xFF).astype(np.uint8)
        data = packed.tobytes()
    else:
        data = ints.astype("<i4").tobytes()
    block_align = channels * (bits_per_sample // 8)
    byte_rate = sample_rate * block_align
    fmt = struct.pack(
        "<HHIIHH",
        1,
        channels,
        sample_rate,
        byte_rate,
        block_align,
        bits_per_sample,
    )
    header = b"RIFF" + struct.pack("<I", 4 + 8 + len(fmt) + 8 + len(data)) + b"WAVE"
    header += b"fmt " + struct.pack("<I", len(fmt)) + fmt
    header += b"data" + struct.pack("<I", len(data))
    return header + data


def save_wav(
    path: str | Path,
    samples: np.ndarray,
    sample_rate: int,
    bits_per_sample: int = 16,
) -> None:
    data = encode_wav(samples, sample_rate, bits_per_sample)
    Path(path).write_bytes(data)
