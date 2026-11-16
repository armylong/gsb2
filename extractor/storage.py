"""SQLite 存储层：文档、页面、规则版本、抽取结果、人工修正、批处理任务。"""

import datetime
import hashlib
import json
import os
import sqlite3

SCHEMA = """
CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL,
    stored_path TEXT NOT NULL,          -- 原始文件副本，永不被修改
    file_type TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',  -- pending | ok | failed
    error TEXT,                          -- 读取失败原因（无法识别时单独说明）
    page_count INTEGER DEFAULT 0,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    page_no INTEGER NOT NULL,
    source TEXT NOT NULL,                -- text | ocr
    text TEXT NOT NULL DEFAULT '',
    lines_json TEXT NOT NULL DEFAULT '[]', -- [{line_no, text, bbox:[x0,y0,x1,y1]|null}]
    image_path TEXT,                     -- 扫描页/图片页的图像，供原文回看
    width REAL, height REAL,
    UNIQUE(document_id, page_no)
);

CREATE TABLE IF NOT EXISTS rulesets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    version TEXT NOT NULL,               -- 配置内容哈希，规则一变版本即变
    config_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(version)
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS extractions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    field TEXT NOT NULL,
    ruleset_version TEXT NOT NULL,       -- 结果所属规则版本，防止旧结果被误认为新规则结果
    status TEXT NOT NULL,                -- ok | missing | multiple | invalid
    value TEXT,                          -- 机器抽取值（未选候选时为空）
    candidates_json TEXT NOT NULL DEFAULT '[]',
    page_no INTEGER, line_no INTEGER, bbox_json TEXT,
    run_id TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_extr_doc ON extractions(document_id, ruleset_version);

CREATE TABLE IF NOT EXISTS corrections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    field TEXT NOT NULL,
    original_value TEXT,                 -- 修正前的有效值
    corrected_value TEXT NOT NULL,
    operator TEXT NOT NULL,
    confirmed INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_corr_doc ON corrections(document_id, field);

CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ruleset_version TEXT NOT NULL,
    mode TEXT NOT NULL,                  -- all | failed_only
    status TEXT NOT NULL DEFAULT 'running', -- running | paused | done
    total INTEGER NOT NULL DEFAULT 0,
    done INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS job_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending', -- pending | done | failed
    error TEXT,
    UNIQUE(job_id, document_id)
);
"""


def now():
    return datetime.datetime.now().isoformat(timespec="seconds")


def connect(db_path):
    conn = sqlite3.connect(db_path, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db(db_path):
    os.makedirs(os.path.dirname(os.path.abspath(db_path)), exist_ok=True)
    conn = connect(db_path)
    conn.executescript(SCHEMA)
    # 上次异常退出遗留的 running 任务标记为 paused，可恢复
    conn.execute("UPDATE jobs SET status='paused' WHERE status='running'")
    conn.commit()
    return conn


def sha1_file(path):
    h = hashlib.sha1()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def get_setting(conn, key, default=None):
    row = conn.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    return row["value"] if row else default


def set_setting(conn, key, value):
    conn.execute(
        "INSERT INTO settings(key,value) VALUES(?,?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (key, value),
    )


# ---------- 文档 ----------

def add_document(conn, filename, stored_path, file_type, content_hash):
    cur = conn.execute(
        "INSERT INTO documents(filename, stored_path, file_type, content_hash, status, created_at)"
        " VALUES(?,?,?,?, 'pending', ?)",
        (filename, stored_path, file_type, content_hash, now()),
    )
    return cur.lastrowid


def set_document_status(conn, doc_id, status, error=None, page_count=0):
    conn.execute(
        "UPDATE documents SET status=?, error=?, page_count=? WHERE id=?",
        (status, error, page_count, doc_id),
    )


def replace_pages(conn, doc_id, pages):
    """pages: [{page_no, source, text, lines, image_path, width, height}]"""
    conn.execute("DELETE FROM pages WHERE document_id=?", (doc_id,))
    for p in pages:
        conn.execute(
            "INSERT INTO pages(document_id,page_no,source,text,lines_json,image_path,width,height)"
            " VALUES(?,?,?,?,?,?,?,?)",
            (
                doc_id, p["page_no"], p["source"], p.get("text", ""),
                json.dumps(p.get("lines", []), ensure_ascii=False),
                p.get("image_path"), p.get("width"), p.get("height"),
            ),
        )


def get_pages(conn, doc_id):
    rows = conn.execute(
        "SELECT * FROM pages WHERE document_id=? ORDER BY page_no", (doc_id,)
    ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["lines"] = json.loads(d["lines_json"])
        out.append(d)
    return out


# ---------- 规则 ----------

def save_ruleset(conn, name, version, config_json):
    conn.execute(
        "INSERT OR IGNORE INTO rulesets(name, version, config_json, created_at)"
        " VALUES(?,?,?,?)",
        (name, version, config_json, now()),
    )
    set_setting(conn, "active_ruleset", version)


def active_ruleset(conn):
    version = get_setting(conn, "active_ruleset")
    if not version:
        return None
    row = conn.execute("SELECT * FROM rulesets WHERE version=?", (version,)).fetchone()
    return dict(row) if row else None


# ---------- 抽取结果 ----------

def replace_extractions(conn, doc_id, ruleset_version, run_id, results):
    """重抽时只替换当前规则版本的结果；人工修正表不动。"""
    conn.execute(
        "DELETE FROM extractions WHERE document_id=? AND ruleset_version=?",
        (doc_id, ruleset_version),
    )
    for r in results:
        conn.execute(
            "INSERT INTO extractions(document_id,field,ruleset_version,status,value,"
            "candidates_json,page_no,line_no,bbox_json,run_id,created_at)"
            " VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            (
                doc_id, r["field"], ruleset_version, r["status"], r.get("value"),
                json.dumps(r.get("candidates", []), ensure_ascii=False),
                r.get("page_no"), r.get("line_no"),
                json.dumps(r["bbox"]) if r.get("bbox") else None,
                run_id, now(),
            ),
        )


def effective_results(conn, doc_id, ruleset_version):
    """机器结果 + 已确认人工修正（修正优先，重抽不丢）。"""
    rows = conn.execute(
        "SELECT * FROM extractions WHERE document_id=? AND ruleset_version=?"
        " ORDER BY field",
        (doc_id, ruleset_version),
    ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["candidates"] = json.loads(d["candidates_json"])
        d["bbox"] = json.loads(d["bbox_json"]) if d["bbox_json"] else None
        corr = conn.execute(
            "SELECT * FROM corrections WHERE document_id=? AND field=? AND confirmed=1"
            " ORDER BY id DESC LIMIT 1",
            (doc_id, d["field"]),
        ).fetchone()
        if corr:
            d["corrected"] = True
            d["effective_value"] = corr["corrected_value"]
            d["correction"] = dict(corr)
        else:
            d["corrected"] = False
            d["effective_value"] = d["value"]
            d["correction"] = None
        out.append(d)
    return out


def add_correction(conn, doc_id, field, original_value, corrected_value, operator):
    cur = conn.execute(
        "INSERT INTO corrections(document_id,field,original_value,corrected_value,operator,confirmed,created_at)"
        " VALUES(?,?,?,?,?,1,?)",
        (doc_id, field, original_value, corrected_value, operator, now()),
    )
    return cur.lastrowid
