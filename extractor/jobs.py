"""批处理任务：后台线程逐文档处理，状态落库，支持暂停/恢复/只重试失败。

所有进度都在 SQLite 里，进程重启后任务可从 pending 项继续。
"""

import json
import threading

from . import storage as st
from .extract import extract_document
from .ingest import ingest_document

_RUNNERS = {}  # job_id -> Thread


def create_job(db_path, ruleset_version, mode="all"):
    """建立任务与任务项。mode=all 处理全部文档；failed_only 只重试失败文档。"""
    conn = st.connect(db_path)
    try:
        if mode == "failed_only":
            docs = conn.execute(
                "SELECT DISTINCT d.id FROM documents d WHERE d.status='failed'"
                " OR d.id IN (SELECT document_id FROM job_items WHERE status='failed')"
            ).fetchall()
        else:
            docs = conn.execute("SELECT id FROM documents").fetchall()
        cur = conn.execute(
            "INSERT INTO jobs(ruleset_version, mode, status, total, created_at, updated_at)"
            " VALUES(?,?, 'running', ?, ?, ?)",
            (ruleset_version, mode, len(docs), st.now(), st.now()),
        )
        job_id = cur.lastrowid
        for d in docs:
            conn.execute(
                "INSERT OR IGNORE INTO job_items(job_id, document_id) VALUES(?,?)",
                (job_id, d["id"]),
            )
        conn.commit()
        return job_id
    finally:
        conn.close()


def _process_one(conn, storage_dir, doc_id, config, version):
    """返回 (ok, error)。读取失败的文档先重新读取再抽取。"""
    doc = conn.execute("SELECT * FROM documents WHERE id=?", (doc_id,)).fetchone()
    if not doc:
        return False, "文档不存在"
    if doc["status"] != "ok":
        ok, err = ingest_document(conn, storage_dir, doc_id)
        if not ok:
            return False, err
    try:
        extract_document(conn, doc_id, config, version)
        return True, None
    except Exception as e:
        return False, f"抽取异常: {e}"


def run_job(db_path, storage_dir, job_id, config, version):
    """任务主循环：逐项处理；检测到 paused 即退出（保留 pending 项供恢复）。"""
    conn = st.connect(db_path)
    try:
        while True:
            job = conn.execute("SELECT status FROM jobs WHERE id=?", (job_id,)).fetchone()
            if not job or job["status"] != "running":
                return  # 被暂停（或外部终止）
            item = conn.execute(
                "SELECT * FROM job_items WHERE job_id=? AND status='pending'"
                " ORDER BY id LIMIT 1",
                (job_id,),
            ).fetchone()
            if not item:
                conn.execute(
                    "UPDATE jobs SET status='done', updated_at=? WHERE id=?",
                    (st.now(), job_id),
                )
                conn.commit()
                return
            ok, err = _process_one(conn, storage_dir, item["document_id"], config, version)
            conn.execute(
                "UPDATE job_items SET status=?, error=? WHERE id=?",
                ("done" if ok else "failed", err, item["id"]),
            )
            conn.execute(
                "UPDATE jobs SET done=done+1, failed=failed+?, updated_at=? WHERE id=?",
                (0 if ok else 1, st.now(), job_id),
            )
            conn.commit()
    finally:
        conn.close()
        _RUNNERS.pop(job_id, None)


def start_runner(db_path, storage_dir, job_id, config, version):
    if job_id in _RUNNERS and _RUNNERS[job_id].is_alive():
        return False
    t = threading.Thread(
        target=run_job, args=(db_path, storage_dir, job_id, config, version), daemon=True
    )
    _RUNNERS[job_id] = t
    t.start()
    return True


def pause_job(db_path, job_id):
    conn = st.connect(db_path)
    try:
        conn.execute(
            "UPDATE jobs SET status='paused', updated_at=? WHERE id=? AND status='running'",
            (st.now(), job_id),
        )
        conn.commit()
    finally:
        conn.close()


def resume_job(db_path, storage_dir, job_id):
    """从 pending 项继续；返回是否成功启动。"""
    conn = st.connect(db_path)
    try:
        job = conn.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        if not job or job["status"] != "paused":
            return False
        rs = conn.execute(
            "SELECT config_json FROM rulesets WHERE version=?", (job["ruleset_version"],)
        ).fetchone()
        if not rs:
            return False
        conn.execute(
            "UPDATE jobs SET status='running', updated_at=? WHERE id=?",
            (st.now(), job_id),
        )
        conn.commit()
        config = json.loads(rs["config_json"])
    finally:
        conn.close()
    return start_runner(db_path, storage_dir, job_id, config, job["ruleset_version"])


def job_progress(conn, job_id):
    job = conn.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
    if not job:
        return None
    d = dict(job)
    d["pending"] = conn.execute(
        "SELECT COUNT(*) c FROM job_items WHERE job_id=? AND status='pending'", (job_id,)
    ).fetchone()["c"]
    return d
