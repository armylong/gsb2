"""失败重放。

使用报告中记录的环境准备步骤（setup）、清理步骤和原始请求重新执行，
并与原始指纹对比，输出三种明确结论：

- REPRODUCED    仍可复现：重放得到同一指纹的同类失败
- NOT_REPRODUCED 未复现：请求正常完成（OK/REJECTED），或指纹不同但确有响应
- UNKNOWN       无法判断：传输异常/超时/前置条件不满足/访问范围被拦截/
                  环境准备或清理失败
"""
from __future__ import annotations

import copy
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from .client import Budget, ScopedClient
from .config import Config, Endpoint
from .errors import CleanupFailure, FuzzError
from .grouping import fingerprint
from .models import Case, CaseResult
from .runner import Runner
from .verdict import ANOMALY_VERDICTS

REPLAY_REPRODUCED = "REPRODUCED"
REPLAY_NOT_REPRODUCED = "NOT_REPRODUCED"
REPLAY_UNKNOWN = "UNKNOWN"


@dataclass
class ReplayOutcome:
    group_id: str
    endpoint: str
    verdict: str
    original_fingerprint: str
    replay_fingerprint: Optional[str]
    reason: str
    evidence: Dict[str, Any]
    setup_evidence: List[Dict[str, Any]]


def build_case_from_record(record: Dict[str, Any], endpoint: str) -> Case:
    return Case(
        case_id=record.get("case_id", "replay"),
        endpoint=endpoint,
        rule=record.get("rule", "replay"),
        path=record.get("path", "$"),
        body=record.get("body"),
        raw_body=record.get("raw_body", False),
        url_params=dict(record.get("url_params", {})),
        headers=dict(record.get("headers", {})),
        expectations=dict(record.get("expectations", {})),
    )


def replay_group(cfg: Config, report: Dict[str, Any], group_id: str,
                 override_base_url: Optional[str] = None) -> ReplayOutcome:
    group = _find_group(report, group_id)
    ep_name = group["endpoint"]
    ep = cfg.endpoint(ep_name)
    record = group["representative"]
    original_fp = group["fingerprint"]
    case = build_case_from_record(record, ep_name)

    base_url = override_base_url or cfg.base_url
    budget = Budget(cfg.max_requests, deadline=float("inf"))
    client = ScopedClient(
        base_url=base_url, allowed_hosts=cfg.allowed_hosts,
        allowed_ports=cfg.allowed_ports, budget=budget,
        timeout=cfg.timeout_seconds, max_redirects=cfg.max_redirects,
        max_body_evidence=cfg.max_body_evidence,
    )
    runner = Runner(client)
    ctx: Dict[str, Any] = {}
    setup_evidence: List[Dict[str, Any]] = []

    try:
        for step in ep.setup:
            setup_evidence.append(runner._run_step(step, ctx).to_dict())
        result = runner.run_case(ep, case, ctx)
    except FuzzError as exc:
        return ReplayOutcome(
            group_id, ep_name, REPLAY_UNKNOWN, original_fp, None,
            f"环境准备失败，无法判断: {exc}", {}, setup_evidence)
    finally:
        try:
            runner.cleanup(ep, ctx)
        except CleanupFailure as exc:
            return ReplayOutcome(
                group_id, ep_name, REPLAY_UNKNOWN, original_fp, None,
                f"清理失败，无法判断: {exc}", {}, setup_evidence)

    replay_fp = result.fingerprint or fingerprint(result)
    if result.verdict in ("TRANSPORT_ERROR", "INDETERMINATE", "SCOPE_BLOCKED"):
        verdict = REPLAY_UNKNOWN
        reason = f"{result.verdict}: {result.evidence.error or '前置条件不满足'}"
    elif replay_fp == original_fp and result.verdict in ANOMALY_VERDICTS:
        verdict = REPLAY_REPRODUCED
        reason = f"复现同类失败 {result.verdict}，指纹一致"
    else:
        verdict = REPLAY_NOT_REPRODUCED
        if result.verdict in ANOMALY_VERDICTS:
            reason = (f"仍有异常 {result.verdict} 但指纹变化"
                      f"（{original_fp} -> {replay_fp}），原始问题未复现")
        else:
            reason = f"服务正常处理（{result.verdict}），原始问题未复现"

    return ReplayOutcome(
        group_id, ep_name, verdict, original_fp, replay_fp, reason,
        result.evidence.to_dict(), setup_evidence,
    )


def replay_all(cfg: Config, report: Dict[str, Any],
               override_base_url: Optional[str] = None) -> List[ReplayOutcome]:
    return [replay_group(cfg, report, g["group_id"], override_base_url)
            for g in report.get("groups", [])]


def _find_group(report: Dict[str, Any], group_id: str) -> Dict[str, Any]:
    for group in report.get("groups", []):
        if group["group_id"] == group_id:
            return group
    raise FuzzError(f"报告中不存在分组 {group_id}")
