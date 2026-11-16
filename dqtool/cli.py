"""命令行入口：python -m dqtool ..."""
import argparse
import json
import sys

from .db import connect
from . import rules as rules_mod
from . import runner as runner_mod
from . import triage as triage_mod
from . import export as export_mod


def _print(obj):
    print(json.dumps(obj, ensure_ascii=False, indent=2, default=str))


def build_parser():
    p = argparse.ArgumentParser(prog="dqtool", description="可回放的本地数据质量检查工具")
    p.add_argument("--db", default="dq.db", help="SQLite 数据库路径（默认 ./dq.db）")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("init", help="初始化数据库")

    rp = sub.add_parser("rules", help="规则管理")
    rsub = rp.add_subparsers(dest="sub", required=True)
    ri = rsub.add_parser("import", help="导入规则文件（JSON），内容变化自动生成新版本")
    ri.add_argument("file")
    ri.add_argument("--note", default="")
    rsub.add_parser("list").add_argument("--version", type=int, default=None)
    rsub.add_parser("versions")
    for name, on in (("enable", True), ("disable", False)):
        r = rsub.add_parser(name, help=f"{'启用' if on else '停用'}规则（生成新版本）")
        r.add_argument("rule_id")
    rd = rsub.add_parser("diff", help="对比两个规则版本")
    rd.add_argument("v1", type=int)
    rd.add_argument("v2", type=int)

    rn = sub.add_parser("run", help="执行检查（自动续跑同文件同规则版本的未完成运行）")
    rn.add_argument("file")
    rn.add_argument("--dataset", default=None, help="数据集名（默认取文件名）")
    rn.add_argument("--key-field", default=None, help="作为记录键的字段（默认行号）")
    rn.add_argument("--batch-size", type=int, default=1000)
    rn.add_argument("--rule-version", type=int, default=None)
    rn.add_argument("--format", choices=["csv", "json", "ndjson"], default=None)
    rn.add_argument("--fresh", action="store_true", help="强制新运行，不续跑")
    rn.add_argument("--max-batches", type=int, default=None, help=argparse.SUPPRESS)

    rp2 = sub.add_parser("replay", help="用指定规则版本回放历史运行的输入文件")
    rp2.add_argument("run_id", type=int)
    rp2.add_argument("--rule-version", type=int, required=True)
    rp2.add_argument("--batch-size", type=int, default=1000)

    rns = sub.add_parser("runs", help="运行记录")
    rns.add_argument("--dataset", default=None)

    rs = sub.add_parser("results", help="查看某次运行的非 pass 结果")
    rs.add_argument("run_id", type=int)
    rs.add_argument("--status", choices=["fail", "not_applicable", "corrupt"], default=None)

    cp = sub.add_parser("compare", help="对比两次运行，只显示真正变化")
    cp.add_argument("run_a", type=int)
    cp.add_argument("run_b", type=int)

    isq = sub.add_parser("issues", help="问题台账（含人工结论）")
    isq.add_argument("--dataset", default=None)
    isq.add_argument("--manual-status", default=None, help="confirmed|closed|none")
    isq.add_argument("--open", action="store_true", help="只看仍未解决的")

    tg = sub.add_parser("triage", help="人工处理问题")
    tg.add_argument("action", choices=["confirm", "close", "reopen", "note", "ack"])
    tg.add_argument("finding_id", type=int)
    tg.add_argument("--note", default=None)
    tg.add_argument("--by", default=None)

    ex = sub.add_parser("export", help="导出")
    exsub = ex.add_subparsers(dest="sub", required=True)
    er = exsub.add_parser("results")
    er.add_argument("--run", type=int, required=True)
    er.add_argument("--out", required=True)
    er.add_argument("--format", choices=["csv", "json"], default=None)
    er.add_argument("--all", action="store_true", help="包含 pass 记录")
    ei = exsub.add_parser("issues")
    ei.add_argument("--dataset", required=True)
    ei.add_argument("--out", required=True)
    ei.add_argument("--format", choices=["csv", "json"], default=None)
    ec = exsub.add_parser("changes")
    ec.add_argument("--dataset", required=True)
    ec.add_argument("--out", required=True)
    ec.add_argument("--format", choices=["csv", "json"], default=None)
    ecp = exsub.add_parser("compare")
    ecp.add_argument("--from-run", type=int, required=True, dest="from_run")
    ecp.add_argument("--to-run", type=int, required=True, dest="to_run")
    ecp.add_argument("--out", required=True)
    ecp.add_argument("--format", choices=["csv", "json"], default=None)
    eru = exsub.add_parser("rules")
    eru.add_argument("--version", type=int, default=None)
    eru.add_argument("--out", required=True)
    return p


