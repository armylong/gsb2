"""Offline export CLI: render the current 16-step pattern without the GUI.

Run ``python -m drumchopper.export --help`` for details.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

from . import audio as A


def _parse_steps(text: str) -> list[int | None]:
    cleaned = text.replace(",", " ").replace("|", " ").strip()
    compact = cleaned.replace(" ", "")
    if " " not in cleaned:
        # allow a compact 16-character pattern such as ``0-1-2-0-1-2-3-0-``
        parts = list(compact)
    else:
        parts = cleaned.split()
    if len(parts) != A.STEPS:
        raise SystemExit(f"步骤必须正好 {A.STEPS} 项, 例如: "
                         f"0-1-2-0-1-2-3-0-"
                         f"  (数字为切片序号, - 为空格)")
    steps: list[int | None] = []
    for p in parts:
        steps.append(None if p in ("-", "", ".", "_") else int(p))
    return steps


def _parse_slices(text: str) -> list[int]:
    return [int(v) for v in text.replace(",", " ").split()]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="把短鼓循环按切点重排成 16 格节奏并导出 wav")
    parser.add_argument("input", help="输入 wav (≤8 s, 单/立体声)")
    parser.add_argument("output", help="输出 wav")
    parser.add_argument("--bpm", type=float, default=120.0)
    parser.add_argument("--steps", default="0---1---2---0---",
                        help="16 格: 紧凑串如 0-1-2-0-1-2-3-0-, 或空格分隔 16 项; "
                             "数字=切片序号 (0 起), '-'=空格. 默认 0---1---2---0---, "
                             "不够 16 格时可用隔项写法 0 - - - 1 - - - 2 - - - 0 - - -")
    parser.add_argument("--slices", default=None,
                        help="手动切点采样位置, 逗号/空格分隔; 省略则自动检测")
    parser.add_argument("--fade-ms", type=float, default=5.0,
                        help="每片统一的淡入/淡出长度, 毫秒")
    parser.add_argument("--target-peak", type=float, default=0.98,
                        help="超幅保护的统一衰减目标峰值")
    parser.add_argument("--no-protection", action="store_true",
                        help="关闭超幅保护 (仍会硬限幅到 ±1)")
    parser.add_argument("--json", default=None, help="导出元数据 json 路径")
    args = parser.parse_args(argv)

    source = A.read_wav(args.input)
    steps = _parse_steps(args.steps)
    if args.slices:
        cuts = _parse_slices(args.slices)
    else:
        cuts = A.detect_onsets(source.samples, source.samplerate,
                               limit=A.MAX_SLICES - 1)
    model = A.SliceModel(source.frames)
    model.set_cuts(cuts)
    for i, s in enumerate(steps):
        if s is not None and not (0 <= s < model.count):
            raise SystemExit(f"第 {i + 1} 格引用了不存在的切片 {s} (共 {model.count} 片)")

    sequence = A.Sequence(steps)
    fade_s = args.fade_ms / 1000.0
    render = A.render_sequence(
        source, model, sequence, args.bpm,
        fade_in_s=fade_s, fade_out_s=fade_s,
        apply_protection=not args.no_protection,
        target_peak=args.target_peak,
    )
    A.write_wav(args.output, render.audio, source.samplerate)

    meta = {
        "input": str(args.input),
        "output": str(args.output),
        "samplerate": source.samplerate,
        "channels": source.channels,
        "bpm": args.bpm,
        "fade_in_s": fade_s,
        "fade_out_s": fade_s,
        "frames": render.length,
        "duration": render.length / source.samplerate,
        "step_samples": render.step_offsets,
        "gain": render.gain,
        "peak_before": render.peak_before,
        "peak_after": render.peak_after,
        "slices": [{"index": i, "start": s, "end": e}
                   for i, (s, e) in enumerate(model.slice_bounds())],
        "steps": steps,
    }
    json_path = args.json or str(Path(args.output).with_suffix(".json"))
    Path(json_path).write_text(json.dumps(meta, indent=2, ensure_ascii=False),
                               encoding="utf-8")
    print(f"导出 {args.output}: {render.length} 采样 "
          f"({render.length / source.samplerate:.4f}s), 峰值 {render.peak_after:.3f}"
          + (f", 保护衰减 {20 * math.log10(render.gain):.2f} dB"
             if render.gain < 0.9999 else ""))
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
