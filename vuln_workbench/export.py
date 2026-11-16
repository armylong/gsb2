"""脱敏导出。

导出物为单个 JSON (可选 Markdown 摘要), 导出流程:
1. 汇总待脱敏项供 UI 展示确认;
2. 对工程字典做递归脱敏生成导出对象;
3. 泄露自检: 用全部启用规则再次扫描导出 JSON 的字符串,
   确认命中数为 0, 否则拒绝导出。

source_path 属于本机绝对路径, 导出清单只保留包名与包内相对路径,
不把完整来源路径带出本机。
"""

from __future__ import annotations

import json
from typing import Any

from .masking import (
    MaskSettings, collect_pending, redact_obj, redact_structured,
    redact_text, scan_text,
)
from .models import Project
from .safety import MASK_PLACEHOLDER


def pending_items(project: Project) -> list[dict[str, Any]]:
    return collect_pending(project.files, project.mask_settings)


def _build_export_dict(project: Project, settings: MaskSettings) -> dict[str, Any]:
    packages = [{
        "name": p.name,
        "source_type": p.source_type,
        "imported_at": p.imported_at,
        "import_error": p.import_error,
        "files": p.file_ids,
    } for p in project.packages]

    files = [{
        "id": f.id,
        "package_id": f.package_id,
        "rel_path": f.rel_path,
        "kind": f.kind,
        "size_bytes": f.size_bytes,
        "sha256": f.sha256,
        "md5": f.md5,
        "duplicate_of": f.duplicate_of,
        "duplicate_reason": f.duplicate_reason,
        # 结构化解析树按字段名上下文脱敏 (headers/JSON body 等)
        "parse": redact_structured(f.parse.to_dict(), settings),
        "text": redact_text(f.text, settings) if f.text else f.text,
        "text_truncated": f.text_truncated,
    } for f in project.files]

    annotations = [{
        "id": a.id,
        "title": a.title,
        "steps": redact_text(a.steps, settings),
        "expected": redact_text(a.expected, settings),
        "actual": redact_text(a.actual, settings),
        "conclusion": redact_text(a.conclusion, settings),
        "linked_file_ids": a.linked_file_ids,
        "conclusion_history": [
            {
                "changed_at": h.changed_at,
                "old_value": redact_text(h.old_value, settings),
                "new_value": redact_text(h.new_value, settings),
            }
            for h in a.conclusion_history
        ],
        "updated_at": a.updated_at,
    } for a in project.annotations]

    payload = {
        "export_format": "vuln-workbench-export",
        "export_version": 1,
        "project_name": project.name,
        "exported_at": project.updated_at,
        "packages": packages,
        "files": files,
        "correlations": [redact_structured(c.to_dict(), settings)
                         for c in project.correlations],
        "annotations": annotations,
        "mask_preview": {
            "placeholder": MASK_PLACEHOLDER,
            "enabled_rules": [r.id for r in settings.rules if r.enabled],
            "custom_rule_count": sum(1 for r in settings.rules if not r.builtin),
        },
    }
    return payload


def _leak_scan(exported: dict[str, Any],
               settings: MaskSettings) -> list[dict[str, Any]]:
    """对最终导出 JSON 做字符串级泄露扫描, 返回残留命中。

    命中值本身就是脱敏占位符的不算泄露 (占位符是脱敏产物, 不是原文)。
    """
    raw = json.dumps(exported, ensure_ascii=False)
    return [
        {
            "rule_id": h.rule_id,
            "rule_name": h.rule_name,
            "line_no": h.line_no,
            "matched": h.matched,
        }
        for h in scan_text(raw, settings)
        if h.matched and MASK_PLACEHOLDER not in h.matched
    ]


def export_project(project: Project,
                   settings: MaskSettings | None = None
                   ) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """返回 (脱敏后的导出字典, 导出前待脱敏项清单)。

    若泄露自检发现残留, 抛 :class:`AssertionError`, 绝不返回带原文的数据。
    """
    settings = settings or project.mask_settings
    pending = pending_items(project)
    exported = _build_export_dict(project, settings)
    leaks = _leak_scan(exported, settings)
    if leaks:
        raise AssertionError(
            f"导出脱敏自检失败, 仍有 {len(leaks)} 处敏感内容: "
            + ", ".join(f"{x['rule_name']}@line{x['line_no']}" for x in leaks[:5]))
    project.log_op(
        "export_project",
        f"导出工程 {project.name}: 脱敏 {sum(p['count'] for p in pending)} 处, "
        f"涉及 {len(pending)} 类敏感项",
    )
    return exported, pending


def render_markdown(exported: dict[str, Any]) -> str:
    """把脱敏后的导出字典渲染成 Markdown 摘要 (输入必须已经脱敏)。"""
    lines: list[str] = []
    lines.append(f"# 复现证据导出: {exported['project_name']}")
    lines.append("")
    lines.append(f"- 导出时间: {exported['exported_at']}")
    lines.append(f"- 复现包数量: {len(exported['packages'])}")
    lines.append(f"- 证据文件数量: {len(exported['files'])}")
    lines.append(f"- 脱敏占位符: `{exported['mask_preview']['placeholder']}`")
    lines.append("")

    lines.append("## 复现包")
    for pkg in exported["packages"]:
        lines.append(f"- **{pkg['name']}** ({pkg['source_type']}, "
                     f"{len(pkg['files'])} 个文件)")
    lines.append("")

    lines.append("## 证据文件")
    for f in exported["files"]:
        dup = f"，重复于 `{f['duplicate_of']}`" if f["duplicate_of"] else ""
        lines.append(f"### {f['rel_path']} `[{f['kind']}]`{dup}")
        lines.append(f"- sha256: `{f['sha256']}`")
        if f["parse"]["error"]:
            lines.append(f"- 解析说明: {f['parse']['error']}")
        if f["text"]:
            lines.append("```")
            lines.append(f["text"][:5000])
            if len(f["text"]) > 5000:
                lines.append("... (导出摘要已截断)")
            lines.append("```")
        lines.append("")

    if exported["annotations"]:
        lines.append("## 人工复现记录")
        for a in exported["annotations"]:
            lines.append(f"### {a['title']}")
            lines.append(f"- 复现步骤: {a['steps'] or '(未填写)'}")
            lines.append(f"- 预期现象: {a['expected'] or '(未填写)'}")
            lines.append(f"- 实际现象: {a['actual'] or '(未填写)'}")
            lines.append(f"- 结论: {a['conclusion'] or '(未填写)'}")
            if a["conclusion_history"]:
                lines.append("- 结论变更历史:")
                for h in a["conclusion_history"]:
                    lines.append(
                        f"  - {h['changed_at']}: "
                        f"{h['old_value'] or '(空)'} → {h['new_value'] or '(空)'}")
            lines.append("")
    return "\n".join(lines)