def main(argv=None):
    args = build_parser().parse_args(argv)
    conn = connect(args.db)
    try:
        return _dispatch(conn, args)
    except (ValueError, rules_mod.RuleError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 2


def _dispatch(conn, args):
    cmd = args.cmd
    if cmd == "init":
        print(f"initialized {args.db}")
    elif cmd == "rules":
        _rules_cmd(conn, args)
    elif cmd == "run":
        try:
            run_id = runner_mod.run_check(
                conn, args.file, dataset=args.dataset, key_field=args.key_field,
                batch_size=args.batch_size, rule_version=args.rule_version,
                fmt=args.format, max_batches=args.max_batches, fresh=args.fresh)
        except runner_mod.RunInterrupted as e:
            print(f"interrupted: {e}", file=sys.stderr)
            return 3
        _print(runner_mod.run_summary(conn, run_id))
    elif cmd == "replay":
        run_id = runner_mod.replay_run(conn, args.run_id, args.rule_version,
                                       batch_size=args.batch_size)
        _print(runner_mod.run_summary(conn, run_id))
    elif cmd == "runs":
        sql = "SELECT run_id, dataset, rule_version, status, processed_records," \
              " total_records, started_at, finished_at FROM runs"
        args_q = []
        if args.dataset:
            sql += " WHERE dataset=?"
            args_q.append(args.dataset)
        rows = [dict(r) for r in conn.execute(sql + " ORDER BY run_id", tuple(args_q))]
        _print(rows)
    elif cmd == "results":
        _print(runner_mod.run_summary(conn, args.run_id))
        smap = runner_mod.status_map_for_run(conn, args.run_id)
        rows = [{"record_key": k[0], "rule_id": k[1], "status": s}
                for k, s in sorted(smap.items())
                if s != "pass" and (args.status is None or s == args.status)]
        _print(rows)
    elif cmd == "compare":
        _print(runner_mod.diff_runs(conn, args.run_a, args.run_b))
    elif cmd == "issues":
        _print(triage_mod.list_findings(conn, dataset=args.dataset,
                                        manual_status=args.manual_status,
                                        only_open=args.open))
    elif cmd == "triage":
        f = triage_mod.triage(conn, args.finding_id, args.action, note=args.note, by=args.by)
        _print(dict(f))
    elif cmd == "export":
        n = _export_cmd(conn, args)
        print(f"exported {n} rows to {args.out}")
    return 0


def _rules_cmd(conn, args):
    if args.sub == "import":
        with open(args.file, encoding="utf-8") as f:
            specs = json.load(f)
        if isinstance(specs, dict):
            note = args.note or specs.get("note", "")
            specs = specs["rules"]
        else:
            note = args.note
        version, changed = rules_mod.import_rules(conn, specs, note=note)
        print(f"rule version {version} ({'new version' if changed else 'unchanged'})")
    elif args.sub == "list":
        _print(rules_mod.get_rules(conn, args.version))
    elif args.sub == "versions":
        _print([dict(r) for r in conn.execute(
            "SELECT * FROM rule_versions ORDER BY version")])
    elif args.sub in ("enable", "disable"):
        version, _ = rules_mod.set_enabled(conn, args.rule_id, args.sub == "enable")
        print(f"rule version {version}")
    elif args.sub == "diff":
        a = {r["rule_id"]: r for r in rules_mod.get_rules(conn, args.v1)}
        b = {r["rule_id"]: r for r in rules_mod.get_rules(conn, args.v2)}
        out = []
        for rid in sorted(set(a) | set(b)):
            ra, rb = a.get(rid), b.get(rid)
            if ra is None:
                out.append({"rule_id": rid, "change": "added"})
            elif rb is None:
                out.append({"rule_id": rid, "change": "removed"})
            elif ra["content_hash"] != rb["content_hash"]:
                out.append({"rule_id": rid, "change": "modified",
                            "from": {"enabled": ra["enabled"], "params": json.loads(ra["params"])},
                            "to": {"enabled": rb["enabled"], "params": json.loads(rb["params"])}})
        _print(out)


def _export_cmd(conn, args):
    if args.sub == "results":
        return export_mod.export_results(conn, args.run, args.out, fmt=args.format,
                                         include_all=args.all)
    if args.sub == "issues":
        return export_mod.export_issues(conn, args.dataset, args.out, fmt=args.format)
    if args.sub == "changes":
        return export_mod.export_changes(conn, args.dataset, args.out, fmt=args.format)
    if args.sub == "compare":
        return export_mod.export_compare(conn, args.from_run, args.to_run, args.out,
                                         fmt=args.format)
    if args.sub == "rules":
        return export_mod.export_rules(conn, args.version, args.out)
    raise ValueError(f"unknown export: {args.sub}")


if __name__ == "__main__":
    sys.exit(main())
