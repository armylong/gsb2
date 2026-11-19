"""卷积混响核心（纯 NumPy/SciPy，不依赖 Qt 与声卡）。

约定
----
* 内部一律 float64、形状 ``(frames, 2)``。
* 输出时间轴：``[预延迟][完整卷积尾音]``，总长
  ``n_dry + n_ir_used - 1 + predelay``。
* 湿声 = 每个输出声道分别与同一条（重采样后的）单声道响应做完整卷积；
  左右互不串音，响应不做任何自动归一化。
* 干湿比例使用线性交叉淡化 ``out = (1-mix)*dry + mix*wet``，
  所以 mix=0 是纯干声、mix=1 是纯混响。
* 统一衰减保护只在最终输出上乘一个左右共享的标量，不改变左右比例。
"""

from __future__ import annotations

import math
from dataclasses import dataclass, replace

import numpy as np
from scipy.signal import fftconvolve, resample_poly

from .audio_io import LoadedAudio, frames_for_duration

MIN_PREDELAY_MS = 0.0
MAX_PREDELAY_MS = 1000.0
MIN_GAIN_DB = -48.0
MAX_GAIN_DB = 24.0


@dataclass(frozen=True)
class ReverbParams:
    mix: float = 0.5  # 0 = 纯干声, 1 = 纯混响
    predelay_ms: float = 0.0
    output_gain_db: float = 0.0
    protection: bool = True
    ceiling_db: float = -0.1  # 统一衰减保护的上限 (dBFS)

    def normalized(self) -> ReverbParams:
        return replace(
            self,
            mix=float(np.clip(self.mix, 0.0, 1.0)),
            predelay_ms=float(
                np.clip(self.predelay_ms, MIN_PREDELAY_MS, MAX_PREDELAY_MS)
            ),
            output_gain_db=float(
                np.clip(self.output_gain_db, MIN_GAIN_DB, MAX_GAIN_DB)
            ),
            ceiling_db=float(np.clip(self.ceiling_db, -24.0, 0.0)),
        )

    def key(self, sample_rate: int) -> tuple:
        """用于判断"预览是否仍对应当前参数"的稳定键。"""
        return (
            round(self.mix, 6),
            round(self.predelay_ms, 4),
            round(self.output_gain_db, 4),
            bool(self.protection),
            round(self.ceiling_db, 4),
            int(sample_rate),
        )


@dataclass(frozen=True)
class RenderResult:
    samples: np.ndarray  # (n, 2) 最终输出（若启用保护则已统一衰减）
    raw_samples: np.ndarray  # (n, 2) 保护前输出
    dry_reference: np.ndarray  # (n, 2) 对齐到输出时间轴的干声（未加增益）
    dry_monitor: np.ndarray  # (n, 2) 干声 + 同一输出增益与保护标量，用于 A/B
    dry_sample_rate: int
    ir_sample_rate: int
    dry_frames: int
    ir_frames_input: int
    ir_frames_used: int
    predelay_frames: int
    params: ReverbParams
    dry_peak: float
    dry_monitor_peak: float
    raw_peak: float
    output_peak: float
    protection_gain_db: float = 0.0

    # ---------- 长度与时间轴 ----------
    @property
    def frames(self) -> int:
        return int(self.samples.shape[0])

    @property
    def channels(self) -> int:
        return int(self.samples.shape[1])

    @property
    def dry_end_frame(self) -> int:
        """干声在输出时间轴上结束的位置（= 尾音起点）。"""
        return self.predelay_frames + self.dry_frames

    @property
    def tail_frames(self) -> int:
        return self.frames - self.dry_end_frame

    @property
    def expected_frames(self) -> int:
        return self.dry_frames + self.ir_frames_used - 1 + self.predelay_frames

    # ---------- 时间换算 ----------
    @property
    def duration_s(self) -> float:
        return self.frames / self.dry_sample_rate

    @property
    def dry_duration_s(self) -> float:
        return self.dry_frames / self.dry_sample_rate

    @property
    def ir_used_duration_s(self) -> float:
        return self.ir_frames_used / self.dry_sample_rate

    @property
    def ir_input_duration_s(self) -> float:
        return self.ir_frames_input / self.ir_sample_rate

    @property
    def dry_end_s(self) -> float:
        return self.dry_end_frame / self.dry_sample_rate

    @property
    def tail_duration_s(self) -> float:
        return self.tail_frames / self.dry_sample_rate

    # ---------- 峰值 ----------
    @property
    def overshoot(self) -> bool:
        """保护前输出是否超过 0 dBFS。"""
        return self.raw_peak > 1.0 + 1e-12

    @property
    def overshoot_db(self) -> float:
        return linear_to_db(self.raw_peak) if self.raw_peak > 0 else -math.inf

    @property
    def protection_active(self) -> bool:
        return self.params.protection and self.protection_gain_db < -1e-9

    def params_key(self) -> tuple:
        return self.params.key(self.dry_sample_rate)

    def crop_frames(self, start_frame: int, end_frame: int) -> np.ndarray:
        start = int(np.clip(start_frame, 0, self.frames))
        end = int(np.clip(end_frame, start, self.frames))
        return np.ascontiguousarray(self.samples[start:end], dtype=np.float64)


