from extractor import jobs as jobmod
from extractor import storage as st


def test_job_run_all_and_failure_tracked(env):
    job_id = jobmod.create_job(env.db_path, env.version, "all")
    jobmod.run_job(env.db_path, env.storage, job_id, env.config, env.version)
    conn = st.connect(env.db_path)
    try:
        job = jobmod.job_progress(conn, job_id)
        assert job["status"] == "done"
        assert job["done"] == job["total"] == len(env.doc_ids)
        assert job["failed"] == 1  # corrupt.pdf
        failed = conn.execute(
            "SELECT ji.*, d.filename FROM job_items ji JOIN documents d"
            " ON d.id=ji.document_id WHERE ji.job_id=? AND ji.status='failed'",
            (job_id,)).fetchall()
        assert len(failed) == 1
        assert "corrupt" in failed[0]["filename"]
        assert failed[0]["error"]  # 失败原因有说明
        # 正常文档已出结果
        n = conn.execute(
            "SELECT COUNT(*) c FROM extractions WHERE document_id=? AND ruleset_version=?",
            (env.doc_ids["layoutA"], env.version)).fetchone()["c"]
        assert n == len(env.config["fields"])
    finally:
        conn.close()


def test_pause_and_resume(env):
    job_id = jobmod.create_job(env.db_path, env.version, "all")
    jobmod.pause_job(env.db_path, job_id)  # 运行前暂停
    jobmod.run_job(env.db_path, env.storage, job_id, env.config, env.version)
    conn = st.connect(env.db_path)
    try:
        job = jobmod.job_progress(conn, job_id)
        assert job["status"] == "paused"
        assert job["pending"] == job["total"]  # 一项都没做，可恢复
    finally:
        conn.close()
    # 恢复：重新置 running 后继续，pending 项被处理完
    conn = st.connect(env.db_path)
    conn.execute("UPDATE jobs SET status='running' WHERE id=?", (job_id,))
    conn.commit()
    conn.close()
    jobmod.run_job(env.db_path, env.storage, job_id, env.config, env.version)
    conn = st.connect(env.db_path)
    try:
        job = jobmod.job_progress(conn, job_id)
        assert job["status"] == "done"
        assert job["pending"] == 0
    finally:
        conn.close()


def test_retry_failed_only(env):
    job1 = jobmod.create_job(env.db_path, env.version, "all")
    jobmod.run_job(env.db_path, env.storage, job1, env.config, env.version)
    job2 = jobmod.create_job(env.db_path, env.version, "failed_only")
    conn = st.connect(env.db_path)
    try:
        items = conn.execute(
            "SELECT ji.*, d.filename FROM job_items ji JOIN documents d"
            " ON d.id=ji.document_id WHERE ji.job_id=?", (job2,)).fetchall()
        assert len(items) == 1
        assert "corrupt" in items[0]["filename"]
    finally:
        conn.close()
    jobmod.run_job(env.db_path, env.storage, job2, env.config, env.version)
    conn = st.connect(env.db_path)
    try:
        job = jobmod.job_progress(conn, job2)
        assert job["status"] == "done"
        assert job["failed"] == 1  # 仍然失败，但只重试了它
    finally:
        conn.close()
