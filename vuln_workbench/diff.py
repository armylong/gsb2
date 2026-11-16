"""两份复现包的文件差异与关键字段差异。

状态语义:
- ``added``       仅 B 包存在
- ``removed``     仅 A 包存在 (缺失)
- ``modified``    两边都有但 sha256 不同, 且不是纯顺序变化
- ``order_only``  两边文件集合与内容完全一致, 仅排列顺序不同 (包级),
                  或单个结构化文件内部条目顺序变化、字段集合不变
- ``unchanged``   完全一致

匹配策略: 优先按 rel_path 匹配, 路径对不上时再按 sha256 兜底,
这样文件被重命名时也能识别为 "仅路径变化" 而不是一对新增+缺失。
"""

from __future__ import annotations

import difflib
from dataclasses import dataclass, field, asdict
from typing import Any

from .models import EvidenceFile

ADDED = "added"
REMOVED = "removed"
MODIFIED = "modified"
ORDER_ONLY = "order_only"
UNCHANGED = "unchanged"
RENAMED = "renamed"


@dataclass
class FileDiff:
    status: str
    rel_path_a: str | None = None
    rel_path_b: str | None = None
    file_id_a: str | None = None
    file_id_b: str | None = None
    sha256_a: str | None = None
    sha256_b: str | None = None
    detail: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _index(files: list[EvidenceFile]):
    by_path: dict[str, EvidenceFile] = {}
    by_hash: dict[str, list[EvidenceFile]] = {}
    for f in files:
        by_path[f.rel_path] = f
        by_hash.setdefault(f.sha256, []).append(f)
    return by_path, by_hash


def _is_order_only(fa: EvidenceFile, fb: EvidenceFile) -> bool:
    """判断是否为纯顺序变化 (要求多重证据一致, 不能只看字段)。"""
    pa, pb = fa.parse.fields or {}, fb.parse.fields or {}
    # 双方都得有真实解析出的结构, 否则没有资格判定为顺序变化
    if not pa or not pb:
        return False
    if _canonical(pa) != _canonical(pb):
        return False
    # 文本级最强证据: 行的多重集合完全相同, 只是排列不同
    lines_a = sorted((fa.text or "").splitlines())
    lines_b = sorted((fb.text or "").splitlines())
    return lines_a == lines_b and lines_a != []


def _canonical(obj: Any) -> Any:
    if isinstance(obj, dict):
        # line_no 是行位置信息, 顺序无关比较时必须忽略,
        # 否则纯行序变化会被误判为内容修改
        return {k: _canonical(v) for k, v in sorted(obj.items())
                if k != "line_no"}
    if isinstance(obj, list):
        canonical_items = [_canonical(v) for v in obj]
        try:
            return sorted(canonical_items, key=lambda v: jsonish_key(v))
        except TypeError:
            return canonical_items
    return obj


def jsonish_key(obj: Any) -> str:
    import json
    return json.dumps(obj, ensure_ascii=False, sort_keys=True,
                      default=str)


def _line_diff(text_a: str, text_b: str, limit: int = 400) -> list[dict[str, Any]]:
    """生成带行号的 unified diff 片段 (静态文本, 不执行任何内容)。"""
    lines = list(difflib.unified_diff(
        text_a.splitlines(keepends=False),
        text_b.splitlines(keepends=False),
        fromfile="A", tofile="B", lineterm="", n=2,
    ))
    out: list[dict[str, Any]] = []
    for line in lines[:limit]:
        kind = ("context" if line.startswith("---") or line.startswith("+++")
                else {"+": "add", "-": "del", " ": "ctx", "@": "hunk"}
                .get(line[:1], "ctx"))
        out.append({"kind": kind, "text": line})
    if len(lines) > limit:
        out.append({"kind": "ctx", "text": f"... 已截断, 共 {len(lines)} 行差异"})
    return out


def _field_diff(fa: EvidenceFile, fb: EvidenceFile) -> dict[str, Any]:
    """关键字段层面的差异 (HTTP 方法/URL/状态码/头, 日志级别统计等)。"""
    out: dict[str, Any] = {}
    pa, pb = fa.parse.fields or {}, fb.parse.fields or {}

    if fa.kind in ("request", "response") and fb.kind in ("request", "response"):
        keys = ("method", "target", "path", "status_code", "reason", "version")
        changed = {k: {"a": pa.get(k), "b": pb.get(k)}
                   for k in keys if pa.get(k) != pb.get(k)}
        if changed:
            out["http_fields"] = changed
        ha = {h["name"].lower(): h["value"] for h in pa.get("headers", [])}
        hb = {h["name"].lower(): h["value"] for h in pb.get("headers", [])}
        header_changes = {}
        for name in sorted(set(ha) | set(hb)):
            if ha.get(name) != hb.get(name):
                header_changes[name] = {"a": ha.get(name), "b": hb.get(name)}
        if header_changes:
            out["headers"] = header_changes

    if fa.kind == "log" and fb.kind == "log":
        ea = pa.get("entries", [])
        eb = pb.get("entries", [])
        levels_a = sorted({e.get("level") for e in ea if e.get("level")})
        levels_b = sorted({e.get("level") for e in eb if e.get("level")})
        if levels_a != levels_b:
            out["log_levels"] = {"a": levels_a, "b": levels_b}
        if pa.get("line_count") != pb.get("line_count"):
            out["line_count"] = {
                "a": pa.get("line_count"),
                "b": pb.get("line_count"),
            }

    if fa.kind == "config" and fb.kind == "config":
        ca = _canonical(pa.get("sections") or pa.get("data") or {})
        cb = _canonical(pb.get("sections") or pb.get("data") or {})
        if ca != cb:
            out["config_keys_changed"] = True

    return out


