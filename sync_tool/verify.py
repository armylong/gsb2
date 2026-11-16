"""两端一致性校验。

做法
====

1. 在目标库上开启 *一个* 只读事务, 在同一事务内读取 applied_seq 与全部
   业务表 —— 同步仍在运行时, 这保证拿到的是同一个时间点的一致视图,
   不会出现"进度是新值、数据是旧值"的跨时间点结论。
2. 以源快照为基线, 按变更文件重放所有 commit 序号 <= applied_seq 的
   已提交事务(未提交事务自然不生效), 得到该位置上的期望状态。
3. 逐表比对记录数、主键集合与字段内容, 并顺带核对最后修改事务归属。
"""

import json
import os

from . import storage
from .config import Config
from .engine import parse_event_line, quote_ident
from .errors import SyncError


def _normalize(value):
    """统一 JSON 与 SQLite 的数值表示后再比较(1 与 1.0 视为相等)。"""
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return value


def _snapshot_rows(config: Config):
    """读取源快照, 返回 {source_table: {key_tuple: payload_dict}}。"""
    manifest_path = os.path.join(config.snapshot_dir, "manifest.json")
    with open(manifest_path, "r", encoding="utf-8") as fh:
        manifest = json.load(fh)
    state = {}
    for source_table, data_file in manifest.get("tables", {}).items():
        mapping = config.mapping_for(source_table)
        if mapping is None:
            raise SyncError(f"快照包含未配置的来源表: {source_table}")
        rows = {}
        path = os.path.join(config.snapshot_dir, data_file)
        with open(path, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                payload = json.loads(line)
                key = tuple(payload[k] for k in mapping.key)
                rows[key] = dict(payload)
        state[source_table] = rows
    return state, manifest["snapshot_seq"]


def _replay(config: Config, state, stop_seq, snapshot_seq):
    """重放变更文件到 stop_seq, 只应用已提交事务; 同时记录最后修改归属。"""
    # txn_id -> [(op_order, table, op, payload, seq)]
    open_txns = {}
    # key -> (txn_id, seq)
    last_touch = {t: {} for t in state}
    changes_dir = config.changes_dir
    if not os.path.isdir(changes_dir):
        return last_touch
    names = sorted(
        n for n in os.listdir(changes_dir) if n[:-6].isdigit() and n.endswith(".jsonl")
    )
    for name in names:
        path = os.path.join(changes_dir, name)
        with open(path, "r", encoding="utf-8") as fh:
            for line_no, line in enumerate(fh, 1):
                line = line.strip()
                if not line:
                    continue
                # 先用宽松解析拿到 seq: 超出 stop_seq 的事件(可能正是导致
                # 阻塞的坏行)与本次校验无关, 直接跳过
                try:
                    raw_event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                seq = raw_event.get("seq") if isinstance(raw_event, dict) else None
                if not isinstance(seq, int) or seq > stop_seq:
                    continue
                event = parse_event_line(line, name, line_no)
                if seq <= snapshot_seq:
                    # 已包含在快照里的事件, 不能再应用一次
                    continue
                txn_id = event["txn_id"]
                if event["kind"] == "row":
                    open_txns.setdefault(txn_id, []).append(
                        (
                            event["op_order"],
                            event["table"],
                            event["op"],
                            event["payload"],
                            seq,
                        )
                    )
                else:  # commit: 整笔事务按 op_order 生效
                    ops = sorted(open_txns.pop(txn_id, []), key=lambda x: x[0])
                    for op_order, table, op, payload, row_seq in ops:
                        mapping = config.mapping_for(table)
                        key = tuple(payload[k] for k in mapping.key)
                        rows = state[table]
                        if op == "INSERT" or op == "UPDATE":
                            rows[key] = dict(payload)
                        else:
                            rows.pop(key, None)
                        last_touch[table][key] = (txn_id, row_seq)
    return last_touch


def verify(conn, config: Config, max_diffs=100):
    """一致性校验, 返回结构化比对结果。

    调用方传入的连接可以是只读连接; 本函数在内部显式开启一致读事务。
    """
    snapshot_state, snapshot_seq = _snapshot_rows(config)
    conn.execute("BEGIN")
    try:
        applied_seq = storage.meta_get(conn, storage.META_APPLIED_SEQ)
        if applied_seq is None:
            raise SyncError("目标库尚未初始化, 无法校验")
        expected_touch = _replay(config, snapshot_state, applied_seq, snapshot_seq)

        result = {
            "ok": True,
            "at_applied_seq": applied_seq,
            "snapshot_seq": snapshot_seq,
            "tables": {},
        }
        for source_table, mapping in config.mappings.items():
            target = quote_ident(mapping.target_table)
            actual_rows = conn.execute(f"SELECT * FROM {target}").fetchall()
            actual = {}
            actual_touch = {}
            key_target_cols = [mapping.target_column(k) for k in mapping.key]
            for row in actual_rows:
                d = dict(row)
                key = tuple(d[c] for c in key_target_cols)
                actual_touch[key] = (d["_last_txn_id"], d["_last_seq"])
                actual[key] = {
                    src: _normalize(d[mapping.target_column(src)])
                    for src in mapping.columns
                }
            expected = {
                key: {src: _normalize(val) for src, val in payload.items()}
                for key, payload in snapshot_state.get(source_table, {}).items()
            }

            missing, extra, diff, touch_diff = [], [], [], []
            for key in sorted(set(expected) - set(actual)):
                missing.append({"key": list(key)})
            for key in sorted(set(actual) - set(expected)):
                extra.append({"key": list(key)})
            for key in sorted(set(expected) & set(actual)):
                col_diffs = {}
                for src_col in mapping.columns:
                    if actual[key].get(src_col) != expected[key].get(src_col):
                        col_diffs[src_col] = {
                            "expected": expected[key][src_col],
                            "actual": actual[key].get(src_col),
                        }
                if col_diffs:
                    diff.append({"key": list(key), "columns": col_diffs})
                # 最后修改事务归属也要对得上
                exp_touch = expected_touch.get(source_table, {}).get(key)
                if exp_touch is not None and actual_touch.get(key) != exp_touch:
                    touch_diff.append(
                        {
                            "key": list(key),
                            "expected_txn": exp_touch[0],
                            "expected_seq": exp_touch[1],
                            "actual_txn": actual_touch.get(key, (None, None))[0],
                            "actual_seq": actual_touch.get(key, (None, None))[1],
                        }
                    )

            table_ok = not (missing or extra or diff or touch_diff)
            result["ok"] &= table_ok
            result["tables"][source_table] = {
                "ok": table_ok,
                "expected_count": len(expected),
                "actual_count": len(actual),
                "missing": missing[:max_diffs],
                "extra": extra[:max_diffs],
                "content_diff": diff[:max_diffs],
                "last_txn_diff": touch_diff[:max_diffs],
                "truncated": (
                    len(missing) + len(extra) + len(diff) + len(touch_diff)
                )
                > max_diffs,
            }
        return result
    finally:
        # 只读事务回滚即结束, 不产生任何写入
        conn.rollback()
