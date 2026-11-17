"""本地 Web 服务：仅绑定 127.0.0.1，仅依赖 Python 标准库 + 本机 ffmpeg。"""
from __future__ import annotations

import json
import mimetypes
import os
import re
import threading
import uuid
from email.parser import BytesParser
from email.policy import default
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

from . import MAX_CLIPS, __version__
from .project import ExportSettings, Project, ProjectError
from .probe import ProbeError
from .samples import SAMPLE_SPECS, extract_thumbnail, generate_samples
from .verify import VerifyError, verify_export

PACKAGE_DIR = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(PACKAGE_DIR, "web")


class ServerState:
    def __init__(self, work_dir: str):
        self.work_dir = os.path.abspath(work_dir)
        self.upload_dir = os.path.join(self.work_dir, "uploads")
        self.thumb_dir = os.path.join(self.work_dir, "thumbnails")
        self.sample_dir = os.path.join(self.work_dir, "samples")
        os.makedirs(self.upload_dir, exist_ok=True)
        os.makedirs(self.thumb_dir, exist_ok=True)
        self.project = Project(self.work_dir)
        self.lock = threading.Lock()
        self.export_running = False
        self.export_progress = {"ratio": 0.0, "text": ""}

    def clip_payload(self, clip) -> dict:
        info = clip.info
        thumb = f"/api/thumbnails/{clip.clip_id}.png"
        return {
            "clip_id": clip.clip_id,
            "name": os.path.basename(clip.path),
            "path": clip.path,
            "ok": clip.ok,
            "error": clip.error,
            "thumbnail": thumb,
            "duration": None if info is None else round(info.duration, 3),
            "width": None if info is None else info.width,
            "height": None if info is None else info.height,
            "fps": None if info is None else round(info.fps, 3),
            "has_audio": None if info is None else info.has_audio,
            "audio_duration": None if info is None else info.audio_duration,
        }

    def snapshot(self) -> dict:
        settings = self.project.settings
        try:
            effective = self.project.effective_settings().to_dict()
        except ProjectError:
            effective = None
        return {
            "app_version": __version__,
            "max_clips": MAX_CLIPS,
            "clips": [self.clip_payload(c) for c in self.project.clips],
            "settings": {
                "width": settings.width, "height": settings.height,
                "fps": settings.fps, "fit": settings.fit,
                "silent_policy": settings.silent_policy,
            },
            "effective_settings": effective,
            "estimated_duration": self.project.estimated_duration(),
            "junctions": self.project.junction_report(),
            "export_running": self.export_running,
            "export_progress": dict(self.export_progress),
            "last_result": None if self.project.last_result is None
            else {
                "output_path": self.project.last_result.output_path,
                "ok": self.project.last_result.ok,
                "error": self.project.last_result.error,
                "failed_clip_id": self.project.last_result.failed_clip_id,
                "failed_stage": self.project.last_result.failed_stage,
                "expected_duration": self.project.last_result.expected_duration,
            },
        }


def parse_multipart(body: bytes, content_type: str) -> dict[str, list[dict]]:
    """用标准库 email 解析 multipart/form-data。

    返回 {字段名: [{"filename": ..., "content": bytes, "content_type": ...}]}
    注意：iter_attachments 会漏掉内联文本字段，必须用 walk() 遍历。
    """
    header = f"Content-Type: {content_type}\r\n\r\n".encode()
    msg = BytesParser(policy=default).parsebytes(header + body)
    result: dict[str, list[dict]] = {}
    for part in msg.walk():
        if part.is_multipart():
            continue
        name = part.get_param("name", header="content-disposition")
        if not name:
            continue
        payload = part.get_payload(decode=True) or b""
        result.setdefault(name, []).append({
            "filename": part.get_filename(),
            "content": payload,
            "content_type": part.get_content_type(),
        })
    return result


_SAFE_NAME = re.compile(r"[^A-Za-z0-9._-]+")


def safe_filename(name: str) -> str:
    name = os.path.basename(name or "clip")
    cleaned = _SAFE_NAME.sub("_", name).strip("._") or "clip"
    return cleaned[:120]


