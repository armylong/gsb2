"""WAV 读取、样本切片与 PCM 解码(仅标准库)。"""

from __future__ import annotations

import sys
import wave
from array import array
from dataclasses import dataclass
from functools import cached_property
from pathlib import Path


class AudioError(Exception):
    """WAV 读取或样本访问失败。"""


_SUPPORTED_WIDTHS = (1, 2, 3, 4)


@dataclass
class AudioData:
    """一段已完整载入内存的 PCM WAV。

    ``start``/``end`` 以及所有“样本”字段均指 *帧* (frame, 每帧含全部声道),
    与 WAV 的 sample frame 含义一致; 单声道时即普通采样点序号。
    """

    sample_rate: int
    channels: int
    sample_width: int
    raw: bytes
    source_name: str = "audio"
    path: Path | None = None

    def __post_init__(self) -> None:
        if self.sample_rate <= 0:
            raise AudioError("采样率必须大于 0")
        if self.channels <= 0:
            raise AudioError("声道数必须大于 0")
        if self.sample_width not in _SUPPORTED_WIDTHS:
            raise AudioError(f"不支持的样本位宽: {self.sample_width} 字节")
        frame_bytes = self.channels * self.sample_width
        if len(self.raw) % frame_bytes:
            raise AudioError("PCM 数据长度不是整帧, 文件可能已损坏")
        if not self.raw:
            raise AudioError("WAV 不含音频帧")

    @property
    def frame_bytes(self) -> int:
        return self.channels * self.sample_width

    @property
    def frame_count(self) -> int:
        return len(self.raw) // self.frame_bytes

    @property
    def duration_seconds(self) -> float:
        return self.frame_count / self.sample_rate

    @property
    def bit_depth(self) -> int:
        return self.sample_width * 8

    @classmethod
    def from_wav(cls, path: str | Path) -> "AudioData":
        path = Path(path)
        try:
            with wave.open(str(path), "rb") as wav:
                channels = wav.getnchannels()
                sample_width = wav.getsampwidth()
                sample_rate = wav.getframerate()
                frames = wav.getnframes()
                comptype = wav.getcomptype()
                if comptype != "NONE":
                    raise AudioError(f"仅支持未压缩 PCM WAV, 当前压缩类型: {comptype}")
                if sample_width not in _SUPPORTED_WIDTHS:
                    raise AudioError(
                        f"不支持 {sample_width * 8} bit 样本, 支持 8/16/24/32 bit PCM"
                    )
                raw = wav.readframes(frames)
        except AudioError:
            raise
        except (wave.Error, EOFError, OSError) as exc:
            raise AudioError(
                f"无法读取 WAV: {exc}。请确认它是未压缩的 8/16/24/32 bit PCM WAV; "
                "其他格式可先用 ffmpeg 转成 PCM WAV。"
            ) from exc

        try:
            return cls(
                sample_rate=int(sample_rate),
                channels=int(channels),
                sample_width=int(sample_width),
                raw=raw,
                source_name=path.stem,
                path=path,
            )
        except AudioError as exc:
            raise AudioError(f"{path.name}: {exc}") from exc

    def slice_bytes(self, start: int, end: int) -> bytes:
        """返回 [start, end) 帧的原始字节, 保持原声道/位深。"""
        if not isinstance(start, int) or not isinstance(end, int):
            raise AudioError("样本边界必须是整数")
        if not 0 <= start < end <= self.frame_count:
            raise AudioError(
                f"样本区间 [{start}, {end}) 越界, 有效范围 [0, {self.frame_count}]"
            )
        return self.raw[start * self.frame_bytes : end * self.frame_bytes]

    def write_wav_slice(self, path: str | Path, start: int, end: int) -> Path:
        """把 [start, end) 帧写成独立 WAV, 参数与原始文件完全一致。"""
        payload = self.slice_bytes(start, end)
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        with wave.open(str(path), "wb") as out:
            out.setnchannels(self.channels)
            out.setsampwidth(self.sample_width)
            out.setframerate(self.sample_rate)
            out.writeframes(payload)
        return path

    @cached_property
    def decoded(self) -> tuple[array, int]:
        """把 PCM 解码为交错整数序列及满量程值, 用于电平/波形计算。"""
        raw = self.raw
        if self.sample_width == 1:
            # WAV 8 bit 是无符号 0..255; 去直流后范围 -128..127
            values = array("h", (byte - 128 for byte in raw))
            full_scale = 128
        elif self.sample_width == 2:
            values = array("h")
            values.frombytes(raw)
            if sys.byteorder == "big":
                values.byteswap()
            full_scale = 1 << 15
        elif self.sample_width == 3:
            values = array("i")
            append = values.append
            data = raw
            for i in range(0, len(data), 3):
                value = data[i] | (data[i + 1] << 8) | (data[i + 2] << 16)
                if value & 0x800000:
                    value -= 0x1000000
                append(value)
            full_scale = 1 << 23
        else:
            values = array("i")
            values.frombytes(raw)
            if sys.byteorder == "big":
                values.byteswap()
            full_scale = 1 << 31
        return values, full_scale

    @cached_property
    def mono(self) -> tuple[array, int]:
        """交错样本下混为单声道 (整数均值), 返回 (mono, full_scale)。"""
        values, full_scale = self.decoded
        channels = self.channels
        if channels == 1:
            return values, full_scale
        frames = self.frame_count
        # 多声道求和可能超出 int32, 32 bit 源使用 int64 容器。
        mono = array("q" if self.sample_width >= 4 else "i")
        append = mono.append
        if channels == 2:
            left = values[0::2]
            right = values[1::2]
            for a, b in zip(left, right):
                append((a + b) // 2)
        else:
            for frame in range(frames):
                base = frame * channels
                append(sum(values[base : base + channels]) // channels)
        return mono, full_scale
