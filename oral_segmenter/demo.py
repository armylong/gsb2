"""在程序内生成一段可复现的口述录音样例。"""

from __future__ import annotations

import math
import random
import wave
from pathlib import Path

# 语音爆发区间 (秒)。组内短停顿 90/120ms, 组间静音 500/700ms,
# 正好用来验证“短停顿不切段”。
DEMO_SCHEDULE: tuple[tuple[float, float], ...] = (
    (0.00, 0.55),
    (0.64, 0.45),
    (1.79, 0.80),
    (3.09, 0.35),
    (3.56, 0.50),
)
DEMO_TOTAL_SECONDS = 4.06
DEMO_SAMPLE_RATE = 16_000


def _voice_burst(rng: random.Random, seconds: float, sample_rate: int) -> list[float]:
    """合成一段带共振峰和音节起伏的浊音, 峰值约 -8 dBFS。"""
    count = int(round(seconds * sample_rate))
    f0 = rng.uniform(105.0, 165.0)
    # 用两个“共振峰”给谐波加权, 听感接近人声而不是纯音。
    formants = (rng.uniform(450, 750), rng.uniform(1200, 1900))
    syllable_rate = rng.uniform(2.4, 3.4)
    syllable_phase = rng.uniform(0.0, 2 * math.pi)

    samples: list[float] = []
    phase = 0.0
    for i in range(count):
        t = i / sample_rate
        freq = f0 * (1.0 + 0.03 * math.sin(2 * math.pi * 0.8 * t))
        phase += 2 * math.pi * freq / sample_rate
        value = 0.0
        for harmonic in range(1, 16):
            f = freq * harmonic
            if f > sample_rate / 2:
                break
            weight = 0.0
            for center in formants:
                weight += math.exp(-0.5 * ((f - center) / 260.0) ** 2)
            value += (weight + 0.05) * math.sin(harmonic * phase) / harmonic
        syllable = 0.55 + 0.45 * math.sin(
            2 * math.pi * syllable_rate * t + syllable_phase
        ) ** 2
        samples.append(value * syllable)

    peak = max((abs(v) for v in samples), default=1.0) or 1.0
    target = rng.uniform(0.28, 0.42)
    fade = min(int(0.012 * sample_rate), max(1, count // 4))
    for i in range(count):
        gain = target / peak
        if i < fade:
            gain *= i / fade
        if i >= count - fade:
            gain *= (count - i) / fade
        samples[i] *= gain
    return samples


def build_demo_samples(sample_rate: int = DEMO_SAMPLE_RATE) -> list[int]:
    """生成 16 bit 单声道样本 (int16 范围), 固定随机种子, 每次结果一致。"""
    rng = random.Random(20241122)
    total = int(round(DEMO_TOTAL_SECONDS * sample_rate))
    noise_floor = 0.0009  # 约 -61 dBFS 底噪
    mix = [rng.uniform(-noise_floor, noise_floor) for _ in range(total)]

    for start_s, duration_s in DEMO_SCHEDULE:
        burst = _voice_burst(rng, duration_s, sample_rate)
        start = int(round(start_s * sample_rate))
        for offset, value in enumerate(burst):
            index = start + offset
            if 0 <= index < total:
                mix[index] += value

    return [max(-32768, min(32767, int(round(v * 32767)))) for v in mix]


def make_demo_wav(path: str | Path, sample_rate: int = DEMO_SAMPLE_RATE) -> Path:
    """把样例写到 path, 返回该路径。"""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = bytearray()
    for value in build_demo_samples(sample_rate):
        payload += int(value).to_bytes(2, "little", signed=True)
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(bytes(payload))
    return path
