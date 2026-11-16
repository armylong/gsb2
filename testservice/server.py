"""测试服务的 HTTP 实现（标准库 http.server，线程化，仅监听 127.0.0.1）。"""
from __future__ import annotations

import json
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, Optional, Tuple

DEFAULT_PORT = 8765


class ApiError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


# ---------- 内存存储（线程安全） ----------

class Store:
    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.users: Dict[str, Dict[str, Any]] = {}
        self.accounts: Dict[str, Dict[str, Any]] = {}

    def reset(self) -> None:
        with self.lock:
            self.users.clear()
            self.accounts.clear()


STORE = Store()


# ---------- 业务处理函数（刻意保留缺陷） ----------

def _require_string(body: Dict[str, Any], field: str) -> None:
    if field in body and not isinstance(body[field], str):
        raise ApiError(400, f"字段 {field} 必须是字符串")


def create_user(body: Dict[str, Any]) -> Tuple[int, Dict[str, Any]]:
    if not isinstance(body, dict):
        raise ApiError(400, "请求体必须是 JSON 对象")
    required = ("name", "email", "age")
    missing = [f for f in required if f not in body]
    if missing:
        raise ApiError(400, f"缺少必填字段: {', '.join(missing)}")
    _require_string(body, "name")
    _require_string(body, "email")
    if "age" in body and (not isinstance(body["age"], int)
                          or isinstance(body["age"], bool)):
        raise ApiError(400, "字段 age 必须是整数")
    if isinstance(body.get("email"), str) and "@" not in body["email"]:
        raise ApiError(400, "email 格式不合法")
    profile = body.get("profile", {})
    if profile is not None and not isinstance(profile, dict):
        raise ApiError(400, "字段 profile 必须是对象")
    # [缺陷 1] 嵌套字段 geo 只校验了存在性，未校验类型；
    # list/dict 上调用 startswith 会抛 AttributeError -> 500
    if isinstance(profile, dict) and "geo" in profile:
        geo = profile["geo"]
        if geo is not None:
            _ = geo.startswith("geo:")  # list/dict 触发 AttributeError
    user_id = uuid.uuid4().hex[:12]
    with STORE.lock:
        user = {
            "id": user_id,
            "name": body["name"],
            "email": body["email"],
            "age": body["age"],
            "profile": profile or {},
            # [缺陷 2 的入口] 未声明字段可能从 update 写入；create 保持干净
        }
        STORE.users[user_id] = user
    return 201, {"user": user}


def update_user(user_id: str, body: Dict[str, Any]) -> Tuple[int, Dict[str, Any]]:
    if not isinstance(body, dict):
        raise ApiError(400, "请求体必须是 JSON 对象")
    with STORE.lock:
        user = STORE.users.get(user_id)
        if user is None:
            raise ApiError(404, "用户不存在")
        if "name" in body:
            _require_string(body, "name")
            user["name"] = body["name"]
        if "age" in body:
            if not isinstance(body["age"], int) or isinstance(body["age"], bool):
                raise ApiError(400, "字段 age 必须是整数")
            user["age"] = body["age"]
        # [缺陷 2] 整体合并请求体，未声明字段 is_admin/role 被静默持久化，
        # 响应仍然 200，单看状态码完全正常，只有后置状态检查能发现。
        for key, value in body.items():
            if key not in ("name", "age", "email", "profile"):
                user[key] = value
        if "profile" in body:
            if not isinstance(body["profile"], dict):
                raise ApiError(400, "字段 profile 必须是对象")
            user["profile"] = body["profile"]
        return 200, {"user": dict(user)}


def get_user(user_id: str) -> Tuple[int, Dict[str, Any]]:
    with STORE.lock:
        user = STORE.users.get(user_id)
        if user is None:
            raise ApiError(404, "用户不存在")
        return 200, {"user": dict(user)}


def delete_user(user_id: str) -> Tuple[int, Optional[Dict[str, Any]]]:
    with STORE.lock:
        STORE.users.pop(user_id, None)
    return 204, None


def create_account(body: Dict[str, Any]) -> Tuple[int, Dict[str, Any]]:
    if not isinstance(body, dict) or "owner" not in body:
        raise ApiError(400, "缺少必填字段 owner")
    if not isinstance(body["owner"], str):
        raise ApiError(400, "字段 owner 必须是字符串")
    account_id = uuid.uuid4().hex[:12]
    with STORE.lock:
        account = {"id": account_id, "owner": body["owner"],
                   "status": "active", "balance": 0}
        STORE.accounts[account_id] = account
    return 201, {"account": account}


def close_account(account_id: str) -> Tuple[int, Dict[str, Any]]:
    with STORE.lock:
        account = STORE.accounts.get(account_id)
        if account is None:
            raise ApiError(404, "账户不存在")
        account["status"] = "closed"
        return 200, {"account": dict(account)}


def get_account(account_id: str) -> Tuple[int, Dict[str, Any]]:
    with STORE.lock:
        account = STORE.accounts.get(account_id)
        if account is None:
            raise ApiError(404, "账户不存在")
        return 200, {"account": dict(account)}


def delete_account(account_id: str) -> Tuple[int, Optional[Dict[str, Any]]]:
    with STORE.lock:
        STORE.accounts.pop(account_id, None)
    return 204, None


