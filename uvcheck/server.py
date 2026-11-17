"""仅依赖标准库的本地 HTTP 服务。

路由：
- GET  /                 前端双视图页面（web/index.html）
- GET  /app.js /styles.css
- GET  /api/samples      列出自带样例文件
- POST /api/analyze      上传 OBJ 文本（multipart 或 text/plain），返回解析+分析报告

只绑定 127.0.0.1，不监听外网；所有路径限定在 web/ 与 samples/ 目录内。
"""

from __future__ import annotations

import json
import os
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

from .analyzer import analyze
from .parser import parse_obj
from .samples import generate_samples

PACKAGE_DIR = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.normpath(os.path.join(PACKAGE_DIR, "..", "web"))
SAMPLES_DIR = os.path.normpath(os.path.join(PACKAGE_DIR, "..", "samples"))

_CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".png": "image/png",
    ".obj": "text/plain; charset=utf-8",
    ".json": "application/json; charset=utf-8",
}


def _safe_join(base: str, name: str) -> str | None:
    """把文件名限制在 base 目录内，拒绝任何路径穿越。"""
    candidate = os.path.normpath(os.path.join(base, name))
    if candidate == base or candidate.startswith(base + os.sep):
        return candidate
    return None


def _parse_multipart(body: bytes, content_type: str) -> dict[str, dict[str, str]]:
    """极简 multipart/form-data 解析，返回 {字段名: {filename, content_type, data}}。"""
    marker = "boundary="
    idx = content_type.find(marker)
    if idx < 0:
        return {}
    boundary = content_type[idx + len(marker):].strip().strip('"')
    delimiter = ("--" + boundary).encode()
    parts: dict[str, dict[str, str]] = {}
    for raw_part in body.split(delimiter):
        if not raw_part or raw_part in (b"--", b"--\r\n", b"\r\n"):
            continue
        if b"\r\n\r\n" not in raw_part:
            continue
        head, data = raw_part.split(b"\r\n\r\n", 1)
        data = data.rstrip(b"\r\n")
        name = "file"
        filename = ""
        part_ct = "application/octet-stream"
        for header_line in head.decode("latin-1").split("\r\n"):
            if ";" in header_line and "name=" in header_line:
                for token in header_line.split(";"):
                    token = token.strip()
                    if token.startswith("name="):
                        name = token[5:].strip('"')
                    elif token.startswith("filename="):
                        filename = token[9:].strip('"')
            elif header_line.lower().startswith("content-type:"):
                part_ct = header_line.split(":", 1)[1].strip()
        parts[name] = {"filename": filename, "content_type": part_ct,
                       "data": data.decode("utf-8", errors="replace")}
    return parts


class UVCheckHandler(BaseHTTPRequestHandler):
    server_version = "UVCheck/1.0"

    # ---- 工具 -------------------------------------------------------
    def _send_json(self, payload: dict, status: int = 200) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _send_error_json(self, status: int, message: str) -> None:
        """send_error 的原因短语只能用 latin-1，中文会导致断连，
        因此统一返回 JSON 错误体，状态短语保持 ASCII。"""
        body = json.dumps({"error": message}, ensure_ascii=False).encode("utf-8")
        self.send_response(status, "Error")
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_file(self, path: str) -> None:
        try:
            with open(path, "rb") as fh:
                data = fh.read()
        except OSError:
            self._send_error_json(404, "文件不存在")
            return
        ext = os.path.splitext(path)[1].lower()
        self.send_response(200)
        self.send_header("Content-Type", _CONTENT_TYPES.get(ext, "application/octet-stream"))
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt: str, *args) -> None:  # 安静日志
        pass

    # ---- GET --------------------------------------------------------
    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path in ("/", "/index.html"):
            self._send_file(os.path.join(WEB_DIR, "index.html"))
            return
        if path == "/api/samples":
            generate_samples(SAMPLES_DIR)
            files = sorted(
                f for f in os.listdir(SAMPLES_DIR)
                if os.path.isfile(os.path.join(SAMPLES_DIR, f))
            )
            self._send_json({"samples_dir": SAMPLES_DIR, "files": files})
            return
        if path.startswith("/samples/"):
            name = path[len("/samples/"):]
            target = _safe_join(SAMPLES_DIR, name)
            if target and os.path.isfile(target):
                self._send_file(target)
                return
            self._send_error_json(403, "非法路径")
            return
        # 其它静态资源限定在 web/
        rel = path.lstrip("/")
        target = _safe_join(WEB_DIR, rel) if rel else None
        if target and os.path.isfile(target):
            self._send_file(target)
            return
        self._send_error_json(404, "未找到资源")

    # ---- POST -------------------------------------------------------
    def do_POST(self) -> None:
        path = urlparse(self.path).path
        if path != "/api/analyze":
            self._send_error_json(404, "未找到接口")
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        body = self.rfile.read(length) if length else b""
        content_type = self.headers.get("Content-Type", "")

        obj_text = ""
        filename = "uploaded.obj"
        if "multipart/form-data" in content_type:
            parts = _parse_multipart(body, content_type)
            field = parts.get("file") or next(iter(parts.values()), None)
            if field is None:
                self._send_json({"error": "multart 表单中没有文件字段"}, status=400)
                return
            obj_text = field["data"]
            if field.get("filename"):
                filename = field["filename"]
        else:
            obj_text = body.decode("utf-8", errors="replace")
            named = self.headers.get("X-Obj-Filename")
            if named:
                filename = named

        if not obj_text.strip():
            self._send_json({"error": "上传内容为空"}, status=400)
            return

        # 可选查询参数：拉伸阈值
        query = urlparse(self.path).query
        threshold = 3.0
        for pair in query.split("&"):
            if pair.startswith("threshold="):
                try:
                    threshold = float(pair.split("=", 1)[1])
                except ValueError:
                    pass

        parsed = parse_obj(obj_text, source_name=os.path.basename(filename))
        report = analyze(parsed, stretch_threshold=threshold)
        self._send_json({"parse": parsed.to_payload(), "analysis": report})


def create_server(host: str = "127.0.0.1", port: int = 8765) -> ThreadingHTTPServer:
    """创建服务；端口被占用时自动尝试后续端口。"""
    generate_samples(SAMPLES_DIR)
    last_error: OSError | None = None
    for candidate in range(port, port + 20):
        try:
            httpd = ThreadingHTTPServer((host, candidate), UVCheckHandler)
            httpd.samples_dir = SAMPLES_DIR  # type: ignore[attr-defined]
            return httpd
        except OSError as exc:
            last_error = exc
    raise OSError(f"端口 {port}~{port + 19} 均被占用") from last_error


def serve(host: str = "127.0.0.1", port: int = 8765, open_browser: bool = True) -> None:
    httpd = create_server(host, port)
    actual_host, actual_port = httpd.server_address[0], httpd.server_address[1]
    url = f"http://{actual_host}:{actual_port}/"
    print("UV 检查工具已启动")
    print(f"  地址:   {url}")
    print(f"  样例:   {SAMPLES_DIR}")
    print("  按 Ctrl+C 停止")
    if open_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n正在停止...")
    finally:
        httpd.server_close()
