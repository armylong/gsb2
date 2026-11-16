"""检查运行器：分批处理、断点续跑、完成后更新问题台账与变化记录。"""
import os

from .db import now_iso
from .ingest import file_sha256, iter_records, record_content_hash
from .rules import current_version, evaluate_rule, get_rules, UniqueContext


class RunInterrupted(Exception):
    """测试/调试用：模拟过程中断。"""


class DbUniqueContext(UniqueContext):
    def __init__(self, conn, run_id):
        self.conn = conn
        self.run_id = run_id
        self.pending = []  # 本批待写入的 (rule_id, value, record_key)

    def lookup(self, rule_id, value):
        row = self.conn.execute(
            "SELECT record_key FROM unique_seen WHERE run_id=? AND rule_id=? AND value=?",
            (self.run_id, rule_id, value)).fetchone()
        return row["record_key"] if row else None

    def register(self, rule_id, value, record_key):
        self.conn.execute(
            "INSERT INTO unique_seen (run_id, rule_id, value, record_key) VALUES (?,?,?,?)",
            (self.run_id, rule_id, value, record_key))


def _make_record_key(record, line_no, key_field, counters):
    """确定性记录键：优先取 key_field，重复键按出现次序加后缀。
    同一文件重跑/续跑生成完全相同的键。"""
    base = None
    if key_field and record is not None:
        v = record.get(key_field)
        if v is not None and str(v).strip() != "":
            base = str(v)
    if base is None:
        base = f"row:{line_no}"
    n = counters.get(base, 0)
    counters[base] = n + 1
    return base if n == 0 else f"{base}#{n + 1}"


def run_check(conn, input_path, dataset=None, key_field=None, batch_size=1000,
              rule_version=None, fmt=None, max_batches=None, fresh=False):
    """执行一次检查。返回 run_id。

    若同一 dataset + 文件校验值 + 规则版本存在未完成运行，则自动续跑（fresh=True 强制新运行）。
    max_batches 用于测试中断：处理指定批数后抛 RunInterrupted。
    """
    dataset = dataset or os.path.basename(input_path)
    sha = file_sha256(input_path)
    if rule_version is None:
        rule_version = current_version(conn)
    rules = get_rules(conn, rule_version, enabled_only=True)
    if not rules:
        raise ValueError(f"no enabled rules at version {rule_version}")

    run_id = None
    if not fresh:
        row = conn.execute(
            "SELECT run_id FROM runs WHERE dataset=? AND file_sha256=? AND rule_version=?"
            " AND status IN ('running','interrupted') ORDER BY run_id DESC LIMIT 1",
            (dataset, sha, rule_version)).fetchone()
        if row:
            run_id = row["run_id"]
    if run_id is None:
        cur = conn.execute(
            "INSERT INTO runs (dataset, input_path, file_sha256, rule_version, key_field, fmt,"
            " status, batch_size, started_at) VALUES (?,?,?,?,?,?, 'running',?,?)",
            (dataset, os.path.abspath(input_path), sha, rule_version, key_field, fmt,
             batch_size, now_iso()))
        run_id = cur.lastrowid
        conn.commit()

    # 已处理记录（续跑时跳过）
    done_keys = {r["record_key"] for r in conn.execute(
        "SELECT record_key FROM records WHERE run_id=?", (run_id,))}
    processed = conn.execute(
        "SELECT processed_records AS p FROM runs WHERE run_id=?", (run_id,)).fetchone()["p"]

    uctx = DbUniqueContext(conn, run_id)
    batches = 0
    counters = {}
    try:
        batch_records, batch_results = [], []
        for line_no, record, corrupt in iter_records(input_path, fmt):
            key = _make_record_key(record, line_no, key_field, counters)
            if key in done_keys:
                continue
            if corrupt is not None:
                batch_records.append((run_id, key, line_no, "", "corrupt"))
            else:
                chash = record_content_hash(record)
                batch_records.append((run_id, key, line_no, chash, "checked"))
                for rule in rules:
                    status, detail = evaluate_rule(rule, record, key, uctx)
                    if status != "pass":  # 稀疏存储：只落非 pass
                        batch_results.append((run_id, key, rule["rule_id"], status, detail))
            processed += 1
            if len(batch_records) >= batch_size:
                _flush(conn, run_id, batch_records, batch_results, processed)
                batch_records, batch_results = [], []
                batches += 1
                if max_batches is not None and batches >= max_batches:
                    raise RunInterrupted(f"stopped after {batches} batches")
        _flush(conn, run_id, batch_records, batch_results, processed)
        conn.execute(
            "UPDATE runs SET status='completed', total_records=?, finished_at=? WHERE run_id=?",
            (processed, now_iso(), run_id))
        conn.commit()
        update_findings(conn, run_id)
        generate_changes(conn, run_id)
    except RunInterrupted:
        conn.execute("UPDATE runs SET status='interrupted' WHERE run_id=?", (run_id,))
        conn.commit()
        raise
    except Exception as e:
        conn.execute("UPDATE runs SET status='failed', error=? WHERE run_id=?",
                     (str(e), run_id))
        conn.commit()
        raise
    return run_id


