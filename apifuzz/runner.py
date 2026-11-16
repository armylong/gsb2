"""用例执行器：环境准备、前后置条件、目标请求、清理与判定。

状态类接口（``stateful=true``）每条用例独立执行 准备 -> 用例 -> 清理，
保证用例之间互不污染；无状态接口每批只做一次准备/清理。

清理失败属于硬故障：立即停止该接口剩余用例，避免在脏状态上继续测试
或把数据遗留到下一轮运行。
"""
from __future__ import annotations

import copy
import re
from typing import Any, Dict, List, Optional, Tuple

from .client import ScopedClient
from .config import Endpoint, Step
from .errors import CleanupFailure, SetupFailure
from .jsonpath import get_path, set_saved
from .models import Case, CaseResult, Evidence
from .oracle import classify, evaluate_checks

_PLACEHOLDER = re.compile(r"\{([a-zA-Z0-9_.]+)\}")


class Runner:
    def __init__(self, client: ScopedClient):
        self.client = client

    # ---------- 模板与步骤 ----------

    @staticmethod
    def _render(value: Any, ctx: Dict[str, Any]) -> Any:
        if isinstance(value, str):
            def repl(match: re.Match) -> str:
                key = match.group(1)
                exists, found = get_path(ctx, f"$.{key}")
                return str(found) if exists else match.group(0)
            return _PLACEHOLDER.sub(repl, value)
        if isinstance(value, dict):
            return {k: Runner._render(v, ctx) for k, v in value.items()}
        if isinstance(value, list):
            return [Runner._render(v, ctx) for v in value]
        return value

    def _run_step(self, step: Step, ctx: Dict[str, Any]) -> Evidence:
        path = self._render(step.path, ctx)
        body = self._render(copy.deepcopy(step.body), ctx) if step.body is not None else None
        headers = {k: str(self._render(v, ctx)) for k, v in step.headers.items()}
        ev = self.client.request(step.method, path, body=body, headers=headers)
        if ev.scope_blocked:
            raise SetupFailure(f"步骤 {step.name} 被访问范围拦截: {ev.error}")
        if step.checks:
            failures = evaluate_checks(step.checks, ev)
            if failures:
                detail = "; ".join(reason for _, reason in failures)
                raise SetupFailure(f"步骤 {step.name} 检查失败: {detail}")
        for var, jpath in step.save.items():
            exists, value = get_path(ev.response_body, jpath)
            if not exists:
                raise SetupFailure(
                    f"步骤 {step.name} 的 save 路径 {jpath} 在响应中不存在")
            set_saved(ctx, f"$.{var}", value)
        return ev

    def run_steps(self, steps: List[Step], ctx: Dict[str, Any]) -> None:
        for step in steps:
            self._run_step(step, ctx)

    def cleanup(self, ep: Endpoint, ctx: Dict[str, Any]) -> None:
        """清理；任何失败都包装为 CleanupFailure（调用方必须停止相关测试）。"""
        for step in ep.cleanup:
            try:
                self._run_step(step, ctx)
            except SetupFailure as exc:
                raise CleanupFailure(
                    f"接口 {ep.name} 清理步骤 {step.name} 失败: {exc}") from exc

    # ---------- 单条用例 ----------

    def run_case(self, ep: Endpoint, case: Case,
                 ctx: Dict[str, Any]) -> CaseResult:
        # 前置条件：对状态查询结果执行检查
        pre_ok = True
        pre_note: Optional[str] = None
        state: Optional[Dict[str, Any]] = None
        if ep.precondition and ep.state_query:
            qev = self._run_step(ep.state_query, ctx)
            state = qev.response_body if isinstance(qev.response_body, dict) else {}
            pre_failures = evaluate_checks(ep.precondition, qev, state=state)
            if pre_failures:
                pre_ok = False
                pre_note = "; ".join(r for _, r in pre_failures)

        headers = dict(ep.headers)
        headers.update(case.headers)
        headers = {k: str(self._render(v, ctx)) for k, v in headers.items()}
        url = self._render(ep.path, ctx)
        url_params = {k: self._render(v, ctx) for k, v in case.url_params.items()}
        if url_params:
            from urllib.parse import urlencode
            sep = "&" if "?" in url else "?"
            url = f"{url}{sep}{urlencode(url_params)}"

        evidence = self.client.request(
            ep.method, url, body=case.body, raw_body=case.raw_body,
            headers=headers,
        )
        verdict = classify(evidence, ep.response_contract)
        post_info: Optional[Dict[str, Any]] = None

        if verdict != "SCOPE_BLOCKED" and ep.postcondition and ep.state_query:
            qev2 = self._run_step(ep.state_query, ctx)
            new_state = qev2.response_body if isinstance(qev2.response_body, dict) else {}
            post_failures = evaluate_checks(
                ep.postcondition, evidence, state=new_state)
            post_info = {
                "failures": [
                    {"check": f"{c.type}:{c.path or c.name or ''}", "reason": r}
                    for c, r in post_failures
                ],
                "state": new_state,
            }
            if post_failures and verdict in ("OK", "REJECTED"):
                # 响应看起来正常，但数据被意外修改
                verdict = "STATE_VIOLATION"

        if not pre_ok and verdict in ("OK", "REJECTED"):
            verdict = "INDETERMINATE"

        return CaseResult(
            case=case, verdict=verdict, evidence=evidence,
            fingerprint=None, precondition_ok=pre_ok,
            postcondition=post_info, note=pre_note,
        )

    # ---------- 整个接口的生命周期 ----------

    def run_endpoint(self, ep: Endpoint, cases: List[Case],
                     on_result) -> Tuple[List[CaseResult], Optional[CleanupFailure]]:
        results: List[CaseResult] = []
        if ep.stateful:
            for case in cases:
                ctx: Dict[str, Any] = {}
                try:
                    self.run_steps(ep.setup, ctx)
                    result = self.run_case(ep, case, ctx)
                    results.append(result)
                    on_result(result)
                    self.cleanup(ep, ctx)
                except CleanupFailure as exc:
                    return results, exc
        else:
            ctx = {}
            try:
                self.run_steps(ep.setup, ctx)
                for case in cases:
                    result = self.run_case(ep, case, ctx)
                    results.append(result)
                    on_result(result)
            finally:
                if ep.cleanup:
                    try:
                        self.cleanup(ep, ctx)
                    except CleanupFailure as exc:
                        return results, exc
        return results, None
