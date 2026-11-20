"""命令行入口：无界面自检、批量导出、界面快照。"""

from __future__ import annotations

import argparse
import json
import os
import sys

from .report import (
    analyze_selection,
    build_report,
    export_alignment,
    format_report_text,
    sanitize,
    verify_aligned_wav,
)
from .synth import PRESET_KEYS, make_preset

#: 自检用例：(样例键, 允许的绝对误差采样, 期望极性, 期望是否时变, 期望是否有歧义候选)
VERIFY_CASES = [
    ("clean", 0.15, 1, False, False),
    ("low_snr", 0.35, 1, False, False),
    ("very_noisy", 0.60, 1, False, False),
    ("inverted", 0.15, -1, False, False),
    ("rhythmic", 0.20, 1, False, True),
    ("mic", 1.50, 1, False, False),   # 回声造成系统偏差，容差放宽
    ("drift", 8.00, 1, True, False),  # 时变信号，单值仅作近似
]


def _fmt(v: float) -> str:
    return f"{v:+.3f}"


def cmd_verify(args: argparse.Namespace) -> int:
    out_dir = os.path.abspath(args.out)
    os.makedirs(out_dir, exist_ok=True)
    failures: list[str] = []
    summaries = []

    print(f"TDOA 自检 · 样例 {len(VERIFY_CASES)} 个 · 输出目录 {out_dir}\n")
    for key, tol, want_pol, want_drift, want_amb in VERIFY_CASES:
        sample = make_preset(key)
        start, dur = sample.selection
        a = analyze_selection(sample, start, dur, max_lag_ms=args.max_lag_ms)
        sel = a["selected"]
        res = a["result"]
        drift = a["drift"]
        err = sel.refined_lag - sample.truth_delay
        has_amb = any(p.ambiguous for p in res.peaks[1:])
        rep = build_report(sample, a, sel.refined_lag, sample.truth_delay, source="CLI 自检")
        paths = export_alignment(
            out_dir, f"verify_{key}", a["ch0"], a["ch1"], a["sr"],
            sel.refined_lag, res.polarity, rep,
        )
        chk = verify_aligned_wav(paths["aligned_wav"], sample.sr)

        problems = []
        if abs(err) > tol:
            problems.append(f"误差 {err:+.3f} 超出容差 ±{tol:.2f}")
        if res.polarity != want_pol:
            problems.append(f"极性 {res.polarity:+d}，期望 {want_pol:+d}")
        if drift.changed != want_drift:
            problems.append(f"时变判定 {drift.changed}，期望 {want_drift}")
        if has_amb != want_amb:
            problems.append(f"歧义候选 {has_amb}，期望 {want_amb}")
        # 时变样例本身不存在能“对齐到 0”的单一常量平移，残留量按漂移幅度放行
        residual_tol = 3.0 if drift.changed else 0.6
        if abs(chk["lag"]) > residual_tol:
            problems.append(f"导出对齐后残留 lag {chk['lag']:+.3f}（容差 ±{residual_tol:.1f}）")
        if chk["polarity"] != 1:
            problems.append("导出对齐音频应为同相")
        if not chk["sr_ok"]:
            problems.append("导出采样率不一致")

        status = "OK  " if not problems else "FAIL"
        print(
            f"[{status}] {key:10s} 真值 {_fmt(sample.truth_delay):>8s}  "
            f"检测 {_fmt(sel.refined_lag):>8s}  误差 {_fmt(err):>7s}  "
            f"置信 {sel.confidence:.2f}  极性 {res.polarity:+d}  "
            f"候选 {len(res.peaks)}  时变 {'是' if drift.changed else '否'}"
        )
        for p in problems:
            print(f"         ! {p}")
            failures.append(f"{key}: {p}")
        summaries.append({
            "key": key,
            "truth": sample.truth_delay,
            "detected": sel.refined_lag,
            "error": err,
            "tolerance": tol,
            "polarity": res.polarity,
            "confidence": sel.confidence,
            "ambiguous": has_amb,
            "drift_changed": bool(drift.changed),
            "reference_interval": rep["reference_interval"],
            "aligned_wav": paths["aligned_wav"],
            "report_json": paths["report_json"],
            "roundtrip": chk,
            "ok": not problems,
        })

    summary_path = os.path.join(out_dir, "verify_summary.json")
    with open(summary_path, "w", encoding="utf-8") as f:
        json.dump(
            {"cases": summaries, "ok": not failures, "failures": failures},
            f, ensure_ascii=False, indent=2,
        )
    print()
    if failures:
        print(f"自检失败：{len(failures)} 项")
        return 1
    print(f"全部通过。对齐音频与报告在 {out_dir}")
    print(f"汇总：{summary_path}")
    return 0


