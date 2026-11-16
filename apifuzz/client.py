"""带访问范围与预算限制的 HTTP 客户端。

安全约束（对应需求 2）：

1. 只允许访问配置中 ``allowed_hosts`` + ``allowed_ports`` 明确列出的目标，
   每次请求发送前、每次跳转跟随前都重新校验，跳转无法把请求带出范围。
2. 全局请求次数上限（含跳转产生的请求）、单次请求超时、整轮运行截止时间。
3. 并发上限由引擎的线程池容量保证，客户端只负责计数与截止时间。
4. 不使用环境代理变量（``urllib.request`` 默认会读 ``HTTP_PROXY``），
   防止代理把流量带出本机。
"""
from __future__ import annotations

import http.client
import json
import threading
import time
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urljoin, urlparse

from .errors import BudgetExhausted, ScopeViolation
from .models import Evidence

_DEFAULT_PORTS = {"http": 80, "https": 443}


class Budget:
    """线程安全的请求计数与运行截止时间。"""

    def __init__(self, max_requests: int, deadline: float):
        self.max_requests = max_requests
        self.deadline = deadline
        self._lock = threading.Lock()
        self.used = 0

    def acquire(self) -> int:
        with self._lock:
            if time.monotonic() > self.deadline:
                raise BudgetExhausted("已超过最大运行时长")
            if self.used >= self.max_requests:
                raise BudgetExhausted(
                    f"已达到请求次数上限 {self.max_requests}")
            self.used += 1
            return self.used


