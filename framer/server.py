"""本地 HTTP 服务：静态页面 + JSON API + 视频流（支持 Range）。

只监听 127.0.0.1，不监听外网。文件路径由前端显式传入，
仅做存在性/扩展名白名单校验，不做 shell 拼接。
"""
from __future__ import annotations

import json
import mimetypes
import tempfile
import threading
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from . import ffmpeg as ff, jobs
from .keyframes import KeyframeError
from .persistence import load_project, save_project

STATIC_DIR = Path(__file__).resolve().parent / "static"
PROXY_DIR = Path(tempfile.gettempdir()) / "framer_proxy"
SAMPLE_DIR = Path(tempfile.gettempdir()) / "framer_samples"

_VIDEO_EXT = {".mp4", ".mov", ".m4v", ".mkv", ".avi", ".webm", ".mts", ".m2ts"}
_PROJECT_EXT = {".framer.json", ".json"}
_LOCK = threading.Lock()
_PROXY_CACHE: dict[str, str] = {}


def _is_within(base: Path, target: Path) -> bool:
    try:
        target.resolve().relative_to(base.resolve())
        return True
    except ValueError:
        return False


class Handler(BaseHTTPRequestHandler):
    server_version = "Framer/1.0"

    # ---------- 工具 ----------
    def _json(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _error(self, message: str, status: int = 400) -> None:
        self._json({"ok": False, "error": message}, status)

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", 0))
        if length <= 0 or length > 50 * 1024 * 1024:
            raise ValueError("请求体为空或过大")
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def log_message(self, fmt: str, *args) -> None:  # 安静一点
        pass

    # ---------- GET ----------
    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        route, qs = parsed.path, parsed.query
        try:
            if route == "/" or route == "/index.html":
                self._send_static(STATIC_DIR / "index.html")
            elif route.startswith("/static/"):
                name = route[len("/static/"):]
                target = (STATIC_DIR / name).resolve()
                if not _is_within(STATIC_DIR, target) or not target.is_file():
                    self._error("资源不存在", 404)
                else:
                    self._send_static(target)
            elif route == "/api/info":
                self._api_info(qs)
            elif route == "/api/media":
                self._api_media(qs)
            elif route == "/api/job":
                self._api_job(qs)
            elif route == "/api/verify":
                self._api_verify(qs)
            else:
                self._error("未知路由", 404)
        except Exception as exc:
            self._error(str(exc), 500)

    def _send_static(self, path: Path) -> None:
        ctype = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
        data = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _require_path(self, qs: str, exts: set[str]) -> Path:
        from urllib.parse import parse_qs
        raw = parse_qs(qs).get("path", [""])[0]
        if not raw:
            raise ValueError("缺少 path 参数")
        p = Path(raw).expanduser()
        if not p.is_file():
            raise FileNotFoundError(f"文件不存在：{raw}")
        if p.suffix.lower() not in exts:
            raise ValueError(f"不支持的文件类型：{p.suffix}")
        return p

    def _api_info(self, qs: str) -> None:
        src = self._require_path(qs, _VIDEO_EXT)
        info = ff.probe(src)
        payload = info.to_dict()
        # 带旋转的视频给出烤正后的代理路径
        proxy = None
        if info.rotation:
            key = str(src)
            with _LOCK:
                proxy = _PROXY_CACHE.get(key)
            if proxy and not Path(proxy).is_file():
                proxy = None
        payload["proxy"] = proxy
        self._json({"ok": True, "info": payload})

    def _api_media(self, qs: str) -> None:
        """流式发送视频（支持 Range，保证浏览器可拖动进度条）。"""
        src = self._require_path(qs, _VIDEO_EXT)
        total = src.stat().st_size
        ctype = "video/mp4" if src.suffix.lower() in (".mp4", ".m4v", ".mov") \
            else "application/octet-stream"
        rng = self.headers.get("Range")
        start, end = 0, total - 1
        status = HTTPStatus.OK
        if rng:
            import re
            m = re.match(r"bytes=(\d*)-(\d*)", rng)
            if not m:
                self._error("非法 Range", 416)
                return
            if m.group(1):
                start = int(m.group(1))
            if m.group(2):
                end = min(int(m.group(2)), total - 1)
            if start > end or start >= total:
                self.send_error(416)
                return
            status = HTTPStatus.PARTIAL_CONTENT
        length = end - start + 1
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        if status == HTTPStatus.PARTIAL_CONTENT:
            self.send_header("Content-Range",
                             f"bytes {start}-{end}/{total}")
        self.end_headers()
        with open(src, "rb") as fh:
            fh.seek(start)
            remaining = length
            while remaining > 0:
                chunk = fh.read(min(1 << 20, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)

    def _api_job(self, qs: str) -> None:
        from urllib.parse import parse_qs
        job_id = parse_qs(qs).get("id", [""])[0]
        job = jobs.get_job(job_id)
        if not job:
            self._error("任务不存在", 404)
            return
        self._json({
            "ok": True, "status": job.status,
            "progress": round(job.progress, 4),
            "error": job.error, "dst": job.dst,
        })

    def _api_verify(self, qs: str) -> None:
        out = self._require_path(qs, _VIDEO_EXT)
        info = ff.probe(out)
        self._json({"ok": True, "info": info.to_dict()})

    # ---------- POST ----------
    def do_POST(self) -> None:
        route = urlparse(self.path).path
        try:
            body = self._read_json()
            if route == "/api/proxy":
                self._api_proxy(body)
            elif route == "/api/export":
                self._api_export(body)
            elif route == "/api/sample":
                self._api_sample(body)
            elif route == "/api/project/save":
                self._api_project_save(body)
            elif route == "/api/project/load":
                self._api_project_load(body)
            else:
                self._error("未知路由", 404)
        except FileNotFoundError as exc:
            self._error(str(exc), 404)
        except (ValueError, KeyframeError) as exc:
            self._error(str(exc), 400)
        except ff.FFmpegError as exc:
            self._error(str(exc), 422)
        except Exception as exc:
            self._error(f"服务器内部错误：{exc}", 500)

    def _api_proxy(self, body: dict) -> None:
        src = Path(body["path"]).expanduser()
        if not src.is_file():
            raise FileNotFoundError(f"文件不存在：{src}")
        PROXY_DIR.mkdir(parents=True, exist_ok=True)
        dst = PROXY_DIR / (src.stem + f"_{abs(hash(str(src))) & 0xffffffff:x}.mp4")
        with _LOCK:
            cached = _PROXY_CACHE.get(str(src))
        if cached and Path(cached).is_file():
            self._json({"ok": True, "proxy": cached})
            return
        ff.make_normalized_proxy(src, dst)
        with _LOCK:
            _PROXY_CACHE[str(src)] = str(dst)
        self._json({"ok": True, "proxy": str(dst)})

    def _api_export(self, body: dict) -> None:
        project = body.get("project")
        output = body.get("output", "").strip()
        if not isinstance(project, dict) or not output:
            raise ValueError("缺少 project 或 output")
        src = Path(project["src"]).expanduser()
        if not src.is_file():
            raise FileNotFoundError(f"源视频不存在：{src}")
        out = Path(output).expanduser()
        if out.suffix.lower() != ".mp4":
            raise ValueError("导出文件必须以 .mp4 结尾")
        # 预检：关键点非法直接报错，前端保留原设置
        info = ff.probe(src)
        from .keyframes import crop_size, normalize_keyframes
        crop_w, _ = crop_size(info.display_width, info.display_height)
        normalize_keyframes(project["keyframes"], info.duration,
                            info.display_width, crop_w)
        job_id = jobs.start_export(project, str(out))
        self._json({"ok": True, "jobId": job_id})

    def _api_sample(self, body: dict) -> None:
        SAMPLE_DIR.mkdir(parents=True, exist_ok=True)
        kind = body.get("kind", "normal")
        rotation = {"normal": 0, "rot90": 90, "rot180": 180, "rot270": 270}.get(kind, 0)
        name = f"sample_{kind}.mp4"
        dst = SAMPLE_DIR / name
        ff.generate_sample(dst, rotation=rotation, with_audio=True)
        info = ff.probe(dst)
        self._json({"ok": True, "path": str(dst), "info": info.to_dict()})

    def _api_project_save(self, body: dict) -> None:
        path = Path(body["path"]).expanduser()
        if path.suffix.lower() not in _PROJECT_EXT:
            raise ValueError("工程文件需以 .json 结尾")
        save_project(path, body["project"])
        self._json({"ok": True})

    def _api_project_load(self, body: dict) -> None:
        path = Path(body["path"]).expanduser()
        if not path.is_file():
            raise FileNotFoundError(f"工程不存在：{path}")
        project = load_project(path)
        self._json({"ok": True, "project": project})


def serve(host: str = "127.0.0.1", port: int = 8765) -> ThreadingHTTPServer:
    httpd = ThreadingHTTPServer((host, port), Handler)
    return httpd