def create_transaction(account_id: str, body: Dict[str, Any]
                       ) -> Tuple[int, Dict[str, Any]]:
    if not isinstance(body, dict) or "amount" not in body:
        raise ApiError(400, "缺少必填字段 amount")
    with STORE.lock:
        account = STORE.accounts.get(account_id)
        if account is None:
            raise ApiError(404, "账户不存在")
        if account["status"] != "active":
            # 已关闭账户不允许交易，正常应返回 409
            # [缺陷 3] 错误页生成前先拼接 memo，非字符串 memo 触发 TypeError -> 500，
            # 即"状态依赖异常"：同样的输入在 active 账户上只会得到 400。
            if "memo" in body and not isinstance(body["memo"], str):
                _ = "closed:" + body["memo"]  # TypeError
            raise ApiError(409, f"账户状态 {account['status']} 不允许交易")
        if not isinstance(body["amount"], (int, float)) or isinstance(body["amount"], bool):
            raise ApiError(400, "字段 amount 必须是数字")
        if "memo" in body and not isinstance(body["memo"], str):
            raise ApiError(400, "字段 memo 必须是字符串")
        tx = {"id": uuid.uuid4().hex[:12], "amount": body["amount"],
              "memo": body.get("memo", "")}
        account["balance"] += body["amount"]
        return 201, {"transaction": tx, "balance": account["balance"]}


def register(body: Dict[str, Any]) -> Tuple[int, Dict[str, Any]]:
    """带字段间约束的接口：confirm_password 必须等于 password；
    type=business 时必须带 company。"""
    if not isinstance(body, dict):
        raise ApiError(400, "请求体必须是 JSON 对象")
    for field in ("username", "password", "confirm_password"):
        if field not in body:
            raise ApiError(400, f"缺少必填字段: {field}")
        if not isinstance(body[field], str):
            raise ApiError(400, f"字段 {field} 必须是字符串")
    if body["password"] != body["confirm_password"]:
        raise ApiError(400, "confirm_password 必须与 password 一致")
    if body.get("type") == "business" and not body.get("company"):
        raise ApiError(400, "type=business 时必须提供 company")
    return 201, {"username": body["username"], "registered": True}


# ---------- HTTP 适配层 ----------

class _Handler(BaseHTTPRequestHandler):
    server_version = "apifuzz-testservice/1.0"

    def log_message(self, fmt: str, *args: Any) -> None:  # 安静模式
        return

    def _send(self, status: int, payload: Optional[Dict[str, Any]],
              headers: Optional[Dict[str, str]] = None) -> None:
        self.send_response(status)
        if payload is None:
            for key, value in (headers or {}).items():
                self.send_header(key, value)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(data)

    def _read_body(self) -> Any:
        length = int(self.headers.get("Content-Length", 0))
        if length == 0:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise ApiError(400, f"请求体不是合法 JSON: {exc}")

    def _dispatch(self, method: str) -> None:
        path = self.path.split("?", 1)[0]
        try:
            body = self._read_body() if method in ("POST", "PUT", "PATCH") else None
            if method == "GET" and path == "/health":
                self._send(200, {"status": "ok"})
            elif method == "GET" and path == "/api/redirect":
                # 跳转到范围外地址，验证客户端拦截（不会真的发出外部请求）
                self._send(302, None, {"Location": "http://example.invalid/elsewhere"})
            elif method == "POST" and path == "/api/users":
                status, payload = create_user(body)
                self._send(status, payload)
            elif method == "POST" and path == "/api/register":
                status, payload = register(body)
                self._send(status, payload)
            elif method == "POST" and path == "/api/accounts":
                status, payload = create_account(body)
                self._send(status, payload)
            else:
                routed = self._dispatch_routed(method, path, body)
                if not routed:
                    self._send(404, {"error": "not_found",
                                     "message": f"无此路由: {method} {path}"})
        except ApiError as exc:
            self._send(exc.status, {"error": "api_error", "message": exc.message})
        except Exception as exc:  # 模拟真实框架的未捕获异常 -> 500
            self._send(500, {"error": "internal_server_error",
                             "message": f"{type(exc).__name__}: {exc}"})

    def _dispatch_routed(self, method: str, path: str,
                         body: Any) -> bool:
        # /api/users/{id}
        if path.startswith("/api/users/"):
            user_id = path.split("/")[3]
            if method == "PUT":
                status, payload = update_user(user_id, body)
            elif method == "GET":
                status, payload = get_user(user_id)
            elif method == "DELETE":
                status, payload = delete_user(user_id)
                self._send(status, payload)
                return True
            else:
                return False
            self._send(status, payload)
            return True
        # /api/accounts/{id}/...
        parts = path.strip("/").split("/")
        if len(parts) >= 3 and parts[0] == "api" and parts[1] == "accounts":
            account_id = parts[2]
            if method == "GET" and len(parts) == 3:
                status, payload = get_account(account_id)
                self._send(status, payload)
                return True
            if method == "DELETE" and len(parts) == 3:
                status, payload = delete_account(account_id)
                self._send(status, payload)
                return True
            if method == "POST" and len(parts) == 4 and parts[3] == "close":
                status, payload = close_account(account_id)
                self._send(status, payload)
                return True
            if method == "POST" and len(parts) == 4 and parts[3] == "transactions":
                status, payload = create_transaction(account_id, body)
                self._send(status, payload)
                return True
        return False

    def do_GET(self) -> None:
        self._dispatch("GET")

    def do_POST(self) -> None:
        self._dispatch("POST")

    def do_PUT(self) -> None:
        self._dispatch("PUT")

    def do_DELETE(self) -> None:
        self._dispatch("DELETE")


def create_server(port: int = DEFAULT_PORT,
                  host: str = "127.0.0.1") -> ThreadingHTTPServer:
    return ThreadingHTTPServer((host, port), _Handler)


def reset_store() -> None:
    STORE.reset()


def serve(port: int = DEFAULT_PORT, host: str = "127.0.0.1") -> None:
    server = create_server(port, host)
    actual_port = server.server_address[1]
    print(f"[testservice] 仅监听 {host}:{actual_port}，Ctrl+C 停止")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
