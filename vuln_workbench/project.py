"""工程文件的保存、打开与人工标注管理。

工程为单个 JSON 文件 (UTF-8)。保存采用 "写临时文件再原子替换",
避免写一半导致工程损坏; 打开失败时抛 :class:`ProjectLoadError`,
调用方 (UI/CLI) 必须保证当前工程不被清空。
"""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

from .masking import default_settings
from .models import (
    Annotation, ConclusionHistoryEntry, Project, new_id, utc_now,
)


class ProjectLoadError(Exception):
    """工程文件无法读取或格式非法。"""


def new_project(name: str = "未命名工程") -> Project:
    p = Project(name=name)
    p.mask_settings = default_settings()
    p.log_op("create_project", f"创建工程 {name}")
    return p


def save_project(project: Project, path: str | Path) -> Path:
    """原子保存工程, 返回最终路径。"""
    target = Path(path).expanduser().resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    project.updated_at = utc_now()
    payload = json.dumps(project.to_dict(), ensure_ascii=False, indent=2)
    # 同目录临时文件 + os.replace, 保证不会写出半截工程
    fd, tmp_name = tempfile.mkstemp(
        prefix=f".{target.name}.", suffix=".tmp", dir=str(target.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(payload)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp_name, target)
    except BaseException:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise
    project.log_op("save_project", f"保存到 {target}")
    return target


def load_project(path: str | Path) -> Project:
    """读取工程; 文件缺失/JSON 非法/格式不符都抛 ProjectLoadError。"""
    target = Path(path).expanduser().resolve()
    if not target.exists():
        raise ProjectLoadError(f"工程文件不存在: {target}")
    try:
        raw = target.read_bytes()
    except OSError as exc:
        raise ProjectLoadError(f"工程文件无法读取: {exc}") from exc
    try:
        data = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ProjectLoadError(f"工程文件不是合法 JSON: {exc}") from exc
    try:
        project = Project.from_dict(data)
    except (ValueError, KeyError, TypeError) as exc:
        raise ProjectLoadError(f"工程内容结构非法: {exc}") from exc
    project.log_op("open_project", f"打开工程 {target}")
    return project


# ---------------------------------------------------------------------------
# 人工标注
# ---------------------------------------------------------------------------

def add_annotation(project: Project, title: str,
                   linked_file_ids: list[str] | None = None) -> Annotation:
    annotation = Annotation(
        id=new_id("ann"),
        title=title or "未命名复现记录",
        linked_file_ids=list(linked_file_ids or []),
    )
    project.annotations.append(annotation)
    project.log_op("add_annotation", f"新增标注 {annotation.id}: {annotation.title}")
    return annotation


def update_annotation(project: Project, annotation_id: str, **fields) -> Annotation:
    """更新标注字段。

    支持 title/steps/expected/actual/conclusion/linked_file_ids。
    其中 conclusion 的每次变化都会写入 conclusion_history, 历史不可删除。
    """
    annotation = project.get_annotation(annotation_id)
    if annotation is None:
        raise KeyError(f"标注不存在: {annotation_id}")

    allowed = {"title", "steps", "expected", "actual",
               "conclusion", "linked_file_ids"}
    unknown = set(fields) - allowed
    if unknown:
        raise ValueError(f"不允许更新的字段: {sorted(unknown)}")

    if "conclusion" in fields:
        new_value = fields["conclusion"] or ""
        if new_value != annotation.conclusion:
            annotation.conclusion_history.append(ConclusionHistoryEntry(
                changed_at=utc_now(),
                old_value=annotation.conclusion,
                new_value=new_value,
            ))
            annotation.conclusion = new_value

    for key in ("title", "steps", "expected", "actual"):
        if key in fields:
            setattr(annotation, key, fields[key] or "")
    if "linked_file_ids" in fields:
        annotation.linked_file_ids = list(fields["linked_file_ids"] or [])

    annotation.updated_at = utc_now()
    project.log_op("update_annotation",
                   f"更新标注 {annotation_id}: {', '.join(sorted(fields))}")
    return annotation
