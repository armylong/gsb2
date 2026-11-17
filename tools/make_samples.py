#!/usr/bin/env python3
"""make_samples.py — 在 samples/ 下生成可直接导入的短 WAV 样例（全部 1 秒左右）。

样例设计：
  ping_stereo_44100.wav  双声道 44.1k：左右同频不同相位的正弦 ping，
                         故意让首尾采样不连续，便于观察原始接缝跳变。
  pluck_stereo_48000.wav 双声道 48k：带衰减包络的拨弦音，适合做无爆音循环。
  pulse_mono_22050.wav   单声道 22.05k：重复小脉冲，验证单声道边界。
不做任何节拍识别，仅确定性合成。
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from wav_io import write_wav16  # noqa: E402

OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "samples")


def gen_ping(sr=44100, dur=1.0):
    n = int(sr * dur)
    left, right = [], []
    for i in range(n):
        t = i / sr
        env = min(1.0, t * 40) * math.exp(-2.2 * t)
        left.append(0.7 * env * math.sin(2 * math.pi * 440 * t))
        right.append(0.7 * env * math.sin(2 * math.pi * 440 * t + math.pi / 3))
    # 起点保持非零振幅，制造明显接缝跳变用于演示
    return [left, right]


def gen_pluck(sr=48000, dur=0.9):
    n = int(sr * dur)
    left, right = [], []
    for i in range(n):
        t = i / sr
        env = math.exp(-3.5 * t)
        # 基频 + 两个泛音，左右轻微声像差异
        v = math.sin(2 * math.pi * 330 * t) + 0.45 * math.sin(2 * math.pi * 660 * t) \
            + 0.22 * math.sin(2 * math.pi * 990 * t)
        left.append(0.55 * env * v)
        right.append(0.5 * env * (math.sin(2 * math.pi * 330 * t + 0.5)
                                  + 0.45 * math.sin(2 * math.pi * 660 * t + 0.5)))
    return [left, right]


def gen_pulse(sr=22050, dur=0.8):
    n = int(sr * dur)
    mono = [0.0] * n
    period = int(sr * 0.1)  # 每 100ms 一个短脉冲
    for k in range(0, n, period):
        for j in range(min(40, n - k)):
            mono[k + j] = 0.6 * math.exp(-j / 9.0) * math.sin(2 * math.pi * 880 * (j / sr))
    return [mono]


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    jobs = [
        ("ping_stereo_44100.wav", gen_ping(), 44100),
        ("pluck_stereo_48000.wav", gen_pluck(), 48000),
        ("pulse_mono_22050.wav", gen_pulse(), 22050),
    ]
    for name, channels, sr in jobs:
        path = os.path.join(OUT_DIR, name)
        frames = write_wav16(path, channels, sr)
        print("generated %s (%d frames, %d Hz, %d ch)" % (path, frames, sr, len(channels)))


if __name__ == "__main__":
    main()
