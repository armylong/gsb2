"""同步引擎: 快照装载、变更接收、事务原子应用与断点续传。

设计要点
========

1. 每个变更文件在 *一个* SQLite 事务内完成接收(登记 _events/_staging、
   更新 received_seq、登记 _files); 事务提交前崩溃不会留下任何痕迹,
   重跑时整个文件重来, 天然幂等。
2. 提交标记到达时, 同一业务事务的客户/订单变更在同一个 SQLite 事务里
   整体生效; 未提交前只存在于 _staging, 外部查询业务表永远看不到半成品。
3. 已提交位置(applied_seq)与业务数据在同一事务里推进, 强制退出后
   进度与数据不可能互相矛盾。
4. seq 严格连续: 期望 seq = 高水位 + 1, 缺口/乱序/重复但内容不一致
   都会写 _blocked 并暂停, 不会跳过。
"""

import hashlib
import json
import os
import re
import sqlite3

from . import storage
from .config import Config
from .errors import BlockedError, SyncError

_FILE_RE = re.compile(r"^(\d+)\.jsonl$")
_OPS = {"INSERT", "UPDATE", "DELETE"}
_KINDS = {"row", "commit"}
_CRASH_ENV = "SYNC_TOOL_CRASH"


def event_hash(event):
    """事件内容的规范化哈希, 用于重复序号内容一致性比对。"""
    blob = json.dumps(event, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def parse_event_line(line, file_name, line_no):
    """解析一行 JSONL 事件, 语法错误直接转成 BlockedError(带定位)。"""
    try:
        event = json.loads(line)
    except json.JSONDecodeError as exc:
        raise BlockedError(
            {
                "reason": "bad_json",
                "message": f"事件行不是合法 JSON: {exc}",
                "file": file_name,
                "line": line_no,
            }
        ) from exc
    if not isinstance(event, dict):
        raise BlockedError(
            {
                "reason": "bad_event",
                "message": "事件行必须是 JSON 对象",
                "file": file_name,
                "line": line_no,
            }
        )
    return event


def quote_ident(name):
    """防御性引用 SQL 标识符(表名/列名来自配置, 仍做一次校验)。"""
    if not isinstance(name, str) or not name or '"' in name or "\x00" in name:
        raise SyncError(f"非法 SQL 标识符: {name!r}")
    return '"' + name + '"'


class SyncEngine:
    def __init__(self, conn, config: Config):
        self.conn = conn
        self.config = config
        # 测试用的进程内崩溃钩子; 正常使用为 None
        self.crash_hook = None

    # ------------------------------------------------------------- 初始化

    def is_initialized(self):
        return storage.meta_get(self.conn, storage.META_SNAPSHOT_SEQ) is not None

    def load_snapshot(self, manifest_name="manifest.json"):
        """装载初始快照。只能在空目标库上执行一次。"""
        storage.initialize(self.conn, self.config)
        if self.is_initialized():
            raise SyncError(
                "目标库已完成初始快照装载, 如需重新装载请删除目标库后重试"
            )
        manifest_path = os.path.join(self.config.snapshot_dir, manifest_name)
        try:
            with open(manifest_path, "r", encoding="utf-8") as fh:
                manifest = json.load(fh)
        except FileNotFoundError:
            raise SyncError(f"快照清单不存在: {manifest_path}")
        except json.JSONDecodeError as exc:
            raise SyncError(f"快照清单不是合法 JSON: {exc}") from exc

        snap_seq = manifest.get("snapshot_seq")
        if not isinstance(snap_seq, int) or snap_seq < 0:
            raise SyncError("manifest.snapshot_seq 必须是非负整数")
        tables = manifest.get("tables", {})
        if not isinstance(tables, dict):
            raise SyncError("manifest.tables 必须是表名 -> 数据文件名的对象")

        conn = self.conn
        conn.execute("BEGIN IMMEDIATE")
        try:
            for source_table, data_file in tables.items():
                mapping = self.config.mapping_for(source_table)
                if mapping is None:
                    raise SyncError(f"快照包含未配置的来源表: {source_table}")
                self._load_snapshot_table(mapping, data_file, snap_seq)
            # 快照覆盖了 seq 1..snapshot_seq, 以 covered 状态占位,
            # 之后这些序号的事件再来时只允许内容一致的重复, 不会二次生效
            for seq in range(1, snap_seq + 1):
                conn.execute(
                    "INSERT INTO _events(seq, txn_id, kind, hash, state) "
                    "VALUES(?, ?, 'row', ?, 'covered')",
                    (seq, "SNAPSHOT", "covered-by-snapshot"),
                )
            storage.meta_set(conn, storage.META_SNAPSHOT_SEQ, snap_seq)
            storage.meta_set(conn, storage.META_RECEIVED_SEQ, snap_seq)
            storage.meta_set(conn, storage.META_APPLIED_SEQ, snap_seq)
            storage.clear_blocked(conn)
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        return {"snapshot_seq": snap_seq, "tables": list(tables)}

    def _load_snapshot_table(self, mapping, data_file, snap_seq):
        path = os.path.join(self.config.snapshot_dir, data_file)
        if not os.path.isfile(path):
            raise SyncError(f"快照数据文件不存在: {path}")
        conn = self.conn
        target = quote_ident(mapping.target_table)
        cols = [mapping.target_column(c) for c in mapping.columns]
        col_sql = ", ".join(quote_ident(c) for c in cols)
        placeholders = ", ".join("?" for _ in cols)
        extra = ", " + ", ".join(quote_ident(c) for c in
                                  ("_last_txn_id", "_last_seq", "_last_op"))
        sql = (
            f"INSERT INTO {target}({col_sql}{extra}) "
            f"VALUES({placeholders}, ?, ?, ?)"
        )
        with open(path, "r", encoding="utf-8") as fh:
            for line_no, line in enumerate(fh, 1):
                line = line.strip()
                if not line:
                    continue
                try:
                    row = json.loads(line)
                except json.JSONDecodeError as exc:
                    raise SyncError(
                        f"快照 {data_file} 第 {line_no} 行不是合法 JSON: {exc}"
                    )
                values, key_values = self._project_row(mapping, row, data_file, line_no)
                conn.execute(
                    sql, values + ["SNAPSHOT", snap_seq, "SNAPSHOT"]
                )

    # ------------------------------------------------------------- 主流程

    def sync_once(self):
        """接收并应用当前所有待处理变更文件, 返回处理摘要。"""
        storage.initialize(self.conn, self.config)
        if not self.is_initialized():
            raise SyncError("尚未装载初始快照, 请先执行 load-snapshot")
        conn = self.conn
        # 上一轮遗留的阻塞标记: 本轮重新评估, 先清掉
        storage.clear_blocked(conn)
        conn.commit()

        files = self._list_change_files()
        summary = {
            "files_processed": 0,
            "events_received": 0,
            "txns_applied": 0,
            "blocked": None,
        }
        try:
            for file_name in files:
                registered = conn.execute(
                    "SELECT hash FROM _files WHERE file_name = ?", (file_name,)
                ).fetchone()
                path = os.path.join(self.config.changes_dir, file_name)
                digest = self._sha256_file(path)
                if registered is not None:
                    if registered["hash"] != digest:
                        self._raise_blocked(
                            {
                                "reason": "file_content_changed",
                                "message": (
                                    f"文件 {file_name} 已处理过, 但当前内容与"
                                    "首次接收时不一致(文件不可变)"
                                ),
                                "file": file_name,
                            }
                        )
                    continue  # 完全重复的文件: 跳过, 不计数不回退
                applied = self._ingest_file(file_name, path, digest)
                summary["files_processed"] += 1
                summary["events_received"] += applied["events"]
                summary["txns_applied"] += applied["txns"]
                self._maybe_crash("after_file:" + file_name)
        except BlockedError as exc:
            # 业务事务回滚后, 单独持久化阻塞原因
            conn.rollback()
            storage.set_blocked(conn, exc.detail)
            conn.commit()
            summary["blocked"] = exc.detail
            return summary
        return summary

    def _list_change_files(self):
        if not os.path.isdir(self.config.changes_dir):
            return []
        names = [n for n in os.listdir(self.config.changes_dir) if _FILE_RE.match(n)]
        names.sort(key=lambda n: int(_FILE_RE.match(n).group(1)))
        return names

    @staticmethod
    def _sha256_file(path):
        h = hashlib.sha256()
        with open(path, "rb") as fh:
            for chunk in iter(lambda: fh.read(65536), b""):
                h.update(chunk)
        return h.hexdigest()

    # ----------------------------------------------------- 单文件接收/应用

    def _ingest_file(self, file_name, path, digest):
        conn = self.conn
        conn.execute("BEGIN IMMEDIATE")
        high_water = storage.meta_get(conn, storage.META_RECEIVED_SEQ)
        events_in_file = 0
        txns_in_file = 0
        last_seq_in_file = high_water
        prev_seq = None
        # txn_id -> 该事务已见过的最大 op_order(跨文件部分来自 _staging)
        txn_max_op = {}

        with open(path, "r", encoding="utf-8") as fh:
            for line_no, raw in enumerate(fh, 1):
                line = raw.strip()
                if not line:
                    continue
                event = parse_event_line(line, file_name, line_no)
                self._validate_event_shape(event, file_name, line_no)
                seq = event["seq"]

                # 文件内部必须按 seq 升序
                if prev_seq is not None and seq <= prev_seq:
                    self._raise_blocked(
                        {
                            "reason": "out_of_order",
                            "message": (
                                f"文件内事件序号必须严格递增, 前一序号 {prev_seq}, "
                                f"当前序号 {seq}"
                            ),
                            "file": file_name,
                            "line": line_no,
                            "seq": seq,
                        }
                    )
                prev_seq = seq

                existing = conn.execute(
                    "SELECT hash, state FROM _events WHERE seq = ?", (seq,)
                ).fetchone()
                if existing is not None:
                    # 序号已存在:
                    # - 快照占位(state=covered): 该序号的效果已烘焙进快照,
                    #   无论行事件还是提交标记都直接跳过, 绝不二次应用
                    # - 其余情况要求规范化内容完全一致, 否则判定重复冲突
                    if existing["state"] != storage.EVENT_COVERED \
                            and existing["hash"] != event_hash(event):
                        self._raise_blocked(
                            {
                                "reason": "duplicate_conflict",
                                "message": (
                                    f"序号 {seq} 重复出现但内容与首次接收不一致"
                                ),
                                "file": file_name,
                                "line": line_no,
                                "seq": seq,
                                "txn_id": event["txn_id"],
                            }
                        )
                    continue
                if seq > high_water + 1:
                    missing = list(range(high_water + 1, seq))
                    self._raise_blocked(
                        {
                            "reason": "seq_gap",
                            "message": (
                                f"变更序号缺口: 期望 {high_water + 1}, "
                                f"实际收到 {seq}, 缺失序号 {missing}"
                            ),
                            "file": file_name,
                            "line": line_no,
                            "seq": seq,
                            "txn_id": event["txn_id"],
                            "missing_from": high_water + 1,
                            "missing_to": seq - 1,
                        }
                    )
                # 走到这里 seq == high_water + 1, 是全新事件
                high_water = seq
                last_seq_in_file = seq
                events_in_file += 1
                txn_id = event["txn_id"]

                if event["kind"] == "row":
                    self._ingest_row_event(
                        conn, event, txn_max_op, file_name, line_no
                    )
                else:  # commit
                    txns_in_file += 1
                    self._apply_committed_txn(conn, event, file_name, line_no)

                conn.execute(
                    "INSERT INTO _events(seq, txn_id, op_order, kind, table_name, "
                    "payload, hash, state) VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        seq,
                        txn_id,
                        event.get("op_order"),
                        event["kind"],
                        event.get("table"),
                        json.dumps(event.get("payload"), ensure_ascii=False)
                        if event.get("payload") is not None
                        else None,
                        event_hash(event),
                        "committed" if event["kind"] == "commit" else "staged",
                    ),
                )

        if events_in_file == 0:
            # 整个文件都是已接收事件的重复: 允许, 不推进任何位置
            conn.rollback()
            return {"events": 0, "txns": 0}

        storage.meta_set(conn, storage.META_RECEIVED_SEQ, last_seq_in_file)
        conn.execute(
            "INSERT INTO _files(file_name, hash) VALUES(?, ?) "
            "ON CONFLICT(file_name) DO UPDATE SET hash = excluded.hash",
            (file_name, digest),
        )
        conn.commit()
        return {"events": events_in_file, "txns": txns_in_file}

    def _ingest_row_event(self, conn, event, txn_max_op, file_name, line_no):
        txn_id = event["txn_id"]
        op_order = event["op_order"]
        table_name = event["table"]
        mapping = self.config.mapping_for(table_name)
        if mapping is None:
            self._raise_blocked(
                {
                    "reason": "unknown_table",
                    "message": f"事件引用了未配置映射的来源表 {table_name}",
                    "file": file_name,
                    "line": line_no,
                    "seq": event["seq"],
                    "txn_id": txn_id,
                }
            )
        # 事务一旦提交, 不允许再出现同 txn_id 的行(隐式防重复生效)
        committed = conn.execute(
            "SELECT 1 FROM _events WHERE txn_id = ? AND state = 'committed' LIMIT 1",
            (txn_id,),
        ).fetchone()
        if committed is not None:
            self._raise_blocked(
                {
                    "reason": "txn_reused",
                    "message": f"事务 {txn_id} 已提交, 不能再接收同编号的新变更",
                    "file": file_name,
                    "line": line_no,
                    "seq": event["seq"],
                    "txn_id": txn_id,
                }
            )
        # op_order 在事务内严格递增(含跨文件的暂存部分)
        if txn_id not in txn_max_op:
            row = conn.execute(
                "SELECT COALESCE(MAX(op_order), 0) AS m FROM _staging WHERE txn_id = ?",
                (txn_id,),
            ).fetchone()
            txn_max_op[txn_id] = row["m"]
        if op_order <= txn_max_op[txn_id]:
            self._raise_blocked(
                {
                    "reason": "op_order_conflict",
                    "message": (
                        f"事务 {txn_id} 的操作顺序 {op_order} 不大于已接收的 "
                        f"{txn_max_op[txn_id]}, 同一事务内必须严格递增且不重复"
                    ),
                    "file": file_name,
                    "line": line_no,
                    "seq": event["seq"],
                    "txn_id": txn_id,
                    "op_order": op_order,
                }
            )
        txn_max_op[txn_id] = op_order

        if event["op"] not in _OPS:
            self._raise_blocked(
                {
                    "reason": "bad_op",
                    "message": f"未知操作类型 {event['op']!r}, 允许 INSERT/UPDATE/DELETE",
                    "file": file_name,
                    "line": line_no,
                    "seq": event["seq"],
                    "txn_id": txn_id,
                }
            )
        # 字段映射在接收期就校验, 错误定位精确到行
        self._project_row(mapping, event["payload"], file_name, line_no)

        conn.execute(
            "INSERT INTO _staging(txn_id, op_order, seq, table_name, op, payload) "
            "VALUES(?, ?, ?, ?, ?, ?)",
            (
                txn_id,
                op_order,
                event["seq"],
                table_name,
                event["op"],
                json.dumps(event["payload"], ensure_ascii=False),
            ),
        )

    def _apply_committed_txn(self, conn, event, file_name, line_no):
        """提交标记到达: 整笔事务在当前 SQLite 事务内原子生效。"""
        txn_id = event["txn_id"]
        staged = conn.execute(
            "SELECT op_order, seq, table_name, op, payload FROM _staging "
            "WHERE txn_id = ? ORDER BY op_order",
            (txn_id,),
        ).fetchall()

        expected_order = 1
        for st in staged:
            if st["op_order"] != expected_order:
                self._raise_blocked(
                    {
                        "reason": "op_order_gap",
                        "message": (
                            f"事务 {txn_id} 的操作顺序不连续: 期望 "
                            f"{expected_order}, 实际 {st['op_order']}"
                        ),
                        "file": file_name,
                        "line": line_no,
                        "seq": event["seq"],
                        "txn_id": txn_id,
                    }
                )
            expected_order += 1
            mapping = self.config.mapping_for(st["table_name"])
            payload = json.loads(st["payload"])
            values, key_values = self._project_row(
                mapping, payload, file_name, line_no
            )
            target = quote_ident(mapping.target_table)
            key_cols = [mapping.target_column(k) for k in mapping.key]
            where_sql = " AND ".join(f"{quote_ident(c)} = ?" for c in key_cols)
            existing_row = conn.execute(
                f"SELECT 1 FROM {target} WHERE {where_sql}", key_values
            ).fetchone()

            if st["op"] == "INSERT":
                if existing_row is not None:
                    self._raise_blocked(
                        {
                            "reason": "insert_existing",
                            "message": (
                                f"INSERT 的目标记录已存在: 表 {st['table_name']} "
                                f"主键 {dict(zip(mapping.key, key_values))}"
                            ),
                            "file": file_name,
                            "line": line_no,
                            "seq": st["seq"],
                            "txn_id": txn_id,
                            "table": st["table_name"],
                            "key": dict(zip(mapping.key, key_values)),
                        }
                    )
                cols = [mapping.target_column(c) for c in mapping.columns]
                col_sql = ", ".join(quote_ident(c) for c in cols)
                placeholders = ", ".join("?" for _ in cols)
                extra_cols = ", ".join(
                    quote_ident(c) for c in ("_last_txn_id", "_last_seq", "_last_op")
                )
                conn.execute(
                    f"INSERT INTO {target}({col_sql}, {extra_cols}) "
                    f"VALUES({placeholders}, ?, ?, ?)",
                    values + [txn_id, st["seq"], st["op_order"]],
                )
            else:
                if existing_row is None:
                    self._raise_blocked(
                        {
                            "reason": "modify_missing",
                            "message": (
                                f"{st['op']} 作用于不存在的记录: 表 {st['table_name']} "
                                f"主键 {dict(zip(mapping.key, key_values))}"
                            ),
                            "file": file_name,
                            "line": line_no,
                            "seq": st["seq"],
                            "txn_id": txn_id,
                            "table": st["table_name"],
                            "op": st["op"],
                            "key": dict(zip(mapping.key, key_values)),
                        }
                    )
                if st["op"] == "DELETE":
                    conn.execute(
                        f"DELETE FROM {target} WHERE {where_sql}", key_values
                    )
                else:  # UPDATE, 全字段覆盖
                    cols = [mapping.target_column(c) for c in mapping.columns]
                    set_names = cols + ["_last_txn_id", "_last_seq", "_last_op"]
                    set_sql = ", ".join(
                        f"{quote_ident(c)} = ?" for c in set_names
                    )
                    conn.execute(
                        f"UPDATE {target} SET {set_sql} WHERE {where_sql}",
                        values + [txn_id, st["seq"], st["op_order"]] + key_values,
                    )

        self._maybe_crash("before_commit:" + txn_id)

        # 业务 DML 已成功: 清暂存、事件转 committed、推进 applied_seq
        conn.execute("DELETE FROM _staging WHERE txn_id = ?", (txn_id,))
        conn.execute(
            "UPDATE _events SET state = 'committed' WHERE txn_id = ? AND state = 'staged'",
            (txn_id,),
        )
        storage.meta_set(conn, storage.META_APPLIED_SEQ, event["seq"])

    # ------------------------------------------------------------- 校验辅助

    def _validate_event_shape(self, event, file_name, line_no):
        def fail(reason, message):
            self._raise_blocked(
                {
                    "reason": reason,
                    "message": message,
                    "file": file_name,
                    "line": line_no,
                    "seq": event.get("seq"),
                    "txn_id": event.get("txn_id"),
                }
            )

        seq = event.get("seq")
        if not isinstance(seq, int) or isinstance(seq, bool) or seq < 1:
            fail("bad_seq", f"事件 seq 必须是正整数, 实际 {event.get('seq')!r}")
        txn_id = event.get("txn_id")
        if not isinstance(txn_id, str) or not txn_id:
            fail("bad_txn_id", "事件 txn_id 必须是非空字符串")
        kind = event.get("kind")
        if kind not in _KINDS:
            fail("bad_kind", f"事件 kind 必须是 {sorted(_KINDS)}, 实际 {kind!r}")
        if kind == "row":
            op_order = event.get("op_order")
            if not isinstance(op_order, int) or isinstance(op_order, bool) or op_order < 1:
                fail("bad_op_order", f"row 事件 op_order 必须是正整数, 实际 {op_order!r}")
            if not isinstance(event.get("table"), str) or not event["table"]:
                fail("bad_table", "row 事件 table 必须是非空字符串")
            if event.get("op") not in _OPS:
                fail("bad_op", f"row 事件 op 必须是 {sorted(_OPS)}")
            if not isinstance(event.get("payload"), dict):
                fail("bad_payload", "row 事件 payload 必须是对象")
        else:
            for extra in ("op_order", "table", "op", "payload"):
                if event.get(extra) is not None:
                    fail("commit_with_fields", f"commit 事件不能携带 {extra} 字段")

    def _project_row(self, mapping, payload, file_name, line_no):
        """按映射把来源行投影为目标库参数序列, 同时做字段/类型校验。"""
        if not isinstance(payload, dict):
            self._raise_blocked(
                {
                    "reason": "bad_payload",
                    "message": f"表 {mapping.source_name} 的 payload 必须是对象",
                    "file": file_name,
                    "line": line_no,
                    "table": mapping.source_name,
                }
            )
        extra = set(payload) - set(mapping.columns)
        if extra:
            self._raise_blocked(
                {
                    "reason": "unknown_column",
                    "message": f"表 {mapping.source_name} 出现未映射字段 {sorted(extra)}",
                    "file": file_name,
                    "line": line_no,
                    "table": mapping.source_name,
                    "columns": sorted(extra),
                }
            )
        missing = [c for c in mapping.columns if c not in payload]
        if missing:
            self._raise_blocked(
                {
                    "reason": "missing_column",
                    "message": f"表 {mapping.source_name} 缺少字段 {missing}",
                    "file": file_name,
                    "line": line_no,
                    "table": mapping.source_name,
                    "columns": missing,
                }
            )
        values = []
        key_values = []
        for src_col, (target_col, col_type) in mapping.columns.items():
            value = payload[src_col]
            self._check_type(value, col_type, mapping.source_name, src_col,
                             file_name, line_no)
            values.append(value)
            if src_col in mapping.key:
                key_values.append(value)
        return values, key_values

    def _check_type(self, value, col_type, table, column, file_name, line_no):
        if value is None:
            return  # NULL 对任何声明类型都合法
        ok = (
            (col_type == "INTEGER" and isinstance(value, int) and not isinstance(value, bool))
            or (col_type == "REAL" and isinstance(value, (int, float))
                and not isinstance(value, bool))
            or (col_type == "TEXT" and isinstance(value, str))
            or (col_type == "BLOB")
        )
        if not ok:
            self._raise_blocked(
                {
                    "reason": "type_mismatch",
                    "message": (
                        f"表 {table} 字段 {column} 声明为 {col_type}, "
                        f"实际值类型 {type(value).__name__}"
                    ),
                    "file": file_name,
                    "line": line_no,
                    "table": table,
                    "column": column,
                }
            )

    # ------------------------------------------------------------- 查询入口

    def status(self):
        """返回源/已接收/已应用进度、未提交事务与当前阻塞信息。"""
        conn = self.conn
        if not self.is_initialized():
            return {"initialized": False}
        snapshot_seq = storage.meta_get(conn, storage.META_SNAPSHOT_SEQ, 0)
        received_seq = storage.meta_get(conn, storage.META_RECEIVED_SEQ, 0)
        applied_seq = storage.meta_get(conn, storage.META_APPLIED_SEQ, 0)

        files = self._list_change_files()
        source_max_seq = snapshot_seq
        last_file = None
        for name in files:
            last_file = name
            source_max_seq = max(source_max_seq, self._file_max_seq(name))
        registered = {
            r["file_name"] for r in conn.execute("SELECT file_name FROM _files")
        }
        pending_files = [n for n in files if n not in registered]

        pending = [
            {
                "txn_id": r["txn_id"],
                "event_count": r["event_count"],
                "first_seq": r["first_seq"],
                "last_seq": r["last_seq"],
            }
            for r in conn.execute(
                "SELECT txn_id, COUNT(*) AS event_count, MIN(seq) AS first_seq, "
                "MAX(seq) AS last_seq FROM _staging GROUP BY txn_id ORDER BY first_seq"
            )
        ]
        return {
            "initialized": True,
            "snapshot_seq": snapshot_seq,
            "received_seq": received_seq,
            "applied_seq": applied_seq,
            "source": {
                "last_file": last_file,
                "source_max_seq": source_max_seq,
                "file_count": len(files),
                "pending_files": pending_files,
            },
            "pending_txn": pending,
            "blocked": storage.get_blocked(conn),
        }

    def _file_max_seq(self, file_name):
        """扫描文件里的最大 seq; 坏行只跳过(阻塞判定由 sync 流程负责)。"""
        max_seq = 0
        path = os.path.join(self.config.changes_dir, file_name)
        with open(path, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(event, dict) and isinstance(event.get("seq"), int):
                    max_seq = max(max_seq, event["seq"])
        return max_seq

    def trace_record(self, source_table, key_values):
        """核对一条目标记录由哪笔事务最后修改。"""
        mapping = self.config.mapping_for(source_table)
        if mapping is None:
            raise SyncError(f"未配置的来源表: {source_table}")
        if len(key_values) != len(mapping.key):
            raise SyncError(
                f"表 {source_table} 主键为 {mapping.key}, 收到 {len(key_values)} 个值"
            )
        # CLI 传入的都是字符串, 按列声明类型转换后再比较
        coerced = []
        for col, raw in zip(mapping.key, key_values):
            col_type = mapping.column_type(col)
            try:
                if col_type == "INTEGER":
                    coerced.append(int(raw))
                elif col_type == "REAL":
                    coerced.append(float(raw))
                else:
                    coerced.append(raw)
            except (TypeError, ValueError) as exc:
                raise SyncError(
                    f"主键 {col} 的值 {raw!r} 无法转换为 {col_type}"
                ) from exc
        conn = self.conn
        target = quote_ident(mapping.target_table)
        key_cols = [mapping.target_column(k) for k in mapping.key]
        where_sql = " AND ".join(f"{quote_ident(c)} = ?" for c in key_cols)
        row = conn.execute(
            f"SELECT * FROM {target} WHERE {where_sql}", coerced
        ).fetchone()
        result = {
            "table": source_table,
            "key": dict(zip(mapping.key, coerced)),
            "found": row is not None,
        }
        if row is not None:
            d = dict(row)
            result["last_txn_id"] = d.pop("_last_txn_id")
            result["last_seq"] = d.pop("_last_seq")
            result["last_op_order"] = d.pop("_last_op")
            result["row"] = d
        return result

    # ------------------------------------------------------------- 内部工具

    def _raise_blocked(self, detail):
        raise BlockedError(detail)

    def _maybe_crash(self, point):
        """测试钩子: 模拟进程在指定点被强杀(os._exit, 不做任何清理)。"""
        if self.crash_hook is not None:
            self.crash_hook(point)
        spec = os.environ.get(_CRASH_ENV)
        if spec and spec == point:
            os._exit(137)
