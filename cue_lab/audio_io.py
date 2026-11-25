"""WAV 读写与线性重采样 (只用标准库 wave + numpy, 不引入 scipy)。

支持 8/16/24/32-bit PCM、32-bit IEEE float、mono/stereo/多声道,
统一返回 float64 单声道, 幅度约定 -1..1。
"""

from __future__ import annotations

import io
import wave

import numpy as np

WAVE_FORMAT_PCM = 0x0001
WAVE_FORMAT_IEEE_FLOAT = 0x0003
WAVE_FORMAT_EXTENSIBLE = 0xFFFE


def _parse_fmt_tag(raw: bytes, bit_depth: int) -> tuple[int, int]:
    """从 fmt chunk 原始字节解析 (格式 tag, 有效位深)。

    普通 PCM 块是 16 字节; WAVE_FORMAT_EXTENSIBLE 是 40 字节,
    真正的格式藏在 SubFormat GUID 的前两个字节里。
    """
    if len(raw) < 16:
        raise ValueError("wav 的 fmt 块长度异常")
    tag = int.from_bytes(raw[0:2], "little")
    if tag == WAVE_FORMAT_EXTENSIBLE and len(raw) >= 40:
        valid_bits = int.from_bytes(raw[18:20], "little") or bit_depth
        sub_tag = int.from_bytes(raw[24:26], "little")
        return sub_tag, valid_bits
    return tag, bit_depth


def _decode_pcm(data: bytes, bit_depth: int, channels: int) -> np.ndarray:
    if bit_depth == 8:
        # 8-bit PCM 是无符号的, 中心在 128
        x = (np.frombuffer(data, dtype=np.uint8).astype(np.float64) - 128.0) / 128.0
    elif bit_depth == 16:
        x = np.frombuffer(data, dtype="<i2").astype(np.float64) / 32768.0
    elif bit_depth == 24:
        raw = np.frombuffer(data, dtype=np.uint8).reshape(-1, 3)
        as32 = (
            raw[:, 0].astype(np.int32)
            | (raw[:, 1].astype(np.int32) << 8)
            | (raw[:, 2].astype(np.int32) << 16)
        )
        # 手动做 24 位有符号扩展
        as32 = np.where(as32 & 0x800000, as32 - 0x1000000, as32)
        x = as32.astype(np.float64) / float(1 << 23)
    elif bit_depth == 32:
        x = np.frombuffer(data, dtype="<i4").astype(np.float64) / float(1 << 31)
    else:
        raise ValueError(f"不支持的 PCM 位深: {bit_depth}")
    return x.reshape(-1, channels)


def read_wav(path: str) -> tuple[np.ndarray, int]:
    """读取 wav, 返回 (单声道 float64 波形, 采样率)。"""
    with wave.open(path, "rb") as wf:
        nch = wf.getnchannels()
        sr = wf.getframerate()
        bit_depth = wf.getsampwidth() * 8
        nframes = wf.getnframes()
        fmt_raw = wf.getcomptype()
        if fmt_raw != "NONE":
            raise ValueError(f"不支持压缩 wav: {wf.getcompname()}")
        # wave 模块不直接暴露 fmt tag, 走一遍底层参数自己解析
        fmt_chunk = wf.getparams()
        _ = fmt_chunk
        raw = wf.readframes(nframes)

    # wave 模块没有公开 fmt tag; 重新手动扫 chunk 拿到格式信息,
    # 拿不到时按位深默认走 PCM。
    tag, valid_bits = _scan_format_tag(path) or (WAVE_FORMAT_PCM, bit_depth)
    if tag == WAVE_FORMAT_IEEE_FLOAT:
        if bit_depth == 32:
            x = np.frombuffer(raw, dtype="<f4").astype(np.float64)
        elif bit_depth == 64:
            x = np.frombuffer(raw, dtype="<f8").astype(np.float64)
        else:
            raise ValueError(f"不支持的 float 位深: {bit_depth}")
        x = x.reshape(-1, nch)
    elif tag == WAVE_FORMAT_PCM:
        x = _decode_pcm(raw, valid_bits, nch)
    else:
        raise ValueError(f"不支持的 wav 格式 tag: 0x{tag:04x}")

    # 多声道下混为单声道 (等权平均)
    if nch > 1:
        x = x.mean(axis=1)
    else:
        x = x.reshape(-1)
    return np.ascontiguousarray(x, dtype=np.float64), sr


