"""失败分组与指纹。

不能只按响应状态判断两次失败相同——两个不同输入都打出 500，根因可能完全
不同。指纹综合以下维度：

- endpoint 与 verdict（接口/判定不同天然不同组）
- 传输异常：异常类型名
- 服务异常 / 契约违反：响应结构骨架 + 错误消息归一化
- 触发路径（输入中被修改的字段路径），防止不同字段的问题被并组
"""
from __future__ import annotations

import hashlib
import re
from collections import defaultdict
from typing import Any, Dict, List, Optional, Tuple

from .models import CaseResult

_NUM = re.compile(r"-?\d+")
_HEX = re.compile(r"0x[0-9a-fA-F]+|\\b[0-9a-f]{8,}\\b")
_QUOTED = re.compile(r"\"[^\"]*\"|'[^']*'")


def normalize_text(text: str) -> str:
    """把错误消息中的数字、十六进制指针、引号内容归一化，只保留结构。"""
    text = _HEX.sub("<hex>", text)
    text = _NUM.sub("<n>", text)
    text = _QUOTED.sub("<str>", text)
    return text[:200]


def skeleton(obj: Any, depth: int = 0) -> Any:
    """提取 JSON 结构骨架：保留 key 与值类型，抹掉具体标量值。"""
    if depth > 6:
        return "<maxdepth>"
    if isinstance(obj, dict):
        return {k: skeleton(v, depth + 1) for k, v in sorted(obj.items())}
    if isinstance(obj, list):
        if not obj:
            return []
        # 同类元素只保留第一个的骨架，避免数组长度影响分组
        return [skeleton(obj[0], depth + 1)]
    return type(obj).__name__


def _error_family(evidence) -> Tuple[str, str]:
    if evidence.error:
        family = evidence.error.split(":", 1)[0]
        return family, normalize_text(evidence.error)
    return "", ""


def fingerprint(result: CaseResult) -> str:
    ev = result.evidence
    parts = [result.case.endpoint, result.verdict]
    if result.verdict == "TRANSPORT_ERROR":
        family, _msg = _error_family(ev)
        parts += ["transport", family or "unknown"]
    else:
        family, msg = _error_family(ev)
        parts.append(family)
        parts.append(str(ev.status))
        parts.append(repr(skeleton(ev.response_body)))
        if isinstance(ev.response_body, dict):
            for key in ("error", "message", "detail", "error_message"):
                if key in ev.response_body and isinstance(ev.response_body[key], str):
                    parts.append(normalize_text(ev.response_body[key]))
        elif isinstance(ev.response_body, str):
            parts.append(normalize_text(ev.response_body)[:80])
    parts.append(result.case.rule)
    parts.append(result.case.path)
    raw = "|".join(parts)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


def group_results(results: List[CaseResult]) -> Dict[str, List[CaseResult]]:
    """把异常用例按指纹分组，并把指纹写回每个结果。"""
    groups: Dict[str, List[CaseResult]] = defaultdict(list)
    for result in results:
        if not result.is_anomaly():
            continue
        fp = fingerprint(result)
        result.fingerprint = fp
        groups[fp].append(result)
    return dict(sorted(groups.items(), key=lambda kv: kv[0]))