def _flush(conn, run_id, batch_records, batch_results, processed):
    if batch_records:
        conn.executemany(
            "INSERT OR REPLACE INTO records (run_id, record_key, line_no, content_hash, status)"
            " VALUES (?,?,?,?,?)", batch_records)
    if batch_results:
        conn.executemany(
            "INSERT OR REPLACE INTO results (run_id, record_key, rule_id, status, detail)"
            " VALUES (?,?,?,?,?)", batch_results)
    conn.execute("UPDATE runs SET processed_records=? WHERE run_id=?", (processed, run_id))
    conn.commit()


def replay_run(conn, run_id, rule_version, batch_size=1000, max_batches=None):
    """用指定规则版本回放历史运行的输入文件。旧运行与旧结果全部保留。
    文件校验值必须与历史运行一致，否则拒绝回放（防止拿错文件）。"""
    run = conn.execute("SELECT * FROM runs WHERE run_id=?", (run_id,)).fetchone()
    if run is None:
        raise ValueError(f"no such run: {run_id}")
    if conn.execute("SELECT 1 FROM rule_versions WHERE version=?", (rule_version,)).fetchone() is None:
        raise ValueError(f"no such rule version: {rule_version}")
    path = run["input_path"]
    if file_sha256(path) != run["file_sha256"]:
        raise ValueError(
            f"input file {path} changed since run {run_id}; cannot replay faithfully")
    return run_check(conn, path, dataset=run["dataset"], key_field=run["key_field"],
                     batch_size=batch_size, rule_version=rule_version, fmt=run["fmt"],
                     max_batches=max_batches, fresh=True)


# ---------- 派生状态 ----------

def status_map_for_run(conn, run_id):
    """返回 {(record_key, rule_id): status}，覆盖该运行已处理的全部 记录×启用规则。

    推导规则：记录损坏 → 所有规则 corrupt；结果表有非 pass 行 → 用该行；
    否则 pass。未处理的记录根本不在 map 中（即 unchecked，绝不显示为 pass）。
    """
    run = conn.execute("SELECT * FROM runs WHERE run_id=?", (run_id,)).fetchone()
    if run is None:
        raise ValueError(f"no such run: {run_id}")
    rules = get_rules(conn, run["rule_version"], enabled_only=True)
    non_pass = {(r["record_key"], r["rule_id"]): r["status"] for r in conn.execute(
        "SELECT record_key, rule_id, status FROM results WHERE run_id=?", (run_id,))}
    out = {}
    for rec in conn.execute("SELECT record_key, status FROM records WHERE run_id=?", (run_id,)):
        for rule in rules:
            k = (rec["record_key"], rule["rule_id"])
            if rec["status"] == "corrupt":
                out[k] = "corrupt"
            else:
                out[k] = non_pass.get(k, "pass")
    return out


def run_summary(conn, run_id):
    run = conn.execute("SELECT * FROM runs WHERE run_id=?", (run_id,)).fetchone()
    if run is None:
        raise ValueError(f"no such run: {run_id}")
    smap = status_map_for_run(conn, run_id)
    counts = {}
    for s in smap.values():
        counts[s] = counts.get(s, 0) + 1
    return {
        "run_id": run_id, "dataset": run["dataset"], "status": run["status"],
        "rule_version": run["rule_version"], "file_sha256": run["file_sha256"],
        "started_at": run["started_at"], "finished_at": run["finished_at"],
        "processed_records": run["processed_records"],
        "total_records": run["total_records"],
        "complete": run["status"] == "completed",
        "result_counts": counts,
    }