def _scan_format_tag(path: str) -> tuple[int, int] | None:
    """手动解析 RIFF 块, 找到 fmt chunk 里的格式 tag。"""
    try:
        with open(path, "rb") as fh:
            riff = fh.read(12)
            if len(riff) < 12 or riff[:4] != b"RIFF" or riff[8:12] != b"WAVE":
                return None
            while True:
                header = fh.read(8)
                if len(header) < 8:
                    return None
                cid = header[:4]
                size = int.from_bytes(header[4:8], "little")
                body = fh.read(size)
                if size % 2:
                    fh.read(1)  # 对齐字节
                if cid == b"fmt ":
                    bit_depth = int.from_bytes(body[14:16], "little") if len(body) >= 16 else 16
                    return _parse_fmt_tag(body, bit_depth)
    except OSError:
        return None


def resample_linear(x: np.ndarray, sr_in: int, sr_out: int) -> np.ndarray:
    """线性插值重采样。语音/噪声试听场景足够, 且实现确定、无额外依赖。"""
    if sr_in == sr_out or x.size == 0:
        return x.astype(np.float64, copy=True)
    duration = (x.size - 1) / sr_in
    n_out = max(1, int(round(x.size * sr_out / sr_in)))
    t_out = np.linspace(0.0, duration, n_out, dtype=np.float64)
    pos = t_out * sr_in
    i0 = np.floor(pos).astype(np.int64)
    i0 = np.clip(i0, 0, x.size - 1)
    i1 = np.clip(i0 + 1, 0, x.size - 1)
    frac = (pos - i0).astype(np.float64)
    return x[i0] * (1.0 - frac) + x[i1] * frac


def write_wav_int16(path: str, x: np.ndarray, sr: int) -> None:
    """把 float 波形按 16-bit PCM 写出 (先软限幅避免硬切)。"""
    x = np.asarray(x, dtype=np.float64)
    peak = float(np.max(np.abs(x))) if x.size else 0.0
    if peak > 0.99:
        # tanh 软限幅, 削顶不会变成一串方波
        x = np.tanh(x / peak) * 0.99
    pcm = np.clip(np.round(x * 32768.0), -32768, 32767).astype("<i2")
    with wave.open(path, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(pcm.tobytes())


def wav_to_bytes(x: np.ndarray, sr: int) -> bytes:
    """内存里生成 16-bit wav 字节, 供工程文件内嵌音频。"""
    buf = io.BytesIO()
    peak = float(np.max(np.abs(x))) if x.size else 0.0
    if peak > 0.99:
        x = np.tanh(x / peak) * 0.99
    pcm = np.clip(np.round(x * 32768.0), -32768, 32767).astype("<i2")
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(pcm.tobytes())
    return buf.getvalue()


def bytes_to_wav(b: bytes) -> tuple[np.ndarray, int]:
    """工程文件里内嵌 wav 字节的逆操作。"""
    return read_wav_from_bytes(b)


def read_wav_from_bytes(b: bytes) -> tuple[np.ndarray, int]:
    with wave.open(io.BytesIO(b), "rb") as wf:
        nch = wf.getnchannels()
        sr = wf.getframerate()
        bit_depth = wf.getsampwidth() * 8
        nframes = wf.getnframes()
        raw = wf.readframes(nframes)
    x = _decode_pcm(raw, bit_depth, nch)
    if nch > 1:
        x = x.mean(axis=1)
    else:
        x = x.reshape(-1)
    return np.ascontiguousarray(x, dtype=np.float64), sr