def compare_packages(files_a: list[EvidenceFile],
                     files_b: list[EvidenceFile]) -> dict[str, Any]:
    """比较两个包的文件列表, 返回汇总 + 每个文件的差异。

    三阶段匹配, 避免哈希兜底抢占同路径的修改/顺序变化:
      1. 同 rel_path 直接配对 (unchanged / modified / order_only);
      2. 剩余项按 sha256 配对为 renamed;
      3. 仍未配对的分别记为 removed / added。
    """
    path_a, hash_a = _index(files_a)
    path_b, hash_b = _index(files_b)
    diffs: list[FileDiff] = []
    consumed_a: set[str] = set()
    consumed_b: set[str] = set()

    # ---- 阶段 1: 同路径配对 ----
    for rel in sorted(set(path_a) & set(path_b)):
        fa, fb = path_a[rel], path_b[rel]
        consumed_a.add(rel)
        consumed_b.add(rel)
        if fa.sha256 == fb.sha256:
            diffs.append(FileDiff(
                status=UNCHANGED, rel_path_a=rel, rel_path_b=rel,
                file_id_a=fa.id, file_id_b=fb.id,
                sha256_a=fa.sha256, sha256_b=fb.sha256,
            ))
            continue
        order_only = _is_order_only(fa, fb)
        detail: dict[str, Any] = {}
        if order_only:
            detail["reason"] = "结构化字段集合一致, 仅条目/行顺序不同"
            status = ORDER_ONLY
        else:
            status = MODIFIED
            detail["field_diff"] = _field_diff(fa, fb)
            detail["line_diff"] = _line_diff(fa.text or "", fb.text or "")
        diffs.append(FileDiff(
            status=status, rel_path_a=rel, rel_path_b=rel,
            file_id_a=fa.id, file_id_b=fb.id,
            sha256_a=fa.sha256, sha256_b=fb.sha256,
            detail=detail,
        ))

    # ---- 阶段 2: 剩余项按内容哈希配对 (重命名) ----
    for rel in sorted(set(path_a) - consumed_a):
        fa = path_a[rel]
        same_hash = [f for f in hash_b.get(fa.sha256, [])
                     if f.rel_path not in consumed_b]
        if same_hash:
            fb = same_hash[0]
            consumed_a.add(rel)
            consumed_b.add(fb.rel_path)
            diffs.append(FileDiff(
                status=RENAMED, rel_path_a=rel, rel_path_b=fb.rel_path,
                file_id_a=fa.id, file_id_b=fb.id,
                sha256_a=fa.sha256, sha256_b=fb.sha256,
                detail={"reason": "内容完全一致, 仅文件路径/名称变化"},
            ))

    # ---- 阶段 3: 剩余项即缺失 / 新增 ----
    for rel in sorted(set(path_a) - consumed_a):
        fa = path_a[rel]
        diffs.append(FileDiff(
            status=REMOVED, rel_path_a=rel,
            file_id_a=fa.id, sha256_a=fa.sha256,
            detail={"reason": "B 包缺失该文件"},
        ))
    for rel in sorted(set(path_b) - consumed_b):
        fb = path_b[rel]
        diffs.append(FileDiff(
            status=ADDED, rel_path_b=rel, file_id_b=fb.id,
            sha256_b=fb.sha256,
            detail={"reason": "A 包没有该文件"},
        ))

    # 包级顺序判断: 忽略顺序后完全一致, 但两边 rel_path 排列不同
    order_only_package = (
        sorted(path_a.keys()) == sorted(path_b.keys())
        and [f.sha256 for f in sorted(files_a, key=lambda x: x.rel_path)]
        == [f.sha256 for f in sorted(files_b, key=lambda x: x.rel_path)]
        and [f.rel_path for f in files_a] != [f.rel_path for f in files_b]
    )

    counts: dict[str, int] = {}
    for d in diffs:
        counts[d.status] = counts.get(d.status, 0) + 1

    return {
        "diffs": [d.to_dict() for d in diffs],
        "counts": counts,
        "package_order_only": order_only_package,
        "summary": (
            "两包文件集合与内容完全一致, 仅文件排列顺序不同"
            if order_only_package and counts.get(MODIFIED, 0) == 0
            and counts.get(ADDED, 0) == 0 and counts.get(REMOVED, 0) == 0
            else "存在内容差异"
        ),
    }
