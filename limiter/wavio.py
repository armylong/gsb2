"""WAV 读写：统一转成 float64 [-1, 1] 处理，导出默认 32-bit float（不二次截断）。

不依赖标准库 wave 模块读文件 —— 它不认识 IEEE float (format tag 3)，
这里直接解析 RIFF 块，PCM 与 float 都支持。
"""

from __future__ import annotations

import struct

import numpy as np

WAVE_FORMAT_PCM = 1
WAVE_FORMAT_IEEE_FLOAT = 3


def _iter_chunks(f):
    """依次 yield (chunk_id, data_bytes)，跳过非数据块。"""
    riff = f.read(4)
    if riff != b"RIFF":
        raise ValueError("不是 RIFF/WAV 文件")
    f.read(4)  # 总长度
    if f.read(4) != b"WAVE":
        raise ValueError("不是 WAV 文件")
    while True:
        head = f.read(8)
        if len(head) < 8:
            break
        cid, size = struct.unpack("<4sI", head)
        data = f.read(size)
        if size & 1:  # 块按字对齐，奇数长度补 1 字节
            f.read(1)
        yield cid, data


def read_wav(path: str) -> tuple[np.ndarray, float]:
    """读取 WAV，返回 (float64 信号, 采样率)。

    单声道返回一维数组，多声道返回 (N, ch)。支持 8/16/24/32-bit PCM
    与 32-bit float WAV。
    """
    with open(path, "rb") as f:
        chunks = dict(_iter_chunks(f))

    fmt = chunks[b"fmt "]
    tag, nch, fs, _avg, _align, bits = struct.unpack("<HHIIHH", fmt[:16])
    sw = bits // 8  # bitsPerSample 单位是 bit，转字节
    raw = chunks[b"data"]

    if tag == WAVE_FORMAT_IEEE_FLOAT and sw == 4:
        x = np.frombuffer(raw, dtype="<f4").astype(np.float64)
    elif tag == WAVE_FORMAT_PCM:
        if sw == 1:  # 8-bit PCM 无符号
            data = np.frombuffer(raw, dtype=np.uint8).astype(np.float64)
            x = (data - 128.0) / 128.0
        elif sw == 2:
            x = np.frombuffer(raw, dtype="<i2").astype(np.float64) / 32768.0
        elif sw == 3:
            b = np.frombuffer(raw, dtype=np.uint8).reshape(-1, 3)
            i32 = (b[:, 0].astype(np.int32)
                   | (b[:, 1].astype(np.int32) << 8)
                   | (b[:, 2].astype(np.int32) << 16))
            i32 = np.where(i32 & 0x800000, i32 - 0x1000000, i32)
            x = i32.astype(np.float64) / 8388608.0
        elif sw == 4:
            x = (np.frombuffer(raw, dtype="<i4").astype(np.float64)
                 / 2147483648.0)
        else:
            raise ValueError(f"不支持的 PCM 位宽: {sw * 8} bit")
    else:
        raise ValueError(f"不支持的 WAV 格式: tag={tag}, width={sw}")

    if nch > 1:
        x = x.reshape(-1, nch)
    return x, float(fs)


def write_wav(path: str, x: np.ndarray, fs: float,
              subtype: str = "FLOAT") -> None:
    """写 WAV。

    subtype="FLOAT"  -> 32-bit float（默认，限幅结果不会被位深再次硬切）
    subtype="PCM_16" -> 16-bit PCM
    """
    x = np.asarray(x, dtype=np.float64)
    mono = x.ndim == 1
    data = x if mono else x.reshape(-1)
    nch = 1 if mono else x.shape[1]
    nframes = x.shape[0]

    if subtype == "FLOAT":
        raw = data.astype("<f4").tobytes()
        tag, sw = WAVE_FORMAT_IEEE_FLOAT, 4
    elif subtype == "PCM_16":
        clipped = np.clip(data, -1.0, 1.0)
        raw = np.round(clipped * 32767.0).astype("<i2").tobytes()
        tag, sw = WAVE_FORMAT_PCM, 2
    else:
        raise ValueError(f"不支持的导出格式: {subtype}")

    fmt_chunk = struct.pack("<HHIIHH", tag, nch, int(fs),
                            int(fs) * nch * sw, nch * sw, sw * 8)
    riff_size = 4 + (8 + len(fmt_chunk)) + (8 + len(raw))
    with open(path, "wb") as f:
        f.write(b"RIFF" + struct.pack("<I", riff_size) + b"WAVE")
        f.write(b"fmt " + struct.pack("<I", len(fmt_chunk)) + fmt_chunk)
        f.write(b"data" + struct.pack("<I", len(raw)) + raw)
