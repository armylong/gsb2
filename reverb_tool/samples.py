"""可复现的测试素材生成器。

所有样例都写成 wav 并按已知参数命名（回声位置 / 幅度 / 音符时长），
方便在界面里"导入 → 核对"。返回 :class:`SampleSpec` 描述预期值。
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from scipy.signal import resample_poly

from .audio_io import write_wav

DEFAULT_SAMPLE_RATE = 48000


@dataclass(frozen=True)
class EchoTap:
    delay_s: float
    gain: float
    channel: int | None = None  # None = 两声道相同; 0/1 = 只出现在该侧


@dataclass(frozen=True)
class SampleSpec:
    name: str
    path: Path
    sample_rate: int
    kind: str  # "dry" / "ir" / "both"
    description: str
    expected: dict = field(default_factory=dict)


def _click(frames: int, index: int, amplitude: float) -> np.ndarray:
    out = np.zeros(frames, dtype=np.float64)
    out[index] = amplitude
    return out


def short_note(
    path: Path,
    sample_rate: int = DEFAULT_SAMPLE_RATE,
    duration_s: float = 0.25,
    frequency: float = 440.0,
) -> SampleSpec:
    """短音符：带缓起的正弦，后面留一段数字静音，便于听尾音。"""
    frames = round(duration_s * sample_rate)
    t = np.arange(frames, dtype=np.float64) / sample_rate
    envelope = np.ones(frames, dtype=np.float64)
    fade = max(1, int(0.005 * sample_rate))
    if frames > 2 * fade:
        envelope[:fade] = np.linspace(0.0, 1.0, fade)
        envelope[-fade:] = np.linspace(1.0, 0.0, fade)
    tone = 0.5 * np.sin(2.0 * math.pi * frequency * t) * envelope
    note_frames = frames
    total = frames + int(0.75 * sample_rate)  # 0.75 s 静音，听得到尾音出来后停止
    samples = np.zeros(total, dtype=np.float64)
    samples[:note_frames] = tone
    write_wav(path, samples, sample_rate)
    return SampleSpec(
        name="短音符干声",
        path=path,
        sample_rate=sample_rate,
        kind="dry",
        description=(
            f"{duration_s:.2f} s 的 {frequency:.0f} Hz 正弦，尾部额外 "
            f"0.75 s 数字静音；适合检查干声停止后的尾音。"
        ),
        expected={
            "note_frames": note_frames,
            "silent_tail_frames": total - note_frames,
            "peak": 0.5,
        },
    )


def click_dry(
    path: Path,
    sample_rate: int = DEFAULT_SAMPLE_RATE,
    click_index: int = 480,
    amplitude: float = 0.9,
    duration_s: float = 0.05,
) -> SampleSpec:
    """单点脉冲干声：输出采样里能直接读出回声位置与幅度。"""
    frames = round(duration_s * sample_rate)
    samples = _click(frames, click_index, amplitude)
    write_wav(path, samples, sample_rate)
    return SampleSpec(
        name="单点脉冲干声",
        path=path,
        sample_rate=sample_rate,
        kind="dry",
        description=(
            f"{duration_s:.2f} s 单声道，只有第 {click_index} 点 = {amplitude:+.2f}；"
            "配离散回声响应可直接读回声采样值和位置。"
        ),
        expected={"click_index": click_index, "amplitude": amplitude, "frames": frames},
    )


def stereo_note(path: Path, sample_rate: int = DEFAULT_SAMPLE_RATE) -> SampleSpec:
    """左右不同相位的短音符，用于检查左右不串音。"""
    frames = round(0.3 * sample_rate)
    t = np.arange(frames, dtype=np.float64) / sample_rate
    left = 0.5 * np.sin(2 * math.pi * 330.0 * t)
    right = 0.25 * np.sin(2 * math.pi * 550.0 * t)
    total = frames + int(0.5 * sample_rate)
    samples = np.zeros((total, 2), dtype=np.float64)
    samples[:frames, 0] = left
    samples[:frames, 1] = right
    write_wav(path, samples, sample_rate)
    return SampleSpec(
        name="立体声短音符干声",
        path=path,
        sample_rate=sample_rate,
        kind="dry",
        description="左 330 Hz、右 550 Hz，各 0.3 s（峰值 0.5 / 0.25），后接 0.5 s 静音。",
        expected={"left_freq": 330.0, "right_freq": 550.0, "peak_left": 0.5, "peak_right": 0.25},
    )


def impulse_response(
    path: Path,
    sample_rate: int = DEFAULT_SAMPLE_RATE,
    taps: tuple[EchoTap, ...] = (
        EchoTap(0.0, 1.0),
        EchoTap(0.050, 0.5),
        EchoTap(0.120, 0.25),
        EchoTap(0.250, -0.125),
    ),
    length_s: float = 0.8,
) -> SampleSpec:
    """离散回声响应：每个 tap 是一个已知位置/幅度的单点。"""
    frames = round(length_s * sample_rate)
    ir = np.zeros(frames, dtype=np.float64)
    for tap in taps:
        index = round(tap.delay_s * sample_rate)
        if 0 <= index < frames:
            ir[index] += tap.gain
    write_wav(path, ir, sample_rate)
    tap_list = ", ".join(f"{t.delay_s * 1000:.0f} ms@{t.gain:+.3f}" for t in taps)
    return SampleSpec(
        name="离散回声响应",
        path=path,
        sample_rate=sample_rate,
        kind="ir",
        description=f"{length_s:.2f} s 单声道响应，回声: {tap_list}",
        expected={
            "taps": tuple((t.delay_s, t.gain) for t in taps),
            "length_s": length_s,
            "frames": frames,
        },
    )


def synthetic_ir(
    path: Path,
    sample_rate: int = DEFAULT_SAMPLE_RATE,
    length_s: float = 0.6,
    decay: float = 0.35,
    seed: int = 7,
) -> SampleSpec:
    """指数衰减噪声响应（没有离散回声，听感更像房间）。"""
    frames = round(length_s * sample_rate)
    rng = np.random.default_rng(seed)
    t = np.arange(frames, dtype=np.float64) / sample_rate
    noise = rng.standard_normal(frames)
    envelope = np.exp(-t / decay)
    ir = noise * envelope
    ir /= np.max(np.abs(ir))
    ir[0] = 0.9  # 直接声
    write_wav(path, ir, sample_rate)
    return SampleSpec(
        name="指数衰减噪声响应",
        path=path,
        sample_rate=sample_rate,
        kind="ir",
        description=f"{length_s:.2f} s，时间常数 {decay:.2f} s，第 0 点 0.9 为直接声。",
        expected={"frames": frames, "decay": decay, "direct": 0.9},
    )


def mismatched_rate_ir(
    path: Path,
    ir_sample_rate: int = 44100,
    taps: tuple[EchoTap, ...] = (EchoTap(0.0, 1.0), EchoTap(0.080, 0.5)),
    length_s: float = 0.5,
) -> SampleSpec:
    """44.1 kHz 响应，用来核对"以干声采样率处理"和实际使用长度。"""
    frames = round(length_s * ir_sample_rate)
    ir = np.zeros(frames, dtype=np.float64)
    for tap in taps:
        index = round(tap.delay_s * ir_sample_rate)
        if 0 <= index < frames:
            ir[index] += tap.gain
    write_wav(path, ir, ir_sample_rate)
    resampled_frames = len(resample_poly(ir, 48000, 44100))
    return SampleSpec(
        name="44.1 kHz 离散回声响应",
        path=path,
        sample_rate=ir_sample_rate,
        kind="ir",
        description=(
            f"44.1 kHz、{length_s:.2f} s；导入后应按干声采样率重采样，"
            f"重采样后约 {resampled_frames} 点。"
        ),
        expected={
            "frames": frames,
            "taps": tuple((t.delay_s, t.gain) for t in taps),
            "resampled_frames_at_48k": resampled_frames,
        },
    )


def write_all(directory: str | Path) -> list[SampleSpec]:
    """在 directory 下生成全部样例，返回描述列表。"""
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    specs = [
        click_dry(directory / "dry_click_48k.wav"),
        short_note(directory / "dry_note_48k.wav"),
        stereo_note(directory / "dry_stereo_48k.wav"),
        stereo_note(directory / "dry_stereo_44k.wav", sample_rate=44100),
        impulse_response(directory / "ir_echoes_48k.wav"),
        synthetic_ir(directory / "ir_noise_48k.wav"),
        mismatched_rate_ir(directory / "ir_echoes_44k1.wav"),
    ]
    return specs


if __name__ == "__main__":  # python -m reverb_tool.samples [目录]
    import sys

    target = sys.argv[1] if len(sys.argv) > 1 else "samples"
    for spec in write_all(target):
        print(f"{spec.path}  |  {spec.name}  |  {spec.description}")
