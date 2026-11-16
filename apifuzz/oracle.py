"""判定逻辑：把一次请求的证据归类为"正常拒绝"或某类异常。"""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

from .config import Check
from .jsonpath import ABSENT, get_path
from .models import Evidence


def evaluate_checks(checks: List[Check], evidence: Evidence,
                    state: Optional[Dict[str, Any]] = None
                    ) -> List[Tuple[Check, str]]:
    """执行一组检查，返回 (检查项, 失败原因) 列表；空列表表示全部通过。

    state 给定时 json_path 检查作用在状态查询结果上，否则作用在响应体上。
    """
    failures: List[Tuple[Check, str]] = []
    for check in checks:
        reason = _evaluate_one(check, evidence, state)
        if reason:
            failures.append((check, reason))
    return failures


def _evaluate_one(check: Check, evidence: Evidence,
                  state: Optional[Dict[str, Any]]) -> Optional[str]:
    if check.type == "status":
        allowed = check.expect if isinstance(check.expect, list) else [check.expect]
        if evidence.status not in allowed:
            return f"状态码 {evidence.status} 不在声明 {allowed} 中"
        return None
    if check.type == "header":
        actual = evidence.response_headers.get(check.name) \
            or evidence.response_headers.get(check.name.lower())
        if check.expect is None:
            if actual is None:
                return f"缺少响应头 {check.name}"
        elif actual != check.expect:
            return f"响应头 {check.name}={actual!r} 与声明 {check.expect!r} 不符"
        return None
    # json_path
    target = state if state is not None else evidence.response_body
    exists, actual = get_path(target, check.path)
    if check.expect == ABSENT:
        if exists:
            return f"{check.path} 应当不存在，实际值 {actual!r}"
        return None
    if not exists:
        return f"缺少路径 {check.path}"
    if check.expect is not None and actual != check.expect:
        return f"{check.path}={actual!r} 与声明 {check.expect!r} 不符"
    return None


def classify(evidence: Evidence, contract: List[Check]) -> str:
    """依据证据和响应契约给出 verdict（不含后置条件，STATE_VIOLATION 由 runner 判定）。"""
    if evidence.scope_blocked:
        return "SCOPE_BLOCKED"
    if evidence.status is None:
        return "TRANSPORT_ERROR"
    if 500 <= evidence.status < 600:
        return "SERVER_ERROR"
    failures = evaluate_checks(contract, evidence)
    if failures:
        return "CONTRACT_VIOLATION"
    if 200 <= evidence.status < 300:
        return "OK"
    if 400 <= evidence.status < 500:
        return "REJECTED"
    # 3xx 未跟随完等其他情况：契约未覆盖即视为违反声明
    return "CONTRACT_VIOLATION"
