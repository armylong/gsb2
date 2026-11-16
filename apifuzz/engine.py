"""模糊测试引擎：编排生成、执行、分组、缩减与报告。"""
from __future__ import annotations

import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from . import __version__
from .client import Budget, ScopedClient
from .config import Config
from .errors import BudgetExhausted, CleanupFailure, ScopeViolation, SetupFailure
from .generator import generate_cases
from .grouping import group_results
from .models import Case, CaseResult
from .reducer import Reducer
from .runner import Runner


@dataclass
class RunResult:
    config: Config
    results: List[CaseResult]
    groups: Dict[str, List[CaseResult]]
    reductions: Dict[str, Dict[str, Any]]
    events: List[Dict[str, Any]]
    stopped_reason: Optional[str]
    requests_used: int
    elapsed_seconds: float
    rule_inventory: Dict[str, List[str]] = field(default_factory=dict)
    abort_endpoint: Optional[str] = None
    scope_probe_results: List[Dict[str, Any]] = field(default_factory=list)


def run(cfg: Config, reduce: bool = True) -> RunResult:
    started = time.monotonic()
    deadline = started + cfg.max_runtime_seconds
    budget = Budget(cfg.max_requests, deadline)
    events: List[Dict[str, Any]] = []

    def log(level: str, message: str) -> None:
        events.append({"t_ms": int((time.monotonic() - started) * 1000),
                       "level": level, "message": message})

    all_results: List[CaseResult] = []
    rule_inventory: Dict[str, List[str]] = {}
    scope_probe_results: List[Dict[str, Any]] = []
    stopped_reason: Optional[str] = None
    abort_endpoint: Optional[str] = None

    # 阶段 0：访问范围探测。这些 URL 按设计应全部被客户端拦截，
    # 拦截证据写入报告；若有任何一个真的发出去了，立即停止运行。
    probe_client = ScopedClient(
        base_url=cfg.base_url, allowed_hosts=cfg.allowed_hosts,
        allowed_ports=cfg.allowed_ports, budget=budget,
        timeout=cfg.timeout_seconds, max_redirects=cfg.max_redirects,
        max_body_evidence=cfg.max_body_evidence,
    )
    for probe in cfg.scope_probes:
        ev = probe_client.request(
            probe.get("method", "GET"), probe["url"],
            headers=probe.get("headers"))
        scope_probe_results.append({
            "name": probe.get("name", probe["url"]),
            "url": probe["url"],
            "scope_blocked": ev.scope_blocked,
            "redirected": ev.redirected,
            "redirect_chain": ev.redirect_chain,
            "error": ev.error,
        })
        if ev.scope_blocked:
            log("info", f"范围拦截生效: {probe['url']} -> {ev.error}")
        else:
            stopped_reason = (f"范围探测失败: {probe['url']} 未被拦截"
                              f"（status={ev.status}），为安全起见停止运行")
            log("error", stopped_reason)
            break
    if stopped_reason:
        return RunResult(
            config=cfg, results=all_results, groups={}, reductions={},
            events=events, stopped_reason=stopped_reason,
            requests_used=budget.used,
            elapsed_seconds=time.monotonic() - started,
            rule_inventory=rule_inventory, abort_endpoint=None,
        )

    for ep in cfg.endpoints:
        if stopped_reason:
            break
        cases = generate_cases(ep, cfg.seed)
        rule_inventory[ep.name] = sorted({c.rule for c in cases})
        log("info", f"接口 {ep.name} 生成 {len(cases)} 条用例，规则 {rule_inventory[ep.name]}")

        client = ScopedClient(
            base_url=cfg.base_url, allowed_hosts=cfg.allowed_hosts,
            allowed_ports=cfg.allowed_ports, budget=budget,
            timeout=cfg.timeout_seconds, max_redirects=cfg.max_redirects,
            max_body_evidence=cfg.max_body_evidence,
        )
        runner = Runner(client)
        lock = threading.Lock()

        def collect(result: CaseResult) -> None:
            with lock:
                all_results.append(result)

        try:
            if ep.stateful:
                # 状态接口串行：每条用例独立 setup/cleanup，避免互相污染
                results, cleanup_err = runner.run_endpoint(ep, cases, collect)
            else:
                # 无状态接口：setup/cleanup 各一次，用例并发执行
                ctx: Dict[str, Any] = {}
                runner.run_steps(ep.setup, ctx)
                results = []
                try:
                    with ThreadPoolExecutor(max_workers=cfg.max_concurrency) as pool:
                        futures = [pool.submit(runner.run_case, ep, case, ctx)
                                   for case in cases]
                        for future in futures:
                            result = future.result()
                            results.append(result)
                            collect(result)
                finally:
                    if ep.cleanup:
                        runner.cleanup(ep, ctx)
                cleanup_err = None
        except BudgetExhausted as exc:
            stopped_reason = f"预算耗尽: {exc}"
            abort_endpoint = ep.name
            log("warning", stopped_reason)
            break
        except CleanupFailure as exc:
            stopped_reason = str(exc)
            abort_endpoint = ep.name
            log("error", f"{stopped_reason} —— 已停止接口 {ep.name} 的剩余测试")
            break
        except SetupFailure as exc:
            stopped_reason = f"环境准备失败，接口 {ep.name} 无法测试: {exc}"
            abort_endpoint = ep.name
            log("error", stopped_reason)
            break
        except ScopeViolation as exc:
            stopped_reason = f"访问范围拦截: {exc}"
            abort_endpoint = ep.name
            log("error", stopped_reason)
            break
        log("info", f"接口 {ep.name} 执行完成，共 {len(results)} 条结果")

    groups = group_results(all_results)
    log("info", f"异常用例 {sum(len(v) for v in groups.values())} 条，"
                f"归并为 {len(groups)} 个失败分组")

    # 缩减：串行执行，每个分组取代表样本
    reductions: Dict[str, Dict[str, Any]] = {}
    if reduce and groups:
        reducer_client = ScopedClient(
            base_url=cfg.base_url, allowed_hosts=cfg.allowed_hosts,
            allowed_ports=cfg.allowed_ports, budget=budget,
            timeout=cfg.timeout_seconds, max_redirects=cfg.max_redirects,
            max_body_evidence=cfg.max_body_evidence,
        )
        reducer_runner = Runner(reducer_client)
        for fp, members in groups.items():
            if stopped_reason:
                log("warning", f"分组 {fp} 因运行已停止而跳过缩减")
                break
            representative = members[0]
            ep = cfg.endpoint(representative.case.endpoint)

            def trial(case: Case) -> CaseResult:
                trial_ctx: Dict[str, Any] = {}
                reducer_runner.run_steps(ep.setup, trial_ctx)
                try:
                    return reducer_runner.run_case(ep, case, trial_ctx)
                finally:
                    reducer_runner.cleanup(ep, trial_ctx)

            try:
                reductions[fp] = Reducer(trial).reduce(ep, representative)
                log("info", f"分组 {fp} 缩减完成: "
                            f"接受 {reductions[fp]['trials_accepted']} 次，"
                            f"拒绝 {reductions[fp]['trials_rejected']} 次，"
                            f"无法判断 {reductions[fp]['trials_inconclusive']} 次")
            except BudgetExhausted as exc:
                stopped_reason = f"缩减阶段预算耗尽: {exc}"
                log("warning", stopped_reason)
                break
            except (CleanupFailure, SetupFailure) as exc:
                stopped_reason = f"缩减阶段环境步骤失败: {exc}"
                log("error", stopped_reason)
                break

    return RunResult(
        config=cfg, results=all_results, groups=groups,
        reductions=reductions, events=events, stopped_reason=stopped_reason,
        requests_used=budget.used,
        elapsed_seconds=time.monotonic() - started,
        rule_inventory=rule_inventory, abort_endpoint=abort_endpoint,
        scope_probe_results=scope_probe_results,
    )
