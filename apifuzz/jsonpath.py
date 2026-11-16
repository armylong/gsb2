"""极简 JSONPath（点分路径）工具，用于响应契约与后置条件检查。"""
from __future__ import annotations

from typing import Any, Tuple

ABSENT = "__ABSENT__"


def get_path(obj: Any, path: str) -> Tuple[bool, Any]:
    """返回 (是否存在, 值)。路径根 ``$`` 可省略。"""
    if path in ("$", ""):
        return True, obj
    keys = path[2:].split(".") if path.startswith("$.") else path.split(".")
    cur = obj
    for key in keys:
        if isinstance(cur, dict) and key in cur:
            cur = cur[key]
            continue
        return False, None
    return True, cur


def set_saved(obj: Any, path: str, value: Any) -> None:
    """环境准备步骤的 save：把响应中的值写回上下文。"""
    keys = path[2:].split(".") if path.startswith("$.") else path.split(".")
    cur = obj
    for key in keys[:-1]:
        cur = cur.setdefault(key, {})
    cur[keys[-1]] = value
