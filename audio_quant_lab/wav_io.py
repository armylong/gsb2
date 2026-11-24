"""Small dependency-free integer/float WAV reader and integer-depth exporter."""

from __future__ import annotations

import struct
import wave
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .dsp import AudioData, QuantResult, quantizer_limits


@dataclass
class WavReadResult:
    audio: AudioData
    raw_signed: np.ndarray | None  # shape (frames, channels), signed container ints
    container_bits: int
    audio_format_tag: int
    valid_bits: int | None = None


def _read_chunks(path: Path) -> tuple[bytes, dict[bytes, bytes]]:
    with path.open("rb") as f:
        header = f.read(12)
        if len(header) < 12 or header[:4] != b"RIFF" or header[8:12] != b"WAVE":
            raise ValueError("不是标准 RIFF/WAVE 文件")

        chunks: dict[bytes, bytes] = {}
        data_parts: list[bytes] = []
        while True:
            chunk_header = f.read(8)
            if not chunk_header:
                break
            if len(chunk_header) < 8:
                raise ValueError("WAV chunk 头被截断")
            chunk_id, size = struct.unpack("<4sI", chunk_header)
            payload = f.read(size)
            if len(payload) != size:
                raise ValueError(f"WAV chunk {chunk_id!r} 数据被截断")
            if size & 1:
                f.read(1)  # RIFF chunks are word-aligned.

            if chunk_id == b"data":
                data_parts.append(payload)
            elif chunk_id == b"fmt ":
                chunks[chunk_id] = payload
            # Other chunks (LIST, fact, etc.) are intentionally ignored.

    if b"fmt " not in chunks:
        raise ValueError("WAV 缺少 fmt chunk")
    if not data_parts:
        raise ValueError("WAV 缺少 data chunk")
    return b"".join(data_parts), chunks


def _decode_24bit(data: bytes, channels: int) -> np.ndarray:
    usable = len(data) - (len(data) % 3)
    raw = np.frombuffer(data[:usable], dtype=np.uint8)
    b0 = raw[0::3].astype(np.int32)
    b1 = raw[1::3].astype(np.int32)
    b2 = raw[2::3].astype(np.int32)
    values = b0 | (b1 << 8) | (b2 << 16)
    values[values >= 0x800000] -= 1 << 24
    frames = values.size // channels
    return values[: frames * channels].reshape(frames, channels).astype(np.int64)


def read_wav(path: str | Path) -> WavReadResult:
    """Read a short PCM/float WAV and downmix it to mono float64."""
    path = Path(path)
    data, chunks = _read_chunks(path)
    fmt = chunks[b"fmt "]
    if len(fmt) < 16:
        raise ValueError("WAV fmt chunk 太短")

    format_tag, channels, sample_rate, _, block_align, bits = struct.unpack(
        "<HHIIHH", fmt[:16]
    )
    valid_bits = None
    if format_tag == 0xFFFE and len(fmt) >= 26:
        # WAVEFORMATEXTENSIBLE: actual tag is the first two bytes of SubFormat.
        valid_bits = struct.unpack("<H", fmt[18:20])[0]
        format_tag = struct.unpack("<H", fmt[24:26])[0]

    if channels <= 0 or sample_rate <= 0 or bits <= 0:
        raise ValueError("WAV 声道数、采样率或位深无效")

    raw_signed: np.ndarray | None = None
    is_float = format_tag == 3

    if format_tag == 1 and bits == 8:
        usable = len(data) - (len(data) % max(1, block_align))
        raw_u8 = np.frombuffer(data[:usable], dtype=np.uint8)
        frames = raw_u8.size // channels
        raw_u8 = raw_u8[: frames * channels].reshape(frames, channels)
        raw_signed = raw_u8.astype(np.int64) - 128
        # Unsigned PCM is centered at 128; 0 and 255 map to -1 and +127/128.
        samples = raw_u8.astype(np.float64) / 128.0 - 1.0
    elif format_tag == 1 and bits == 16:
        usable = len(data) - (len(data) % 2)
        raw = np.frombuffer(data[:usable], dtype="<i2").astype(np.int64)
        frames = raw.size // channels
        raw_signed = raw[: frames * channels].reshape(frames, channels)
        samples = raw_signed.astype(np.float64) / (1 << 15)
    elif format_tag == 1 and bits == 24:
        raw_signed = _decode_24bit(data, channels)
        samples = raw_signed.astype(np.float64) / (1 << 23)
    elif format_tag == 1 and bits == 32:
        usable = len(data) - (len(data) % 4)
        raw = np.frombuffer(data[:usable], dtype="<i4").astype(np.int64)
        frames = raw.size // channels
        raw_signed = raw[: frames * channels].reshape(frames, channels)
        samples = raw_signed.astype(np.float64) / (1 << 31)
    elif format_tag == 3 and bits == 32:
        usable = len(data) - (len(data) % 4)
        raw_f = np.frombuffer(data[:usable], dtype="<f4").astype(np.float64)
        frames = raw_f.size // channels
        samples = raw_f[: frames * channels].reshape(frames, channels)
    elif format_tag == 3 and bits == 64:
        usable = len(data) - (len(data) % 8)
        raw_f = np.frombuffer(data[:usable], dtype="<f8").astype(np.float64)
        frames = raw_f.size // channels
        samples = raw_f[: frames * channels].reshape(frames, channels)
    else:
        raise ValueError(
            f"暂不支持该 WAV 格式: tag={format_tag}, bits={bits}。"
            "请使用 8/16/24/32-bit PCM 或 32/64-bit float WAV。"
        )

    if samples.ndim == 2:
        mono = np.mean(samples, axis=1)
    else:  # pragma: no cover - all branches reshape today
        mono = samples

    audio = AudioData(
        samples=np.ascontiguousarray(mono, dtype=np.float64),
        sample_rate=int(sample_rate),
        channels=int(channels),
        source_bits=int(valid_bits or bits),
        name=path.name,
        is_float_source=is_float,
    )
    return WavReadResult(
        audio=audio,
        raw_signed=raw_signed,
        container_bits=int(bits),
        audio_format_tag=int(format_tag),
        valid_bits=valid_bits,
    )


