"""命令行入口：fuzz / replay / run-local-demo。"""
from __future__ import annotations

import argparse
import json
import sys
from typing import List, Optional

from .config import load_config
from .engine import run
from .errors import FuzzError
from .replay import (REPLAY_NOT_REPRODUCED, REPLAY_REPRODUCED, REPLAY_UNKNOWN,
                     ReplayOutcome, replay_all, replay_group)
from .report import build_report, render_markdown, write_report


def _cmd_fuzz(args: argparse.Namespace) -> int:
    cfg = load_config(args.config)
    if args.seed is not None:
        cfg.seed = args.seed
    if args.max_requests is not None:
        cfg.max_requests = args.max_requests
    result = run(cfg, reduce=not args.no_reduce)
    report = build_report(result)
    paths = write_report(report, args.outdir)
    print(f"[apifuzz] JSON 报告: {paths['json']}")
    print(f"[apifuzz] Markdown 报告: {paths['markdown']}")
    print(f"[apifuzz] 用例 {report['summary']['total']} 条，"
          f"异常 {report['summary']['anomaly_count']} 条，"
          f"分组 {report['summary']['group_count']} 个，"
          f"请求 {report['limits_usage']['requests_used']} 次")
    if result.stopped_reason:
        print(f"[apifuzz] 提前停止: {result.stopped_reason}", file=sys.stderr)
    return 0


def _load_report(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def _print_replay(outcome: ReplayOutcome) -> None:
    label = {
        REPLAY_REPRODUCED: "仍可复现",
        REPLAY_NOT_REPRODUCED: "未复现",
        REPLAY_UNKNOWN: "无法判断",
    }[outcome.verdict]
    print(f"[{label}] 分组 {outcome.group_id} 接口 {outcome.endpoint}: "
          f"{outcome.reason}")
    print(f"    原始指纹 {outcome.original_fingerprint} -> "
          f"重放指纹 {outcome.replay_fingerprint}")


def _cmd_replay(args: argparse.Namespace) -> int:
    cfg = load_config(args.config)
    report = _load_report(args.report)
    if args.group:
        outcomes = [replay_group(cfg, report, args.group, args.base_url)]
    else:
        outcomes = replay_all(cfg, report, args.base_url)
    for outcome in outcomes:
        _print_replay(outcome)
    code = 0 if all(o.verdict != REPLAY_UNKNOWN for o in outcomes) else 2
    return code


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="apifuzz",
        description="本机接口输入校验模糊测试工具（仅访问白名单内的本机服务）",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_fuzz = sub.add_parser("fuzz", help="执行一轮模糊测试")
    p_fuzz.add_argument("-c", "--config", required=True, help="配置 JSON 路径")
    p_fuzz.add_argument("-s", "--seed", type=int, default=None,
                        help="覆盖配置中的随机种子")
    p_fuzz.add_argument("--max-requests", type=int, default=None,
                        help="覆盖请求次数上限")
    p_fuzz.add_argument("--no-reduce", action="store_true",
                        help="跳过失败样本缩减阶段")
    p_fuzz.add_argument("-o", "--outdir", default="reports",
                        help="报告输出目录（默认 reports/）")
    p_fuzz.set_defaults(func=_cmd_fuzz)

    p_replay = sub.add_parser("replay", help="按报告重放失败分组")
    p_replay.add_argument("-c", "--config", required=True)
    p_replay.add_argument("-r", "--report", required=True,
                          help="fuzz 产生的 JSON 报告路径")
    p_replay.add_argument("-g", "--group", default=None,
                          help="只重放指定分组（如 G001），默认全部")
    p_replay.add_argument("--base-url", default=None,
                          help="覆盖报告中的 base_url（仍受白名单限制）")
    p_replay.set_defaults(func=_cmd_replay)
    return parser


def main(argv: Optional[List[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except FuzzError as exc:
        print(f"[apifuzz] 错误: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