# ---------- 问题台账与变化记录 ----------

def update_findings(conn, run_id):
    run = conn.execute("SELECT * FROM runs WHERE run_id=?", (run_id,)).fetchone()
    dataset = run["dataset"]
    hashes = {r["record_key"]: r["content_hash"] for r in conn.execute(
        "SELECT record_key, content_hash FROM records WHERE run_id=?", (run_id,))}
    fails = conn.execute(
        "SELECT record_key, rule_id FROM results WHERE run_id=? AND status='fail'",
        (run_id,)).fetchall()
    for f in fails:
        key, rid = f["record_key"], f["rule_id"]
        row = conn.execute(
            "SELECT * FROM findings WHERE dataset=? AND rule_id=? AND record_key=?",
            (dataset, rid, key)).fetchone()
        if row is None:
            conn.execute(
                "INSERT INTO findings (dataset, rule_id, record_key, first_seen_run,"
                " last_seen_run, last_status) VALUES (?,?,?,?,?,'fail')",
                (dataset, rid, key, run_id, run_id))
        else:
            data_changed = row["data_changed"]
            if (row["manual_status"] is not None and row["record_hash_at_triage"]
                    and hashes.get(key) != row["record_hash_at_triage"]):
                data_changed = 1  # 人工结论后数据发生变化：提示，但不覆盖结论
            conn.execute(
                "UPDATE findings SET last_seen_run=?, last_status='fail', data_changed=?"
                " WHERE finding_id=?",
                (run_id, data_changed, row["finding_id"]))
    # 本次运行中不再出现的问题标记为 resolved（仅完整运行后才调用）
    conn.execute(
        "UPDATE findings SET last_status='resolved' WHERE dataset=? AND last_status='fail'"
        " AND last_seen_run < ?",
        (dataset, run_id))
    conn.commit()


def generate_changes(conn, run_id):
    """与同一 dataset 上一个已完成运行对比，只把真正变化写入 changes。"""
    run = conn.execute("SELECT * FROM runs WHERE run_id=?", (run_id,)).fetchone()
    prev = conn.execute(
        "SELECT run_id FROM runs WHERE dataset=? AND run_id<? AND status='completed'"
        " ORDER BY run_id DESC LIMIT 1",
        (run["dataset"], run_id)).fetchone()
    prev_id = prev["run_id"] if prev else None
    diffs = diff_runs(conn, prev_id, run_id) if prev_id else _baseline_diffs(conn, run_id)
    for d in diffs:
        conn.execute(
            "INSERT OR IGNORE INTO changes (dataset, from_run, to_run, rule_id, record_key,"
            " change_type, old_status, new_status, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
            (run["dataset"], prev_id, run_id, d["rule_id"], d["record_key"],
             d["change_type"], d["old_status"], d["new_status"], now_iso()))
    conn.commit()
    return len(diffs)


def _baseline_diffs(conn, run_id):
    out = []
    for (key, rid), status in status_map_for_run(conn, run_id).items():
        if status in ("fail", "not_applicable", "corrupt"):
            out.append({"rule_id": rid, "record_key": key, "change_type": "new",
                        "old_status": None, "new_status": status})
    return out


def diff_runs(conn, run_a, run_b):
    """对比两次运行，返回真正变化的条目列表。"""
    a = status_map_for_run(conn, run_a)
    b = status_map_for_run(conn, run_b)
    out = []
    for key in sorted(set(a) | set(b)):
        sa, sb = a.get(key), b.get(key)
        if sa == sb:
            continue
        # pass ↔ absent（如规则被停用）不算问题变化
        if (sa, sb) in (("pass", None), (None, "pass")):
            continue
        record_key, rule_id = key
        if sa in (None, "pass"):
            ctype = "new"
        elif sb in (None, "pass"):
            ctype = "resolved"
        else:
            ctype = "status_changed"
        out.append({"rule_id": rule_id, "record_key": record_key, "change_type": ctype,
                    "old_status": sa, "new_status": sb})
    return out
