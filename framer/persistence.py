"""工程文件的保存与加载（JSON，人工可读）。"""
from __future__ import annotations

import json
from pathlib import Path

PROJECT_VERSION = 1


def save_project(path: str | Path, project: dict) -> None:
    payload = {"version": PROJECT_VERSION, "project": project}
    tmp = Path(path).with_suffix(Path(path).suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2),
                   encoding="utf-8")
    tmp.replace(path)  # 原子替换，写一半也不会破坏旧文件


def load_project(path: str | Path) -> dict:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(data, dict) or "project" not in data:
        raise ValueError("不是有效的取景工程文件")
    project = data["project"]
    required = {"src", "keyframes", "easing"}
    if not required.issubset(project):
        raise ValueError(f"工程文件缺少字段：{sorted(required - set(project))}")
    if project["easing"] not in ("linear", "smoothstep"):
        raise ValueError("easing 只能是 linear 或 smoothstep")
    if not isinstance(project["keyframes"], list) or not project["keyframes"]:
        raise ValueError("工程文件没有关键点")
    return project
