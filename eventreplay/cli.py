"""命令行入口。

子命令:
  run        读取来源文件并处理, 支持 --from-date/--to-date/--from-event
  reprocess  忽略断点重读全部文件, 重算指定日期范围并原子发布(保留差异)
  query      查询已发布的窗口统计
  explain    解释某个统计值: 列出贡献它的全部原始事件(含文件:行号)
  export     导出结果/异常/重放记录为 csv 或 json
  status     查看运行、文件与异常概览
"""

from __future__ import annotations

import argparse
import csv
import json
import sys

from .config import load_config
from .processor import run as do_run
from .store import Store
from .timeutil import day_ceiling, day_floor


def _open_store(args) -> Store:
    return Store(args.db)


def _print_json(obj):
    print(json.dumps(obj, ensure_ascii=False, indent=2, default=str))


def cmd_run(args):
    cfg = load_config(args.config)
    store = Store(args.db or cfg["db"])
    try:
        summary = do_run(
            cfg, store,
            from_date=args.from_date, to_date=args.to_date,
            from_event=args.from_event, kind="run",
            use_checkpoints=not args.no_checkpoints,
        )
    finally:
        store.close()
    _print_json(summary)


def cmd_reprocess(args):
    if not args.start or not args.end:
        raise SystemExit("reprocess 必须指定 --start 和 --end(日期, 右开)")
    cfg = load_config(args.config)
    store = Store(args.db or cfg["db"])
    try:
        summary = do_run(
            cfg, store,
            from_date=args.start, to_date=args.end,
            from_event=None, kind="reprocess",
            use_checkpoints=False,  # 重读全部文件, 拾取迟到数据
        )
    finally:
        store.close()
    _print_json(summary)


def cmd_query(args):
    store = _open_store(args)
    try:
        rows = store.query_published(
            biz_key=args.key,
            start=day_floor(args.start) if args.start else None,
            end=day_ceiling(args.end) if args.end else None,
        )
        out = [
            {
                "biz_key": r["biz_key"],
                "window_start": r["window_start"],
                "window_end": r["window_end"],
                "count": r["cnt"],
                "amount_sum": r["amount_sum"],
                "status": json.loads(r["status_json"]),
                "run_id": r["run_id"],
                "published_at": r["published_at"],
            }
            for r in rows
        ]
    finally:
        store.close()
    _print_json(out)


def cmd_explain(args):
    store = _open_store(args)
    try:
        pub, events = store.explain_window(args.key, args.window_start)
        if pub is None:
            raise SystemExit(
                f"没有已发布的结果: key={args.key} window_start={args.window_start}")
        contrib = [
            {
                "event_id": e["event_id"],
                "biz_time": e["biz_time"],
                "amount": e["amount"],
                "status": e["status"],
                "location": f"{e['source_file']}:{e['source_line']}",
                "source": e["source"],
            }
            for e in events
        ]
        amount_sum = round(sum(e["amount"] or 0 for e in events), 6)
        result = {
            "biz_key": pub["biz_key"],
            "window": [pub["window_start"], pub["window_end"]],
            "published": {
                "count": pub["cnt"],
                "amount_sum": pub["amount_sum"],
                "status": json.loads(pub["status_json"]),
            },
            "recomputed_from_events": {"count": len(events), "amount_sum": amount_sum},
            "events": contrib,
        }
    finally:
        store.close()
    _print_json(result)


def _rows_for_export(store, what):
    if what == "results":
        rows = store.conn.execute(
            "SELECT biz_key, window_start, window_end, cnt, amount_sum, status_json,"
            " run_id, published_at FROM published ORDER BY biz_key, window_start"
        ).fetchall()
        return [dict(r) for r in rows]
    if what == "anomalies":
        out = []
        for r in store.conn.execute(
            "SELECT run_id, event_id, source, source_file, source_line, detail"
            " FROM conflicts ORDER BY id"
        ):
            d = dict(r); d["type"] = "conflict"; d["reason"] = "同一事件编号内容不一致"
            out.append(d)
        for r in store.conn.execute(
            "SELECT run_id, NULL AS event_id, source, source_file, source_line, reason,"
            " raw AS detail FROM skipped ORDER BY id"
        ):
            d = dict(r); d["type"] = "skipped"
            out.append(d)
        for r in store.conn.execute(
            "SELECT run_id, NULL AS event_id, source, path AS source_file, NULL AS source_line,"
            " error AS reason, NULL AS detail FROM files WHERE status='failed' ORDER BY id"
        ):
            d = dict(r); d["type"] = "file_failed"
            out.append(d)
        return out
    if what == "replay":
        rows = store.conn.execute(
            "SELECT id, kind, started_at, finished_at, range_start, range_end, from_event,"
            " status, note FROM runs ORDER BY id"
        ).fetchall()
        return [dict(r) for r in rows]
    if what == "diffs":
        rows = store.conn.execute(
            "SELECT * FROM publish_diffs ORDER BY id").fetchall()
        return [dict(r) for r in rows]
    raise SystemExit(f"未知的导出类型: {what}")


