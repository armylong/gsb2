"""目标 SQLite 库的连接管理与元数据结构。

元数据表(全部以下划线前缀, 避免与业务表冲突):

_meta           单行 K/V: snapshot_seq / received_seq / applied_seq
_events         已接收事件流水(seq 唯一), 状态 staged/committed/covered
_staging        未提交事务暂存区, 提交时整体生效, 中断后仍在
_files          已接收文件登记(文件名 -> 内容哈希)
_blocked        当前阻塞信息(最多一条), 重新推进时自动清除
"""

import json
import os
import sqlite3

from .config import Config

META_SNAPSHOT_SEQ = "snapshot_seq"
META_RECEIVED_SEQ = "received_seq"
META_APPLIED_SEQ = "applied_seq"

EVENT_STAGED = "staged"
EVENT_COMMITTED = "committed"
EVENT_COVERED = "covered"

_DDL = [
    """
    CREATE TABLE IF NOT EXISTS _meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS _events (
        seq         INTEGER PRIMARY KEY,
        txn_id      TEXT NOT NULL,
        op_order    INTEGER,
        kind        TEXT NOT NULL,
        table_name  TEXT,
        payload     TEXT,
        hash        TEXT NOT NULL,
        state       TEXT NOT NULL
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_events_txn ON _events(txn_id, state)",
    """
    CREATE TABLE IF NOT EXISTS _staging (
        txn_id      TEXT NOT NULL,
        op_order    INTEGER NOT NULL,
        seq         INTEGER NOT NULL,
        table_name  TEXT NOT NULL,
        op          TEXT NOT NULL,
        payload     TEXT NOT NULL,
        PRIMARY KEY (txn_id, op_order)
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_staging_txn ON _staging(txn_id)",
    """
    CREATE TABLE IF NOT EXISTS _files (
        file_name   TEXT PRIMARY KEY,
        hash        TEXT NOT NULL,
        ingested_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS _blocked (
        id          INTEGER PRIMARY KEY CHECK (id = 1),
        reason      TEXT NOT NULL,
        message     TEXT NOT NULL,
        detail      TEXT NOT NULL,
        blocked_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )
    """,
]


def connect(db_path):
    """打开(必要时创建)目标库并启用 WAL。

    check_same_thread=False 仅为方便测试, 引擎本身不做跨线程共享。
    """
    directory = os.path.dirname(os.path.abspath(db_path))
    if directory:
        os.makedirs(directory, exist_ok=True)
    conn = sqlite3.connect(db_path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    # busy_timeout: verify 在 sync 运行时并发只读, 避免立刻撞锁
    conn.execute("PRAGMA busy_timeout=5000")
    return conn


def connect_readonly(db_path):
    """以只读模式打开, verify/status 等查询入口使用。"""
    if not os.path.exists(db_path):
        raise FileNotFoundError(db_path)
    uri = "file:" + os.path.abspath(db_path) + "?mode=ro"
    conn = sqlite3.connect(uri, uri=True, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout=5000")
    return conn


def initialize(conn, config: Config):
    """创建元数据表与业务目标表, 幂等。"""
    cur = conn.cursor()
    for stmt in _DDL:
        cur.execute(stmt)
    for mapping in config.mappings.values():
        cur.execute(_build_target_ddl(mapping))
    conn.commit()


def _build_target_ddl(mapping):
    # 目标列定义; key 列同时作为 WITHOUT ROWID 主键。
    # 额外三列审计信息记录最后修改事务, 供 trace/verify 使用。
    col_defs = []
    for src_col, (target_col, col_type) in mapping.columns.items():
        col_defs.append(f'"{target_col}" {col_type}')
    col_defs.extend(
        [
            '"_last_txn_id" TEXT',
            '"_last_seq" INTEGER',
            '"_last_op" INTEGER',
        ]
    )
    pk_cols = ", ".join(f'"{c}"' for c in mapping.target_key)
    return (
        f'CREATE TABLE IF NOT EXISTS "{mapping.target_table}" ('
        + ", ".join(col_defs)
        + f', PRIMARY KEY ({pk_cols})) WITHOUT ROWID'
    )


# ---------------------------------------------------------------- meta 辅助

def meta_get(conn, key, default=None):
    row = conn.execute("SELECT value FROM _meta WHERE key = ?", (key,)).fetchone()
    if row is None:
        return default
    return int(row["value"])


def meta_set(conn, key, value):
    conn.execute(
        "INSERT INTO _meta(key, value) VALUES(?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, str(int(value))),
    )


def get_blocked(conn):
    row = conn.execute("SELECT * FROM _blocked WHERE id = 1").fetchone()
    if row is None:
        return None
    detail = json.loads(row["detail"])
    detail.setdefault("reason", row["reason"])
    detail.setdefault("message", row["message"])
    detail["blocked_at"] = row["blocked_at"]
    return detail


def set_blocked(conn, detail):
    conn.execute("DELETE FROM _blocked")
    conn.execute(
        "INSERT INTO _blocked(id, reason, message, detail) VALUES(1, ?, ?, ?)",
        (
            detail.get("reason", "unknown"),
            detail.get("message", ""),
            json.dumps(detail, ensure_ascii=False, sort_keys=True),
        ),
    )


def clear_blocked(conn):
    conn.execute("DELETE FROM _blocked")
