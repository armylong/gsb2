"""凭据 / 敏感字段遮盖。

报告与终端输出统一经过 :func:`mask_value` 处理，原始凭据只保留在内存的
实际请求里，不写入报告文件。原始报文（字符串形式的 JSON/HTTP 头）走
:func:`mask_raw_text`，用模式匹配遮盖键值，避免畸形结构绕过遮盖。
"""
from __future__ import annotations

import re
from typing import Any, Iterable

MASK = "***MASKED***"

# 名称命中这些片段（大小写不敏感）的字段一律遮盖。
DEFAULT_SECRET_HINTS = (
    "password", "passwd", "pwd", "secret", "token", "authorization",
    "apikey", "api_key", "credential", "private_key",
)

# "password": "xxx" / password=xxx / Authorization: xxx 三类原始文本模式
_RAW_JSON_PAIR = re.compile(
    r"(?P<key>[\"']?[A-Za-z0-9_.]*(?:password|passwd|pwd|secret|token|apikey|"
    r"api_key|credential|private_key)[A-Za-z0-9_.]*[\"']?\s*[:=]\s*)"
    r"(?P<q>[\"'])(?:\\.|(?!(?P=q)).)*(?P=q)",
    re.IGNORECASE,
)
_RAW_HEADER = re.compile(
    r"(?P<key>Authorization\s*:\s*)(?P<val>[^\r\n,]+)", re.IGNORECASE)


def _is_secret(name: str, extra_hints: Iterable[str] = ()) -> bool:
    low = name.lower()
    return any(h.lower() in low for h in (*DEFAULT_SECRET_HINTS, *extra_hints))


def mask_raw_text(text: Any, secret_fields: Iterable[str] = ()) -> Any:
    """遮盖字符串报文中的敏感键值；非字符串原样返回。"""
    if not isinstance(text, str):
        return text
    hints = tuple(secret_fields) or ("password",)

    def _json_repl(match: re.Match) -> str:
        key = match.group("key")
        if any(h.lower() in key.lower() for h in (*DEFAULT_SECRET_HINTS, *hints)):
            return f'{key}{match.group("q")}{MASK}{match.group("q")}'
        return match.group(0)

    text = _RAW_JSON_PAIR.sub(_json_repl, text)
    text = _RAW_HEADER.sub(lambda m: f"{m.group('key')}{MASK}", text)
    return text


def mask_value(value: Any, secret_fields: Iterable[str] = ()) -> Any:
    """递归遮盖敏感字段，支持 dict / list / 原始字符串 / 标量。

    字符串会原样保留结构，仅把命中字段的值替换为 :data:`MASK`。
    """
    secret_fields = tuple(secret_fields)
    return _mask(value, secret_fields, in_secret=False)


def _mask(node: Any, secret_fields: tuple, in_secret: bool) -> Any:
    if isinstance(node, dict):
        out = {}
        for k, v in node.items():
            child_secret = in_secret or (isinstance(k, str) and _is_secret(k, secret_fields))
            out[k] = MASK if child_secret and not isinstance(v, (dict, list)) else _mask(
                v, secret_fields, child_secret
            )
        return out
    if isinstance(node, list):
        return [_mask(v, secret_fields, in_secret) for v in node]
    if isinstance(node, str):
        return mask_raw_text(node, secret_fields) if in_secret else node
    return MASK if in_secret else node
