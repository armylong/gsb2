"""SyncMark 命令行入口."""

from __future__ import annotations

import argparse
import os
import sys
from typing import Any

from . import __version__, analyzer, export, generator, model


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="syncmark",
        description="声画标记打点与回读: 生成带编号闪光+提示声的测试片, "
                    "从解码后的画面/声音独立识别, 再与计划对齐.")
    p.add_argument("--version", action="version", version=f"SyncMark {__version__}")
    sub = p.add_subparsers(dest="cmd")

    g = sub.add_parser("generate", help="生成测试片与原计划")
    g.add_argument("out", help="输出短片路径 (.mp4/.mov)")
    g.add_argument("--profile", default="clean", choices=list(generator.PROFILES),
                   help="故障档位")
    g.add_argument("--markers", type=int, default=model.DEFAULT_MARKER_COUNT)
    g.add_argument("--fps", type=int, default=model.DEFAULT_FPS)
    g.add_argument("--width", type=int, default=model.DEFAULT_WIDTH)
    g.add_argument("--height", type=int, default=model.DEFAULT_HEIGHT)
    g.add_argument("--audio-offset-ms", type=float, default=None)
    g.add_argument("--missing-first", action="store_true")
    g.add_argument("--repeat-marker", type=int, default=None, metavar="ID")
    g.add_argument("--repeat-after-ms", type=int, default=350)
    g.add_argument("--truncate-last", action="store_true")
    g.add_argument("--duplicate-glitch", action="store_true")
    g.add_argument("--first-at-zero", action="store_true")
    g.add_argument("--plan", default=None, help="计划 JSON 输出路径")

    a = sub.add_parser("analyze", help="独立识别并与计划对齐")
    a.add_argument("film")
    a.add_argument("--plan", default=None, help="计划 JSON; 省略则在短片旁查找")
    a.add_argument("--report", default=None, help="报告 JSON 输出路径")
    a.add_argument("--html", default=None, help="导出 HTML 报告路径")
    a.add_argument("--md", default=None, help="导出 Markdown 报告路径")
    a.add_argument("--no-match", action="store_true", help="只做独立识别, 不读计划")
    a.add_argument("-q", "--quiet", action="store_true")

    return p


def _generate(args: argparse.Namespace) -> int:
    opts: dict[str, Any] = {
        "marker_count": args.markers,
        "fps": args.fps,
        "width": args.width,
        "height": args.height,
    }
    if args.audio_offset_ms is not None:
        opts["audio_offset_ms"] = args.audio_offset_ms
    if args.missing_first:
        opts["missing_first"] = True
    if args.repeat_marker:
        opts["repeat_mid"] = {"marker_id": args.repeat_marker, "after_ms": args.repeat_after_ms}
    if args.truncate_last:
        opts["truncate_last"] = True
    if args.duplicate_glitch:
        opts["duplicate_glitch"] = True
    if args.first_at_zero:
        opts["first_at_zero"] = True
    if args.plan:
        opts["write_plan_path"] = args.plan
    plan = generator.make_fault_profile(args.out, args.profile, **opts)
    print(f"已生成 {args.out}")
    print(f"原计划 {model.plan_default_path(args.out)} ({len(plan['markers'])} 个标记, "
          f"{plan['video']['frames']} 帧 / {plan['video']['duration']:.2f}s)")
    return 0


def _analyze(args: argparse.Namespace) -> int:
    plan_path = None if args.no_match else (args.plan or model.find_plan_sidecar(args.film))
    plan = None
    if plan_path:
        plan = model.read_json(plan_path)
        plan["plan_path"] = plan_path
    analysis = analyzer.analyze_film(args.film)
    report = analyzer.match_plan(
        analysis,
        plan or {"markers": [], "video": None, "audio": None, "faults": {},
                "plan_path": None},
    )
    report.pop("analysis_tmpdir", None)

    if args.report:
        model.write_json_atomic(args.report, report)
    if args.html:
        export.export_html(report, args.html)
    if args.md:
        export.export_markdown(report, args.md)

    if not args.quiet:
        s = report["summary"]
        print(f"片子: {args.film}")
        print(f"计划: {plan_path or '(未使用计划)'}")
        print(f"检出: 画面 {s['video_detections']} 个, 声音 {s['audio_detections']} 个")
        a_off = report["sync"]["audio"]
        v_off = report["sync"]["video"]
        print(f"整体偏移: 声音 {a_off['seconds'] * 1000:+.1f} ms "
              f"({'是' if a_off['applicable'] else '否'}), "
              f"画面 {v_off['seconds'] * 1000:+.1f} ms "
              f"({'是' if v_off['applicable'] else '否'})")
        print(f"匹配 {s['matched']} / 未找到 {s['missing']} / 仅一半 {s['partial']} / "
              f"计划外 {s['extra']}")
        for e in report["events"]:
            if e["status"] != "matched" or e.get("sync_tags"):
                tags = "/".join(e.get("sync_tags") or [])
                probs = "/".join(e.get("problems") or [])
                print(f"  [{e.get('id')}] {e['status']}  {probs} {tags}")
        for item in report["boundary"]["items"]:
            print(f"  边界·{item['name']}: {'通过' if item['passed'] else '异常'} — "
                  f"{item.get('detail', '')}")
    analysis.release()
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    if args.cmd == "generate":
        return _generate(args)
    if args.cmd == "analyze":
        return _analyze(args)
    if args.cmd is None:
        parser.print_help()
        return 2
    parser.print_help()
    return 2


def run_gui(argv: list[str] | None = None) -> int:
    from PySide6.QtWidgets import QApplication

    from .ui import MainWindow

    app = QApplication(sys.argv if argv is None else argv)
    app.setApplicationName("SyncMark")
    app.setApplicationDisplayName("SyncMark")
    win = MainWindow()
    win.show()
    if os.environ.get("SYNCMARK_AUTOLOAD"):
        win._load_film(os.environ["SYNCMARK_AUTOLOAD"], analyze=True)
    return app.exec()
