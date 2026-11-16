"""命令行入口。

用法总览::

    python -m sync_tool generate   --root ./demo --mode clean
    python -m sync_tool load-snapshot --config ./demo/config.json
    python -m sync_tool sync       --config ./demo/config.json [--watch]
    python -m sync_tool status     --config ./demo/config.json [--json]
    python -m sync_tool trace      --config ./demo/config.json --table customer --key 1
    python -m sync_tool verify     --config ./demo/config.json [--json]
"""

import argparse
import json
import sys
import time

from . import datagen, storage
from .config import Config
from .engine import SyncEngine
from .errors import BlockedError, SyncError
from .verify import verify as run_verify

EXIT_OK = 0
EXIT_SYNC_ERROR = 2
EXIT_BLOCKED = 3
EXIT_DIFF = 4
EXIT_WATCH_INTERRUPTED = 130


def _print_json(obj):
    print(json.dumps(obj, ensure_ascii=False, indent=2, sort_keys=True))


def _cmd_generate(args):
    summary = datagen.generate(args.root, mode=args.mode)
    print(f"已在 {summary['root']} 生成 {summary['mode']} 场景数据")
    print(f"  快照位置 seq = {summary['snapshot_seq']}")
    print(f"  变更文件 {len(summary['files'])} 个: {', '.join(summary['files'])}")
    if summary["anomaly"] and summary["anomaly"].get("reason"):
        print(f"  内置异常: {summary['anomaly']['reason']} -> {summary['anomaly']}")
    print(f"  配置文件: {summary['config']}")
    return EXIT_OK


def _open_engine(config_path):
    config = Config.load(config_path)
    conn = storage.connect(config.target_db)
    storage.initialize(conn, config)
    return config, conn


def _cmd_load_snapshot(args):
    config, conn = _open_engine(args.config)
    engine = SyncEngine(conn, config)
    result = engine.load_snapshot()
    print(
        f"快照装载完成: seq 1..{result['snapshot_seq']}, "
        f"表 {', '.join(result['tables'])}"
    )
    conn.close()
    return EXIT_OK


def _run_sync_once(engine):
    summary = engine.sync_once()
    print(
        f"本轮处理文件 {summary['files_processed']} 个, "
        f"接收事件 {summary['events_received']} 条, "
        f"应用事务 {summary['txns_applied']} 笔"
    )
    if summary["blocked"] is not None:
        detail = summary["blocked"]
        print("\n同步已阻塞, 暂停推进:", file=sys.stderr)
        _print_json(detail)
        return EXIT_BLOCKED
    return EXIT_OK


def _cmd_sync(args):
    config, conn = _open_engine(args.config)
    engine = SyncEngine(conn, config)
    code = _run_sync_once(engine)
    if code == EXIT_BLOCKED or not args.watch:
        conn.close()
        return code
    print(f"进入 watch 模式, 每 {args.interval}s 轮询一次, Ctrl-C 退出")
    try:
        while True:
            time.sleep(args.interval)
            code = _run_sync_once(engine)
            if code == EXIT_BLOCKED:
                break
    except KeyboardInterrupt:
        print("\n收到中断, 已安全退出(下次启动可继续)")
        conn.close()
        return EXIT_WATCH_INTERRUPTED
    conn.close()
    return code


def _cmd_status(args):
    config, conn = _open_engine(args.config)
    engine = SyncEngine(conn, config)
    status = engine.status()
    conn.close()
    if args.json:
        _print_json(status)
        return EXIT_OK
    if not status["initialized"]:
        print("目标库尚未装载初始快照")
        return EXIT_OK
    print(f"初始快照位置   : {status['snapshot_seq']}")
    print(
        f"源端最新位置   : seq {status['source']['source_max_seq']} "
        f"(文件 {status['source']['file_count']} 个, "
        f"最新 {status['source']['last_file']})"
    )
    print(f"已接收位置     : seq {status['received_seq']}")
    print(f"已应用位置     : seq {status['applied_seq']}")
    gap = status["source"]["source_max_seq"] - status["received_seq"]
    print(f"待接收事件数   : {gap}")
    if status["source"]["pending_files"]:
        print("待处理文件     : " + ", ".join(status["source"]["pending_files"]))
    if status["pending_txn"]:
        print("未提交(暂存)事务:")
        for t in status["pending_txn"]:
            print(
                f"  - {t['txn_id']}: {t['event_count']} 条变更, "
                f"seq {t['first_seq']}..{t['last_seq']}"
            )
    else:
        print("未提交事务     : 无")
    if status["blocked"]:
        print("\n当前阻塞:")
        _print_json(status["blocked"])
    else:
        print("阻塞状态       : 无")
    return EXIT_OK


