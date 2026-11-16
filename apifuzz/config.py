"""配置加载与校验。

配置为 JSON（见 configs/demo.json）。加载阶段做严格校验，缺失或类型错误
直接抛 :class:`ConfigError`，避免把配置问题误判成服务问题。
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

from .errors import ConfigError

_ALLOWED_METHODS = {"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"}
_ALLOWED_CHECK_TYPES = {"status", "json_path", "header"}
_ALLOWED_RULES = {
    "missing", "type", "boundary", "nested", "unknown", "constraint", "malformed",
}


@dataclass
class Check:
    """响应契约 / 后置条件检查。

    type=status:    断言响应状态码在 expect（int 或 list）中
    type=json_path: 断言响应或状态查询 JSON 中 path 的值；
                    expect 为 "__ABSENT__" 表示该路径必须不存在
    type=header:    断言响应头 name 存在（expect 为 None）或等于 expect
    """

    type: str
    expect: Any = None
    path: Optional[str] = None
    name: Optional[str] = None

    @classmethod
    def from_dict(cls, raw: Dict[str, Any]) -> "Check":
        if not isinstance(raw, dict):
            raise ConfigError(f"check 必须是对象: {raw!r}")
        ctype = raw.get("type")
        if ctype not in _ALLOWED_CHECK_TYPES:
            raise ConfigError(f"不支持的 check 类型: {ctype!r}")
        if ctype == "json_path" and not raw.get("path"):
            raise ConfigError("json_path 检查必须提供 path")
        if ctype == "header" and not raw.get("name"):
            raise ConfigError("header 检查必须提供 name")
        return cls(type=ctype, expect=raw.get("expect"),
                   path=raw.get("path"), name=raw.get("name"))


@dataclass
class Step:
    """环境准备 / 清理 / 前后置条件中的一个 HTTP 步骤。"""

    name: str
    method: str
    path: str
    body: Any = None
    headers: Dict[str, str] = field(default_factory=dict)
    save: Dict[str, str] = field(default_factory=dict)
    checks: List[Check] = field(default_factory=list)

    @classmethod
    def from_dict(cls, raw: Dict[str, Any]) -> "Step":
        if not isinstance(raw, dict):
            raise ConfigError(f"step 必须是对象: {raw!r}")
        name = raw.get("name")
        if not name:
            raise ConfigError("step 缺少 name")
        method = str(raw.get("method", "GET")).upper()
        if method not in _ALLOWED_METHODS:
            raise ConfigError(f"step {name} 方法不合法: {method}")
        path = raw.get("path")
        if not path or not isinstance(path, str):
            raise ConfigError(f"step {name} 缺少 path")
        save = raw.get("save", {})
        if not isinstance(save, dict) or not all(isinstance(k, str) and isinstance(v, str)
                                                 for k, v in save.items()):
            raise ConfigError(f"step {name} 的 save 必须是 字符串->JSONPath 的映射")
        return cls(
            name=name, method=method, path=path,
            body=raw.get("body"), headers=dict(raw.get("headers", {})),
            save=dict(save),
            checks=[Check.from_dict(c) for c in raw.get("checks", [])],
        )


@dataclass
class Endpoint:
    name: str
    method: str
    path: str
    sample: Dict[str, Any]
    constraints: List[Dict[str, Any]] = field(default_factory=list)
    rules: List[str] = field(default_factory=list)
    response_contract: List[Check] = field(default_factory=list)
    setup: List[Step] = field(default_factory=list)
    cleanup: List[Step] = field(default_factory=list)
    precondition: List[Check] = field(default_factory=list)
    postcondition: List[Check] = field(default_factory=list)
    state_query: Optional[Step] = None
    headers: Dict[str, str] = field(default_factory=dict)
    stateful: bool = False

    @classmethod
    def from_dict(cls, raw: Dict[str, Any]) -> "Endpoint":
        if not isinstance(raw, dict):
            raise ConfigError("endpoint 必须是对象")
        name = raw.get("name")
        if not name:
            raise ConfigError("endpoint 缺少 name")
        method = str(raw.get("method", "POST")).upper()
        if method not in _ALLOWED_METHODS:
            raise ConfigError(f"endpoint {name} 方法不合法: {method}")
        path = raw.get("path")
        if not path or not isinstance(path, str):
            raise ConfigError(f"endpoint {name} 缺少 path")
        sample = raw.get("sample", {})
        if not isinstance(sample, dict):
            raise ConfigError(f"endpoint {name} 的 sample 必须是 JSON 对象")
        rules = list(raw.get("rules", sorted(_ALLOWED_RULES)))
        bad = [r for r in rules if r not in _ALLOWED_RULES]
        if bad:
            raise ConfigError(f"endpoint {name} 存在未知生成规则: {bad}")
        constraints = raw.get("constraints", [])
        if not isinstance(constraints, list):
            raise ConfigError(f"endpoint {name} 的 constraints 必须是列表")
        for c in constraints:
            _validate_constraint(name, c)
        state_query = raw.get("state_query")
        return cls(
            name=name, method=method, path=path, sample=sample,
            constraints=list(constraints), rules=rules,
            response_contract=[Check.from_dict(c)
                               for c in raw.get("response_contract", [])],
            setup=[Step.from_dict(s) for s in raw.get("setup", [])],
            cleanup=[Step.from_dict(s) for s in raw.get("cleanup", [])],
            precondition=[Check.from_dict(c)
                          for c in raw.get("precondition", [])],
            postcondition=[Check.from_dict(c)
                           for c in raw.get("postcondition", [])],
            state_query=Step.from_dict(state_query) if state_query else None,
            headers=dict(raw.get("headers", {})),
            stateful=bool(raw.get("stateful", False)),
        )


def _validate_constraint(ep_name: str, raw: Any) -> None:
    if not isinstance(raw, dict):
        raise ConfigError(f"endpoint {ep_name} 的 constraint 必须是对象")
    ctype = raw.get("type")
    if ctype not in {"all_or_none", "equals_field", "value_dependency"}:
        raise ConfigError(f"endpoint {ep_name} 未知约束类型: {ctype!r}")
    if ctype == "all_or_none":
        fields = raw.get("fields")
        if not isinstance(fields, list) or not fields or not all(isinstance(f, str) for f in fields):
            raise ConfigError(f"endpoint {ep_name} all_or_none 需要非空 fields 列表")
    elif ctype == "equals_field":
        for key in ("field", "equals"):
            if not isinstance(raw.get(key), str):
                raise ConfigError(f"endpoint {ep_name} equals_field 需要字符串 {key}")
    else:  # value_dependency
        if not isinstance(raw.get("field"), str) or "when" not in raw or "require" not in raw:
            raise ConfigError(f"endpoint {ep_name} value_dependency 需要 field/when/require")


@dataclass
class Config:
    base_url: str
    allowed_hosts: List[str]
    allowed_ports: List[int]
    endpoints: List[Endpoint]
    seed: int = 1234
    max_requests: int = 500
    max_concurrency: int = 4
    timeout_seconds: float = 5.0
    max_runtime_seconds: float = 180.0
    max_redirects: int = 3
    secret_fields: List[str] = field(default_factory=list)
    max_body_evidence: int = 8192
    scope_probes: List[Dict[str, str]] = field(default_factory=list)

    @classmethod
    def from_dict(cls, raw: Dict[str, Any]) -> "Config":
        if not isinstance(raw, dict):
            raise ConfigError("配置根节点必须是 JSON 对象")
        base_url = raw.get("base_url")
        if not base_url:
            raise ConfigError("缺少 base_url")
        parsed = urlparse(base_url)
        if parsed.scheme not in ("http", "https") or not parsed.hostname:
            raise ConfigError(f"base_url 不合法: {base_url}")
        endpoints = [Endpoint.from_dict(e) for e in raw.get("endpoints", [])]
        if not endpoints:
            raise ConfigError("至少需要配置一个 endpoint")
        names = [e.name for e in endpoints]
        if len(names) != len(set(names)):
            raise ConfigError("endpoint name 必须唯一")
        limits = raw.get("limits", {})
        if not isinstance(limits, dict):
            raise ConfigError("limits 必须是对象")
        cfg = cls(
            base_url=base_url.rstrip("/"),
            allowed_hosts=list(raw.get("allowed_hosts", [])),
            allowed_ports=[int(p) for p in raw.get("allowed_ports", [])],
            endpoints=endpoints,
            seed=int(raw.get("seed", 1234)),
            max_requests=int(limits.get("max_requests", 500)),
            max_concurrency=int(limits.get("max_concurrency", 4)),
            timeout_seconds=float(limits.get("timeout_seconds", 5.0)),
            max_runtime_seconds=float(limits.get("max_runtime_seconds", 180.0)),
            max_redirects=int(limits.get("max_redirects", 3)),
            secret_fields=list(raw.get("secret_fields", [])),
        )
        if cfg.max_concurrency < 1 or cfg.max_requests < 1:
            raise ConfigError("max_requests / max_concurrency 必须 >= 1")
        if cfg.timeout_seconds <= 0 or cfg.max_runtime_seconds <= 0:
            raise ConfigError("超时配置必须为正数")
        if not cfg.allowed_hosts:
            raise ConfigError("allowed_hosts 不能为空：工具只允许访问明确配置的主机")
        probes = raw.get("scope_probes", [])
        if not isinstance(probes, list):
            raise ConfigError("scope_probes 必须是列表")
        for probe in probes:
            if not isinstance(probe, dict) or "url" not in probe:
                raise ConfigError("scope_probes 每项必须包含 url")
        cfg.scope_probes = list(probes)
        return cfg

    def endpoint(self, name: str) -> Endpoint:
        for ep in self.endpoints:
            if ep.name == name:
                return ep
        raise ConfigError(f"配置中不存在 endpoint: {name}")


def load_config(path: str) -> Config:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            raw = json.load(fh)
    except OSError as exc:
        raise ConfigError(f"无法读取配置 {path}: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise ConfigError(f"配置不是合法 JSON: {exc}") from exc
    return Config.from_dict(raw)
