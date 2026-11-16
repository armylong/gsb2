"""SQLite 存储层。

表结构说明:
- runs:        每次处理运行; 只有 status='published' 的运行其结果对外可见
- files:       每个来源文件的处理结果(成功/失败/行数/校验和)
- events:      归一化后的有效事件, 按 (event_id, content_hash) 去重
- conflicts:   事件编号相同但内容不同的记录, 不计入统计
- skipped:     解析失败被跳过的原始行, 可定位到文件与行号
- windows:     某次运行算出的窗口统计(暂存区), 发布后不清除, 便于审计
- window_events: 窗口与事件的对应关系(统计值的来源, 供 explain 使用)
- published:   当前对外可查询的窗口结果(每次发布整体替换所涉窗口)
- publish_diffs: 每次发布前后结果的差异
- checkpoints: 每个文件已完整处理到的位置, 供断点续跑使用
"""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone

SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,               -- run | reprocess
    started_at TEXT NOT NULL,
    finished_at TEXT,
    range_start TEXT,
    range_end TEXT,
    from_event TEXT,
    status TEXT NOT NULL,             -- running | failed | published
    note TEXT
);
CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL,
    source TEXT NOT NULL,
    path TEXT NOT NULL,
    checksum TEXT,
    status TEXT NOT NULL,             -- ok | failed | skipped
    error TEXT,
    total_lines INTEGER DEFAULT 0,
    ok_lines INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS events (
    event_id TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    biz_time TEXT NOT NULL,
    biz_key TEXT NOT NULL,
    amount REAL,
    status TEXT,
    source TEXT NOT NULL,
    source_file TEXT NOT NULL,
    source_line INTEGER NOT NULL,
    run_id INTEGER NOT NULL,
    PRIMARY KEY (event_id, content_hash)
);
CREATE INDEX IF NOT EXISTS idx_events_biz ON events(biz_key, biz_time);
CREATE TABLE IF NOT EXISTS conflicts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL,
    event_id TEXT NOT NULL,
    existing_hash TEXT NOT NULL,
    new_hash TEXT NOT NULL,
    source TEXT NOT NULL,
    source_file TEXT NOT NULL,
    source_line INTEGER NOT NULL,
    detail TEXT
);
CREATE TABLE IF NOT EXISTS skipped (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL,
    source TEXT NOT NULL,
    source_file TEXT NOT NULL,
    source_line INTEGER NOT NULL,
    reason TEXT NOT NULL,
    raw TEXT
);
CREATE TABLE IF NOT EXISTS windows (
    run_id INTEGER NOT NULL,
    biz_key TEXT NOT NULL,
    window_start TEXT NOT NULL,
    window_end TEXT NOT NULL,
    cnt INTEGER NOT NULL,
    amount_sum REAL NOT NULL,
    status_json TEXT NOT NULL,
    PRIMARY KEY (run_id, biz_key, window_start)
);
CREATE TABLE IF NOT EXISTS window_events (
    run_id INTEGER NOT NULL,
    biz_key TEXT NOT NULL,
    window_start TEXT NOT NULL,
    event_id TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    PRIMARY KEY (run_id, biz_key, window_start, event_id, content_hash)
);
CREATE TABLE IF NOT EXISTS published (
    biz_key TEXT NOT NULL,
    window_start TEXT NOT NULL,
    window_end TEXT NOT NULL,
    cnt INTEGER NOT NULL,
    amount_sum REAL NOT NULL,
    status_json TEXT NOT NULL,
    run_id INTEGER NOT NULL,
    published_at TEXT NOT NULL,
    PRIMARY KEY (biz_key, window_start)
);
CREATE TABLE IF NOT EXISTS publish_diffs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL,
    biz_key TEXT NOT NULL,
    window_start TEXT NOT NULL,
    old_json TEXT,
    new_json TEXT
);
CREATE TABLE IF NOT EXISTS checkpoints (
    source TEXT NOT NULL,
    path TEXT NOT NULL,
    checksum TEXT NOT NULL,
    last_line INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (source, path)
);
"""


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class Store:
    def __init__(self, path: str):
        self.conn = sqlite3.connect(path)
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript(SCHEMA)
        self.conn.commit()

    def close(self):
        self.conn.close()

    # ---- runs ----
    def start_run(self, kind, range_start, range_end, from_event, note="") -> int:
        cur = self.conn.execute(
            "INSERT INTO runs(kind, started_at, range_start, range_end, from_event, status, note)"
            " VALUES (?,?,?,?,?,'running',?)",
            (kind, now_iso(), range_start, range_end, from_event, note),
        )
        self.conn.commit()
        return cur.lastrowid

    def finish_run(self, run_id: int, status: str, note: str = ""):
        self.conn.execute(
            "UPDATE runs SET finished_at=?, status=?, note=? WHERE id=?",
            (now_iso(), status, note, run_id),
        )
        self.conn.commit()

    # ---- files / checkpoints ----
    def record_file(self, run_id, source, path, checksum, status, error, total, ok):
        self.conn.execute(
            "INSERT INTO files(run_id, source, path, checksum, status, error, total_lines, ok_lines)"
            " VALUES (?,?,?,?,?,?,?,?)",
            (run_id, source, path, checksum, status, error, total, ok),
        )

    def file_already_done(self, source: str, path: str, checksum: str) -> bool:
        row = self.conn.execute(
            "SELECT 1 FROM checkpoints WHERE source=? AND path=? AND checksum=?",
            (source, path, checksum),
        ).fetchone()
        return row is not None

    def set_checkpoint(self, source: str, path: str, checksum: str, last_line: int):
        self.conn.execute(
            "INSERT INTO checkpoints(source, path, checksum, last_line, updated_at) VALUES (?,?,?,?,?)"
            " ON CONFLICT(source, path) DO UPDATE SET checksum=excluded.checksum,"
            " last_line=excluded.last_line, updated_at=excluded.updated_at",
            (source, path, checksum, last_line, now_iso()),
        )

    # ---- events ----
    def insert_event(self, run_id: int, ev) -> str:
        """返回 'inserted' | 'duplicate' | 'conflict'。"""
        existing = self.conn.execute(
            "SELECT content_hash FROM events WHERE event_id=?", (ev.event_id,)
        ).fetchall()
        hashes = {r["content_hash"] for r in existing}
        if ev.content_hash in hashes:
            return "duplicate"
        if hashes:
            self.conn.execute(
                "INSERT INTO conflicts(run_id, event_id, existing_hash, new_hash, source,"
                " source_file, source_line, detail) VALUES (?,?,?,?,?,?,?,?)",
                (
                    run_id, ev.event_id, sorted(hashes)[0], ev.content_hash, ev.source,
                    ev.source_file, ev.source_line,
                    json.dumps(
                        {"biz_time": ev.biz_time, "biz_key": ev.biz_key,
                         "amount": ev.amount, "status": ev.status},
                        ensure_ascii=False,
                    ),
                ),
            )
            return "conflict"
        self.conn.execute(
            "INSERT INTO events(event_id, content_hash, biz_time, biz_key, amount, status,"
            " source, source_file, source_line, run_id) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (ev.event_id, ev.content_hash, ev.biz_time, ev.biz_key, ev.amount, ev.status,
             ev.source, ev.source_file, ev.source_line, run_id),
        )
        return "inserted"

    def record_skipped(self, run_id, source, path, line, reason, raw):
        self.conn.execute(
            "INSERT INTO skipped(run_id, source, source_file, source_line, reason, raw)"
            " VALUES (?,?,?,?,?,?)",
            (run_id, source, path, line, reason, raw),
        )

    def find_event_position(self, event_id: str):
        """返回该事件首次出现的 (source, source_file, source_line), 用于 --from-event。"""
        return self.conn.execute(
            "SELECT source, source_file, source_line FROM events WHERE event_id=?"
            " ORDER BY source, source_file, source_line LIMIT 1",
            (event_id,),
        ).fetchone()

    # ---- windows ----
    def events_in_range(self, range_start: str, range_end: str):
        return self.conn.execute(
            "SELECT event_id, content_hash, biz_time, biz_key, amount, status FROM events"
            " WHERE biz_time >= ? AND biz_time < ? ORDER BY biz_time, event_id",
            (range_start, range_end),
        ).fetchall()

    def save_window(self, run_id, biz_key, w_start, w_end, cnt, amount_sum, status_counts):
        self.conn.execute(
            "INSERT INTO windows(run_id, biz_key, window_start, window_end, cnt, amount_sum,"
            " status_json) VALUES (?,?,?,?,?,?,?)"
            " ON CONFLICT(run_id, biz_key, window_start) DO UPDATE SET"
            " cnt=excluded.cnt, amount_sum=excluded.amount_sum, status_json=excluded.status_json",
            (run_id, biz_key, w_start, w_end, cnt, amount_sum, json.dumps(status_counts, ensure_ascii=False, sort_keys=True)),
        )

    def save_window_event(self, run_id, biz_key, w_start, event_id, content_hash):
        self.conn.execute(
            "INSERT OR IGNORE INTO window_events(run_id, biz_key, window_start, event_id, content_hash)"
            " VALUES (?,?,?,?,?)",
            (run_id, biz_key, w_start, event_id, content_hash),
        )

    def publish_run(self, run_id: int) -> int:
        """把某次运行的窗口结果原子发布; 记录与旧发布结果的差异。返回发布的窗口数。"""
        rows = self.conn.execute(
            "SELECT biz_key, window_start, window_end, cnt, amount_sum, status_json"
            " FROM windows WHERE run_id=?",
            (run_id,),
        ).fetchall()
        ts = now_iso()
        with self.conn:  # 单事务: 旧结果在发布前一直可查询
            for r in rows:
                old = self.conn.execute(
                    "SELECT cnt, amount_sum, status_json, run_id FROM published"
                    " WHERE biz_key=? AND window_start=?",
                    (r["biz_key"], r["window_start"]),
                ).fetchone()
                old_json = None
                if old:
                    old_json = json.dumps(
                        {"cnt": old["cnt"], "amount_sum": old["amount_sum"],
                         "status": json.loads(old["status_json"]), "run_id": old["run_id"]},
                        ensure_ascii=False, sort_keys=True,
                    )
                new_json = json.dumps(
                    {"cnt": r["cnt"], "amount_sum": r["amount_sum"],
                     "status": json.loads(r["status_json"]), "run_id": run_id},
                    ensure_ascii=False, sort_keys=True,
                )
                if old_json != new_json:
                    self.conn.execute(
                        "INSERT INTO publish_diffs(run_id, biz_key, window_start, old_json, new_json)"
                        " VALUES (?,?,?,?,?)",
                        (run_id, r["biz_key"], r["window_start"], old_json, new_json),
                    )
                self.conn.execute(
                    "INSERT INTO published(biz_key, window_start, window_end, cnt, amount_sum,"
                    " status_json, run_id, published_at) VALUES (?,?,?,?,?,?,?,?)"
                    " ON CONFLICT(biz_key, window_start) DO UPDATE SET"
                    " window_end=excluded.window_end, cnt=excluded.cnt,"
                    " amount_sum=excluded.amount_sum, status_json=excluded.status_json,"
                    " run_id=excluded.run_id, published_at=excluded.published_at",
                    (r["biz_key"], r["window_start"], r["window_end"], r["cnt"],
                     r["amount_sum"], r["status_json"], run_id, ts),
                )
            self.conn.execute(
                "UPDATE runs SET status='published', finished_at=? WHERE id=?", (ts, run_id)
            )
        return len(rows)

    # ---- query ----
    def query_published(self, biz_key=None, start=None, end=None):
        sql = "SELECT * FROM published WHERE 1=1"
        args = []
        if biz_key:
            sql += " AND biz_key=?"
            args.append(biz_key)
        if start:
            sql += " AND window_start>=?"
            args.append(start)
        if end:
            sql += " AND window_start<?"
            args.append(end)
        sql += " ORDER BY biz_key, window_start"
        return self.conn.execute(sql, args).fetchall()

    def explain_window(self, biz_key: str, window_start: str):
        """返回 (published 行, 贡献事件列表)。事件按发布该结果的 run 反查。"""
        pub = self.conn.execute(
            "SELECT * FROM published WHERE biz_key=? AND window_start=?",
            (biz_key, window_start),
        ).fetchone()
        if not pub:
            return None, []
        events = self.conn.execute(
            "SELECT e.* FROM window_events we JOIN events e"
            " ON e.event_id=we.event_id AND e.content_hash=we.content_hash"
            " WHERE we.run_id=? AND we.biz_key=? AND we.window_start=?"
            " ORDER BY e.biz_time, e.event_id",
            (pub["run_id"], biz_key, window_start),
        ).fetchall()
        return pub, events
