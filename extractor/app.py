"""本地网页界面：文档管理、规则配置、抽取核对、批处理、导出。"""

import json
import os

from flask import (Flask, abort, redirect, render_template, request,
                   send_file, url_for, Response)

from . import jobs as jobmod
from . import rules as rulemod
from . import storage as st
from .export import export_anomalies, export_confirmed
from .extract import extract_document
from .ingest import ingest_document

STATUS_LABELS = {
    "ok": "正常", "missing": "缺失", "multiple": "多候选",
    "invalid": "格式错误", "pending": "待读取", "failed": "读取失败",
}


def create_app(db_path, storage_dir):
    app = Flask(__name__)
    app.config["DB_PATH"] = db_path
    app.config["STORAGE_DIR"] = storage_dir
    os.makedirs(os.path.join(storage_dir, "uploads"), exist_ok=True)
    st.init_db(db_path)

    def db():
        return st.connect(db_path)

    def active():
        conn = db()
        try:
            rs = st.active_ruleset(conn)
            if not rs:  # 首次启动写入默认规则
                config = rulemod.DEFAULT_CONFIG
                version = rulemod.version_of(config)
                st.save_ruleset(conn, config["name"], version,
                                json.dumps(config, ensure_ascii=False))
                conn.commit()
                rs = st.active_ruleset(conn)
            return rs
        finally:
            conn.close()

    @app.context_processor
    def inject():
        return {"status_labels": STATUS_LABELS, "active_ruleset": active()}

    # ---------- 文档 ----------

    @app.route("/")
    def index():
        status = request.args.get("status", "")
        conn = db()
        try:
            sql = "SELECT * FROM documents"
            args = []
            if status:
                sql += " WHERE status=?"
                args.append(status)
            sql += " ORDER BY id DESC"
            docs = conn.execute(sql, args).fetchall()
            counts = {r["status"]: r["c"] for r in conn.execute(
                "SELECT status, COUNT(*) c FROM documents GROUP BY status")}
        finally:
            conn.close()
        return render_template("index.html", docs=docs, counts=counts, filter=status)

    @app.route("/upload", methods=["POST"])
    def upload():
        files = request.files.getlist("files")
        conn = db()
        try:
            for f in files:
                if not f.filename:
                    continue
                ext = os.path.splitext(f.filename)[1].lower()
                safe = f"{st.now().replace(':', '')}_{os.path.basename(f.filename)}"
                dest = os.path.join(app.config["STORAGE_DIR"], "uploads", safe)
                f.save(dest)  # 原始文件只保存，不修改
                doc_id = st.add_document(conn, f.filename, dest, ext, st.sha1_file(dest))
                conn.commit()
                ingest_document(conn, app.config["STORAGE_DIR"], doc_id)
        finally:
            conn.close()
        return redirect(url_for("index"))

    @app.route("/documents/<int:doc_id>")
    def document(doc_id):
        highlight = request.args.get("highlight", type=int)
        conn = db()
        try:
            doc = conn.execute("SELECT * FROM documents WHERE id=?", (doc_id,)).fetchone()
            if not doc:
                abort(404)
            pages = st.get_pages(conn, doc_id)
            rs = st.active_ruleset(conn)
            results = st.effective_results(conn, doc_id, rs["version"]) if rs else []
            stale = conn.execute(
                "SELECT DISTINCT ruleset_version v FROM extractions WHERE document_id=?",
                (doc_id,)).fetchall()
            stale = [r["v"] for r in stale if rs and r["v"] != rs["version"]]
            hl = None
            if highlight:
                row = conn.execute(
                    "SELECT * FROM extractions WHERE id=? AND document_id=?",
                    (highlight, doc_id)).fetchone()
                if row:
                    hl = dict(row)
                    hl["bbox"] = json.loads(hl["bbox_json"]) if hl["bbox_json"] else None
        finally:
            conn.close()
        return render_template("document.html", doc=doc, pages=pages,
                               results=results, highlight=hl, stale_versions=stale)

    @app.route("/files/page/<int:page_id>/image")
    def page_image(page_id):
        conn = db()
        try:
            row = conn.execute("SELECT image_path FROM pages WHERE id=?", (page_id,)).fetchone()
        finally:
            conn.close()
        if not row or not row["image_path"] or not os.path.exists(row["image_path"]):
            abort(404)
        return send_file(row["image_path"])

    @app.route("/extract/<int:doc_id>", methods=["POST"])
    def extract_one(doc_id):
        rs = active()
        conn = db()
        try:
            extract_document(conn, doc_id, json.loads(rs["config_json"]), rs["version"])
        finally:
            conn.close()
        return redirect(url_for("document", doc_id=doc_id))

    # ---------- 规则 ----------

    @app.route("/rules", methods=["GET", "POST"])
    def rules():
        error = None
        conn = db()
        try:
            if request.method == "POST":
                text = request.form.get("config", "")
                try:
                    config = json.loads(text)
                except json.JSONDecodeError as e:
                    error = f"JSON 解析失败: {e}"
                    config = None
                if config is not None:
                    errs = rulemod.validate_config(config)
                    if errs:
                        error = "；".join(errs)
                    else:
                        version = rulemod.version_of(config)
                        st.save_ruleset(conn, config.get("name", "未命名规则"), version,
                                        json.dumps(config, ensure_ascii=False))
                        conn.commit()
                        return redirect(url_for("rules"))
            current = st.active_ruleset(conn)
            versions = conn.execute(
                "SELECT * FROM rulesets ORDER BY id DESC").fetchall()
        finally:
            conn.close()
        text = json.dumps(json.loads(current["config_json"]), ensure_ascii=False,
                          indent=2) if current else ""
        return render_template("rules.html", config_text=text, current=current,
                               versions=versions, error=error)

    @app.route("/rules/activate/<version>", methods=["POST"])
    def activate_rules(version):
        conn = db()
        try:
            if conn.execute("SELECT 1 FROM rulesets WHERE version=?", (version,)).fetchone():
                st.set_setting(conn, "active_ruleset", version)
                conn.commit()
        finally:
            conn.close()
        return redirect(url_for("rules"))

    # ---------- 核对与修正 ----------

    @app.route("/review")
    def review():
        status = request.args.get("status", "")
        field = request.args.get("field", "")
        conn = db()
        try:
            rs = st.active_ruleset(conn)
            rows = []
            if rs:
                sql = ("SELECT e.*, d.filename FROM extractions e"
                       " JOIN documents d ON d.id=e.document_id"
                       " WHERE e.ruleset_version=?")
                args = [rs["version"]]
                if status:
                    sql += " AND e.status=?"
                    args.append(status)
                if field:
                    sql += " AND e.field=?"
                    args.append(field)
                sql += " ORDER BY e.document_id, e.field"
                for r in conn.execute(sql, args).fetchall():
                    d = dict(r)
                    corr = conn.execute(
                        "SELECT * FROM corrections WHERE document_id=? AND field=?"
                        " AND confirmed=1 ORDER BY id DESC LIMIT 1",
                        (d["document_id"], d["field"])).fetchone()
                    d["correction"] = dict(corr) if corr else None
                    d["effective"] = corr["corrected_value"] if corr else d["value"]
                    rows.append(d)
                fields = [f["name"] for f in json.loads(rs["config_json"])["fields"]]
            else:
                fields = []
        finally:
            conn.close()
        return render_template("review.html", rows=rows, fields=fields,
                               filter_status=status, filter_field=field)

    @app.route("/correct", methods=["POST"])
    def correct():
        doc_id = request.form.get("document_id", type=int)
        field = request.form.get("field", "")
        value = request.form.get("corrected_value", "").strip()
        operator = request.form.get("operator", "").strip() or "未署名"
        if not doc_id or not field or not value:
            abort(400)
        conn = db()
        try:
            rs = st.active_ruleset(conn)
            current = st.effective_results(conn, doc_id, rs["version"]) if rs else []
            original = next((r["effective_value"] for r in current
                             if r["field"] == field), None)
            st.add_correction(conn, doc_id, field, original, value, operator)
            conn.commit()
        finally:
            conn.close()
        return redirect(request.referrer or url_for("review"))

    # ---------- 批处理 ----------

    @app.route("/jobs")
    def jobs_page():
        conn = db()
        try:
            jobs = conn.execute("SELECT * FROM jobs ORDER BY id DESC LIMIT 20").fetchall()
            items = {}
            for j in jobs:
                items[j["id"]] = conn.execute(
                    "SELECT ji.*, d.filename FROM job_items ji"
                    " JOIN documents d ON d.id=ji.document_id"
                    " WHERE ji.job_id=? AND ji.status='failed'", (j["id"],)).fetchall()
        finally:
            conn.close()
        return render_template("jobs.html", jobs=jobs, failed_items=items)

    @app.route("/jobs/start", methods=["POST"])
    def job_start():
        mode = request.form.get("mode", "all")
        if mode not in ("all", "failed_only"):
            abort(400)
        rs = active()
        job_id = jobmod.create_job(app.config["DB_PATH"], rs["version"], mode)
        config = json.loads(rs["config_json"])
        jobmod.start_runner(app.config["DB_PATH"], app.config["STORAGE_DIR"],
                            job_id, config, rs["version"])
        return redirect(url_for("jobs_page"))

    @app.route("/jobs/<int:job_id>/pause", methods=["POST"])
    def job_pause(job_id):
        jobmod.pause_job(app.config["DB_PATH"], job_id)
        return redirect(url_for("jobs_page"))

    @app.route("/jobs/<int:job_id>/resume", methods=["POST"])
    def job_resume(job_id):
        jobmod.resume_job(app.config["DB_PATH"], app.config["STORAGE_DIR"], job_id)
        return redirect(url_for("jobs_page"))

    # ---------- 导出 ----------

    @app.route("/export/<kind>.csv")
    def export(kind):
        rs = active()
        conn = db()
        try:
            if kind == "confirmed":
                data = export_confirmed(conn, rs["version"])
                name = "confirmed_results.csv"
            elif kind == "anomalies":
                data = export_anomalies(conn, rs["version"])
                name = "anomalies.csv"
            else:
                abort(404)
        finally:
            conn.close()
        return Response(data, mimetype="text/csv; charset=utf-8",
                        headers={"Content-Disposition": f"attachment; filename={name}"})

    return app
