"""SQLite 存储层：所有规则版本、运行、结果、人工结论都落在这里。"""
import sqlite3
from datetime import datetime, timezone

SCHEMA = """
CREATE TABLE IF NOT EXISTS rule_versions (
    version     INTEGER PRIMARY KEY,
    created_at  TEXT NOT NULL,
    note        TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS rules (
    rule_id      TEXT NOT NULL,
    version      INTEGER NOT NULL,
    name         TEXT NOT NULL,
    rule_type    TEXT NOT NULL,
    field        TEXT,
    params       TEXT NOT NULL DEFAULT '{}',
    enabled      INTEGER NOT NULL DEFAULT 1,
    content_hash TEXT NOT NULL,
    PRIMARY KEY (rule_id, version)
);

CREATE TABLE IF NOT EXISTS runs (
    run_id            INTEGER PRIMARY KEY AUTOINCREMENT,
    dataset           TEXT NOT NULL,
    input_path        TEXT NOT NULL,
    file_sha256       TEXT NOT NULL,
    rule_version      INTEGER NOT NULL,
    key_field         TEXT,
    fmt               TEXT,
    status            TEXT NOT NULL DEFAULT 'running',  -- running|completed|interrupted|failed
    batch_size        INTEGER NOT NULL DEFAULT 1000,
    total_records     INTEGER,
    processed_records INTEGER NOT NULL DEFAULT 0,
    started_at        TEXT NOT NULL,
    finished_at       TEXT,
    error             TEXT
);

CREATE TABLE IF NOT EXISTS records (
    run_id       INTEGER NOT NULL,
    record_key   TEXT NOT NULL,
    line_no      INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    status       TEXT NOT NULL,  -- checked|corrupt
    PRIMARY KEY (run_id, record_key)
);

-- 稀疏结果表：只存非 pass 的结果（fail / not_applicable）。
-- pass / corrupt / unchecked 由 records 表与 rules 版本推导，保证未检查永远不会被当成通过。
CREATE TABLE IF NOT EXISTS results (
    run_id     INTEGER NOT NULL,
    record_key TEXT NOT NULL,
    rule_id    TEXT NOT NULL,
    status     TEXT NOT NULL,    -- fail|not_applicable
    detail     TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (run_id, record_key, rule_id)
);

-- 唯一性规则的跨记录状态，落库以支持断点续跑。
CREATE TABLE IF NOT EXISTS unique_seen (
    run_id     INTEGER NOT NULL,
    rule_id    TEXT NOT NULL,
    value      TEXT NOT NULL,
    record_key TEXT NOT NULL,
    PRIMARY KEY (run_id, rule_id, value)
);

-- 问题（finding）按 (dataset, rule, record) 定位，跨运行存续，承载人工结论。
CREATE TABLE IF NOT EXISTS findings (
    finding_id            INTEGER PRIMARY KEY AUTOINCREMENT,
    dataset               TEXT NOT NULL,
    rule_id               TEXT NOT NULL,
    record_key            TEXT NOT NULL,
    first_seen_run        INTEGER NOT NULL,
    last_seen_run         INTEGER NOT NULL,
    last_status           TEXT NOT NULL,           -- fail|resolved
    manual_status         TEXT,                    -- NULL|confirmed|closed
    note                  TEXT NOT NULL DEFAULT '',
    triaged_at            TEXT,
    triaged_by            TEXT,
    record_hash_at_triage TEXT,
    data_changed          INTEGER NOT NULL DEFAULT 0,
    UNIQUE (dataset, rule_id, record_key)
);

-- 变化记录：只有两次运行之间真正发生变化才写入。
CREATE TABLE IF NOT EXISTS changes (
    change_id  INTEGER PRIMARY KEY AUTOINCREMENT,
    dataset    TEXT NOT NULL,
    from_run   INTEGER,                 -- NULL 表示首个基线运行
    to_run     INTEGER NOT NULL,
    rule_id    TEXT NOT NULL,
    record_key TEXT NOT NULL,
    change_type TEXT NOT NULL,          -- new|resolved|status_changed
    old_status TEXT,
    new_status TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (dataset, from_run, to_run, rule_id, record_key, change_type)
);
"""

# 结果状态枚举（派生规则见 runner.status_map_for_run）：
#   pass           已检查，通过
#   fail           已检查，数据错误
#   not_applicable 规则对该记录不适用（如可空字段为空）
#   corrupt        输入记录损坏，未能解析
#   unchecked      运行中断，该记录尚未检查
RESULT_STATUSES = ("pass", "fail", "not_applicable", "corrupt", "unchecked")


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def connect(db_path):
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.executescript(SCHEMA)
    return conn
