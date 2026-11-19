"""可运行的关键验证：所有数值都直接读自渲染输出的采样点。

    .venv/bin/python -m reverb_tool.verify

退出码 0 表示全部通过。窗口界面里的"一次生成全部样例"对应同一批素材。
"""

from __future__ import annotations

import tempfile
from pathlib import Path

import numpy as np

from .audio_io import load_dry, load_impulse, write_wav
from .dsp import ReverbParams, render
from .samples import impulse_response, write_all

SR = 48000
TOL = 1e-9


def _db(value: float) -> float:
    return 20.0 * np.log10(value) if value > 0 else -np.inf


def check(name: str, ok: bool, detail: str) -> bool:
    print(f"[{'PASS' if ok else 'FAIL'}] {name}: {detail}")
    return ok


def main() -> int:
    results: list[bool] = []
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        specs = write_all(tmp)
        print(f"样例已生成于 {tmp}")

        click_spec = next(s for s in specs if s.name == "单点脉冲干声")
        click_index = click_spec.expected["click_index"]
        dry = load_dry(click_spec.path)
        ir = load_impulse(tmp / "ir_echoes_48k.wav")
        params = ReverbParams(mix=1.0, predelay_ms=0.0, protection=False)
        wet = render(dry, ir, params)

        expected = dry.frames + ir.frames - 1
        results.append(
            check(
                "完整尾音长度",
                wet.frames == expected,
                f"干声 {dry.frames} + 响应 {ir.frames} - 1 = {expected}，"
                f"实际输出 {wet.frames} 点 ({wet.duration_s:.3f} s)",
            )
        )

        # 回声位置与幅度：直接读输出采样
        tap_values = []
        ir_taps = impulse_response(
            tmp / "ir_check.wav", sample_rate=SR
        ).expected["taps"]
        for delay_s, gain in ir_taps:
            index = click_index + round(delay_s * SR)
            amp = float(wet.samples[index, 0])
            tap_values.append((delay_s, gain, amp, abs(amp - gain * dry.peak) < TOL))
        results.append(
            check(
                "已知回声位置/幅度",
                all(item[3] for item in tap_values),
                "; ".join(
                    f"{d * 1000:.0f} ms 期望 {g * dry.peak:+.4f} 实得 {a:+.4f}"
                    if abs(a - g * dry.peak) < TOL
                    else f"{d * 1000:.0f} ms 期望 {g * dry.peak:+.4f} 实得 {a:+.4f} (偏差)"
                    for d, g, a, _ in tap_values
                ),
            )
        )

        # 预延迟
        shifted = render(dry, ir, ReverbParams(mix=1.0, predelay_ms=20.0, protection=False))
        shift_frames = round(0.020 * SR)
        results.append(
            check(
                "预延迟",
                shifted.frames == wet.frames + shift_frames
                and np.max(np.abs(shifted.samples[:shift_frames])) == 0.0
                and np.allclose(shifted.samples[shift_frames:], wet.samples, atol=TOL),
                f"20 ms = {shift_frames} 点，前 {shift_frames} 点全零，"
                "之后与无预延迟输出逐样本一致",
            )
        )

        # 纯干声
        pure = render(dry, ir, ReverbParams(mix=0.0, predelay_ms=0.0, protection=False))
        tail_peak = float(np.max(np.abs(pure.samples[dry.frames :]))) if pure.frames > dry.frames else 0.0
        results.append(
            check(
                "纯干声",
                np.allclose(pure.samples[: dry.frames], np.repeat(dry.samples[:, None], 2, 1), atol=TOL)
                and tail_peak == 0.0,
                f"前 {dry.frames} 点与原声逐样本一致；尾段峰值 {tail_peak:.1f}",
            )
        )

        # 左右互不串音：只给左声道一个脉冲
        stereo_path = tmp / "dry_left_only.wav"
        left = np.zeros((64, 2))
        left[0, 0] = 1.0
        write_wav(stereo_path, left, SR)
        stereo_dry = load_dry(stereo_path)
        bleed = render(stereo_dry, ir, ReverbParams(mix=1.0, protection=False))
        right_peak = float(np.max(np.abs(bleed.samples[:, 1])))
        left_peak = float(np.max(np.abs(bleed.samples[:, 0])))
        results.append(
            check(
                "左右互不串音",
                right_peak < 1e-12,
                f"左声道峰值 {_db(left_peak):+.1f} dBFS，右声道峰值 {_db(right_peak):+.1f} dBFS（{right_peak:.1e}）",
            )
        )

        # 统一衰减保护不改变左右比例
        loud = render(
            dry, ir, ReverbParams(mix=1.0, output_gain_db=12.0, protection=True)
        )
        ratio_ok = True
        if loud.protection_active:
            mask = np.abs(loud.samples) > 1e-9
            ratios = loud.raw_samples[mask] / loud.samples[mask]
            ratio_ok = bool(np.allclose(ratios, ratios[0], rtol=1e-9))
        results.append(
            check(
                "统一衰减保护",
                loud.output_peak <= 10 ** (-0.1 / 20) + 1e-12 and ratio_ok,
                f"保护前 {_db(loud.raw_peak):+.2f} dBFS → 保护后 {_db(loud.output_peak):+.2f} dBFS，"
                f"衰减 {loud.protection_gain_db:+.2f} dB，左右共用同一标量",
            )
        )

    print()
    print(f"通过 {sum(results)}/{len(results)} 项")
    return 0 if all(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
