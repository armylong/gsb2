"""最小依赖的 WAV 读写, 支持 16/24/32 bit PCM、IEEE float32 与 WAVE_EXTENSIBLE。

读入统一归一化为 float64, 值域 [-1, 1]; 写回按子类型量化。
仅实现本项目需要的 RIFF 子集(单 data chunk)。
"""

from __future__ import annotations

import struct
import wave
from dataclasses import dataclass

import numpy as np

WAVE_TAG_PCM = 0x0001
WAVE_TAG_FLOAT = 0x0003
WAVE_TAG_EXTENSIBLE = 0xFFFE
# KSDATAFORMAT_SUBTYPE_IEEE_FLOAT / PCM 的 GUID 前缀
_SUBTYPE_PCM = bytes((1, 0, 0, 0, 0, 0, 16, 0, 128, 0, 0, 170, 0, 56, 155, 113))
_SUBTYPE_FLOAT = bytes((3, 0, 0, 0, 0, 0, 16, 0, 128, 0, 0, 170, 0, 56, 155, 113))


@dataclass
class WavData:
    data: np.ndarray          # (帧数, 通道数), float64
    sample_rate: int
    tag: int                  # 实际格式标签 (1=PCM, 3=FLOAT)
    bits: int

    @property
    def channels(self) -> int:
        return self.data.shape[1]


def _read_chunks(buf: bytes):
    if buf[:4] != b"RIFF" or buf[8:12] != b"WAVE":
        raise ValueError("不是合法的 WAV (RIFF/WAVE) 文件")
    pos = 12
    chunks = {}
    while pos + 8 <= len(buf):
        cid = buf[pos:pos + 4]
        (size,) = struct.unpack_from("<I", buf, pos + 4)
        body = pos + 8
        chunks.setdefault(cid, []).append((body, size))
        pos = body + size + (size & 1)
    return chunks


def read_wav(path: str) -> WavData:
    with open(path, "rb") as f:
        buf = f.read()
    chunks = _read_chunks(buf)
    if b"fmt " not in chunks or b"data" not in chunks:
        raise ValueError("WAV 缺少 fmt 或 data chunk")
    fmt_pos, fmt_size = chunks[b"fmt "][0]
    fmt = buf[fmt_pos:fmt_pos + fmt_size]
    tag, channels, sr, _avg, _align, bits = struct.unpack_from("<HHIIHH", fmt, 0)
    if tag == WAVE_TAG_EXTENSIBLE:
        if fmt_size < 40:
            raise ValueError("WAVE_EXTENSIBLE fmt chunk 过短")
        valid_bits = struct.unpack_from("<H", fmt, 18)[0]
        if valid_bits:
            bits = valid_bits
        guid = fmt[24:40]
        tag = WAVE_TAG_FLOAT if guid == _SUBTYPE_FLOAT else WAVE_TAG_PCM
    data_pos, data_size = chunks[b"data"][0]
    raw = buf[data_pos:data_pos + data_size]

    if tag == WAVE_TAG_FLOAT:
        if bits == 32:
            x = np.frombuffer(raw, dtype="<f4").astype(np.float64)
        elif bits == 64:
            x = np.frombuffer(raw, dtype="<f8").astype(np.float64)
        else:
            raise ValueError(f"不支持的 float 位深: {bits}")
    elif tag == WAVE_TAG_PCM:
        if bits == 8:  # 8bit PCM 为无符号
            x = (np.frombuffer(raw, dtype=np.uint8).astype(np.float64) - 128.0) / 128.0
        elif bits == 16:
            x = np.frombuffer(raw, dtype="<i2").astype(np.float64) / 32768.0
        elif bits == 24:
            u = np.frombuffer(raw, dtype=np.uint8).reshape(-1, 3)
            i32 = (u[:, 0].astype(np.int32)
                   | (u[:, 1].astype(np.int32) << 8)
                   | (u[:, 2].astype(np.int32) << 16))
            i32 = np.where(i32 & 0x800000, i32 - 0x1000000, i32)
            x = i32.astype(np.float64) / 8388608.0
        elif bits == 32:
            x = np.frombuffer(raw, dtype="<i4").astype(np.float64) / 2147483648.0
        else:
            raise ValueError(f"不支持的 PCM 位深: {bits}")
    else:
        raise ValueError(f"不支持的 WAV 格式标签: {tag}")

    if channels <= 0 or x.size % channels:
        raise ValueError("WAV 通道数与数据长度不匹配")
    x = x.reshape(-1, channels)
    return WavData(data=x, sample_rate=sr, tag=tag, bits=bits)


def write_wav(path: str, data: np.ndarray, sample_rate: int,
              subtype: str = "pcm16") -> None:
    """写标准 WAV。subtype: pcm16 / pcm24 / float32。"""
    arr = np.asarray(data, dtype=np.float64)
    if arr.ndim == 1:
        arr = arr[:, None]
    channels = arr.shape[1]

    if subtype == "pcm16":
        tag, bits = WAVE_TAG_PCM, 16
        q = np.clip(arr, -1.0, 1.0)
        q = np.round(q * 32767.0).astype("<i2")
        raw = q.tobytes()
    elif subtype == "pcm24":
        tag, bits = WAVE_TAG_PCM, 24
        q = np.clip(arr, -1.0, 1.0)
        i32 = np.round(q * 8388607.0).astype(np.int32)
        u = np.empty((i32.size, 3), dtype=np.uint8)
        flat = i32.reshape(-1)
        u[:, 0] = flat & 0xFF
        u[:, 1] = (flat >> 8) & 0xFF
        u[:, 2] = (flat >> 16) & 0xFF
        raw = u.tobytes()
    elif subtype == "float32":
        tag, bits = WAVE_TAG_FLOAT, 32
        raw = arr.astype("<f4").tobytes()
    else:
        raise ValueError(f"未知导出子类型: {subtype}")

    block_align = channels * bits // 8
    byte_rate = sample_rate * block_align
    if tag == WAVE_TAG_PCM:
        with wave.open(path, "wb") as wf:
            wf.setnchannels(channels)
            wf.setsampwidth(bits // 8)
            wf.setframerate(sample_rate)
            wf.setcomptype("NONE", "not compressed")
            wf.writeframes(raw)
        return
    # wave 模块只能写 PCM 标签; IEEE float 需手工拼 RIFF 头
    import struct as _struct
    fmt_chunk = _struct.pack(
        "<HHIIHH", WAVE_TAG_FLOAT, channels, sample_rate, byte_rate,
        block_align, bits)
    with open(path, "wb") as f:
        f.write(b"RIFF")
        f.write(_struct.pack("<I", 4 + (8 + len(fmt_chunk)) + (8 + len(raw))))
        f.write(b"WAVE")
        f.write(b"fmt ")
        f.write(_struct.pack("<I", len(fmt_chunk)))
        f.write(fmt_chunk)
        f.write(b"data")
        f.write(_struct.pack("<I", len(raw)))
        f.write(raw)