def _cmd_trace(args):
    config, conn = _open_engine(args.config)
    engine = SyncEngine(conn, config)
    result = engine.trace_record(args.table, args.key)
    conn.close()
    if args.json:
        _print_json(result)
    elif not result["found"]:
        print(f"记录不存在: {result['table']} 主键 {result['key']}")
    else:
        print(f"记录: {result['table']} 主键 {result['key']}")
        print(f"  最后修改事务 : {result['last_txn_id']}")
        print(f"  最后事件序号 : {result['last_seq']}")
        print(f"  事务内操作号 : {result['last_op_order']}")
        print(f"  当前内容     : {json.dumps(result['row'], ensure_ascii=False)}")
    return EXIT_OK


def _cmd_verify(args):
    config = Config.load(args.config)
    conn = storage.connect_readonly(config.target_db)
    try:
        result = run_verify(conn, config)
    finally:
        conn.close()
    if args.json:
        _print_json(result)
    else:
        print(f"校验基准: 已提交位置 seq {result['at_applied_seq']} "
              f"(快照 seq {result['snapshot_seq']})")
        for table, rep in result["tables"].items():
            mark = "通过" if rep["ok"] else "不一致"
            print(
                f"  [{mark}] 表 {table}: 期望 {rep['expected_count']} 行, "
                f"实际 {rep['actual_count']} 行"
            )
            for label, key in (
                ("缺失", "missing"),
                ("多余", "extra"),
                ("内容差异", "content_diff"),
                ("最后修改事务差异", "last_txn_diff"),
            ):
                for item in rep[key]:
                    print(f"      {label}: {json.dumps(item, ensure_ascii=False)}")
                if rep["truncated"]:
                    print("      (差异较多, 已截断; 用 --json 查看上限参数)")
    return EXIT_OK if result["ok"] else EXIT_DIFF


def build_parser():
    parser = argparse.ArgumentParser(
        prog="sync_tool", description="本地 SQLite 客户/订单增量同步工具"
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("generate", help="生成本地测试数据")
    p.add_argument("--root", required=True, help="输出目录")
    p.add_argument("--mode", choices=datagen.available_modes(), default="clean")
    p.set_defaults(func=_cmd_generate)

    p = sub.add_parser("load-snapshot", help="装载初始快照(只允许一次)")
    p.add_argument("--config", required=True)
    p.set_defaults(func=_cmd_load_snapshot)

    p = sub.add_parser("sync", help="接收并应用变更(可重复执行, 自动续传)")
    p.add_argument("--config", required=True)
    p.add_argument("--watch", action="store_true", help="持续轮询新文件")
    p.add_argument("--interval", type=float, default=2.0)
    p.set_defaults(func=_cmd_sync)

    p = sub.add_parser("status", help="查询源/接收/应用进度与阻塞事务")
    p.add_argument("--config", required=True)
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=_cmd_status)

    p = sub.add_parser("trace", help="核对目标记录由哪笔事务最后修改")
    p.add_argument("--config", required=True)
    p.add_argument("--table", required=True, help="来源表名, 如 customer")
    p.add_argument("--key", required=True, nargs="+",
                   help="主键值(多列主键按配置顺序给多个)")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=_cmd_trace)

    p = sub.add_parser("verify", help="同一已提交位置上的两端记录数与内容比对")
    p.add_argument("--config", required=True)
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=_cmd_verify)
    return parser


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except BlockedError as exc:
        _print_json(exc.detail)
        return EXIT_BLOCKED
    except SyncError as exc:
        print(f"错误: {exc}", file=sys.stderr)
        return EXIT_SYNC_ERROR
    except FileNotFoundError as exc:
        print(f"错误: 文件不存在 {exc}", file=sys.stderr)
        return EXIT_SYNC_ERROR


if __name__ == "__main__":
    sys.exit(main())
