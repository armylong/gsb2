"""本地工作台 HTTP 服务。

安全边界:
- 只绑定 127.0.0.1, 拒绝任何非 loopback 的对端;
- 只实现工作台自身 API 与静态界面, 不提供任何代理/转发能力;
- 全部请求体限制大小, 全部路径参数在服务端白名单内处理;
- 不 import urllib/socket 主动连接, socket 仅用于监听本地端口。
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

from . import correlation, diff as diff_mod
from .export import export_project, pending_items, render_markdown
from .importer import ImportFatalError, import_package
from .masking import (
    add_custom_rule, audit_reveal, default_settings, redact_text,
    scan_text, validate_rule_pattern,
)
from .models import Project
from .project import (
    ProjectLoadError, add_annotation, load_project, new_project,
    save_project, update_annotation,
)
from .safety import MASK_PLACEHOLDER

MAX_BODY_BYTES = 2 * 1024 * 1024  # 请求体上限 2MB (导入走服务端本地路径, 不上传文件)
STATIC_DIR = Path(__file__).resolve().parent / "static"


class WorkbenchState:
    """内存中的当前工程与最近打开的工程文件路径。"""

    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.project: Project = new_project()
        self.current_path: str | None = None


STATE = WorkbenchState()


class ApiError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


# ---------------------------------------------------------------------------
# 序列化辅助
# ---------------------------------------------------------------------------

def _file_dto(f, mask: bool) -> dict:
    settings_obj = STATE.project.mask_settings
    hits = scan_text(f.text, settings_obj) if f.text else []
    text = f.text
    if mask and text:
        text = redact_text(text, settings_obj)
    return {
        "id": f.id,
        "package_id": f.package_id,
        "rel_path": f.rel_path,
        "source_path": f.source_path,
        "kind": f.kind,
        "size_bytes": f.size_bytes,
        "sha256": f.sha256,
        "md5": f.md5,
        "parse": f.parse.to_dict(),
        "text": text,
        "text_truncated": f.text_truncated,
        "duplicate_of": f.duplicate_of,
        "duplicate_reason": f.duplicate_reason,
        "masked_hit_count": len(hits),
        "masked_hits": [
            {"rule_id": h.rule_id, "rule_name": h.rule_name,
             "line_no": h.line_no, "placeholder": MASK_PLACEHOLDER}
            for h in hits
        ],
        "imported_at": f.imported_at,
    }


def _project_dto(mask: bool = True) -> dict:
    p = STATE.project
    return {
        "id": p.id,
        "name": p.name,
        "current_path": STATE.current_path,
        "created_at": p.created_at,
        "updated_at": p.updated_at,
        "packages": [pkg.to_dict() for pkg in p.packages],
        "files": [_file_dto(f, mask) for f in p.files],
        "correlations": [c.to_dict() for c in p.correlations],
        "annotations": [a.to_dict() for a in p.annotations],
        "mask_settings": p.mask_settings.to_dict(),
        "operations": [o.to_dict() for o in p.operations[-200:]],
    }


# ---------------------------------------------------------------------------
# API 处理
# ---------------------------------------------------------------------------

def _require_file(file_id: str):
    f = STATE.project.get_file(file_id)
    if f is None:
        raise ApiError(404, f"文件不存在: {file_id}")
    return f


def handle_api(method: str, path: str, query: dict, body: dict) -> dict:
    p = STATE.project

    if method == "GET" and path == "/api/state":
        return _project_dto(mask=bool(p.mask_settings.hide_by_default))

    if method == "POST" and path == "/api/project/new":
        with STATE.lock:
            STATE.project = new_project(body.get("name") or "未命名工程")
            STATE.current_path = None
        return _project_dto()

    if method == "POST" and path == "/api/project/open":
        target = body.get("path")
        if not target:
            raise ApiError(400, "缺少 path 参数")
        try:
            loaded = load_project(target)  # 先加载, 成功后才替换当前工程
        except ProjectLoadError as exc:
            raise ApiError(400, f"工程打开失败, 当前工程保持不变: {exc}") from exc
        with STATE.lock:
            STATE.project = loaded
            STATE.current_path = str(Path(target).expanduser().resolve())
        return _project_dto()

    if method == "POST" and path == "/api/project/save":
        target = body.get("path") or STATE.current_path
        if not target:
            raise ApiError(400, "缺少保存路径")
        if body.get("name"):
            STATE.project.name = str(body["name"])[:200]
        save_path = save_project(STATE.project, target)
        STATE.current_path = str(save_path)
        return {"ok": True, "path": str(save_path)}

    if method == "POST" and path == "/api/import":
        source = body.get("path")
        if not source:
            raise ApiError(400, "缺少复现包路径 path")
        try:
            with STATE.lock:
                report = import_package(STATE.project, source)
        except ImportFatalError as exc:
            # 整包失败: 工程未被修改
            raise ApiError(400, f"复现包无法读取, 当前工程保持不变: {exc}") from exc
        return {
            "ok": True,
            "package": report.package.to_dict(),
            "file_count": len(report.items),
            "duplicates": report.duplicates,
            "warnings": [
                {"rel_path": item.file.rel_path, "warnings": item.warnings}
                for item in report.items if item.warnings
            ],
        }

    if method == "GET" and path == "/api/files":
        mask = query.get("mask", ["1"])[0] not in ("0", "false", "False")
        return {"files": [_file_dto(f, mask) for f in p.files]}

    if method == "GET" and path.startswith("/api/files/"):
        file_id = path.rsplit("/", 1)[1]
        mask = query.get("mask", ["1"])[0] not in ("0", "false", "False")
        f = _require_file(file_id)
        return _file_dto(f, mask)

    if method == "POST" and path.startswith("/api/files/") and \
            path.endswith("/reveal"):
        file_id = path.split("/")[3]
        f = _require_file(file_id)
        if f.text is None:
            raise ApiError(400, "该文件没有可显示的文本")
        audit_reveal(p.mask_settings, file_id, body.get("reason", ""))
        p.log_op("reveal_text",
                 f"查看文件 {f.rel_path} 的脱敏原文: {body.get('reason', '')}")
        return {"text": f.text}

    if method == "POST" and path == "/api/annotations":
        annotation = add_annotation(
            p, body.get("title", ""), body.get("linked_file_ids") or [])
        return annotation.to_dict()

    if method == "PUT" and path.startswith("/api/annotations/"):
        annotation_id = path.rsplit("/", 1)[1]
        try:
            annotation = update_annotation(p, annotation_id, **body)
        except KeyError as exc:
            raise ApiError(404, str(exc)) from exc
        except ValueError as exc:
            raise ApiError(400, str(exc)) from exc
        return annotation.to_dict()

    if method == "POST" and path == "/api/correlations/rebuild":
        correlation.rebuild(p)
        p.log_op("rebuild_correlations", "手动重建关联")
        return {"correlations": [c.to_dict() for c in p.correlations]}

    if method == "POST" and path == "/api/diff":
        pkg_a = p.get_package(body.get("package_a_id", ""))
        pkg_b = p.get_package(body.get("package_b_id", ""))
        if pkg_a is None or pkg_b is None:
            raise ApiError(404, "指定的复现包不存在")
        files_a = [f for f in p.files if f.package_id == pkg_a.id]
        files_b = [f for f in p.files if f.package_id == pkg_b.id]
        return diff_mod.compare_packages(files_a, files_b)

    # ---- 脱敏设置 ----
    if method == "GET" and path == "/api/mask/rules":
        return {"rules": [r.to_dict() for r in p.mask_settings.rules],
                "hide_by_default": p.mask_settings.hide_by_default}

    if method == "POST" and path == "/api/mask/rules":
        err = validate_rule_pattern(body.get("pattern", ""))
        if err:
            raise ApiError(400, err)
        rule = add_custom_rule(
            p.mask_settings, body.get("name", ""),
            body.get("pattern", ""), body.get("description", ""))
        p.log_op("add_mask_rule", f"新增脱敏规则 {rule.name}")
        return rule.to_dict()

    if method == "PUT" and path.startswith("/api/mask/rules/"):
        rule_id = path.rsplit("/", 1)[1]
        rule = next((r for r in p.mask_settings.rules if r.id == rule_id), None)
        if rule is None:
            raise ApiError(404, "规则不存在")
        if "enabled" in body:
            rule.enabled = bool(body["enabled"])
        if "name" in body and not rule.builtin:
            rule.name = body["name"]
        if "pattern" in body and not rule.builtin:
            err = validate_rule_pattern(body["pattern"])
            if err:
                raise ApiError(400, err)
            rule.pattern = body["pattern"]
        p.log_op("update_mask_rule", f"更新脱敏规则 {rule_id}")
        return rule.to_dict()

    if method == "POST" and path == "/api/mask/mode":
        p.mask_settings.hide_by_default = bool(body.get("hide_by_default", True))
        p.log_op("toggle_mask_mode",
                 f"默认隐藏={p.mask_settings.hide_by_default}")
        return {"hide_by_default": p.mask_settings.hide_by_default}

    if method == "GET" and path == "/api/mask/pending":
        return {"pending": pending_items(p)}

    if method == "GET" and path == "/api/export":
        exported, pending = export_project(p)
        fmt = query.get("format", ["json"])[0]
        if fmt == "markdown":
            return {"format": "markdown", "filename":
                    f"{p.name}-redacted.md",
                    "content": render_markdown(exported)}
        return {"format": "json",
                "filename": f"{p.name}-redacted.json",
                "content": exported, "pending": pending}

    raise ApiError(404, f"未知接口: {method} {path}")


# ---------------------------------------------------------------------------
# HTTP Handler
# ---------------------------------------------------------------------------

class _Handler(BaseHTTPRequestHandler):
    server_version = "VulnWorkbench/1.0"

    def log_message(self, fmt: str, *args) -> None:  # 安静日志
        return

    def _reject_non_local(self) -> bool:
        client = self.client_address[0]
        if client not in ("127.0.0.1", "::1", "localhost"):
            self.send_error(403, "only local access is allowed")
            return True
        return False

    def _send_json(self, obj, status: int = 200,
                   content_type: str = "application/json; charset=utf-8") -> None:
        payload = (json.dumps(obj, ensure_ascii=False)
                   if not isinstance(obj, (bytes, str)) else obj)
        if isinstance(payload, str):
            payload = payload.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def _read_body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        if length > MAX_BODY_BYTES:
            raise ApiError(413, "请求体过大")
        raw = self.rfile.read(length)
        if not raw:
            return {}
        try:
            data = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ApiError(400, f"请求体不是合法 JSON: {exc}") from exc
        if not isinstance(data, dict):
            raise ApiError(400, "请求体必须是 JSON 对象")
        return data

    def _serve_static(self, rel: str) -> None:
        if rel in ("", "/"):
            rel = "index.html"
        target = (STATIC_DIR / rel).resolve()
        if not str(target).startswith(str(STATIC_DIR.resolve())) or \
                not target.is_file():
            self.send_error(404, "not found")
            return
        ctype = {
            ".html": "text/html; charset=utf-8",
            ".js": "application/javascript; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".svg": "image/svg+xml",
        }.get(target.suffix, "application/octet-stream")
        self._send_json(target.read_bytes(), content_type=ctype)

    def do_GET(self) -> None:
        if self._reject_non_local():
            return
        parsed = urlparse(self.path)
        try:
            if parsed.path.startswith("/api/"):
                query = parse_qs(parsed.query)
                result = handle_api("GET", parsed.path, query, {})
                self._send_json(result)
            else:
                self._serve_static(parsed.path.lstrip("/"))
        except ApiError as exc:
            self._send_json({"error": exc.message}, status=exc.status)
        except Exception as exc:  # pragma: no cover - 兜底
            self._send_json(
                {"error": f"服务内部错误: {type(exc).__name__}: {exc}"},
                status=500)

    def do_POST(self) -> None:
        self._mutate("POST")

    def do_PUT(self) -> None:
        self._mutate("PUT")

    def _mutate(self, method: str) -> None:
        if self._reject_non_local():
            return
        parsed = urlparse(self.path)
        if not parsed.path.startswith("/api/"):
            self.send_error(404, "not found")
            return
        try:
            body = self._read_body()
            result = handle_api(method, parsed.path, {}, body)
            self._send_json(result)
        except ApiError as exc:
            self._send_json({"error": exc.message}, status=exc.status)
        except Exception as exc:  # pragma: no cover - 兜底
            self._send_json(
                {"error": f"服务内部错误: {type(exc).__name__}: {exc}"},
                status=500)


def create_server(host: str = "127.0.0.1", port: int = 8765) -> ThreadingHTTPServer:
    return ThreadingHTTPServer((host, port), _Handler)


def serve(host: str = "127.0.0.1", port: int = 8765) -> None:
    httpd = create_server(host, port)
    actual_host, actual_port = httpd.server_address[:2]
    print(f"漏洞复现证据工作台已启动: http://{actual_host}:{actual_port}")
    print("仅监听本机回环地址; 按 Ctrl+C 停止。")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n正在停止...")
    finally:
        httpd.server_close()
