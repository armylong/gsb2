# -*- coding: utf-8 -*-
"""命令行验证脚本: 不依赖 GUI, 覆盖需求中的关键质量指标与回读检查。

运行:
    python verify.py            # 完整验证(含全部转换组合)
    python verify.py --quick    # 仅核心 48kHz -> 16kHz 验收组合

验收点(高质量路径, 48k -> 16k):
    1kHz 通带音幅变化 < 1 dB
    12kHz 折叠到 4kHz 的能量相对原 12kHz 下降 >= 40 dB
另检查: 等长点数、同采样率原样复制、左右串音、导出回读一致性。
"""
from __future__ import annotations

import argparse
import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "src"))

import numpy as np  # noqa: E402

from srcompare.audioio import read_wav_any_rate, save_wav  # noqa: E402
from srcompare.measure import (  # noqa: E402
    ALIAS_SUPPRESS_DB, PASSBAND_LIMIT_DB, evaluate_conversion, verify_export,
)
from srcompare.resample import convert, expected_num_frames  # noqa: E402
from srcompare.testtone import make_test_tone  # noqa: E402

failures: list[str] = []


def check(condition: bool, text: str):
    mark = "PASS" if condition else "FAIL"
    print(f"[{mark}] {text}")
    if not condition:
        failures.append(text)


def run_case(in_sr: int, target_sr: int, tmpdir: str, detailed: bool):
    print("\n" + "=" * 74)
    print(f"测试音: 左右不同 (L:1k+2k+12k / R:1k), {in_sr}Hz -> {target_sr}Hz")
    print("=" * 74)
    src = make_test_tone("stereo_independence", in_sr, duration=2.0)
    lin = convert(src, target_sr, "linear")
    hq = convert(src, target_sr, "high_quality")

    want_n = expected_num_frames(src, target_sr)
    check(lin.num_frames == want_n and hq.num_frames == want_n,
          f"两路输出点数均为 round(时长×目标率)={want_n} "
          f"(linear={lin.num_frames}, hq={hq.num_frames})")
    check(lin.num_frames == hq.num_frames, "两路结果等长, 无串音结构错位")
    check(lin.channels == hq.channels == 2, "立体声通道数保持为 2")
    check(abs(lin.duration - src.duration) < 1.0 / target_sr + 1e-12,
          f"输出时长 {lin.duration:.4f}s 与输入 {src.duration:.4f}s 对齐")

    if in_sr == target_sr:
        check(np.array_equal(lin.samples, src.samples)
              and np.array_equal(hq.samples, src.samples),
              "目标采样率相同: 两条路径均逐样本原样复制, 不做处理")
        return

    rep_lin = evaluate_conversion(src, lin, channel=0)
    rep_hq = evaluate_conversion(src, hq, channel=0)

    print("-" * 74)
    print("线性插值路径:")
    for line in rep_lin.summary_lines():
        print("  " + line)
    print("-" * 74)
    print("高质量抗混叠路径:")
    for line in rep_hq.summary_lines():
        print("  " + line)

    # ---- 核心验收阈值(只对下采样且含 12kHz 混叠的组合强制判定) ----
    if target_sr < in_sr:
        pb = [t for t in rep_hq.tones if t.kind == "passband" and t.freq == 1000.0]
        al = [t for t in rep_hq.tones if t.kind == "alias"]
        if pb:
            check(abs(pb[0].delta_db) < PASSBAND_LIMIT_DB,
                  f"高质量 1kHz 通带幅度变化 {pb[0].delta_db:+.2f}dB "
                  f"(阈值 ±{PASSBAND_LIMIT_DB:g}dB)")
        if al:
            t0 = al[0]
            check(abs(t0.measure_freq_out - 4000.0) < 1e-6,
                  f"12kHz 在 {target_sr}Hz 采样下折叠到 4kHz "
                  f"(实测 {t0.measure_freq_out:g}Hz)")
            check(t0.suppression_db >= ALIAS_SUPPRESS_DB,
                  f"高质量混叠抑制 {t0.suppression_db:.1f}dB "
                  f"(阈值 >= {ALIAS_SUPPRESS_DB:g}dB)")
            # 线性路径应当明显更差(证明对比是有效的)
            lin_alias = [t for t in rep_lin.tones if t.kind == "alias"][0]
            check(lin_alias.suppression_db < t0.suppression_db,
                  f"线性插值混叠抑制 {lin_alias.suppression_db:.1f}dB 明显弱于 "
                  f"高质量 {t0.suppression_db:.1f}dB — 对比有效")

        if rep_hq.crosstalk_db is not None:
            check(rep_hq.crosstalk_db <= -40.0,
                  f"高质量左右串音 {rep_hq.crosstalk_db:.1f}dB (阈值 <= -40dB)")

    # ---- 导出 + 回读 ----
    if detailed or (in_sr == 48000 and target_sr == 16000):
        for tag, track, rep in (
            ("linear", lin, rep_lin), ("hq", hq, rep_hq),
        ):
            path = os.path.join(tmpdir, f"export_{in_sr}_{target_sr}_{tag}.wav")
            save_wav(path, track.samples, track.sr)
            rb = verify_export(path, track, src, rep)
            for line in rb.lines():
                print("  " + line)
            check(rb.ok, f"回读校验通过: {os.path.basename(path)}")

        # 独立再读一次, 确认文件头采样率与点数自洽(非改写头冒充转换)
        rb_hq = read_wav_any_rate(
            os.path.join(tmpdir, f"export_{in_sr}_{target_sr}_hq.wav")
        )
        check(rb_hq.sr == target_sr and rb_hq.num_frames == want_n,
              "回读文件头采样率与实际点数自洽, 属真实重采样而非改写文件头")


def main():
    ap = argparse.ArgumentParser(description="采样率转换工具离线验证")
    ap.add_argument("--quick", action="store_true", help="只跑 48k->16k 核心组合")
    args = ap.parse_args()

    with tempfile.TemporaryDirectory(prefix="srcompare_") as tmpdir:
        if args.quick:
            run_case(48000, 16000, tmpdir, detailed=True)
        else:
            for in_sr in (48000, 44100):
                for target_sr in (16000, 44100, 48000):
                    run_case(in_sr, target_sr, tmpdir, detailed=False)
            # 全部组合之外, 核心组合补完整回读
            run_case(48000, 16000, tmpdir, detailed=True)

    print("\n" + "=" * 74)
    if failures:
        print(f"验证结束: {len(failures)} 项不通过")
        for f in failures:
            print("  - " + f)
        sys.exit(1)
    print("验证结束: 全部通过")
    sys.exit(0)


if __name__ == "__main__":
    main()
