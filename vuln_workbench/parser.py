"""结构化解析器。

所有解析函数都遵守同一约定:
- 输入是已经读入内存的字节/文本, 绝不执行其中任何内容;
- 单文件解析失败时返回 ``status=fallback`` 的 :class:`ParseResult`,
  保留原始文本供人工查看, 不向调用方抛异常。
"""

from __future__ import annotations

import json
import os
import re
from typing import Any

from .models import ParseResult, PARSE_OK, PARSE_FALLBACK, PARSE_BINARY
from .safety import is_probably_binary

# ---------------------------------------------------------------------------
# 文本解码
# ---------------------------------------------------------------------------

_BOM = "﻿"


def decode_text(data: bytes) -> tuple[str | None, str | None]:
    """尝试把字节解码成文本, 返回 (文本, 错误说明)。

    依次尝试 utf-8(严格) -> utf-8(忽略非法字节) -> latin-1。
    含 NUL 字节的视为二进制, 返回 (None, ...)。
    """
    if is_probably_binary(data):
        return None, "二进制文件 (含 NUL 字节), 未保存正文"
    try:
        return data.decode("utf-8"), None
    except UnicodeDecodeError as exc_utf8:
        try:
            text = data.decode("utf-8", errors="replace")
            return text, f"UTF-8 解码存在非法字节, 已替换显示: {exc_utf8.reason}"
        except Exception:  # pragma: no cover - 理论上 replace 不会失败
            try:
                return data.decode("latin-1"), "非 UTF-8 文本, 已按 Latin-1 解码"
            except Exception as exc:
                return None, f"文本解码失败: {exc}"


# ---------------------------------------------------------------------------
# HTTP 报文
# ---------------------------------------------------------------------------

_HEADER_LINE = re.compile(r"^[\t ]*([^:]+?)\s*:\s*(.*)$")
_HTTP_VERSION = re.compile(r"HTTP/\d\.\d")
_REQUEST_LINE = re.compile(
    r"^(?P<method>[A-Z]+)\s+(?P<target>\S+)\s+(?P<version>HTTP/\d\.\d)\s*$"
)
_STATUS_LINE = re.compile(
    r"^(?P<version>HTTP/\d\.\d)\s+(?P<status>\d{3})(?:\s+(?P<reason>.*))?$"
)
_METHODS = {"GET", "POST", "PUT", "DELETE", "PATCH", "HEAD",
            "OPTIONS", "TRACE", "CONNECT"}


def _split_head_body(text: str) -> tuple[str, str]:
    for sep in ("\r\n\r\n", "\n\n"):
        if sep in text:
            head, body = text.split(sep, 1)
            return head, body
    return text, ""


def _parse_headers(lines: list[str]) -> tuple[list[dict[str, str]], dict[str, str]]:
    ordered: list[dict[str, str]] = []
    lookup: dict[str, str] = {}
    for line in lines[1:]:
        if not line.strip():
            continue
        m = _HEADER_LINE.match(line)
        if not m:
            # 折行头 (obs-fold), 追加到上一个头
            if ordered and line[:1] in (" ", "\t"):
                ordered[-1]["value"] += " " + line.strip()
                last = ordered[-1]["name"]
                lookup[last] = ordered[-1]["value"]
            continue
        name, value = m.group(1).strip(), m.group(2).strip()
        ordered.append({"name": name, "value": value})
        lookup.setdefault(name, value)  # 重复头保留首个, 与多数审计工具一致
    return ordered, lookup


def _parse_http(text: str, expect: str) -> ParseResult:
    """expect: 'request' | 'response'。"""
    head, body = _split_head_body(text)
    lines = head.replace("\r\n", "\n").split("\n")
    if not lines or not lines[0].strip():
        return ParseResult(
            status=PARSE_FALLBACK, parser="http", language="http",
            error="缺少 HTTP 起始行",
        )
    first = lines[0].strip()
    fields: dict[str, Any] = {"headers": [], "body": body}

    if expect == "request":
        m = _REQUEST_LINE.match(first)
        if not m:
            # 兼容没有版本号的裸请求行
            parts = first.split()
            if len(parts) >= 2 and parts[0] in _METHODS:
                fields.update(method=parts[0], target=parts[1],
                              version="", path=_path_of(parts[1]))
            else:
                return ParseResult(
                    status=PARSE_FALLBACK, parser="http", language="http",
                    error=f"无法解析请求行: {first[:120]}",
                )
        else:
            target = m.group("target")
            fields.update(method=m.group("method"), target=target,
                          version=m.group("version"), path=_path_of(target))
    else:
        m = _STATUS_LINE.match(first)
        if not m or not _HTTP_VERSION.search(first):
            return ParseResult(
                status=PARSE_FALLBACK, parser="http", language="http",
                error=f"无法解析状态行: {first[:120]}",
            )
        fields.update(version=m.group("version"),
                      status_code=int(m.group("status")),
                      reason=m.group("reason") or "")

    headers, lookup = _parse_headers(lines)
    fields["headers"] = headers
    fields["header_lookup"] = lookup
    if body.strip():
        try:
            fields["body_json"] = json.loads(body)
        except (ValueError, TypeError):
            fields["body_json"] = None
    return ParseResult(status=PARSE_OK, parser="http", language="http", fields=fields)


