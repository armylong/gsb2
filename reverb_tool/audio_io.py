"""WAV 读写与元数据。

上层只依赖 :class:`LoadedAudio`; 真实解码交给 soundfile（libsndfile）。
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import soundfile as sf

# WAV 采用 32-bit float PCM: 卷积尾音可以超过 ±1, 导出时由界面明确提示并由
# 用户选择衰减保护, 而不是在读文件阶段被悄悄截断。
EXPORT_SUBTYPE = "FLOAT"


class AudioLoadError(ValueError):
    """文件无法作为本工具的输入使用。"""


@dataclass(frozen=True)
class LoadedAudio:
    path: Path
    samples: np.ndarray  # float64, (frames,) 或 (frames, 2)
    sample_rate: int

    @property
    def frames(self) -> int:
        return int(self.samples.shape[0])

    @property
    def channels(self) -> int:
        return 1 if self.samples.ndim == 1 else int(self.samples.shape[1])

    @property
    def duration_s(self) -> float:
        return self.frames / self.sample_rate

    @property
    def peak(self) -> float:
        return float(np.max(np.abs(self.samples))) if self.samples.size else 0.0

    @property
    def is_stereo(self) -> bool:
        return self.channels == 2


def _read_raw(path: Path) -> tuple[np.ndarray, int, int]:
    """返回 (float64 样本, 采样率, 原始声道数)。"""
    try:
        data, sample_rate = sf.read(str(path), dtype="float64", always_2d=True)
    except (RuntimeError, sf.LibsndfileError) as exc:  # type: ignore[attr-defined]
        raise AudioLoadError(f"无法读取音频文件: {path.name}: {exc}") from exc
    info = sf.info(str(path))
    return np.asarray(data, dtype=np.float64), int(sample_rate), int(info.channels)


def load_dry(path: str | Path) -> LoadedAudio:
    path = Path(path)
    data, sample_rate, channels = _read_raw(path)
    if channels not in (1, 2):
        raise AudioLoadError(
            f"干声必须是单声道或立体声，当前文件有 {channels} 个声道。"
        )
    if data.shape[0] == 0:
        raise AudioLoadError("干声文件没有采样点。")
    samples = data[:, 0].copy() if channels == 1 else data.copy()
    loaded = LoadedAudio(path=path, samples=samples, sample_rate=sample_rate)
    if loaded.duration_s > 10.0 + 1e-9:
        raise AudioLoadError(
            f"干声时长 {loaded.duration_s:.2f} 秒，超过 10 秒上限。"
        )
    return loaded


def load_impulse(path: str | Path) -> LoadedAudio:
    path = Path(path)
    data, sample_rate, channels = _read_raw(path)
    if channels != 1:
        raise AudioLoadError(
            f"脉冲响应必须是单声道，当前文件有 {channels} 个声道。"
        )
    if data.shape[0] == 0:
        raise AudioLoadError("脉冲响应文件没有采样点。")
    loaded = LoadedAudio(
        path=path, samples=data[:, 0].copy(), sample_rate=sample_rate
    )
    if loaded.duration_s > 3.0 + 1e-9:
        raise AudioLoadError(
            f"脉冲响应时长 {loaded.duration_s:.2f} 秒，超过 3 秒上限。"
        )
    return loaded


def write_wav(
    path: str | Path,
    samples: np.ndarray,
    sample_rate: int,
    subtype: str = EXPORT_SUBTYPE,
) -> None:
    """写出 wav。samples: (frames,) 或 (frames, channels)，取值不作裁剪。"""
    array = np.asarray(samples, dtype=np.float64)
    if array.ndim == 1:
        array = array[:, None]
    if array.ndim != 2 or array.shape[1] not in (1, 2):
        raise ValueError(f"只支持 1 或 2 声道输出，收到形状 {array.shape}")
    if not np.all(np.isfinite(array)):
        raise ValueError("输出含 NaN/Inf，拒绝写文件。")
    path = Path(path)
    sf.write(
        str(path),
        array,
        int(sample_rate),
        subtype=subtype,
        format="WAV",
        endian="LITTLE",
    )


def frames_for_duration(seconds: float, sample_rate: int) -> int:
    """把秒数换成采样点数（四舍五入，至少 0）。"""
    return max(0, int(math.floor(seconds * sample_rate + 0.5)))
