"""程序入口: python -m dtmf_lab [--no-ui].

默认拉起 PySide6 窗口; 加 --no-ui 时只跑一次命令行识别, 方便在没有图形环境的
机器上自检和做演示脚本.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path


def _run_cli(args: argparse.Namespace) -> int:
    from .analysis import DetectionSettings, detect, export_segments_csv
    from .samples import export_all, render_scenario, scenario_by_name
    from .wavio import load_wav, save_wav

    if args.export_samples:
        out = Path(args.output or "samples")
        paths = export_all(out)
        for path in paths:
            print(path)
        return 0

    if args.scenario:
        scenario = scenario_by_name(args.scenario)
        rendered = render_scenario(scenario)
        if args.output:
            save_wav(args.output, rendered.samples, rendered.sample_rate)
            print(f"写出 {args.output}")
        clip_samples, sr = rendered.samples, rendered.sample_rate
        expected = scenario.keys
    elif args.wav:
        clip = load_wav(args.wav)
        clip_samples, sr = clip.samples, clip.sample_rate
        expected = None
    else:
        print("请给 --wav 或 --scenario, 或者加 --export-samples", file=sys.stderr)
        return 2

    settings = DetectionSettings(
        min_key_ms=args.min_key_ms,
        min_release_ms=args.min_release_ms,
    )
    result = detect(clip_samples, sr, settings)
    if expected is not None:
        print(f"合成键序列: {expected!r}")
    print(f"识别键序列: {result.keys!r}")
    for seg in result.all_segments():
        print(
            f"  [{seg.status_label}] {seg.key or '—':2s} {seg.start_s:7.3f}-{seg.end_s:7.3f}s  "
            f"{seg.duration_ms:6.1f}ms  {seg.reason}"
            + ("  | " + "; ".join(seg.notes) if seg.notes else "")
        )
    if args.csv:
        export_segments_csv(args.csv, result)
        print(f"清单已写出 {args.csv}")
    if args.json:
        from .analysis import export_result_json

        export_result_json(args.json, result)
        print(f"JSON 已写出 {args.json}")
    return 0


def _run_gui() -> int:
    from PySide6.QtWidgets import QApplication

    from .ui.main_window import MainWindow

    app = QApplication(sys.argv)
    app.setApplicationName("双音按键辨认工作台")
    window = MainWindow()
    window.show()
    return app.exec()


def main(argv: list[str] | None = None) -> int:
    from .samples import SCENARIOS

    parser = argparse.ArgumentParser(description="离线双音按键辨认工具")
    parser.add_argument("--no-ui", action="store_true", help="只跑命令行识别")
    parser.add_argument("--wav", help="要识别的 wav 路径")
    parser.add_argument(
        "--scenario", choices=[s.name for s in SCENARIOS], help="用预置样音"
    )
    parser.add_argument("--export-samples", metavar="DIR", nargs="?", const="samples", help="导出全部预置样音")
    parser.add_argument("--output", help="导出 wav 的路径")
    parser.add_argument("--csv", help="导出清单 csv")
    parser.add_argument("--json", help="导出完整 json")
    parser.add_argument("--min-key-ms", type=float, default=40.0)
    parser.add_argument("--min-release-ms", type=float, default=40.0)
    args = parser.parse_args(argv)
    if args.no_ui or args.wav or args.scenario or args.export_samples:
        return _run_cli(args)
    return _run_gui()


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
