"""音频读写与试听切片.

所有时间量一律以秒表示。原始文件只读, 任何写盘都写到显式指定的输出路径。

约定术语:
    参考录音 (reference)  —— 时间基准, 一是作为导出对齐结果的时间轴。
    待对齐录音 (take)     —— 会被时间调整 (拉伸/压缩/补静音) 的那一份。
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import soundfile as sf

MAX_DURATION_S = 120.0  # 处理两分钟以内的 wav


class AudioLoadError(RuntimeError):
    """加载音频失败, 附带用户可读的原因。"""


@dataclass(frozen=True)
class AudioClip:
    """一段已载入内存的音频, 保留原始采样率与原始声道布局。"""

    path: Path
    samples: np.ndarray  # float32, shape = (frames, channels)
    sample_rate: int
    role: str  # "reference" | "take"

    @property
    def duration(self) -> float:
        return len(self.samples) / float(self.sample_rate)

    @property
    def channels(self) -> int:
        return int(self.samples.shape[1])

    @property
    def frames(self) -> int:
        return int(self.samples.shape[0])

    def mono(self) -> np.ndarray:
        """分析用的单声道 48 kHz 以内信号 (不重采样, 仅混合声道)。"""
        if self.samples.shape[1] == 1:
            return self.samples[:, 0].astype(np.float64, copy=False)
        return self.samples.mean(axis=1).astype(np.float64, copy=False)

    def file_sha256(self) -> str:
        h = hashlib.sha256()
        with open(self.path, "rb") as fh:
            for chunk in iter(lambda: fh.read(1 << 20), b""):
                h.update(chunk)
        return h.hexdigest()

    def summary(self) -> str:
        name = "参考录音" if self.role == "reference" else "待对齐录音"
        return (
            f"{name}: {self.path.name} | {self.duration:.3f} s | "
            f"{self.sample_rate} Hz | {self.channels} ch"
        )


def _validate_frames(samples: np.ndarray, path: Path) -> None:
    if samples.ndim != 2:
        raise AudioLoadError(f"{path.name}: 不支持的声道布局")
    if samples.shape[0] == 0:
        raise AudioLoadError(f"{path.name}: 文件为空")
    if not np.all(np.isfinite(samples)):
        raise AudioLoadError(f"{path.name}: 含 NaN/Inf 采样")
    if float(np.max(np.abs(samples))) < 1e-9:
        raise AudioLoadError(f"{path.name}: 全程静音, 无法对齐")


def load_wav(path: str | Path, role: str, max_duration_s: float = MAX_DURATION_S) -> AudioClip:
    """读取一个 wav 文件到内存; 不修改原始文件。"""

    p = Path(path)
    if not p.is_file():
        raise AudioLoadError(f"找不到文件: {p}")
    try:
        info = sf.info(str(p))
    except Exception as exc:  # noqa: BLE001 - 需要把底层错误包装成可读信息
        raise AudioLoadError(f"无法识别音频文件 {p.name}: {exc}") from exc
    if info.format != "WAV":
        raise AudioLoadError(f"{p.name}: 只支持 wav (实际为 {info.format})")
    if info.duration > max_duration_s + 1e-6:
        raise AudioLoadError(
            f"{p.name}: 时长 {info.duration:.1f} s 超过上限 {max_duration_s:.0f} s"
        )
    try:
        data, sr = sf.read(str(p), dtype="float32", always_2d=True)
    except Exception as exc:  # noqa: BLE001
        raise AudioLoadError(f"读取 {p.name} 失败: {exc}") from exc
    data = np.ascontiguousarray(data, dtype=np.float32)
    _validate_frames(data, p)
    return AudioClip(path=p.resolve(), samples=data, sample_rate=int(sr), role=role)


def write_wav(path: str | Path, samples: np.ndarray, sample_rate: int, subtype: str = "FLOAT") -> Path:
    """把 float 数组写成 wav; subtype 默认 FLOAT 以避免对齐结果被量化掩盖。"""

    out = Path(path)
    out.parent.mkdir(parents=True, exist_ok=True)
    arr = np.asarray(samples, dtype=np.float32)
    if arr.ndim == 1:
        arr = arr[:, None]
    peak = float(np.max(np.abs(arr))) if arr.size else 0.0
    if peak > 1.0:
        # 不做隐式限幅: 抛错让调用方决定, 避免悄悄改变听感
        raise ValueError(f"输出幅度 {peak:.3f} 超出 [-1, 1], 拒绝写出")
    sf.write(str(out), arr, int(sample_rate), subtype=subtype, format="WAV")
    return out


def slice_seconds(clip: AudioClip, start_s: float, end_s: float) -> np.ndarray:
    """按秒取一段, 越界部分用静音补齐 (试听时保持请求时长)。"""

    if end_s <= start_s:
        raise ValueError("试听区间终点必须大于起点")
    sr = clip.sample_rate
    a = int(round(start_s * sr))
    b = int(round(end_s * sr))
    a = max(0, a)
    need = max(1, int(round((end_s - start_s) * sr)))
    seg = np.zeros((need, clip.channels), dtype=np.float32)
    if a < clip.frames:
        src = clip.samples[a : min(b, clip.frames)]
        seg[: len(src)] = src
    return seg


def peak_envelope(clip: AudioClip, start_s: float, end_s: float, bins: int = 600) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """为绘图计算 (左峰值, 右峰值, 单声道峰值) 的粗略包络, 返回按秒的 x 轴。"""

    if end_s <= start_s:
        end_s = start_s + 1e-3
    sr = clip.sample_rate
    a = max(0, int(round(start_s * sr)))
    b = min(clip.frames, max(a + 1, int(round(end_s * sr))))
    seg = clip.samples[a:b]
    n = seg.shape[0]
    bins = int(max(8, min(bins, n)))
    edges = np.linspace(0, n, bins + 1).astype(np.int64)
    xs = np.linspace(start_s, end_s, bins)
    left = np.zeros(bins, dtype=np.float32)
    right = np.zeros(bins, dtype=np.float32)
    mono = np.zeros(bins, dtype=np.float32)
    for i in range(bins):
        s0, s1 = edges[i], max(edges[i] + 1, edges[i + 1])
        chunk = seg[s0:s1]
        if chunk.size == 0:
            continue
        mono[i] = float(np.max(np.abs(chunk)))
        left[i] = float(np.max(np.abs(chunk[:, 0])))
        right[i] = float(np.max(np.abs(chunk[:, -1])))
    return xs, left, right, mono


def audio_sha256(samples: np.ndarray) -> str:
    return hashlib.sha256(np.ascontiguousarray(samples).tobytes()).hexdigest()