def cmd_export(args):
    store = _open_store(args)
    try:
        rows = _rows_for_export(store, args.what)
    finally:
        store.close()
    if args.format == "json" or args.out.endswith(".json"):
        with open(args.out, "w", encoding="utf-8") as fh:
            json.dump(rows, fh, ensure_ascii=False, indent=2, default=str)
    else:
        keys = sorted({k for row in rows for k in row}) or ["empty"]
        with open(args.out, "w", encoding="utf-8", newline="") as fh:
            writer = csv.DictWriter(fh, fieldnames=keys)
            writer.writeheader()
            writer.writerows(rows)
    print(f"已导出 {len(rows)} 行到 {args.out}")


def cmd_status(args):
    store = _open_store(args)
    try:
        runs = [dict(r) for r in store.conn.execute(
            "SELECT id, kind, started_at, finished_at, range_start, range_end, status, note"
            " FROM runs ORDER BY id")]
        files = [dict(r) for r in store.conn.execute(
            "SELECT run_id, source, path, status, error, total_lines, ok_lines"
            " FROM files ORDER BY id")]
        counts = {
            "events": store.conn.execute("SELECT COUNT(*) c FROM events").fetchone()["c"],
            "conflicts": store.conn.execute("SELECT COUNT(*) c FROM conflicts").fetchone()["c"],
            "skipped": store.conn.execute("SELECT COUNT(*) c FROM skipped").fetchone()["c"],
            "published_windows": store.conn.execute("SELECT COUNT(*) c FROM published").fetchone()["c"],
        }
    finally:
        store.close()
    _print_json({"counts": counts, "runs": runs, "files": files})


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="eventreplay",
        description="本地业务事件日志重放与统计工具")
    p.add_argument("--db", help="SQLite 数据库路径(默认取配置文件中的 db)")
    sub = p.add_subparsers(dest="command", required=True)

    def add_config(sp):
        sp.add_argument("--config", required=True, help="来源与窗口配置(JSON)")

    sp = sub.add_parser("run", help="读取来源文件并处理")
    add_config(sp)
    sp.add_argument("--from-date", help="只统计该日期(含)之后的事件")
    sp.add_argument("--to-date", help="只统计该日期(含)之前的事件")
    sp.add_argument("--from-event", help="从指定事件编号的位置之后继续处理")
    sp.add_argument("--no-checkpoints", action="store_true", help="忽略文件断点, 全部重读")
    sp.set_defaults(func=cmd_run)

    sp = sub.add_parser("reprocess", help="重算指定日期范围并原子发布")
    add_config(sp)
    sp.add_argument("--start", required=True, help="范围起始日期(含)")
    sp.add_argument("--end", required=True, help="范围结束日期(含)")
    sp.set_defaults(func=cmd_reprocess)

    sp = sub.add_parser("query", help="查询已发布的窗口统计")
    sp.add_argument("--key", help="业务键")
    sp.add_argument("--start", help="起始日期")
    sp.add_argument("--end", help="结束日期")
    sp.set_defaults(func=cmd_query)

    sp = sub.add_parser("explain", help="解释某个统计值的来源事件")
    sp.add_argument("--key", required=True)
    sp.add_argument("--window-start", required=True, help="窗口起始, 如 2026-01-01T00:00:00Z")
    sp.set_defaults(func=cmd_explain)

    sp = sub.add_parser("export", help="导出结果/异常/重放记录")
    sp.add_argument("--what", required=True,
                    choices=["results", "anomalies", "replay", "diffs"])
    sp.add_argument("--out", required=True, help="输出文件路径")
    sp.add_argument("--format", choices=["csv", "json"], default="csv")
    sp.set_defaults(func=cmd_export)

    sp = sub.add_parser("status", help="查看运行与异常概览")
    sp.set_defaults(func=cmd_status)
    return p


def main(argv=None):
    args = build_parser().parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()