def make_handler(state: ServerState):
    class Handler(BaseHTTPRequestHandler):
        server_version = f"VideoJoiner/{__version__}"

        def log_message(self, fmt, *args):  # 安静一点
            pass

        # ---------- 基础工具 ----------

        def _json(self, payload, status: int = 200) -> None:
            raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def _error(self, message: str, status: int = 400) -> None:
            self._json({"error": message}, status=status)

        def _read_body(self) -> bytes:
            length = int(self.headers.get("Content-Length", 0))
            return self.rfile.read(length) if length else b""

        def _parse_form(self) -> dict[str, list[dict]]:
            ctype = self.headers.get("Content-Type", "")
            if "multipart/form-data" not in ctype:
                raise ProjectError("请求必须是 multipart/form-data")
            return parse_multipart(self._read_body(), ctype)

        # ---------- 路由 ----------

        def do_GET(self) -> None:
            parsed = urlparse(self.path)
            path = parsed.path
            try:
                if path == "/api/state":
                    with state.lock:
                        return self._json(state.snapshot())
                m = re.fullmatch(r"/api/thumbnails/([A-Za-z0-9_-]+\.png)", path)
                if m:
                    return self._serve_file(
                        os.path.join(state.thumb_dir, m.group(1)), "image/png")
                if path == "/" or path == "/index.html":
                    return self._serve_file(os.path.join(WEB_DIR, "index.html"),
                                            "text/html; charset=utf-8")
                if path.startswith("/static/"):
                    rel = path[len("/static/"):]
                    target = os.path.normpath(os.path.join(WEB_DIR, rel))
                    if not target.startswith(WEB_DIR + os.sep):
                        return self._error("非法路径", 403)
                    ctype = mimetypes.guess_type(target)[0] or "application/octet-stream"
                    return self._serve_file(target, ctype)
                self._error("未知接口", 404)
            except FileNotFoundError:
                self._error("资源不存在", 404)
            except (ProjectError, ProbeError, VerifyError) as exc:
                self._error(str(exc), 400)

        def do_POST(self) -> None:
            path = urlparse(self.path).path
            try:
                if path == "/api/clips":
                    return self._add_clips()
                if path == "/api/samples":
                    return self._generate_samples()
                if path == "/api/export":
                    return self._start_export()
                if path == "/api/verify":
                    return self._run_verify()
                self._error("未知接口", 404)
            except (ProjectError, ProbeError, VerifyError) as exc:
                self._error(str(exc), 400)

        def do_DELETE(self) -> None:
            path = urlparse(self.path).path
            try:
                m = re.fullmatch(r"/api/clips/([A-Za-z0-9_-]+)", path)
                if m:
                    with state.lock:
                        state.project.remove_clip(m.group(1))
                    return self._json(state.snapshot())
                self._error("未知接口", 404)
            except ProjectError as exc:
                self._error(str(exc), 404)

        def do_PUT(self) -> None:
            path = urlparse(self.path).path
            try:
                m = re.fullmatch(r"/api/clips/([A-Za-z0-9_-]+)/(move|replace)", path)
                if m:
                    clip_id, action = m.groups()
                    if action == "move":
                        payload = json.loads(self._read_body() or b"{}")
                        direction = int(payload.get("direction", 0))
                        if direction not in (-1, 1):
                            raise ProjectError("direction 只能是 -1 或 1")
                        with state.lock:
                            state.project.move_clip(clip_id, direction)
                        return self._json(state.snapshot())
                    return self._replace_clip(clip_id)
                if path == "/api/settings":
                    payload = json.loads(self._read_body() or b"{}")
                    with state.lock:
                        state.project.settings = ExportSettings(
                            width=int(payload.get("width", 0) or 0),
                            height=int(payload.get("height", 0) or 0),
                            fps=float(payload.get("fps", 0) or 0),
                            fit=str(payload.get("fit", "contain")),
                            silent_policy="mute",
                        )
                        state.project.settings.validate()
                    return self._json(state.snapshot())
                self._error("未知接口", 404)
            except (ProjectError, ValueError, TypeError) as exc:
                self._error(str(exc), 400)

        # ---------- 业务处理 ----------

        def _add_clips(self) -> None:
            form = self._parse_form()
            added = []
            with state.lock:
                # 上传文件
                for part in form.get("files", []):
                    if len(state.project.clips) >= MAX_CLIPS:
                        raise ProjectError(f"最多只能添加 {MAX_CLIPS} 段视频")
                    filename = safe_filename(part["filename"])
                    target = os.path.join(
                        state.upload_dir, f"{uuid.uuid4().hex[:8]}_{filename}")
                    with open(target, "wb") as fh:
                        fh.write(part["content"])
                    clip = state.project.add_clip(target)
                    if not clip.ok:
                        # 坏文件不入时间线，直接 400 并指明原因
                        state.project.remove_clip(clip.clip_id)
                        raise ProjectError(
                            f"文件「{filename}」无法识别：{clip.error}")
                    self._make_thumbnail(clip)
                    added.append(state.clip_payload(clip))
                # 本机绝对路径（高级用法）
                for part in form.get("path", []):
                    raw_path = part["content"].decode("utf-8").strip()
                    if not raw_path:
                        continue
                    if len(state.project.clips) >= MAX_CLIPS:
                        raise ProjectError(f"最多只能添加 {MAX_CLIPS} 段视频")
                    clip = state.project.add_clip(os.path.abspath(raw_path))
                    if not clip.ok:
                        state.project.remove_clip(clip.clip_id)
                        raise ProjectError(
                            f"文件「{os.path.basename(raw_path)}」无法识别：{clip.error}")
                    self._make_thumbnail(clip)
                    added.append(state.clip_payload(clip))
            self._json({"added": added, "state": state.snapshot()})

        def _replace_clip(self, clip_id: str) -> None:
            form = self._parse_form()
            with state.lock:
                index = next((i for i, c in enumerate(state.project.clips)
                              if c.clip_id == clip_id), None)
                if index is None:
                    raise ProjectError("待替换的片段不存在")
                if form.get("files"):
                    part = form["files"][0]
                    filename = safe_filename(part["filename"])
                    target = os.path.join(
                        state.upload_dir, f"{uuid.uuid4().hex[:8]}_{filename}")
                    with open(target, "wb") as fh:
                        fh.write(part["content"])
                    new_path = target
                elif form.get("path"):
                    new_path = os.path.abspath(
                        form["path"][0]["content"].decode("utf-8").strip())
                else:
                    raise ProjectError("替换时必须提供新文件或本机路径")

                # 先探测新文件，无效则原片段原封不动
                from .probe import probe_media
                try:
                    probe_media(new_path)
                except ProbeError as exc:
                    raise ProjectError(f"替换文件无法识别：{exc}") from exc
                new_clip = state.project.replace_clip(clip_id, new_path)
                self._make_thumbnail(new_clip)
            self._json(state.snapshot())

        def _make_thumbnail(self, clip) -> None:
            if not clip.ok:
                return
            thumb = os.path.join(state.thumb_dir, f"{clip.clip_id}.png")
            try:
                extract_thumbnail(clip.path, thumb,
                                  at_seconds=min(0.5, clip.info.duration / 2))
            except Exception:
                pass  # 缩略图失败不阻断主流程

        def _generate_samples(self) -> None:
            def _job():
                try:
                    generate_samples(
                        state.sample_dir,
                        progress_cb=lambda r, t: state.export_progress.update(
                            ratio=r, text=t))
                    with state.lock:
                        for spec in SAMPLE_SPECS:
                            if len(state.project.clips) >= MAX_CLIPS:
                                break
                            path = os.path.join(state.sample_dir, spec[0])
                            if any(c.path == path for c in state.project.clips):
                                continue
                            clip = state.project.add_clip(path)
                            self._make_thumbnail(clip)
                finally:
                    state.export_running = False
                    state.export_progress.update(ratio=0, text="")

            with state.lock:
                if state.export_running:
                    raise ProjectError("已有任务在执行，请稍候")
                state.export_running = True
                state.export_progress.update(ratio=0.0, text="正在生成样例")
            threading.Thread(target=_job, daemon=True).start()
            self._json(state.snapshot())

        def _start_export(self) -> None:
            payload = json.loads(self._read_body() or b"{}")
            output = os.path.abspath(payload.get("output") or
                                     os.path.join(state.work_dir, "output.mp4"))
            if not output.lower().endswith(".mp4"):
                raise ProjectError("导出文件需以 .mp4 结尾")

            with state.lock:
                if state.export_running:
                    raise ProjectError("已有导出任务在执行，请稍候")
                if not state.project.valid_clips:
                    raise ProjectError("时间线上没有可导出的有效片段")
                state.project.settings.validate()
                state.export_running = True
                state.export_progress.update(ratio=0.0, text="准备导出")

            def _job():
                try:
                    result = state.project.export(
                        output, progress_cb=lambda r, t:
                        state.export_progress.update(ratio=r, text=t))
                    state.export_progress.update(
                        ratio=1.0,
                        text="导出完成" if result.ok else f"失败：{result.error}")
                finally:
                    state.export_running = False

            threading.Thread(target=_job, daemon=True).start()
            self._json(state.snapshot())

        def _run_verify(self) -> None:
            with state.lock:
                if not state.project.last_result or not state.project.last_result.ok:
                    raise ProjectError("请先成功导出一次再校验")
                output = state.project.last_result.output_path
                project = state.project
            report = verify_export(output, project)
            self._json(report.to_dict())

        def _serve_file(self, path: str, content_type: str) -> None:
            with open(path, "rb") as fh:
                data = fh.read()
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

    return Handler


def serve(host: str = "127.0.0.1", port: int = 8765,
          work_dir: str = ".videojoiner_work") -> tuple[ThreadingHTTPServer, str]:
    state = ServerState(work_dir)
    httpd = ThreadingHTTPServer((host, port), make_handler(state))
    return httpd, f"http://{host}:{httpd.server_address[1]}/"


def main() -> int:
    import argparse
    parser = argparse.ArgumentParser(description="本地视频拼接工具 Web 界面")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--work-dir", default=".videojoiner_work")
    args = parser.parse_args()

    httpd, url = serve(args.host, args.port, args.work_dir)
    print(f"视频拼接工具已启动：{url}（仅监听本机，按 Ctrl+C 停止）")
    print(f"工作目录：{os.path.abspath(args.work_dir)}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
