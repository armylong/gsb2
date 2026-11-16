"""跨证据字段关联: 时间、地址、编号等实体在请求/响应/日志间串联。

只做正则提取与分组统计, 不做任何推断性执行。
"""

from __future__ import annotations

import re
from collections import defaultdict

from .models import CorrelationGroup, EvidenceFile, new_id

# 实体提取规则 (value 为清洗后的展示值)
_IP_RE = re.compile(r"\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}"
                    r"(?:25[0-5]|2[0-4]\d|1?\d?\d)\b")
_URL_RE = re.compile(r"\bhttps?://[^\s'\"<>\)\]]+", re.IGNORECASE)
_TS_RE = re.compile(
    r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?"
    r"|\d{2}/[A-Za-z]{3}/\d{4}:\d{2}:\d{2}:\d{2}"
)
# 常见请求/追踪编号: 语义键 (HTTP 头或 key=value) 后的编号值
_ID_PAIR_RE = re.compile(
    r"(?i)\b(?:X-Request-ID|X-Correlation-ID|X-Trace-Id|Trace-Id|Request-Id|"
    r"trace[_-]?id|request[_-]?id|incident[_-]?id|ticket[_-]?id)\s*[:=]\s*"
    r"([A-Za-z0-9._\-]{4,})"
)
_CVE_RE = re.compile(r"\bCVE-\d{4}-\d{4,7}\b", re.IGNORECASE)


def _entities_for_file(f: EvidenceFile) -> list[tuple[str, str]]:
    """返回 (entity_type, value) 列表, 允许重复 (重复用于计数)。"""
    if f.text is None:
        return []
    text = f.text
    out: list[tuple[str, str]] = []
    out.extend(("ip", m.group(0)) for m in _IP_RE.finditer(text))
    out.extend(("url", m.group(0).rstrip(".,;")) for m in _URL_RE.finditer(text))
    out.extend(("timestamp", m.group(0)) for m in _TS_RE.finditer(text))
    for m in _ID_PAIR_RE.finditer(text):
        out.append(("id", m.group(1)))
    for m in _CVE_RE.finditer(text):
        out.append(("id", m.group(0).upper()))
    return out


def build_correlations(files: list[EvidenceFile]) -> list[CorrelationGroup]:
    """根据当前全部证据重建关联组。

    - 同一实体在同一文件出现多次时累计次数;
    - 只保留出现在 >=2 个文件、或同类型实体跨 >=2 个文件的组;
    - 单文件内重复出现仍计入 occurrences, 方便发现重复证据。
    """
    buckets: dict[tuple[str, str], dict[str, int]] = defaultdict(
        lambda: defaultdict(int))
    for f in files:
        seen_per_file: dict[tuple[str, str], int] = defaultdict(int)
        for entity_type, value in _entities_for_file(f):
            seen_per_file[(entity_type, value)] += 1
        for (entity_type, value), count in seen_per_file.items():
            buckets[(entity_type, value)][f.id] += count

    groups: list[CorrelationGroup] = []
    for (entity_type, value), file_counts in buckets.items():
        if len(file_counts) < 2:
            continue
        groups.append(CorrelationGroup(
            id=new_id("corr"),
            entity_type=entity_type,
            value=value,
            file_ids=sorted(file_counts.keys()),
            occurrences=dict(sorted(file_counts.items())),
        ))
    # 跨文件数多、时间/编号优先的排序, 便于界面展示
    type_order = {"id": 0, "timestamp": 1, "ip": 2, "url": 3}
    groups.sort(key=lambda g: (-len(g.file_ids),
                               type_order.get(g.entity_type, 9),
                               g.entity_type, g.value))
    return groups


def rebuild(project) -> None:
    """就地重建工程的关联组。"""
    project.correlations = build_correlations(project.files)
