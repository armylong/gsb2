#!/usr/bin/env python3
"""wav_io.py — 纯标准库 WAV 读写（PCM 8/16/24/32-bit、float32、单/双声道）

与 js/wav-codec.js 采用同一套解析规则，供样例生成与回读核对使用。
"""
import struct
import wave


class WavError(Exception):
    pass


def read_wav(path):
    """返回 dict: sample_rate, channels, bit_depth, encoding, frame_count, data(list[list[float]])"""
    try:
        with open(path, "rb") as f:
            raw = f.read()
    except OSError as exc:
        raise WavError("无法读取文件：%s" % exc)
    if len(raw) == 0:
        raise WavError("文件为空（0 字节）：%s" % path)
    if len(raw) < 12 or raw[0:4] != b"RIFF" or raw[8:12] != b"WAVE":
        raise WavError("不是 WAV 文件（缺少 RIFF/WAVE 标识）：%s" % path)

    offset = 12
    fmt = None
    data = None
    while offset + 8 <= len(raw):
        chunk_id = raw[offset:offset + 4]
        size = struct.unpack_from("<I", raw, offset + 4)[0]
        body = offset + 8
        if body + size > len(raw):
            raise WavError("文件已损坏：数据块超出文件长度（可能被截断）")
        if chunk_id == b"fmt " and fmt is None:
            fmt = (body, size)
        elif chunk_id == b"data" and data is None:
            data = (body, size)
        offset = body + size + (size % 2)
    if fmt is None:
        raise WavError("WAV 结构不完整（缺少 fmt 块）")
    if data is None:
        raise WavError("WAV 结构不完整（缺少 data 块）")

    foff, fsize = fmt
    audio_format, channels, sample_rate, _, block_align, bits = struct.unpack_from("<HHIIHH", raw, foff)
    if audio_format == 0xFFFE and fsize >= 40:  # WAVE_FORMAT_EXTENSIBLE
        audio_format = struct.unpack_from("<H", raw, foff + 24)[0]
    if audio_format == 1:
        encoding = "PCM"
    elif audio_format == 3:
        encoding = "FLOAT"
    else:
        raise WavError("不支持的 WAV 编码（仅支持无压缩 PCM / IEEE float）")
    if channels not in (1, 2):
        raise WavError("仅支持单声道或双声道 WAV（收到 %d 声道）" % channels)
    if encoding == "PCM" and bits not in (8, 16, 24, 32):
        raise WavError("不支持的 PCM 位深：%d-bit（支持 8/16/24/32）" % bits)
    if encoding == "FLOAT" and bits != 32:
        raise WavError("浮点 WAV 仅支持 32-bit")
    if block_align != channels * bits // 8:
        raise WavError("块对齐与声道/位深不符，文件已损坏")

    doff, dsize = data
    if dsize == 0:
        raise WavError("音频数据为空（data 块长度为 0）")
    if dsize % block_align != 0:
        raise WavError("文件已损坏：音频数据被截断")
    frame_count = dsize // block_align
    out = [[0.0] * frame_count for _ in range(channels)]

    pos = doff
    for i in range(frame_count):
        for c in range(channels):
            if encoding == "FLOAT":
                (v,) = struct.unpack_from("<f", raw, pos)
                if v != v or v in (float("inf"), float("-inf")):
                    v = 0.0
            elif bits == 8:
                v = (raw[pos] - 128) / 128.0
            elif bits == 16:
                v = struct.unpack_from("<h", raw, pos)[0] / 32768.0
            elif bits == 24:
                x = raw[pos] | (raw[pos + 1] << 8) | (raw[pos + 2] << 16)
                if x & 0x800000:
                    x -= 1 << 24
                v = x / 8388608.0
            else:  # 32-bit PCM
                v = struct.unpack_from("<i", raw, pos)[0] / 2147483648.0
            out[c][i] = v
            pos += bits // 8

    return {
        "sample_rate": sample_rate,
        "channels": channels,
        "bit_depth": bits,
        "encoding": encoding,
        "frame_count": frame_count,
        "data": out,
    }


def write_wav16(path, channels, sample_rate):
    """平面声道序列（list[list[float]]）写成 16-bit PCM WAV。"""
    if not channels:
        raise WavError("不能导出空音频（没有声道数据）")
    frames = len(channels[0])
    if frames == 0:
        raise WavError("不能导出空音频（帧数为 0）")
    for ch in channels:
        if len(ch) != frames:
            raise WavError("各声道长度不一致，无法导出")
    with wave.open(path, "wb") as wf:
        wf.setnchannels(len(channels))
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        frames_bytes = bytearray()
        for i in range(frames):
            for ch in channels:
                v = max(-1.0, min(1.0, ch[i]))
                iv = int(round(v * 32767))
                frames_bytes += struct.pack("<h", max(-32768, min(32767, iv)))
        wf.writeframes(bytes(frames_bytes))
    return frames
