"""核心倒放逻辑(纯函数, 与 GUI / 编解码无关, 便于测试).

约定:
- 视频帧编号 0..n-1, 恒定帧率 fps.
- 倒放区间为 [f0, f1): 起点包含, 终点不包含; f1 可以等于 n(最后一帧之后的片尾位置).
- 区间至少包含两帧.
- 音频按相同内容时间换算到采样边界: s = round(t * sr), 只反转 [s0, s1) 内的采样,
  不交换声道.
"""

from __future__ import annotations

from dataclasses import dataclass
from fractions import Fraction

import numpy as np


@dataclass(frozen=True)
class FrameRange:
    """吸附到实际视频帧后的倒放区间 [f0, f1)."""

    f0: int
    f1: int

    def validate(self, n_frames: int) -> None:
        if not 0 <= self.f0 < self.f1 <= n_frames:
            raise ValueError(
                f"区间越界: 需要 0 <= 起点 < 终点 <= {n_frames}, 得到 [{self.f0}, {self.f1})"
            )
        if self.f1 - self.f0 < 2:
            raise ValueError(f"区间至少需要两帧, 当前 {self.f1 - self.f0} 帧")

    @property
    def length(self) -> int:
        return self.f1 - self.f0


def video_frame_mapping(n_frames: int, rng: FrameRange) -> list[int]:
    """返回输出帧 i 对应的原帧编号.

    区间外保持原顺序, 区间内逆序; 输出时间轴仍然递增.
    """
    rng.validate(n_frames)
    mapping = list(range(n_frames))
    for out_idx in range(rng.f0, rng.f1):
        mapping[out_idx] = rng.f0 + (rng.f1 - 1 - out_idx)
    return mapping


@dataclass(frozen=True)
class AudioBounds:
    """音频采样边界及不足一个采样点的舍入差(单位: 采样点)."""

    s0: int
    s1: int
    err0: float  # s0 - t0*sr, 四舍五入引入的偏移, |err| <= 0.5
    err1: float
    sample_rate: int
    total_samples: int

    @property
    def length(self) -> int:
        return self.s1 - self.s0


def audio_sample_bounds(
    rng: FrameRange,
    fps: Fraction,
    sample_rate: int,
    total_samples: int,
) -> AudioBounds:
    """把帧区间 [f0, f1) 按内容时间换算为采样区间 [s0, s1)."""
    t0 = float(Fraction(rng.f0, 1) / fps)
    t1 = float(Fraction(rng.f1, 1) / fps)
    exact0 = t0 * sample_rate
    exact1 = t1 * sample_rate
    s0 = min(max(round(exact0), 0), total_samples)
    s1 = min(max(round(exact1), 0), total_samples)
    return AudioBounds(
        s0=s0,
        s1=s1,
        err0=s0 - exact0,
        err1=s1 - exact1,
        sample_rate=sample_rate,
        total_samples=total_samples,
    )


def reverse_audio_segment(samples: np.ndarray, s0: int, s1: int) -> np.ndarray:
    """反转 [s0, s1) 内的采样, 其余保持不动.

    samples 形状为 (channels, n); 逐声道各自反转, 不交换左右声道.
    """
    if not 0 <= s0 <= s1 <= samples.shape[1]:
        raise ValueError(f"采样区间越界: [{s0}, {s1}) / {samples.shape[1]}")
    out = samples.copy()
    out[:, s0:s1] = samples[:, s0:s1][:, ::-1]
    return out
