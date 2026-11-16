"""凭据/密钥/个人信息识别与脱敏。

设计原则:
- 默认开启全部内置规则, 界面默认隐藏命中片段;
- 导出时做递归脱敏, 确保任何隐藏字段的原文都不会出现在导出物中;
- 查看原文属于显式动作, 需要记录审计 (见 server 层 reveal 接口)。
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Iterable

from .models import MaskRule, MaskSettings, new_id, utc_now
from .safety import MASK_PLACEHOLDER

# 内置规则 (顺序即扫描优先级)
BUILTIN_RULES: list[MaskRule] = [
    MaskRule(
        id="mask_password", builtin=True, enabled=True,
        name="密码/口令赋值",
        description="password/passwd/pwd/secret 等键后的赋值 (兼容 JSON 引号与中文口令)",
        pattern=r"(?i)(?P<k>(?:password|passwd|pwd|secret|passphrase)"
                r"\s*[\"']?\s*[:=]\s*[\"']?)(?P<v>[^\s,;&\"']+)",
    ),
    MaskRule(
        id="mask_password_cn", builtin=True, enabled=True,
        name="中文口令/密码描述",
        description="中文「口令/密码」后紧跟的敏感值, 如 口令 Abc123!",
        pattern=r"(?P<k>(?:口令|密码|密钥|通行证)\s*[:：]?\s+)"
                r"(?P<v>[A-Za-z0-9!@#$%^&*_.\-]{4,})",
    ),
    MaskRule(
        id="mask_bearer", builtin=True, enabled=True,
        name="Bearer 令牌",
        description="Authorization: Bearer <token>",
        pattern=r"(?i)(?P<k>Bearer\s+)(?P<v>[A-Za-z0-9._\-]+)",
    ),
    MaskRule(
        id="mask_basic_auth", builtin=True, enabled=True,
        name="HTTP Basic 凭据",
        description="Authorization: Basic <base64>",
        pattern=r"(?i)(?P<k>Basic\s+)(?P<v>[A-Za-z0-9+/=]+)",
    ),
    MaskRule(
        id="mask_aws_key", builtin=True, enabled=True,
        name="AWS Access Key",
        pattern=r"(?P<v>AKIA[0-9A-Z]{16})",
    ),
    MaskRule(
        id="mask_jwt", builtin=True, enabled=True,
        name="JWT 令牌",
        pattern=r"(?P<v>eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+)",
    ),
    MaskRule(
        id="mask_private_key", builtin=True, enabled=True,
        name="PEM 私钥块",
        pattern=r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----",
    ),
    MaskRule(
        id="mask_generic_secret", builtin=True, enabled=True,
        name="通用 secret/token/api_key 赋值",
        pattern=r"(?i)(?P<k>(?:api[_-]?key|access[_-]?key|secret[_-]?key|"
                r"auth[_-]?token|access[_-]?token|token)"
                r"\s*[\"']?\s*[:=]\s*[\"']?)(?P<v>[A-Za-z0-9._\-]+)",
    ),
    MaskRule(
        id="mask_secret_header", builtin=True, enabled=True,
        name="X-Api-Key/X-Token 等敏感 HTTP 头",
        description="整行头部 (含头名) 一起脱敏, 避免残留前缀被再次识别",
        pattern=r"(?im)^[ \t]*(?P<k>X-[A-Za-z-]*(?:Key|Token|Secret|Auth)[A-Za-z-]*"
                r"|Api-Key)\s*:\s*(?P<v>[^\r\n]+)",
    ),
    MaskRule(
        id="mask_id_card", builtin=True, enabled=True,
        name="身份证号",
        pattern=r"(?P<v>\b\d{17}[\dXx]\b)",
    ),
    MaskRule(
        id="mask_phone_cn", builtin=True, enabled=True,
        name="中国大陆手机号",
        pattern=r"(?P<v>\b1[3-9]\d{9}\b)",
    ),
    MaskRule(
        id="mask_email", builtin=True, enabled=True,
        name="电子邮箱",
        pattern=r"(?P<v>\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b)",
    ),
]


def default_settings() -> MaskSettings:
    return MaskSettings(rules=[MaskRule(**r.to_dict()) for r in BUILTIN_RULES],
                        hide_by_default=True)


@dataclass
class Hit:
    rule_id: str
    rule_name: str
    matched: str
    line_no: int
    start: int
    end: int


def _compiled_rules(settings: MaskSettings) -> list[tuple[MaskRule, re.Pattern[str]]]:
    out: list[tuple[MaskRule, re.Pattern[str]]] = []
    for rule in settings.rules:
        if not rule.enabled:
            continue
        try:
            out.append((rule, re.compile(rule.pattern, re.DOTALL)))
        except re.error:
            # 用户自定义了非法正则: 跳过而不是让整个脱敏失效
            continue
    return out


def scan_text(text: str, settings: MaskSettings) -> list[Hit]:
    """扫描一段文本, 返回全部命中 (不去重, 保留行号与位置)。"""
    hits: list[Hit] = []
    if not text:
        return hits
    line_starts = [0]
    for m in re.finditer(r"\n", text):
        line_starts.append(m.end())

    def line_of(pos: int) -> int:
        import bisect
        return bisect.bisect_right(line_starts, pos)

    occupied: list[tuple[int, int]] = []
    for rule, pattern in _compiled_rules(settings):
        for m in pattern.finditer(text):
            start, end = m.span()
            # 不同规则命中重叠区间时, 先命中的 (规则顺序优先) 胜出
            if any(not (end <= s or start >= e) for s, e in occupied):
                continue
            occupied.append((start, end))
            value = m.groupdict().get("v", m.group(0))
            hits.append(Hit(
                rule_id=rule.id, rule_name=rule.name,
                matched=value, line_no=line_of(start),
                start=start, end=end,
            ))
    hits.sort(key=lambda h: h.start)
    return hits


def redact_text(text: str, settings: MaskSettings) -> str:
    """对文本做原地替换, 命中片段整体替换为占位符。"""
    if not text:
        return text
    hits = scan_text(text, settings)
    if not hits:
        return text
    out: list[str] = []
    cursor = 0
    for hit in hits:
        out.append(text[cursor:hit.start])
        out.append(MASK_PLACEHOLDER)
        cursor = hit.end
    out.append(text[cursor:])
    return "".join(out)


def redact_obj(obj: Any, settings: MaskSettings) -> Any:
    """递归脱敏任意 JSON 兼容对象 (dict/list/str/...)。"""
    if isinstance(obj, str):
        return redact_text(obj, settings)
    if isinstance(obj, dict):
        return {k: redact_obj(v, settings) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [redact_obj(v, settings) for v in obj]
    return obj


# 结构化字段脱敏: 这些键名对应的值无论形态都整体占位
_SENSITIVE_KEY_NAMES = {
    "password", "passwd", "pwd", "secret", "passphrase",
    "api_key", "apikey", "api-key", "access_key", "accesskey",
    "secret_key", "secretkey", "auth_token", "authtoken",
    "access_token", "accesstoken", "token", "authorization",
    "set-cookie", "cookie",
}
_SENSITIVE_HEADER_NAMES = {
    "authorization", "x-api-key", "api-key", "x-auth-token",
    "x-access-token", "x-secret-key", "proxy-authorization",
    "set-cookie", "cookie",
}
# 身份证/手机/邮箱等 PII 即使在结构值里也按正则处理
_PII_PATTERNS = [
    re.compile(r"\b\d{17}[\dXx]\b"),
    re.compile(r"\b1[3-9]\d{9}\b"),
    re.compile(r"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b"),
    re.compile(r"AKIA[0-9A-Z]{16}"),
    re.compile(r"eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+"),
]


def _redact_pii_in_string(value: str, settings: MaskSettings) -> str:
    out = redact_text(value, settings)
    for pat in _PII_PATTERNS:
        out = pat.sub(MASK_PLACEHOLDER, out)
    return out


def redact_structured(obj: Any, settings: MaskSettings,
                      key_name: str | None = None) -> Any:
    """带字段名上下文的递归脱敏, 覆盖解析出的 headers/JSON 树等结构。"""
    if isinstance(obj, str):
        if key_name and key_name.strip().lower() in _SENSITIVE_KEY_NAMES:
            return MASK_PLACEHOLDER
        return _redact_pii_in_string(obj, settings)
    if isinstance(obj, list):
        # HTTP 头列表元素形如 {"name": ..., "value": ...}
        if obj and all(isinstance(x, dict) and "name" in x and "value" in x
                       for x in obj):
            redacted_headers = []
            for h in obj:
                name = str(h.get("name", "")).strip().lower()
                value = h.get("value", "")
                if name in _SENSITIVE_HEADER_NAMES:
                    value = MASK_PLACEHOLDER
                else:
                    value = _redact_pii_in_string(str(value), settings)
                redacted_headers.append({**h, "value": value})
            return redacted_headers
        return [redact_structured(v, settings, key_name) for v in obj]
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            kl = str(k).strip().lower()
            if kl in _SENSITIVE_KEY_NAMES or kl in _SENSITIVE_HEADER_NAMES:
                # 敏感键 (含 header_lookup 里的头名) 的标量值整体占位
                if isinstance(v, (str, int, float, bool)) or v is None:
                    out[k] = MASK_PLACEHOLDER if v is not None else v
                    continue
            out[k] = redact_structured(v, settings, kl)
        return out
    if isinstance(obj, (int, float, bool)) or obj is None:
        return obj
    return redact_text(str(obj), settings)


def collect_pending(project_files: Iterable[Any],
                    settings: MaskSettings) -> list[dict[str, Any]]:
    """汇总导出前需要确认的待脱敏项 (按规则 + 文件聚合)。"""
    summary: dict[tuple[str, str, str], dict[str, Any]] = {}
    for f in project_files:
        if f.text is None:
            continue
        for hit in scan_text(f.text, settings):
            key = (hit.rule_id, hit.rule_name, hit.matched)
            entry = summary.get(key)
            if entry is None:
                entry = {
                    "rule_id": hit.rule_id,
                    "rule_name": hit.rule_name,
                    "sample": hit.matched,
                    "count": 0,
                    "files": [],
                }
                summary[key] = entry
            entry["count"] += 1
            if f.rel_path not in entry["files"]:
                entry["files"].append(f.rel_path)
    return sorted(summary.values(), key=lambda e: (e["rule_id"], e["sample"]))


def validate_rule_pattern(pattern: str) -> str | None:
    """校验自定义正则, 返回错误信息或 None。"""
    try:
        re.compile(pattern)
    except re.error as exc:
        return f"正则无效: {exc}"
    return None


def add_custom_rule(settings: MaskSettings, name: str, pattern: str,
                    description: str = "") -> MaskRule:
    err = validate_rule_pattern(pattern)
    if err:
        raise ValueError(err)
    rule = MaskRule(id=new_id("mask"), name=name or "自定义规则",
                    pattern=pattern, enabled=True, builtin=False,
                    description=description)
    settings.rules.append(rule)
    return rule


def audit_reveal(settings: MaskSettings, file_id: str, reason: str) -> None:
    settings.reveal_audit.append({
        "time": utc_now(), "file_id": file_id,
        "action": "reveal_masked_text", "reason": reason or "(未填写)",
    })
