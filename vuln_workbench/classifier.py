"""按文件名与内容特征识别文件大类 (请求/响应/日志/配置/说明/其他)。

识别失败一律归为 ``other``, 不抛异常。
"""

from __future__ import annotations

import os

from .models import FILE_KINDS

_REQUEST_EXT = {".http", ".req", ".request"}
_RESPONSE_EXT = {".resp", ".response"}
_NOTE_EXT = {".md", ".markdown", ".txt", ".rst"}
_CONFIG_EXT = {".ini", ".cfg", ".conf", ".yaml", ".yml", ".toml",
               ".properties", ".env", ".xml"}
_LOG_EXT = {".log", ".jsonl"}
_JSON_EXT = {".json"}

_REQUEST_HINTS = ("request", "req", "请求")
_RESPONSE_HINTS = ("response", "resp", "响应")
_LOG_HINTS = ("log", "日志", "access", "audit")
_CONFIG_HINTS = ("config", "conf", "配置", "settings", "nginx", "apache")
_NOTE_HINTS = ("readme", "note", "说明", "guide", "manual", "doc")


def _hinted_kind(name: str) -> str | None:
    low = name.lower()
    for hint in _REQUEST_HINTS:
        if hint in low:
            return "request"
    for hint in _RESPONSE_HINTS:
        if hint in low:
            return "response"
    for hint in _LOG_HINTS:
        if hint in low:
            return "log"
    for hint in _CONFIG_HINTS:
        if hint in low:
            return "config"
    for hint in _NOTE_HINTS:
        if hint in low:
            return "note"
    return None


def classify(rel_path: str, text: str | None) -> str:
    """返回 :data:`FILE_KINDS` 中的一种。"""
    name = os.path.basename(rel_path)
    ext = os.path.splitext(name)[1].lower()

    if ext in _REQUEST_EXT:
        return "request"
    if ext in _RESPONSE_EXT:
        return "response"
    if ext in _NOTE_EXT:
        kind = _hinted_kind(name)
        if kind:
            return kind
        # txt 仍可能是裸 HTTP 报文, 交给后面的内容嗅探
        if ext != ".txt":
            return "note"
    if ext in _CONFIG_EXT:
        return "config"
    if ext in _LOG_EXT:
        if ext == ".json":
            return "config"
        return "log"
    if ext in _JSON_EXT:
        # json 可能是结构化日志, 看内容首行
        if text and ('"level"' in text[:400] or '"timestamp"' in text[:400]
                     or '"time"' in text[:200]):
            return "log"
        return "config"

    hinted = _hinted_kind(name)
    if hinted:
        return hinted

    # 内容嗅探: HTTP 报文
    if text:
        head = text.lstrip("﻿")[:512]
        first_line = head.split("\r\n", 1)[0].split("\n", 1)[0]
        if " HTTP/" in first_line and first_line.startswith(("HTTP/",)):
            return "response"
        method_prefix = ("GET ", "POST ", "PUT ", "DELETE ", "PATCH ",
                         "HEAD ", "OPTIONS ", "TRACE ", "CONNECT ")
        if first_line.startswith(method_prefix) and " HTTP/" in first_line:
            return "request"

    return "other"


def supported_kinds() -> tuple[str, ...]:
    return FILE_KINDS
