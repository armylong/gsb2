"""SQLite 存储层。

三张表:
- runs:      每次运行 (含配置快照与哈希, 支持全新运行 / 节点重跑 / 崩溃恢复重跑)
- run_tasks: 某次运行中的任务状态 (carried 表示结果继承自历史运行)
- attempts:  每次尝试, 重试追加新行, 绝不覆盖上一次

状态取值:
- run:   running / success / failed / cancelled / interrupted
- task:  pending / running / success / failed / blocked / skipped / cancelled / carried / unknown
- attempt: running / success / failed / timeout / cancelled / unknown
"""

import json
import sqlite3
import threading
import time

SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  flow_name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'full',          -- full / rerun / recover
  source_run_id INTEGER,
  rerun_root TEXT,
  config_json TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  config_mixed INTEGER NOT NULL DEFAULT 0,    -- 与来源运行配置不一致, 结果混合了不同配置
  status TEXT NOT NULL DEFAULT 'running',
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  created_at REAL NOT NULL,
  finished_at REAL
);
CREATE TABLE IF NOT EXISTS run_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  blocked_by TEXT,                            -- JSON 数组, 阻塞它的失败任务名
  source_run_id INTEGER,                      -- carried 任务的结果来自哪次运行
  task_json TEXT NOT NULL,                    -- 本任务当时的配置快照
  updated_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_run_tasks_run ON run_tasks(run_id);
CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_task_id INTEGER NOT NULL REFERENCES run_tasks(id),
  attempt_no INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  pid INTEGER,
  exit_code INTEGER,
  timed_out INTEGER NOT NULL DEFAULT 0,
  started_at REAL NOT NULL,
  ended_at REAL,
  log_path TEXT
);
CREATE INDEX IF NOT EXISTS idx_attempts_task ON attempts(run_task_id);
"""


class DB:
    def __init__(self, path):
        self.conn = sqlite3.connect(path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA foreign_keys=ON")
        self.lock = threading.Lock()
        with self.lock, self.conn:
            self.conn.executescript(SCHEMA)

    def close(self):
        with self.lock:
            self.conn.close()

    # ---------- runs ----------
    def create_run(self, flow_name, kind, config_json, config_hash,
                   source_run_id=None, rerun_root=None, config_mixed=False,
                   tasks=()):
        """创建运行并原子地写入全部任务, 避免调度器看到只有一半任务的运行。

        tasks: [(name, status, task_json, blocked_by, source_run_id), ...]
        """
        with self.lock, self.conn:
            cur = self.conn.execute(
                "INSERT INTO runs(flow_name, kind, source_run_id, rerun_root,"
                " config_json, config_hash, config_mixed, created_at)"
                " VALUES(?,?,?,?,?,?,?,?)",
                (flow_name, kind, source_run_id, rerun_root,
                 config_json, config_hash, int(config_mixed), time.time()))
            run_id = cur.lastrowid
            now = time.time()
            for name, status, task_json, blocked_by, src_run_id in tasks:
                self.conn.execute(
                    "INSERT INTO run_tasks(run_id, name, status, blocked_by,"
                    " source_run_id, task_json, updated_at) VALUES(?,?,?,?,?,?,?)",
                    (run_id, name, status,
                     json.dumps(blocked_by) if blocked_by else None,
                     src_run_id, task_json, now))
            return run_id

    def finish_run(self, run_id, status):
        with self.lock, self.conn:
            self.conn.execute(
                "UPDATE runs SET status=?, finished_at=? WHERE id=?",
                (status, time.time(), run_id))

    def set_cancel(self, run_id):
        with self.lock, self.conn:
            self.conn.execute(
                "UPDATE runs SET cancel_requested=1 WHERE id=? AND status='running'",
                (run_id,))

    def get_run(self, run_id):
        with self.lock:
            return self.conn.execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone()

    def list_runs(self):
        with self.lock:
            return self.conn.execute("SELECT * FROM runs ORDER BY id DESC").fetchall()

    def list_running_runs(self):
        with self.lock:
            return self.conn.execute(
                "SELECT * FROM runs WHERE status='running'").fetchall()

    def get_cancel_requested(self, run_id):
        with self.lock:
            row = self.conn.execute(
                "SELECT cancel_requested FROM runs WHERE id=?", (run_id,)).fetchone()
            return bool(row and row["cancel_requested"])

    # ---------- run_tasks ----------
    def add_run_task(self, run_id, name, status, task_json,
                     blocked_by=None, source_run_id=None):
        with self.lock, self.conn:
            cur = self.conn.execute(
                "INSERT INTO run_tasks(run_id, name, status, blocked_by,"
                " source_run_id, task_json, updated_at) VALUES(?,?,?,?,?,?,?)",
                (run_id, name, status,
                 json.dumps(blocked_by) if blocked_by else None,
                 source_run_id, task_json, time.time()))
            return cur.lastrowid

    def update_task_status(self, run_task_id, status, blocked_by=None):
        with self.lock, self.conn:
            self.conn.execute(
                "UPDATE run_tasks SET status=?, blocked_by=?, updated_at=? WHERE id=?",
                (status, json.dumps(blocked_by) if blocked_by else None,
                 time.time(), run_task_id))

    def get_run_tasks(self, run_id):
        with self.lock:
            return self.conn.execute(
                "SELECT * FROM run_tasks WHERE run_id=? ORDER BY id", (run_id,)).fetchall()

    # ---------- attempts ----------
    def create_attempt(self, run_task_id, attempt_no, pid, log_path):
        with self.lock, self.conn:
            cur = self.conn.execute(
                "INSERT INTO attempts(run_task_id, attempt_no, pid, started_at, log_path)"
                " VALUES(?,?,?,?,?)",
                (run_task_id, attempt_no, pid, time.time(), log_path))
            return cur.lastrowid

    def finish_attempt(self, attempt_id, status, exit_code=None, timed_out=False):
        with self.lock, self.conn:
            self.conn.execute(
                "UPDATE attempts SET status=?, exit_code=?, timed_out=?, ended_at=?"
                " WHERE id=?",
                (status, exit_code, int(timed_out), time.time(), attempt_id))

    def get_attempts(self, run_task_id):
        with self.lock:
            return self.conn.execute(
                "SELECT * FROM attempts WHERE run_task_id=? ORDER BY attempt_no",
                (run_task_id,)).fetchall()

    def count_attempts(self, run_task_id):
        with self.lock:
            row = self.conn.execute(
                "SELECT COUNT(*) c FROM attempts WHERE run_task_id=?",
                (run_task_id,)).fetchone()
            return row["c"]

    # ---------- 崩溃恢复 ----------
    def recover_interrupted(self):
        """服务重启后调用: 上次仍标记运行中的, 结果一律标记为未知, 绝不当作成功。"""
        with self.lock, self.conn:
            self.conn.execute(
                "UPDATE attempts SET status='unknown', ended_at=? WHERE status='running'",
                (time.time(),))
            self.conn.execute(
                "UPDATE run_tasks SET status='unknown', updated_at=? WHERE status='running'",
                (time.time(),))
            cur = self.conn.execute(
                "UPDATE runs SET status='interrupted', finished_at=? WHERE status='running'",
                (time.time(),))
            return cur.rowcount
