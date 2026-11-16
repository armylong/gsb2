"""报告生成（JSON + Markdown），凭据字段默认遮盖。"""
from __future__ import annotations

import datetime
import json
import os
from collections import Counter
from typing import Any, Dict, List

from .config import Config
from .engine import RunResult
from .masking import mask_raw_text, mask_value
from .models import CaseResult


def _mask_body(body: Any, secret_fields: List[str]) -> Any:
    """结构化 body 递归遮盖；原始报文（字符串）按模式遮盖。"""
    if isinstance(body, str):
        return mask_raw_text(body, secret_fields)
    return mask_value(body, secret_fields)


def _masked_evidence(result: CaseResult, secret_fields: List[str]) -> Dict[str, Any]:
    ev = result.evidence.to_dict()
    ev["request_headers"] = mask_value(ev["request_headers"], secret_fields)
    ev["request_body"] = _mask_body(ev["request_body"], secret_fields)
    ev["response_body"] = mask_value(ev["response_body"], secret_fields)
    return ev


def _case_dict(result: CaseResult, secret_fields: List[str],
               full_evidence: bool) -> Dict[str, Any]:
    case = result.case
    out = {
        "case_id": case.case_id,
        "endpoint": case.endpoint,
        "rule": case.rule,
        "path": case.path,
        "raw_body": case.raw_body,
        "body": _mask_body(case.body, secret_fields),
        "url_params": mask_value(case.url_params, secret_fields),
        "headers": mask_value(case.headers, secret_fields),
        "verdict": result.verdict,
        "status": result.evidence.status,
        "fingerprint": result.fingerprint,
        "precondition_ok": result.precondition_ok,
        "note": result.note,
    }
    if full_evidence:
        out["evidence"] = _masked_evidence(result, secret_fields)
        if result.postcondition:
            out["postcondition"] = mask_value(
                result.postcondition, secret_fields)
        if result.reduction:
            out["reduction"] = mask_value(result.reduction, secret_fields)
    return out


def build_report(run: RunResult) -> Dict[str, Any]:
    cfg: Config = run.config
    secret = cfg.secret_fields
    verdict_counter = Counter(r.verdict for r in run.results)

    groups = []
    for idx, (fp, members) in enumerate(run.groups.items(), start=1):
        rep = members[0]
        group = {
            "group_id": f"G{idx:03d}",
            "fingerprint": fp,
            "endpoint": rep.case.endpoint,
            "verdict": rep.verdict,
            "status": rep.evidence.status,
            "member_count": len(members),
            "rules": sorted({m.case.rule for m in members}),
            "paths": sorted({m.case.path for m in members}),
            "representative": _case_dict(rep, secret, full_evidence=True),
            "members": [_case_dict(m, secret, full_evidence=False) for m in members],
        }
        if fp in run.reductions:
            reduction = run.reductions[fp]
            group["reduction"] = mask_value(reduction, secret)
        groups.append(group)

    return {
        "schema_version": 1,
        "tool": "apifuzz",
        "tool_version": __import__("apifuzz", fromlist=["__version__"]).__version__,
        "generated_at": datetime.datetime.now().isoformat(timespec="seconds"),
        "seed": cfg.seed,
        "determinism": {
            "rng": "random.Random(f'{seed}:{endpoint_name}')",
            "note": "相同配置与 seed 下生成的用例集合与顺序一致，可重复实验",
        },
        "config": _safe_config(cfg),
        "input_generation": {
            "rules_per_endpoint": run.rule_inventory,
            "rule_descriptions": _RULE_DESCRIPTIONS,
            "case_count": len(run.results),
        },
        "limits_usage": {
            "max_requests": cfg.max_requests,
            "requests_used": run.requests_used,
            "max_concurrency": cfg.max_concurrency,
            "max_runtime_seconds": cfg.max_runtime_seconds,
            "elapsed_seconds": round(run.elapsed_seconds, 3),
            "stopped_reason": run.stopped_reason,
            "abort_endpoint": run.abort_endpoint,
        },
        "scope_probes": run.scope_probe_results,
        "summary": {
            "total": len(run.results),
            "by_verdict": dict(sorted(verdict_counter.items())),
            "anomaly_count": sum(1 for r in run.results if r.is_anomaly()),
            "group_count": len(groups),
        },
        "groups": groups,
        "all_cases": [_case_dict(r, secret, full_evidence=False)
                      for r in sorted(run.results,
                                      key=lambda r: r.case.case_id)],
        "events": run.events,
        "masking": {
            "secret_fields": secret,
            "default_hint_match": ("名称含 password/token/secret/authorization 等"
                                   "的字段自动遮盖"),
        },
    }


_RULE_DESCRIPTIONS = {
    "baseline": "正常样本基线请求",
    "missing": "逐层删除叶子字段，覆盖字段缺失",
    "type": "标量/容器/null 等类型互换，覆盖类型变化",
    "boundary": "空串、超长串、数值极值等边界长度与极值",
    "nested": "深层嵌套、dict/list 互换、嵌套数组等嵌套结构变异",
    "unknown": "注入未声明字段（含 is_admin 等越权嫌疑字段）",
    "constraint": "按接口声明破坏字段间约束（all_or_none/equals/value_dependency）",
    "malformed": "畸形 JSON 报文（截断、多余括号、尾随逗号、非法文本）",
}


