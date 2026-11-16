"""导出：当前结果、问题明细、历史对比、规则版本。支持 CSV / JSON。"""
import csv
import json

from .runner import status_map_for_run, run_summary, diff_runs
from .rules import get_rules


def _write(path, rows, fmt):
    fmt = fmt or ("json" if path.endswith(".json") else "csv")
    if fmt == "json":
        with open(path, "w", encoding="utf-8") as f:
            json.dump(rows, f, ensure_ascii=False, indent=2, default=str)
    else:
        if not rows:
            with open(path, "w", encoding="utf-8") as f:
                f.write("")
            return
        with open(path, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
            w.writeheader()
            w.writerows(rows)


def export_results(conn, run_id, path, fmt=None, include_all=False):
    """导出某次运行的结果。默认只导非 pass；include_all 导出全部 记录×规则。
    未完成的运行会在每行标注 run_status，未检查的记录不会出现在结果中（即不会被当作通过）。"""
    summary = run_summary(conn, run_id)
    smap = status_map_for_run(conn, run_id)
    details = {(r["record_key"], r["rule_id"]): r["detail"] for r in conn.execute(
        "SELECT record_key, rule_id, detail FROM results WHERE run_id=?", (run_id,))}
    rows = []
    for (key, rid), status in sorted(smap.items()):
        if not include_all and status == "pass":
            continue
        rows.append({
            "run_id": run_id, "run_status": summary["status"],
            "rule_version": summary["rule_version"],
            "record_key": key, "rule_id": rid, "status": status,
            "detail": details.get((key, rid), ""),
        })
    _write(path, rows, fmt)
    return len(rows)


def export_issues(conn, dataset, path, fmt=None):
    rows = [dict(r) for r in conn.execute(
        "SELECT * FROM findings WHERE dataset=? ORDER BY finding_id", (dataset,))]
    _write(path, rows, fmt)
    return len(rows)


def export_changes(conn, dataset, path, fmt=None, from_run=None, to_run=None):
    sql = "SELECT * FROM changes WHERE dataset=?"
    args = [dataset]
    if from_run is not None:
        sql += " AND from_run=?"
        args.append(from_run)
    if to_run is not None:
        sql += " AND to_run=?"
        args.append(to_run)
    rows = [dict(r) for r in conn.execute(sql + " ORDER BY change_id", tuple(args))]
    _write(path, rows, fmt)
    return len(rows)


def export_compare(conn, run_a, run_b, path, fmt=None):
    rows = [{"from_run": run_a, "to_run": run_b, **d} for d in diff_runs(conn, run_a, run_b)]
    _write(path, rows, fmt)
    return len(rows)


def export_rules(conn, version, path, fmt=None):
    rows = get_rules(conn, version)
    out = [{
        "version": r["version"], "id": r["rule_id"], "name": r["name"],
        "type": r["rule_type"], "field": r["field"],
        "params": json.loads(r["params"]), "enabled": bool(r["enabled"]),
    } for r in rows]
    _write(path, out, fmt or "json")
    return len(out)
