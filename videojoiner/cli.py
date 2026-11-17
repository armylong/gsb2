"""命令行入口：生成样例、导出拼接、回读校验、探测单文件。"""
from __future__ import annotations

import argparse
import json
import os
import sys

from .project import ExportSettings, Project, ProjectError
from .probe import ProbeError, probe_media
from .samples import generate_samples
from .verify import VerifyError, verify_export


def _print_progress(ratio: float, text: str) -> None:
    width = 36
    filled = int(width * ratio)
    bar = "█" * filled + "░" * (width - filled)
    print(f"\r[{bar}] {ratio * 100:5.1f}% {text[:40]:<40}", end="", flush=True)
    if ratio >= 1.0:
        print()


def cmd_samples(args) -> int:
    paths = generate_samples(args.out_dir, progress_cb=_print_progress)
    print(f"已在 {os.path.abspath(args.out_dir)} 生成 {len(paths)} 个样例：")
    for path in paths:
        info = probe_media(path)
        audio = "有声音" if info.has_audio else "无声音"
        print(f"  - {os.path.basename(path)}  "
              f"{info.width}x{info.height} {info.fps:g}fps "
              f"{info.duration:.1f}s {audio}")
    return 0


def _build_project(work_dir: str, clip_paths: list[str]) -> Project:
    project = Project(work_dir)
    failed = False
    for path in clip_paths:
        clip = project.add_clip(path)
        if not clip.ok:
            print(f"[错误] {path}：{clip.error}", file=sys.stderr)
            failed = True
    if failed:
        raise ProjectError("部分片段无法识别，请替换后重试")
    return project


def cmd_export(args) -> int:
    project = _build_project(args.work_dir, args.clips)
    project.settings = ExportSettings(
        width=args.width or 0, height=args.height or 0,
        fps=args.fps or 0.0, fit=args.fit)

    resolved = project.effective_settings()
    print("导出前检查：")
    for i, clip in enumerate(project.clips, 1):
        info = clip.info
        print(f"  {i}. {os.path.basename(clip.path)}  "
              f"{info.duration:.3f}s {info.width}x{info.height} "
              f"{info.fps:g}fps {'有声音' if info.has_audio else '无声音→补静音'}")
    for junction in project.junction_report():
        for issue in junction["issues"]:
            print(f"  交界 {junction['names'][0]} → {junction['names'][1]}：{issue}")
    print(f"  预计总时长：{project.estimated_duration():.3f}s")
    print(f"  输出设置：{resolved.width}x{resolved.height} "
          f"{resolved.fps:g}fps 适配={resolved.fit}")

    result = project.export(args.output, progress_cb=_print_progress)
    if not result.ok:
        print(f"\n[导出失败] 阶段={result.failed_stage} 原因={result.error}",
              file=sys.stderr)
        if result.failed_clip_id:
            clip = next(c for c in project.clips if c.clip_id == result.failed_clip_id)
            print(f"  出错片段：{clip.path}", file=sys.stderr)
            print("  可使用 replace 流程或在 Web UI 中只替换该片段后重新导出",
                  file=sys.stderr)
        return 2

    print(f"\n导出完成：{result.output_path}")
    print("开始回读校验 ...")
    report = verify_export(result.output_path, project)
    for check in report.checks:
        mark = "✓" if check.passed else "✗"
        print(f"  {mark} {check.name}：{check.detail}")
    print("结论：" + ("全部通过" if report.passed else "存在未通过项"))
    return 0 if report.passed else 3


def cmd_verify(args) -> int:
    project = Project.load(args.project_json)
    try:
        report = verify_export(args.video, project)
    except VerifyError as exc:
        print(f"[校验失败] {exc}", file=sys.stderr)
        return 2
    print(json.dumps(report.to_dict(), ensure_ascii=False, indent=2))
    return 0 if report.passed else 3


def cmd_probe(args) -> int:
    try:
        info = probe_media(args.video)
    except ProbeError as exc:
        print(f"[探测失败] {exc}", file=sys.stderr)
        return 2
    from dataclasses import asdict
    print(json.dumps(asdict(info), ensure_ascii=False, indent=2))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m videojoiner.cli",
        description="本地顺序视频拼接工具（ffmpeg，单机运行）")
    sub = parser.add_subparsers(dest="command", required=True)

    p_samples = sub.add_parser("samples", help="程序化生成 6 个测试样例")
    p_samples.add_argument("out_dir", help="样例输出目录")
    p_samples.set_defaults(func=cmd_samples)

    p_export = sub.add_parser("export", help="按顺序拼接并自动回读校验")
    p_export.add_argument("clips", nargs="+", help="按时间线顺序排列的片段路径")
    p_export.add_argument("-o", "--output", required=True, help="导出文件路径")
    p_export.add_argument("--work-dir", default=".videojoiner_work",
                          help="中间片与工程文件目录")
    p_export.add_argument("--width", type=int, default=0, help="输出宽（默认沿用首段）")
    p_export.add_argument("--height", type=int, default=0, help="输出高（默认沿用首段）")
    p_export.add_argument("--fps", type=float, default=0.0, help="输出帧率（默认沿用首段）")
    p_export.add_argument("--fit", choices=["contain", "cover"], default="contain",
                          help="contain=等比缩放加黑边，cover=等比放大裁切")
    p_export.set_defaults(func=cmd_export)

    p_verify = sub.add_parser("verify", help="对导出文件做独立回读校验")
    p_verify.add_argument("video", help="待校验的视频文件")
    p_verify.add_argument("--project-json", required=True,
                          help="导出时保存的 project.json")
    p_verify.set_defaults(func=cmd_verify)

    p_probe = sub.add_parser("probe", help="探测单个媒体文件的元数据")
    p_probe.add_argument("video")
    p_probe.set_defaults(func=cmd_probe)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except ProjectError as exc:
        print(f"[参数错误] {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
