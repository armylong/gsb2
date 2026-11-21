"""命令行自检: 生成固定音高样例 -> 拉伸 -> 导出 -> 校验时长与主频。

用法:
    python -m audiostretch.cli --out /tmp/stretch_check.wav
"""
from __future__ import annotations

import argparse
import sys

import numpy as np

from .core import StretchError, stretch
from .synth import dominant_freq, make_demo
from .wavio import write_wav


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="audiostretch.cli",
                                description="生成样例、拉伸导出并校验时长与主频")
    p.add_argument("--out", default="stretch_check.wav", help="输出 wav 路径")
    p.add_argument("--demo-out", default=None, help="同时保存原始样例到此路径")
    p.add_argument("--f0", type=float, default=220.0, help="样例基频 Hz")
    p.add_argument("--grain-ms", type=float, default=80.0)
    p.add_argument("--overlap", type=float, default=0.75)
    p.add_argument("--ratio", type=float, default=8.0)
    p.add_argument("--jitter-ms", type=float, default=5.0)
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--duration", type=float, default=12.0, help="导出时长(秒)")
    args = p.parse_args(argv)

    demo, sr = make_demo(f0=args.f0)
    if args.demo_out:
        write_wav(args.demo_out, demo, sr)
        print(f"样例已写出: {args.demo_out} ({len(demo) / sr:.2f}s, 主频 {args.f0}Hz)")

    try:
        res = stretch(demo, sr, 0.0, len(demo) / sr,
                      grain_ms=args.grain_ms, overlap=args.overlap, ratio=args.ratio,
                      jitter_ms=args.jitter_ms, seed=args.seed, target_sec=args.duration)
    except StretchError as e:
        print(f"参数错误: {e}", file=sys.stderr)
        return 2

    write_wav(args.out, res.audio, sr)
    print(f"已导出: {args.out}")

    # --- 校验 ---
    ok = True
    dur = len(res.audio) / sr
    grain_s = args.grain_ms / 1000.0
    dur_ok = abs(dur - args.duration) <= grain_s + 0.02
    ok &= dur_ok
    print(f"[{'PASS' if dur_ok else 'FAIL'}] 时长: {dur:.3f}s (目标 {args.duration}s, 容差 ±{grain_s + 0.02:.3f}s)")

    mid = res.audio[int(0.3 * len(res.audio)):int(0.7 * len(res.audio))]
    f = dominant_freq(mid, sr)
    f_ok = abs(f - args.f0) / args.f0 <= 0.02
    ok &= f_ok
    print(f"[{'PASS' if f_ok else 'FAIL'}] 主频: {f:.2f}Hz (目标 {args.f0}Hz, 容差 ±2%)")

    ch_ok = res.audio.shape[1] == 2
    ok &= ch_ok
    print(f"[{'PASS' if ch_ok else 'FAIL'}] 声道数: {res.audio.shape[1]} (目标 2)")

    peak = float(np.abs(res.audio).max())
    clip_ok = peak <= 1.0
    ok &= clip_ok
    print(f"[{'PASS' if clip_ok else 'FAIL'}] 峰值: {peak:.3f} (无削波)")

    print("全部通过" if ok else "存在失败项", file=sys.stderr)
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