def cmd_report(args: argparse.Namespace) -> int:
    if args.wav:
        from .dsp import read_wav
        from .synth import Sample

        data, sr = read_wav(args.wav)
        if data.shape[1] < 2:
            print("错误：wav 需要至少两个通道", file=sys.stderr)
            return 2
        sample = Sample(
            name=os.path.basename(args.wav),
            description=args.wav,
            ch0=data[:, 0],
            ch1=data[:, 1],
            sr=sr,
            truth_delay=None,
            selection=(args.start, args.duration),
        )
        source = "导入"
    else:
        sample = make_preset(args.preset)
        source = "内置样例"

    a = analyze_selection(
        sample, args.start if args.start is not None else sample.selection[0],
        args.duration if args.duration is not None else sample.selection[1],
        max_lag_ms=args.max_lag_ms,
        selected_lag=args.lag,
    )
    truth = args.truth if args.truth is not None else sample.truth_delay
    rep = build_report(sample, a, a["selected"].refined_lag, truth, source=source)
    print(format_report_text(rep))
    if args.export:
        paths = export_alignment(
            args.out, sanitize(sample.name), a["ch0"], a["ch1"], a["sr"],
            a["selected"].refined_lag, a["result"].polarity, rep,
        )
        print("\n■ 导出")
        for k, v in paths.items():
            print(f"  {k}: {v}")
    return 0


def cmd_list(_args: argparse.Namespace) -> int:
    print("可用内置样例：")
    for key, (name, _fn) in PRESET_KEYS.items():
        print(f"  {key:12s} {name}")
    return 0


def cmd_snapshot(args: argparse.Namespace) -> int:
    """离屏渲染主界面并保存 PNG，用于无显示器环境下的界面自检。"""
    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    from PySide6.QtWidgets import QApplication

    from .gui import MainWindow

    app = QApplication.instance() or QApplication([])
    win = MainWindow()
    win.resize(args.width, args.height)
    if args.preset:
        win.load_preset(args.preset)
    win.show()
    for _ in range(8):
        app.processEvents()
    out = os.path.abspath(args.path)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    ok = win.grab().save(out)
    print(f"界面快照：{out} · {'成功' if ok else '失败'}")
    return 0 if ok else 1


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="tdoa-lab", description="双通道到达时差手调对照台")
    sub = p.add_subparsers(dest="cmd", required=True)

    v = sub.add_parser("verify", help="无界面自检：所有样例 + 导出回读校验")
    v.add_argument("--out", default="out", help="输出目录（默认 out/）")
    v.add_argument("--max-lag-ms", type=float, default=50.0)
    v.set_defaults(func=cmd_verify)

    r = sub.add_parser("report", help="对内置样例或 wav 生成文本报告")
    r.add_argument("--preset", default="clean", choices=sorted(PRESET_KEYS))
    r.add_argument("--wav", default=None, help="双通道 wav 路径（优先于 --preset）")
    r.add_argument("--start", type=float, default=None, help="片段起点（秒）")
    r.add_argument("--duration", type=float, default=None, help="片段时长（秒）")
    r.add_argument("--lag", type=int, default=None, help="指定候选峰 lag（采样）")
    r.add_argument("--truth", type=float, default=None, help="参考真值（采样）")
    r.add_argument("--max-lag-ms", type=float, default=50.0)
    r.add_argument("--export", action="store_true", help="同时导出对齐音频")
    r.add_argument("--out", default="out")
    r.set_defaults(func=cmd_report)

    ls = sub.add_parser("list", help="列出内置样例")
    ls.set_defaults(func=cmd_list)

    s = sub.add_parser("snapshot", help="离屏渲染主界面到 PNG")
    s.add_argument("--path", default="out/gui_snapshot.png")
    s.add_argument("--preset", default=None, choices=sorted(PRESET_KEYS))
    s.add_argument("--width", type=int, default=1500)
    s.add_argument("--height", type=int, default=980)
    s.set_defaults(func=cmd_snapshot)
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