def _path_of(target: str) -> str:
    if "://" in target:
        rest = target.split("://", 1)[1]
        return "/" + rest.split("/", 1)[1] if "/" in rest else "/"
    return target.split("?", 1)[0]


# ---------------------------------------------------------------------------
# JSON
# ---------------------------------------------------------------------------

def _parse_json(text: str) -> ParseResult:
    try:
        data = json.loads(text)
    except (ValueError, TypeError) as exc:
        return ParseResult(
            status=PARSE_FALLBACK, parser="json", language="json",
            error=f"JSON 解析失败: {exc}",
        )
    return ParseResult(
        status=PARSE_OK, parser="json", language="json",
        fields={"json_type": type(data).__name__, "data": data},
    )


# ---------------------------------------------------------------------------
# 日志
# ---------------------------------------------------------------------------

_TS_PATTERNS = [
    re.compile(r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?"),
    re.compile(r"\d{2}/[A-Za-z]{3}/\d{4}:\d{2}:\d{2}:\d{2}"),
    re.compile(r"[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}"),
]
_LEVEL_RE = re.compile(
    r"\b(TRACE|DEBUG|INFO|NOTICE|WARN(?:ING)?|ERROR|CRITICAL|FATAL|EMERG)\b"
)
_IP_RE = re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")


def _parse_log(text: str) -> ParseResult:
    lines = text.splitlines()
    entries: list[dict[str, Any]] = []
    parsed_lines = 0
    for idx, line in enumerate(lines):
        if not line.strip():
            continue
        ts = next((p.search(line).group(0) for p in _TS_PATTERNS
                   if p.search(line)), None)
        level_m = _LEVEL_RE.search(line)
        ip_m = _IP_RE.search(line)
        if ts or level_m:
            parsed_lines += 1
        entries.append({
            "line_no": idx + 1,
            "timestamp": ts,
            "level": level_m.group(1) if level_m else None,
            "ip": ip_m.group(0) if ip_m else None,
            "message": line,
        })
    fields: dict[str, Any] = {
        "line_count": len(lines),
        "parsed_lines": parsed_lines,
        "entries": entries[:5000],  # 结构化条目设上限, 原文仍完整保留
    }
    status = PARSE_OK if parsed_lines else PARSE_FALLBACK
    error = None if parsed_lines else "未识别出时间戳或日志级别, 按原始文本展示"
    return ParseResult(status=status, parser="log", language="log",
                       fields=fields, error=error)


# ---------------------------------------------------------------------------
# 配置 (ini / properties / yaml 子集 / 通用 key=value)
# ---------------------------------------------------------------------------

_SECTION_RE = re.compile(r"^\[([^\]]+)\]\s*$")
_KV_RE = re.compile(r"^\s*([\w.\-/$]+)\s*[:=]\s*(.*?)\s*$")
_YAML_KV = re.compile(r"^(\s*)([\w.\-/$]+)\s*:\s*(.*?)\s*$")


def _parse_config(text: str, filename: str) -> ParseResult:
    low = filename.lower()
    if low.endswith((".yaml", ".yml")):
        return _parse_yaml_subset(text)
    if low.endswith(".xml"):
        return _parse_xml_text(text)
    if low.endswith(".json"):
        return _parse_json(text)

    sections: dict[str, dict[str, str]] = {}
    current = "_root"
    sections[current] = {}
    kv_count = 0
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith(("#", ";", "//")):
            continue
        m_sec = _SECTION_RE.match(line)
        if m_sec:
            current = m_sec.group(1).strip()
            sections.setdefault(current, {})
            continue
        m_kv = _KV_RE.match(line)
        if m_kv:
            sections[current][m_kv.group(1)] = m_kv.group(2)
            kv_count += 1

    if not kv_count:
        return ParseResult(
            status=PARSE_FALLBACK, parser="config", language="ini",
            error="未识别出 section/key=value 结构, 按原始文本展示",
        )
    return ParseResult(
        status=PARSE_OK, parser="config",
        language="yaml" if low.endswith((".yaml", ".yml")) else "ini",
        fields={"sections": sections},
    )


def _parse_yaml_subset(text: str) -> ParseResult:
    """只做缩进键值提取, 不引入第三方 YAML 库, 也不实例化任何类型。"""
    root: dict[str, Any] = {}
    stack: list[tuple[int, dict[str, Any]]] = [(-1, root)]
    kv_count = 0
    for raw in text.splitlines():
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        m = _YAML_KV.match(raw)
        if not m:
            continue
        indent = len(m.group(1))
        key, value = m.group(2), m.group(3)
        while stack and indent <= stack[-1][0]:
            stack.pop()
        parent = stack[-1][1]
        if value == "":
            child: dict[str, Any] = {}
            parent[key] = child
            stack.append((indent, child))
        else:
            parent[key] = value.strip('"\'')
        kv_count += 1
    if not kv_count:
        return ParseResult(
            status=PARSE_FALLBACK, parser="config", language="yaml",
            error="未识别出 YAML 键值, 按原始文本展示",
        )
    return ParseResult(status=PARSE_OK, parser="config", language="yaml",
                       fields={"data": root})


def _parse_xml_text(text: str) -> ParseResult:
    """极简 XML 统计: 提取标签名与属性, 不做实体求值、不实例化对象。"""
    tag_re = re.compile(r"<\s*(?P<name>[\w:.-]+)(?P<attrs>[^>]*)>")
    attr_re = re.compile(r"([\w:.-]+)\s*=\s*\"([^\"]*)\"")
    elements: list[dict[str, Any]] = []
    for m in tag_re.finditer(text[:2_000_000]):
        attrs = {a.group(1): a.group(2)
                 for a in attr_re.finditer(m.group("attrs"))}
        elements.append({"tag": m.group("name"), "attrs": attrs})
    if not elements:
        return ParseResult(
            status=PARSE_FALLBACK, parser="config", language="xml",
            error="未识别出 XML 标签, 按原始文本展示",
        )
    return ParseResult(status=PARSE_OK, parser="config", language="xml",
                       fields={"elements": elements[:5000]})


# ---------------------------------------------------------------------------
# Markdown / 说明
# ---------------------------------------------------------------------------

_HEADING_RE = re.compile(r"^(#{1,6})\s+(.*)$")


def _parse_markdown(text: str) -> ParseResult:
    headings: list[dict[str, Any]] = []
    code_fences = 0
    for idx, line in enumerate(text.splitlines(), start=1):
        m = _HEADING_RE.match(line)
        if m:
            headings.append({"line_no": idx, "level": len(m.group(1)),
                             "text": m.group(2).strip()})
        if line.strip().startswith("```"):
            code_fences += 1
    return ParseResult(
        status=PARSE_OK, parser="markdown", language="markdown",
        fields={"headings": headings, "code_fence_markers": code_fences},
    )


# ---------------------------------------------------------------------------
# 入口
# ---------------------------------------------------------------------------

def parse_file(kind: str, text: str | None, rel_path: str,
               binary: bool) -> ParseResult:
    """按分类结果选择解析器; 任何异常都退化为 fallback, 不向上抛。"""
    try:
        if binary or text is None:
            return ParseResult(
                status=PARSE_BINARY, parser="binary", language="text",
                error="二进制文件, 仅保留校验值与元数据",
            )
        ext = os.path.splitext(rel_path)[1].lower()
        if kind == "request":
            return _parse_http(text, "request")
        if kind == "response":
            return _parse_http(text, "response")
        if kind == "log":
            return _parse_log(text)
        if kind == "config":
            return _parse_config(text, rel_path)
        if kind == "note":
            if ext in (".md", ".markdown"):
                return _parse_markdown(text)
            return ParseResult(status=PARSE_OK, parser="text",
                               language="text", fields={"line_count":
                                                        len(text.splitlines())})
        if ext == ".json":
            return _parse_json(text)
        return ParseResult(
            status=PARSE_OK, parser="text", language="text",
            fields={"line_count": len(text.splitlines())},
        )
    except Exception as exc:  # 防御性兜底: 解析器自身 bug 不应影响其他文件
        return ParseResult(
            status=PARSE_FALLBACK, parser="text", language="text",
            error=f"解析异常, 已退化为文本: {type(exc).__name__}: {exc}",
        )