def choose_container_bits(target_bits: int, requested: int | str = "auto") -> int:
    """Choose a standard integer WAV container."""
    standard = (8, 16, 24, 32)
    if requested != "auto":
        container = int(requested)
        if container not in standard:
            raise ValueError("container must be 8, 16, 24 or 32")
        if container < target_bits:
            raise ValueError("container cannot be narrower than target depth")
        return container

    if target_bits in standard:
        return target_bits
    for container in standard:
        if container >= target_bits:
            return container
    raise ValueError("target depth cannot exceed 32 bits")


def pack_integer_frames(container_codes: np.ndarray, container_bits: int) -> bytes:
    values = np.asarray(container_codes, dtype=np.int64)
    if container_bits == 8:
        return (values + 128).astype(np.uint8).tobytes()
    if container_bits == 16:
        return values.astype("<i2").tobytes()
    if container_bits == 24:
        clipped = np.clip(values, -(1 << 23), (1 << 23) - 1)
        u = clipped.astype(np.int32)
        b0 = (u & 0xFF).astype(np.uint8)
        b1 = ((u >> 8) & 0xFF).astype(np.uint8)
        b2 = ((u >> 16) & 0xFF).astype(np.uint8)
        return np.stack((b0, b1, b2), axis=1).ravel().tobytes()
    if container_bits == 32:
        return values.astype("<i4").tobytes()
    raise ValueError("unsupported container bits")


@dataclass
class ExportReport:
    path: Path
    target_bits: int
    container_bits: int
    shift: int
    used_levels: int
    readback_unique_levels: int
    readback_matches: bool
    true_native_depth: bool


def export_quantized_wav(
    path: str | Path,
    result: QuantResult,
    sample_rate: int,
    container: int | str = "auto",
) -> ExportReport:
    """Export target codes, left-aligned in a standard integer container."""
    path = Path(path)
    target_bits = result.bits
    container_bits = choose_container_bits(target_bits, container)
    shift = container_bits - target_bits
    container_codes = result.codes << shift

    # Validate range before wave module writes a misleading header.
    cmin = -(1 << (container_bits - 1))
    cmax = (1 << (container_bits - 1)) - 1
    if np.any(container_codes < cmin) or np.any(container_codes > cmax):
        raise ValueError("导出整数码超出容器范围")

    packed = pack_integer_frames(container_codes, container_bits)
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(container_bits // 8)
        wf.setframerate(int(sample_rate))
        wf.writeframes(packed)

    readback = read_wav(path)
    if readback.raw_signed is None:
        raise RuntimeError("导出后读回失败：不是整数 WAV")
    readback_mono = readback.raw_signed[:, 0]
    expected = container_codes
    matches = (
        readback.container_bits == container_bits
        and readback_mono.size == expected.size
        and np.array_equal(readback_mono.astype(np.int64), expected.astype(np.int64))
    )
    unique_readback = int(np.unique(readback_mono).size)
    return ExportReport(
        path=path,
        target_bits=target_bits,
        container_bits=container_bits,
        shift=shift,
        used_levels=result.used_levels,
        readback_unique_levels=unique_readback,
        readback_matches=bool(matches and unique_readback == result.used_levels),
        true_native_depth=(shift == 0 and target_bits in (8, 16, 24, 32)),
    )


def source_rail_count(audio: AudioData) -> int | None:
    """Count exact signed-container rails from an integer source, if known."""
    if audio.source_bits is None or audio.is_float_source:
        return None
    scale = 1 << (audio.source_bits - 1)
    qmin, qmax = quantizer_limits(audio.source_bits)[1:]
    # Mono downmix can create averages, so this is informational only and uses
    # the normalized extremes rather than pretending channels were retained.
    return int(np.count_nonzero((audio.samples <= qmin / scale) | (audio.samples >= qmax / scale)))