class ScopedClient:
    def __init__(self, base_url: str, allowed_hosts: List[str],
                 allowed_ports: List[int], budget: Budget,
                 timeout: float, max_redirects: int,
                 max_body_evidence: int):
        self.base_url = base_url.rstrip("/")
        self.allowed_hosts = frozenset(allowed_hosts)
        self.allowed_ports = frozenset(allowed_ports)
        self.budget = budget
        self.timeout = timeout
        self.max_redirects = max_redirects
        self.max_body_evidence = max_body_evidence

    # ---------- 范围校验 ----------

    def _check_scope(self, url: str) -> Tuple[str, int, str]:
        parsed = urlparse(url)
        if parsed.scheme not in ("http", "https"):
            raise ScopeViolation(f"仅支持 http/https，拒绝: {url}")
        host = parsed.hostname
        port = parsed.port or _DEFAULT_PORTS[parsed.scheme]
        if host not in self.allowed_hosts:
            raise ScopeViolation(
                f"主机 {host!r} 不在允许列表 {sorted(self.allowed_hosts)} 中: {url}")
        if port not in self.allowed_ports:
            raise ScopeViolation(
                f"端口 {port} 不在允许列表 {sorted(self.allowed_ports)} 中: {url}")
        return host, port, parsed.scheme

    def resolve(self, path_or_url: str) -> str:
        """把接口配置中的路径（可能含 {placeholder}）解析为绝对 URL。"""
        if path_or_url.startswith(("http://", "https://")):
            return path_or_url
        parsed_scheme = urlparse(path_or_url).scheme
        if parsed_scheme:  # file://、ftp:// 等非 http(s) 绝对地址，交给范围校验拒绝
            return path_or_url
        if not path_or_url.startswith("/"):
            path_or_url = "/" + path_or_url
        return self.base_url + path_or_url

    # ---------- 主入口 ----------

    def request(self, method: str, path_or_url: str,
                body: Any = None, raw_body: bool = False,
                headers: Optional[Dict[str, str]] = None) -> Evidence:
        url = self.resolve(path_or_url)
        request_headers = dict(headers or {})
        request_body = self._serialize(body, raw_body, request_headers)
        chain: List[str] = []
        started = time.monotonic()
        try:
            self._check_scope(url)
        except ScopeViolation as exc:
            return self._blocked_evidence(method, url, request_headers,
                                          request_body, str(exc), chain, started)

        current = url
        for _ in range(self.max_redirects + 1):
            self.budget.acquire()  # 跳转产生的每次请求同样占预算
            ev = self._single_request(method if not chain else "GET",
                                      current, request_body if not chain else None,
                                      request_headers if not chain else {},
                                      chain, started)
            if ev.status is None or not (300 <= ev.status < 400):
                ev.redirected = bool(chain)
                ev.redirect_chain = chain
                return ev
            location = ev.response_headers.get("Location") or \
                ev.response_headers.get("location")
            if not location:
                ev.redirected = bool(chain)
                ev.redirect_chain = chain
                return ev
            next_url = urljoin(current, location)
            chain.append(next_url)
            try:
                self._check_scope(next_url)
            except ScopeViolation as exc:
                return self._blocked_evidence(method, url, request_headers,
                                              request_body,
                                              f"跳转目标超出允许范围: {exc}",
                                              chain, started)
            current = next_url
        # 跳转次数耗尽：作为传输异常记录，不静默放过
        return Evidence(
            method=method, url=url, request_headers=request_headers,
            request_body=request_body, status=None, response_headers={},
            response_body=None,
            error=f"超过最大跳转次数 {self.max_redirects}",
            elapsed_ms=int((time.monotonic() - started) * 1000),
            redirected=True, redirect_chain=chain,
        )

    # ---------- 内部实现 ----------

    @staticmethod
    def _serialize(body: Any, raw_body: bool,
                   headers: Dict[str, str]) -> Optional[str]:
        if body is None:
            return None
        if raw_body:
            return body if isinstance(body, str) else json.dumps(body)
        headers.setdefault("Content-Type", "application/json")
        return json.dumps(body, ensure_ascii=False)

    def _single_request(self, method: str, url: str, body: Optional[str],
                        headers: Dict[str, str], chain: List[str],
                        started: float) -> Evidence:
        host, port, scheme = self._check_scope(url)
        parsed = urlparse(url)
        path = parsed.path or "/"
        if parsed.query:
            path = f"{path}?{parsed.query}"
        conn_cls = (http.client.HTTPSConnection if scheme == "https"
                    else http.client.HTTPConnection)
        try:
            conn = conn_cls(host, port, timeout=self.timeout)
            try:
                conn.request(method, path, body=body, headers=headers)
                resp = conn.getresponse()
                raw = resp.read(self.max_body_evidence + 1)
                truncated = len(raw) > self.max_body_evidence
                raw = raw[: self.max_body_evidence]
                resp_headers = {k: v for k, v in resp.getheaders()}
                text = raw.decode("utf-8", errors="replace")
                parsed_body = self._try_json(text)
                if truncated and isinstance(parsed_body, str):
                    parsed_body = parsed_body + "...[truncated]"
                return Evidence(
                    method=method, url=url, request_headers=dict(headers),
                    request_body=body, status=resp.status,
                    response_headers=resp_headers,
                    response_body=parsed_body, error=None,
                    elapsed_ms=int((time.monotonic() - started) * 1000),
                    redirect_chain=list(chain),
                )
            finally:
                conn.close()
        except (OSError, http.client.HTTPException) as exc:
            return Evidence(
                method=method, url=url, request_headers=dict(headers),
                request_body=body, status=None, response_headers={},
                response_body=None, error=f"{type(exc).__name__}: {exc}",
                elapsed_ms=int((time.monotonic() - started) * 1000),
                redirect_chain=list(chain),
            )

    @staticmethod
    def _try_json(text: str) -> Any:
        try:
            return json.loads(text)
        except (json.JSONDecodeError, ValueError):
            return text

    def _blocked_evidence(self, method: str, url: str,
                          request_headers: Dict[str, str], request_body: Any,
                          reason: str, chain: List[str],
                          started: float) -> Evidence:
        return Evidence(
            method=method, url=url, request_headers=request_headers,
            request_body=request_body, status=None, response_headers={},
            response_body=None, error=f"SCOPE_BLOCKED: {reason}",
            elapsed_ms=int((time.monotonic() - started) * 1000),
            redirected=bool(chain), redirect_chain=list(chain),
            scope_blocked=True,
        )