def _safe_config(cfg: Config) -> Dict[str, Any]:
    """报告内嵌配置（供重放使用），敏感头先遮盖。"""
    return {
        "base_url": cfg.base_url,
        "allowed_hosts": cfg.allowed_hosts,
        "allowed_ports": cfg.allowed_ports,
        "seed": cfg.seed,
        "limits": {
            "max_requests": cfg.max_requests,
            "max_concurrency": cfg.max_concurrency,
            "timeout_seconds": cfg.timeout_seconds,
            "max_runtime_seconds": cfg.max_runtime_seconds,
            "max_redirects": cfg.max_redirects,
        },
        "secret_fields": cfg.secret_fields,
        "endpoints": [
            {
                "name": ep.name,
                "method": ep.method,
                "path": ep.path,
                "stateful": ep.stateful,
                "rules": ep.rules,
                "headers": mask_value(ep.headers, cfg.secret_fields),
                "setup": [_step_dict(s) for s in ep.setup],
                "cleanup": [_step_dict(s) for s in ep.cleanup],
            }
            for ep in cfg.endpoints
        ],
    }


def _step_dict(step) -> Dict[str, Any]:
    return {
        "name": step.name, "method": step.method, "path": step.path,
        "body": step.body, "headers": step.headers, "save": step.save,
    }


def write_report(report: Dict[str, Any], outdir: str) -> Dict[str, str]:
    os.makedirs(outdir, exist_ok=True)
    stamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    json_path = os.path.join(outdir, f"fuzz_report_{stamp}.json")
    md_path = os.path.join(outdir, f"fuzz_report_{stamp}.md")
    with open(json_path, "w", encoding="utf-8") as fh:
        json.dump(report, fh, ensure_ascii=False, indent=2)
    with open(md_path, "w", encoding="utf-8") as fh:
        fh.write(render_markdown(report))
    return {"json": json_path, "markdown": md_path}


def render_markdown(report: Dict[str, Any]) -> str:
    lines: List[str] = []
    lines.append(f"# 接口模糊测试报告（seed={report['seed']}）")
    lines.append("")
    lines.append(f"- 生成时间: {report['generated_at']}")
    lines.append(f"- 用例总数: {report['summary']['total']}，"
                 f"异常: {report['summary']['anomaly_count']}，"
                 f"失败分组: {report['summary']['group_count']}")
    lines.append(f"- 判定分布: {report['summary']['by_verdict']}")
    usage = report["limits_usage"]
    lines.append(f"- 请求数: {usage['requests_used']}/{usage['max_requests']}，"
                 f"耗时: {usage['elapsed_seconds']}s/"
                 f"{usage['max_runtime_seconds']}s，"
                 f"并发上限: {usage['max_concurrency']}")
    if usage["stopped_reason"]:
        lines.append(f"- 提前停止: {usage['stopped_reason']}")
    lines.append("")
    lines.append("## 输入生成规则")
    for ep_name, rules in report["input_generation"]["rules_per_endpoint"].items():
        lines.append(f"- `{ep_name}`: {', '.join(rules)}")
    lines.append("")

    for group in report["groups"]:
        lines.append(f"## {group['group_id']} [{group['verdict']}] "
                     f"{group['endpoint']} (fp={group['fingerprint']})")
        lines.append("")
        lines.append(f"- 成员数: {group['member_count']}，"
                     f"涉及规则: {', '.join(group['rules'])}，"
                     f"涉及字段: {', '.join(group['paths'])}")
        rep = group["representative"]
        lines.append("- 代表请求:")
        lines.append("```json")
        lines.append(json.dumps(rep["body"], ensure_ascii=False, indent=2)[:2000])
        lines.append("```")
        ev = rep["evidence"]
        lines.append(f"- 代表响应: status={ev['status']} "
                     f"error={ev.get('error')}")
        lines.append("```json")
        lines.append(json.dumps(ev["response_body"], ensure_ascii=False,
                                indent=2)[:2000])
        lines.append("```")
        if "reduction" in group:
            red = group["reduction"]
            lines.append(f"- 缩减: 尝试 {red['trials_total']} 次"
                         f"（接受 {red['trials_accepted']} / "
                         f"拒绝 {red['trials_rejected']} / "
                         f"无法判断 {red['trials_inconclusive']}），"
                         f"最终仍复现: {red['reproduced']}")
            lines.append("- 缩减后样本:")
            lines.append("```json")
            lines.append(json.dumps(red["after"]["body"], ensure_ascii=False,
                                    indent=2)[:2000])
            lines.append("```")
        lines.append("")
    lines.append("## 访问范围探测（全部应在发出范围外请求前被拦截）")
    if report.get("scope_probes"):
        for probe in report["scope_probes"]:
            status = "已拦截" if probe["scope_blocked"] else "未拦截(异常)"
            lines.append(f"- {status} `{probe['name']}` -> {probe['url']}"
                         + (f"；原因: {probe['error']}" if probe["error"] else ""))
    else:
        lines.append("- 未配置 scope_probes")
    lines.append("")
    lines.append("## 事件日志")
    for event in report["events"]:
        lines.append(f"- +{event['t_ms']}ms [{event['level']}] {event['message']}")
    lines.append("")
    lines.append("> 凭据字段已按配置与默认规则遮盖。")
    return "\n".join(lines)
