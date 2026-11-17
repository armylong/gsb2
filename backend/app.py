"""Flask 路由层：本地视频取帧网页的全部 HTTP 接口。"""

from __future__ import annotations

import os
import shutil
import uuid
from flask import (
    Flask,
    abort,
    jsonify,
    request,
    send_file,
    send_from_directory,
)
from werkzeug.utils import secure_filename

from .export import build_export_zip
from .pipeline import AnalysisError, JobManager

FRONTEND_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "frontend")
UPLOAD_SUBDIR = "uploads"
ALLOWED_EXTENSIONS = {
    ".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v", ".mpg", ".mpeg",
    ".ts", ".flv", ".wmv", ".3gp", ".ogv",
    # 音频/其他媒体也放行，由 ffprobe 给出“无视频流”等明确反馈
    ".m4a", ".aac", ".mp3", ".wav", ".ogg", ".oga", ".flac",
}


def create_app(work_root: str | None = None) -> Flask:
    app = Flask(
        __name__,
        static_folder=FRONTEND_DIR,
        static_url_path="",
    )
    work_root = work_root or os.path.join(os.getcwd(), "workspace")
    upload_dir = os.path.join(work_root, UPLOAD_SUBDIR)
    os.makedirs(upload_dir, exist_ok=True)
    manager = JobManager(os.path.join(work_root, "jobs"))
    app.config["MANAGER"] = manager
    app.config["UPLOAD_DIR"] = upload_dir
    app.config["WORK_ROOT"] = work_root

    def error(message: str, status: int = 400):
        return jsonify({"error": message}), status

    # ------------------------------------------------------------ 页面与静态资源

    @app.get("/")
    def index():
        return send_from_directory(FRONTEND_DIR, "index.html")

    @app.get("/api/samples")
    def list_samples():
        sample_root = os.path.abspath(app.config.get("SAMPLE_DIR", ""))
        descriptions = {
            "sample_cut.mp4": "硬切换：四段纯色画面，适合画面变化检测",
            "sample_gradual.mp4": "渐变：淡入淡出过渡，无硬切",
            "sample_vfr.mp4": "可变帧率：真实帧间隔不均匀",
            "sample_rotated.mp4": "带 90° 旋转元数据，导出截图应自动校正方向",
            "sample_audio_only.m4a": "无视频流（错误反馈测试）",
            "sample_corrupt.mp4": "损坏文件（错误反馈测试）",
        }
        samples = []
        if sample_root and os.path.isdir(sample_root):
            for name in sorted(os.listdir(sample_root)):
                full = os.path.join(sample_root, name)
                if os.path.isfile(full):
                    samples.append(
                        {
                            "name": name,
                            "path": name,
                            "description": descriptions.get(name, "测试样例"),
                        }
                    )
        return jsonify({"samples": samples})

    # ------------------------------------------------------------ 导入

    @app.post("/api/jobs")
    def create_job():
        upload_dir_ = app.config["UPLOAD_DIR"]
        source_path = None
        original_name = None

        sample_path = request.form.get("sample_path")
        if sample_path:
            # 仅允许使用服务器端样例目录内的文件，防止路径穿越
            sample_root = os.path.abspath(app.config.get("SAMPLE_DIR", ""))
            candidate = os.path.abspath(os.path.join(sample_root, sample_path))
            if not sample_root or not candidate.startswith(sample_root + os.sep):
                return error("非法的样例路径。")
            if not os.path.isfile(candidate):
                return error("样例文件不存在。", 404)
            # 复制到本应用工作区，原文件保持只读
            original_name = os.path.basename(candidate)
            target = os.path.join(upload_dir_, f"{uuid.uuid4().hex}_{original_name}")
            shutil.copy2(candidate, target)
            source_path = target
        else:
            file = request.files.get("video")
            if file is None or not file.filename:
                return error("请选择要导入的视频文件。")
            original_name = file.filename
            ext = os.path.splitext(original_name)[1].lower()
            if ext not in ALLOWED_EXTENSIONS:
                return error(f"不支持的文件类型 {ext or '(无扩展名)'}。")
            safe_name = secure_filename(original_name) or f"video{ext}"
            target = os.path.join(upload_dir_, f"{uuid.uuid4().hex}_{safe_name}")
            file.save(target)
            source_path = target

        try:
            job = manager.create_job(source_path, original_name=original_name)
        except AnalysisError as exc:
            try:
                os.remove(source_path)
            except OSError:
                pass
            return error(str(exc), 400)
        return jsonify(job.public_status()), 201

    @app.get("/api/jobs/<job_id>")
    def job_status(job_id: str):
        try:
            job = manager.get(job_id)
        except AnalysisError as exc:
            return error(str(exc), 404)
        return jsonify(job.public_status())

    @app.post("/api/jobs/<job_id>/stream")
    def switch_stream(job_id: str):
        try:
            job = manager.get(job_id)
            stream_index = int((request.get_json(silent=True) or {}).get("stream_index"))
            manager.switch_stream(job, stream_index)
        except AnalysisError as exc:
            return error(str(exc), 400)
        except (TypeError, ValueError):
            return error("stream_index 必须是整数。")
        return jsonify(job.public_status())

    @app.delete("/api/jobs/<job_id>")
    def delete_job(job_id: str):
        try:
            manager.remove_job(job_id)
        except AnalysisError as exc:
            return error(str(exc), 404)
        return jsonify({"ok": True})

    # ------------------------------------------------------------ 分析

    @app.post("/api/jobs/<job_id>/analyze")
    def analyze(job_id: str):
        try:
            job = manager.get(job_id)
            params = request.get_json(silent=True) or {}
            generation = manager.start_analysis(job, params)
        except AnalysisError as exc:
            return error(str(exc), 400)
        return jsonify({"ok": True, "analysis_generation": generation})

    @app.post("/api/jobs/<job_id>/cancel")
    def cancel(job_id: str):
        try:
            job = manager.get(job_id)
            manager.cancel_analysis(job)
        except AnalysisError as exc:
            return error(str(exc), 404)
        return jsonify({"ok": True})

    # ------------------------------------------------------------ 候选管理

    @app.post("/api/jobs/<job_id>/frames")
    def add_frame(job_id: str):
        try:
            job = manager.get(job_id)
            payload = request.get_json(silent=True) or {}
            time_value = payload.get("time")
            if time_value is None:
                return error("请提供 time（秒）。")
            cand = manager.add_manual_candidate(job, float(time_value))
        except AnalysisError as exc:
            return error(str(exc), 400)
        except (TypeError, ValueError):
            return error("time 必须是数字。")
        return jsonify({"candidate": cand.to_dict(), "job": job.public_status()})

    @app.delete("/api/jobs/<job_id>/frames/<candidate_id>")
    def remove_frame(job_id: str, candidate_id: str):
        try:
            job = manager.get(job_id)
            manager.remove_candidate(job, candidate_id)
        except AnalysisError as exc:
            return error(str(exc), 404)
        return jsonify({"ok": True})

    @app.post("/api/jobs/<job_id>/frames/<candidate_id>/select")
    def select_frame(job_id: str, candidate_id: str):
        try:
            job = manager.get(job_id)
            payload = request.get_json(silent=True) or {}
            manager.set_selected(job, candidate_id, bool(payload.get("selected", True)))
        except AnalysisError as exc:
            return error(str(exc), 400)
        return jsonify({"ok": True})

    # ------------------------------------------------------------ 预览与截图

    @app.get("/api/jobs/<job_id>/preview")
    def preview(job_id: str):
        try:
            job = manager.get(job_id)
        except AnalysisError as exc:
            return error(str(exc), 404)
        # 支持 Range 请求，浏览器预览播放器可拖动进度条
        return send_file(
            job.source_path,
            conditional=True,
            as_attachment=False,
            download_name=job.original_name,
        )

    @app.get("/api/jobs/<job_id>/frames/<candidate_id>/image")
    def frame_image(job_id: str, candidate_id: str):
        try:
            job = manager.get(job_id)
        except AnalysisError as exc:
            return error(str(exc), 404)
        with job.lock:
            cand = job.candidates.get(candidate_id)
            if cand is None or not cand.image_ready or not cand.image_path:
                abort(404)
            image_path = cand.image_path
        return send_file(image_path, mimetype="image/jpeg")

    # ------------------------------------------------------------ 导出

    @app.get("/api/jobs/<job_id>/export")
    def export(job_id: str):
        try:
            job = manager.get(job_id)
            data = build_export_zip(job)
        except AnalysisError as exc:
            return error(str(exc), 400)
        except ValueError as exc:
            return error(str(exc), 400)
        base = os.path.splitext(job.original_name)[0]
        return send_file(
            _bytes_io(data),
            mimetype="application/zip",
            as_attachment=True,
            download_name=f"{base}_frames.zip",
        )

    @app.get("/api/jobs/<job_id>/contact-sheet")
    def contact_sheet(job_id: str):
        try:
            job = manager.get(job_id)
            from .export import build_contact_sheet, _export_entries

            entries = _export_entries(job)
            data = build_contact_sheet([c for c, _ in entries], job)
        except (AnalysisError, ValueError) as exc:
            return error(str(exc), 400)
        return send_file(_bytes_io(data), mimetype="image/png")

    @app.errorhandler(404)
    def not_found(_err):
        return error("资源不存在。", 404)

    return app


def _bytes_io(data: bytes):
    import io

    return io.BytesIO(data)
