"""命令行入口: 生成样例、生成代理、执行核对并导出 JSON 记录。"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .errors import ProxyCheckError
from .proxy import build_proxy
from .samples import generate_sample_set
from .verification import Status, verify


def _print_report(report) -> int:
    print(f"\n结论: [{report.overall.value}] {report.conclusion}\n")
    print(f"{'结果':<8}{'检查项':<28}说明")
    print("-" * 96)
    for c in report.checks:
        print(f"{c.status.value:<8}{c.name:<28}{c.detail}")
    print("\n检查点:")
    for cp in report.checkpoints:
        print(f"  源帧 {cp.source_index:4d} (t={cp.source_time:6.3f}s) <-> "
              f"代理帧 {cp.proxy_index:4d} (t={cp.proxy_time:6.3f}s)  "
              f"MAE={cp.mae:.4f} [{cp.status.value}]")
    return 0 if report.overall in (Status.PASS, Status.PENDING, Status.WARN) else 2


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="proxy_check",
                                     description="本地低分辨率代理核对工具")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_sample = sub.add_parser("samples", help="生成整套测试素材")
    p_sample.add_argument("out_dir", type=Path)

    p_build = sub.add_parser("build", help="为原片生成 360p 代理")
    p_build.add_argument("source", type=Path)
    p_build.add_argument("proxy", type=Path)

    p_verify = sub.add_parser("verify", help="核对一对文件")
    p_verify.add_argument("source", type=Path)
    p_verify.add_argument("proxy", type=Path)
    p_verify.add_argument("-o", "--output", type=Path,
                          help="导出 JSON 核对记录的路径")

    args = parser.parse_args(argv)
    try:
        if args.cmd == "samples":
            paths = generate_sample_set(args.out_dir, progress=lambda m: print(m))
            print("\n生成完成:")
            for k, v in paths.items():
                print(f"  {k:<10}{v}")
            return 0

        if args.cmd == "build":
            info, _ = build_proxy(args.source, args.proxy,
                                  progress=lambda m: print(m))
            print(f"代理已生成: {info.path} ({info.resolution}, "
                  f"{info.nb_video_frames} 帧, {info.frame_rate:g}fps)")
            return 0

        if args.cmd == "verify":
            report = verify(args.source, args.proxy)
            rc = _print_report(report)
            if args.output:
                report.save_json(args.output)
                print(f"\n核对记录已导出: {args.output}")
            return rc
    except ProxyCheckError as exc:
        print(f"错误: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