def resample_impulse(dry: LoadedAudio, ir: LoadedAudio) -> np.ndarray:
    """把单声道响应重采样到干声采样率，返回实际使用的响应。"""
    if ir.sample_rate == dry.sample_rate:
        return np.asarray(ir.samples, dtype=np.float64).copy()
    common = math.gcd(int(dry.sample_rate), int(ir.sample_rate))
    up = int(dry.sample_rate) // common
    down = int(ir.sample_rate) // common
    return np.asarray(
        resample_poly(np.asarray(ir.samples, dtype=np.float64), up, down),
        dtype=np.float64,
    )


def _as_stereo(samples: np.ndarray) -> np.ndarray:
    array = np.asarray(samples, dtype=np.float64)
    if array.ndim == 1:
        return np.repeat(array[:, None], 2, axis=1)
    if array.shape[1] == 1:
        return np.repeat(array, 2, axis=1)
    if array.shape[1] != 2:
        raise ValueError(f"只支持 1/2 声道，收到 {array.shape[1]}")
    return array


def _place(source: np.ndarray, offset: int, total: int) -> np.ndarray:
    """把 source 从 offset 开始放到长度为 total 的全零画布上。"""
    out = np.zeros((total, source.shape[1]), dtype=np.float64)
    if source.shape[0] <= 0 or total <= 0:
        return out
    start = min(max(0, offset), total)
    end = min(total, start + source.shape[0])
    if end > start:
        out[start:end] = source[: end - start]
    return out


def gain_db_to_linear(gain_db: float) -> float:
    return float(10.0 ** (gain_db / 20.0))


def linear_to_db(value: float) -> float:
    return 20.0 * math.log10(value) if value > 0 else -math.inf


def render(dry: LoadedAudio, ir: LoadedAudio, params: ReverbParams) -> RenderResult:
    """按当前参数渲染整段输出（含完整尾音）。"""
    if dry.sample_rate <= 0 or ir.sample_rate <= 0:
        raise ValueError("采样率必须为正数")

    params = params.normalized()
    dry_stereo = _as_stereo(dry.samples)
    ir_used = resample_impulse(dry, ir)
    predelay = frames_for_duration(params.predelay_ms / 1000.0, dry.sample_rate)
    n_dry = int(dry_stereo.shape[0])
    n_ir = int(ir_used.shape[0])
    if n_ir <= 0:
        raise ValueError("重采样后的脉冲响应为空")

    conv_frames = n_dry + n_ir - 1
    total = conv_frames + predelay

    wet = np.empty((conv_frames, 2), dtype=np.float64)
    for ch in range(2):
        wet[:, ch] = fftconvolve(dry_stereo[:, ch], ir_used, mode="full")

    wet = _place(wet, predelay, total)
    dry_aligned = _place(dry_stereo, predelay, total)

    mix = float(params.mix)
    mixed = (1.0 - mix) * dry_aligned + mix * wet
    gain = gain_db_to_linear(params.output_gain_db)
    raw = mixed * gain
    raw_peak = float(np.max(np.abs(raw))) if raw.size else 0.0

    # 统一衰减：整段乘同一个标量，左右比例、两声道关系保持不变。
    protection_gain_db = 0.0
    output = raw
    if params.protection:
        ceiling = gain_db_to_linear(params.ceiling_db)
        if raw_peak > ceiling and raw_peak > 0.0:
            scale = ceiling / raw_peak
            protection_gain_db = linear_to_db(scale)
            output = raw * scale

    scale_applied = gain * gain_db_to_linear(protection_gain_db)
    dry_monitor = dry_aligned * scale_applied
    output_peak = float(np.max(np.abs(output))) if output.size else 0.0
    dry_peak = float(np.max(np.abs(dry_stereo))) if dry_stereo.size else 0.0
    dry_monitor_peak = (
        float(np.max(np.abs(dry_monitor))) if dry_monitor.size else 0.0
    )

    return RenderResult(
        samples=np.ascontiguousarray(output, dtype=np.float64),
        raw_samples=np.ascontiguousarray(raw, dtype=np.float64),
        dry_reference=np.ascontiguousarray(dry_aligned, dtype=np.float64),
        dry_monitor=np.ascontiguousarray(dry_monitor, dtype=np.float64),
        dry_sample_rate=int(dry.sample_rate),
        ir_sample_rate=int(ir.sample_rate),
        dry_frames=n_dry,
        ir_frames_input=int(ir.frames),
        ir_frames_used=n_ir,
        predelay_frames=predelay,
        params=params,
        dry_peak=dry_peak,
        dry_monitor_peak=dry_monitor_peak,
        raw_peak=raw_peak,
        output_peak=output_peak,
        protection_gain_db=protection_gain_db,
    )
