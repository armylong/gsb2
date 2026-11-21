"""最小 WAV 读写 (仅依赖标准库).

支持 PCM 8/16/24/32-bit 与 IEEE float 32/64-bit, 单/多声道.
内部统一以 float64、形状 (frames, channels)、值域约 [-1, 1] 表示.
保存时按源文件位深与格式重新量化, 并保证未修改区间的采样值逐位一致.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass
from pathlib import Path

import numpy as np

_PCM = 1
_IEEE_FLOAT = 3
_EXTENSIBLE = 0xFFFE


@dataclass(frozen=True)
class WavData:
    samples: np.ndarray  # float64, (frames, channels)
    sample_rate: int
    bits_per_sample: int
    audio_format: int  # 1 = PCM, 3 = IEEE float

    @property
    def frames(self) -> int:
        return int(self.samples.shape[0])

    @property
    def channels(self) -> int:
        return int(self.samples.shape[1])

    @property
    def duration(self) -> float:
        return self.frames / float(self.sample_rate)

    def copy(self, samples: np.ndarray | None = None) -> "WavData":
        arr = self.samples.copy() if samples is None else np.asarray(samples, dtype=np.float64).copy()
        return WavData(arr, self.sample_rate, self.bits_per_sample, self.audio_format)


def _read_chunks(raw: bytes):
    if len(raw) < 12 or raw[:4] != b"RIFF" or raw[8:12] != b"WAVE":
        raise ValueError("不是有效的 RIFF/WAVE 文件")
    pos = 12
    while pos + 8 <= len(raw):
        cid = raw[pos:pos + 4]
        size = struct.unpack_from("<I", raw, pos + 4)[0]
        body_start = pos + 8
        body_end = min(body_start + size, len(raw))
        yield cid, raw[body_start:body_end]
        pos = body_start + size + (size & 1)


def _decode(body: bytes, fmt: tuple, n_frames: int) -> np.ndarray:
    audio_format, channels, bits = fmt[0], fmt[1], fmt[5]
    block_align = fmt[4] or (channels * bits // 8)
    frame_bytes = block_align
    usable = min(len(body), n_frames * frame_bytes)
    usable -= usable % frame_bytes
    body = body[:usable]
    n = usable // frame_bytes
    if n == 0:
        return np.zeros((0, channels), dtype=np.float64)
    if audio_format == _PCM and bits == 8:
        data = np.frombuffer(body, dtype=np.uint8).astype(np.float64)
        data = (data - 128.0) / 128.0
    elif audio_format == _PCM and bits == 16:
        data = np.frombuffer(body, dtype="<i2").astype(np.float64) / 32768.0
    elif audio_format == _PCM and bits == 24:
        b = np.frombuffer(body, dtype=np.uint8).reshape(-1, 3).astype(np.int32)
        vals = b[:, 0] | (b[:, 1] << 8) | (b[:, 2] << 16)
        vals = np.where(vals & 0x800000, vals - 0x1000000, vals)
        data = vals.astype(np.float64) / 8388608.0
    elif audio_format == _PCM and bits == 32:
        data = np.frombuffer(body, dtype="<i4").astype(np.float64) / 2147483648.0
    elif audio_format == _IEEE_FLOAT and bits == 32:
        data = np.frombuffer(body, dtype="<f4").astype(np.float64)
    elif audio_format == _IEEE_FLOAT and bits == 64:
        data = np.frombuffer(body, dtype="<f8").astype(np.float64)
    else:
        raise ValueError(f"暂不支持的 WAV 格式: format={audio_format}, bits={bits}")
    return data.reshape(-1, channels)


def _encode(samples: np.ndarray, bits: int, audio_format: int) -> bytes:
    flat = np.asarray(samples, dtype=np.float64).reshape(-1)
    if audio_format == _IEEE_FLOAT and bits == 32:
        return flat.astype("<f4").tobytes()
    if audio_format == _IEEE_FLOAT and bits == 64:
        return flat.astype("<f8").tobytes()
    if bits == 8:
        q = np.clip(np.rint(flat * 128.0 + 128.0), 0, 255).astype(np.uint8)
        return q.tobytes()
    if bits == 16:
        q = np.clip(np.rint(flat * 32768.0), -32768, 32767).astype("<i2")
        return q.tobytes()
    if bits == 24:
        q = np.clip(np.rint(flat * 8388608.0), -8388608, 8388607).astype(np.int32)
        b = q.view(np.uint32).astype(np.uint32)
        out = np.empty((b.size, 3), dtype=np.uint8)
        out[:, 0] = b & 0xFF
        out[:, 1] = (b >> 8) & 0xFF
        out[:, 2] = (b >> 16) & 0xFF
        return out.tobytes()
    if bits == 32:
        q = np.clip(np.rint(flat * 2147483648.0), -2147483648, 2147483647).astype("<i4")
        return q.tobytes()
    raise ValueError(f"暂不支持的输出位深: bits={bits}, format={audio_format}")


def _make_fmt_chunk(audio_format: int, channels: int, rate: int, bits: int) -> bytes:
    block_align = channels * bits // 8
    byte_rate = rate * block_align
    return struct.pack("<HHIIHH", audio_format, channels, rate, byte_rate, block_align, bits)


def load_wav(path: str | Path) -> WavData:
    raw = Path(path).read_bytes()
    fmt = None
    data_body = None
    for cid, body in _read_chunks(raw):
        if cid == b"fmt ":
            values = struct.unpack_from("<HHIIHH", body, 0)
            audio_format, channels, rate, _byte_rate, _block_align, bits = values
            if audio_format == _EXTENSIBLE and len(body) >= 40:
                audio_format = struct.unpack_from("<H", body, 24)[0]
            fmt = (audio_format, channels, rate, _byte_rate, _block_align, bits)
        elif cid == b"data":
            data_body = body
    if fmt is None or data_body is None:
        raise ValueError("WAV 缺少 fmt 或 data 块")
    audio_format, channels, rate, _br, block_align, bits = fmt
    if channels < 1 or rate < 1:
        raise ValueError("WAV fmt 块数值非法")
    frame_bytes = block_align or (channels * bits // 8)
    n_frames = len(data_body) // max(1, frame_bytes)
    samples = _decode(data_body, fmt, n_frames)
    return WavData(samples, int(rate), int(bits), int(audio_format))


def snap_to_grid(wav: WavData) -> WavData:
    """把内存样本量化到该 WAV 的位深网格上.

    真实文件读进来时本就落在网格上; 程序内合成的样例需要这一步,
    才能保证"导出 -> 读回"时未修改区间逐位一致.
    """
    fmt = WavData(np.zeros((0, wav.channels)), wav.sample_rate,
                  wav.bits_per_sample, wav.audio_format)
    codec_format = 3 if wav.audio_format == _IEEE_FLOAT else 1
    payload = _encode(wav.samples, wav.bits_per_sample, codec_format)
    frame_bytes = wav.channels * wav.bits_per_sample // 8
    n = len(payload) // max(1, frame_bytes)
    samples = _decode(payload, (codec_format, wav.channels, 0, 0,
                                frame_bytes, wav.bits_per_sample), n)
    return WavData(samples, fmt.sample_rate, fmt.bits_per_sample, fmt.audio_format)


def save_wav(path: str | Path, wav: WavData) -> None:
    samples = np.asarray(wav.samples, dtype=np.float64)
    if samples.ndim != 2:
        raise ValueError("samples 必须是二维 (frames, channels)")
    bits = wav.bits_per_sample
    audio_format = wav.audio_format
    if audio_format != _IEEE_FLOAT:
        audio_format = _PCM
    payload = _encode(samples, bits, audio_format)
    fmt_chunk = _make_fmt_chunk(audio_format, wav.channels, wav.sample_rate, bits)
    chunks = [b"fmt " + struct.pack("<I", len(fmt_chunk)) + fmt_chunk,
              b"data" + struct.pack("<I", len(payload)) + payload]
    body = b"WAVE"
    for chunk in chunks:
        body += chunk
        if len(chunk) % 2:
            body += b"\x00"
    riff = b"RIFF" + struct.pack("<I", len(body)) + body
    Path(path).write_bytes(riff)
