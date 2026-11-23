"""Export merged SRT + unresolved items, and round-trip verification.

The merged SRT uses the on-screen layout: one cue per event, rows in language
order, one or more lines per row.  To make verification unambiguous, a small
JSON manifest is written next to the SRT (``.manifest.json``) recording the
row/language structure.  The SRT alone still re-imports by comparing the
flattened visible lines and timings.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

from .model import Event, Issue, Project, Row
from .srt import (
    SrtCue,
    build_srt,
    ms_to_timestamp,
    parse_srt,
)


# ---------------------------------------------------------------------------
# Export
# ---------------------------------------------------------------------------


@dataclass
class ExportOptions:
    include_lang_labels: bool = False
    include_missing_rows: bool = False
    line_separator: str = "\n"


def _row_display(row: Row, options: ExportOptions, label: str) -> Optional[str]:
    if not row.visible:
        return None
    text = row.text.strip("\n")
    if options.include_lang_labels:
        return f"[{label}] {text}"
    return text


def event_display_lines(
    project: Project, ev: Event, options: Optional[ExportOptions] = None
) -> List[str]:
    options = options or ExportOptions()
    lines: List[str] = []
    for lang in project.lang_order:
        for row in ev.rows_for(lang):
            display = _row_display(row, options, project.lang_label(lang))
            if display is None:
                if options.include_missing_rows:
                    lines.append(f"[{project.lang_label(lang)}] —")
                continue
            lines.extend(display.split("\n"))
    if not lines:
        for row in ev.rows:
            display = _row_display(row, options, project.lang_label(row.lang))
            if display:
                lines.extend(display.split("\n"))
    return lines


def export_merged_cues(
    project: Project, options: Optional[ExportOptions] = None
) -> List[SrtCue]:
    """Cues exactly as they would appear on screen.

    Events with no visible text are dropped: exporting a blank cue would put an
    empty subtitle in the file, and verification could never match it back to
    anything meaningful.
    """
    options = options or ExportOptions()
    cues: List[SrtCue] = []
    for ev in project.sorted_events():
        lines = event_display_lines(project, ev, options)
        if not lines:
            continue
        cues.append(SrtCue(ev.start_ms, ev.end_ms, options.line_separator.join(lines)))
    return cues


def merged_srt_text(
    project: Project, options: Optional[ExportOptions] = None
) -> str:
    return build_srt(export_merged_cues(project, options))


def manifest_dict(
    project: Project, options: Optional[ExportOptions] = None
) -> dict:
    options = options or ExportOptions()
    cues = export_merged_cues(project, options)
    events = [ev for ev in project.sorted_events()
              if event_display_lines(project, ev, options)]
    entries = []
    for index, (ev, cue) in enumerate(zip(events, cues), start=1):
        entries.append(
            {
                "index": index,
                "eid": ev.eid,
                "start_ms": ev.start_ms,
                "end_ms": ev.end_ms,
                "locked": ev.locked,
                "split_group": ev.split_group,
                "text": cue.text,
                "rows": [
                    {
                        "lang": row.lang,
                        "label": project.lang_label(row.lang),
                        "text": row.text,
                        "origin": row.origin,
                        "missing": row.missing,
                        "visible": row.visible,
                    }
                    for row in ev.rows
                ],
            }
        )
    return {
        "format": "subtitle-reflow-merged/1",
        "lang_order": list(project.lang_order),
        "profiles": {k: v.to_dict() for k, v in project.profiles.items()},
        "cues": entries,
    }


def export_merged(
    project: Project,
    srt_path: str,
    manifest_path: Optional[str] = None,
    options: Optional[ExportOptions] = None,
) -> Tuple[str, Optional[str]]:
    options = options or ExportOptions()
    text = merged_srt_text(project, options)
    with open(srt_path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)
    if manifest_path:
        with open(manifest_path, "w", encoding="utf-8") as fh:
            json.dump(manifest_dict(project, options), fh, ensure_ascii=False, indent=2)
    return text, manifest_path


# ---------------------------------------------------------------------------
# Unresolved items
# ---------------------------------------------------------------------------


@dataclass
class UnresolvedReport:
    issues: List[Issue]
    counts: Dict[str, int]
    lines: List[str]

    def to_dict(self) -> dict:
        return {
            "counts": self.counts,
            "issues": [i.to_dict() for i in self.issues],
        }


def collect_unresolved(project: Project) -> UnresolvedReport:
    issues = project.all_issues()
    counts = project.counts()
    plain: List[str] = []
    for issue in issues:
        plain.append(
            f"[{issue.severity}] {issue.time} {issue.event_id} "
            f"{issue.kind}: {issue.message}"
        )
    if not plain:
        plain.append("没有未解决项。")
    return UnresolvedReport(issues, counts, plain)


def export_unresolved(
    project: Project,
    json_path: str,
    txt_path: Optional[str] = None,
) -> UnresolvedReport:
    report = collect_unresolved(project)
    with open(json_path, "w", encoding="utf-8") as fh:
        json.dump(report.to_dict(), fh, ensure_ascii=False, indent=2)
    if txt_path:
        with open(txt_path, "w", encoding="utf-8") as fh:
            fh.write("\n".join(report.lines) + "\n")
    return report


# ---------------------------------------------------------------------------
# Round-trip verification
# ---------------------------------------------------------------------------


@dataclass
class VerifyIssue:
    kind: str
    severity: str
    index: int
    message: str

    def to_dict(self) -> dict:
        return {
            "kind": self.kind,
            "severity": self.severity,
            "index": self.index,
            "message": self.message,
        }


@dataclass
class VerifyReport:
    total_cues: int
    matched: int
    issues: List[VerifyIssue] = field(default_factory=list)
    cues: List[SrtCue] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not any(i.severity == "error" for i in self.issues)

    def to_dict(self) -> dict:
        return {
            "ok": self.ok,
            "total_cues": self.total_cues,
            "matched": self.matched,
            "issues": [i.to_dict() for i in self.issues],
        }

    def summary(self) -> str:
        if self.ok and not self.issues:
            return f"核对通过：{self.matched}/{self.total_cues} 条时间与文字一致。"
        errors = sum(1 for i in self.issues if i.severity == "error")
        warns = sum(1 for i in self.issues if i.severity == "warning")
        head = f"核对完成：{self.matched}/{self.total_cues} 条一致"
        if errors or warns:
            head += f"，{errors} 处时间/文字不符，{warns} 处提示"
        return head + "。"


def _flatten(text: str) -> List[str]:
    return [ln.strip() for ln in text.splitlines() if ln.strip()]


def verify_srt_against_project(
    project: Project,
    srt_text: str,
    tolerance_ms: int = 0,
    options: Optional[ExportOptions] = None,
) -> VerifyReport:
    """Compare an SRT against the project's current export.

    When *options* is omitted the plain layout is tried first and, if that
    mismatches, a language-labelled layout is tried too — so re-importing a
    file exported with labels still verifies without the caller having to
    remember the options.
    """
    if options is not None:
        return _verify_with_options(project, srt_text, tolerance_ms, options)
    report = _verify_with_options(project, srt_text, tolerance_ms, ExportOptions())
    if report.ok:
        return report
    labelled = _verify_with_options(
        project,
        srt_text,
        tolerance_ms,
        ExportOptions(include_lang_labels=True),
    )
    return labelled if labelled.ok else report


def _verify_with_options(
    project: Project,
    srt_text: str,
    tolerance_ms: int,
    options: ExportOptions,
) -> VerifyReport:
    cues = parse_srt(srt_text)
    events = [
        ev for ev in project.sorted_events()
        if event_display_lines(project, ev, options)
    ]
    issues: List[VerifyIssue] = []
    matched = 0
    if len(cues) != len(events):
        issues.append(
            VerifyIssue(
                "cue_count",
                "error",
                0,
                f"SRT 共 {len(cues)} 条，工程导出应有 {len(events)} 条",
            )
        )
    for i, (cue, ev) in enumerate(zip(cues, events), start=1):
        expected = _flatten(
            options.line_separator.join(event_display_lines(project, ev, options))
        )
        actual = _flatten(cue.text)
        if abs(cue.start_ms - ev.start_ms) > tolerance_ms:
            issues.append(
                VerifyIssue(
                    "start_time",
                    "error",
                    i,
                    f"第 {i} 条开始时间 {ms_to_timestamp(cue.start_ms)} != "
                    f"{ms_to_timestamp(ev.start_ms)}",
                )
            )
        if abs(cue.end_ms - ev.end_ms) > tolerance_ms:
            issues.append(
                VerifyIssue(
                    "end_time",
                    "error",
                    i,
                    f"第 {i} 条结束时间 {ms_to_timestamp(cue.end_ms)} != "
                    f"{ms_to_timestamp(ev.end_ms)}",
                )
            )
        if expected != actual:
            for n in range(max(len(expected), len(actual))):
                a = expected[n] if n < len(expected) else "（无）"
                b = actual[n] if n < len(actual) else "（无）"
                if a != b:
                    issues.append(
                        VerifyIssue(
                            "text",
                            "error",
                            i,
                            f"第 {i} 条第 {n + 1} 行文字不一致：应「{a}」实「{b}」",
                        )
                    )
        if (
            abs(cue.start_ms - ev.start_ms) <= tolerance_ms
            and abs(cue.end_ms - ev.end_ms) <= tolerance_ms
            and expected == actual
        ):
            matched += 1
    return VerifyReport(len(cues), matched, issues, cues)


def verify_merged_file(
    project: Project,
    srt_path: str,
    tolerance_ms: int = 0,
    options: Optional[ExportOptions] = None,
) -> VerifyReport:
    with open(srt_path, "r", encoding="utf-8-sig") as fh:
        text = fh.read()
    return verify_srt_against_project(project, text, tolerance_ms, options)


def verify_against_manifest(
    project: Project, srt_path: str, manifest_path: str, tolerance_ms: int = 0
) -> VerifyReport:
    """Compare an exported SRT against the manifest that accompanied it."""
    with open(srt_path, "r", encoding="utf-8-sig") as fh:
        cues = parse_srt(fh.read())
    with open(manifest_path, "r", encoding="utf-8") as fh:
        manifest = json.load(fh)
    entries = manifest.get("cues", [])
    issues: List[VerifyIssue] = []
    matched = 0
    for i, (cue, entry) in enumerate(zip(cues, entries), start=1):
        expected = _flatten(entry.get("text", ""))
        actual = _flatten(cue.text)
        if expected != actual:
            # Sequence position and text differ: the file may still contain
            # the same cues, just in another order, so say so plainly.
            if abs(cue.start_ms - int(entry["start_ms"])) > tolerance_ms:
                issues.append(
                    VerifyIssue(
                        "start_time", "error", i,
                        f"第 {i} 条开始时间 {ms_to_timestamp(cue.start_ms)} 与清单 "
                        f"{ms_to_timestamp(int(entry['start_ms']))} 不符；"
                        "行序或时间被改动",
                    )
                )
            if abs(cue.end_ms - int(entry["end_ms"])) > tolerance_ms:
                issues.append(
                    VerifyIssue(
                        "end_time", "error", i,
                        f"第 {i} 条结束时间 {ms_to_timestamp(cue.end_ms)} 与清单 "
                        f"{ms_to_timestamp(int(entry['end_ms']))} 不符",
                    )
                )
            if expected != actual:
                issues.append(
                    VerifyIssue(
                        "text", "error", i,
                        f"第 {i} 条文字与导出清单不一致：应「{' / '.join(expected)}」，"
                        f"实「{' / '.join(actual)}」",
                    )
                )
        if (
            abs(cue.start_ms - int(entry["start_ms"])) <= tolerance_ms
            and abs(cue.end_ms - int(entry["end_ms"])) <= tolerance_ms
            and expected == actual
        ):
            matched += 1
        elif cue.text.strip() and cue.text.strip() in {
            e.get("text", "").strip() for e in entries
        }:
            # text exists elsewhere in the manifest: this is an order change
            issues.append(
                VerifyIssue(
                    "order", "error", i,
                    f"第 {i} 条内容在清单的其他位置；导出行序被改动",
                )
            )
    if len(cues) != len(entries):
        issues.append(
            VerifyIssue(
                "cue_count", "error", 0,
                f"SRT 共 {len(cues)} 条，清单记录 {len(entries)} 条",
            )
        )
    for i in range(1, len(cues)):
        if cues[i].start_ms < cues[i - 1].start_ms:
            issues.append(
                VerifyIssue(
                    "order", "error", i + 1,
                    f"第 {i + 1} 条开始时间早于上一条；文件未按时间排序",
                )
            )
    return VerifyReport(len(cues), matched, issues, cues)


def verify_scene_coverage(
    project: Project, srt_text: str
) -> List[VerifyIssue]:
    """Check that re-imported cues do not silently straddle a scene cut."""
    issues: List[VerifyIssue] = []
    for i, cue in enumerate(parse_srt(srt_text), start=1):
        for cut in project.cuts:
            if cue.start_ms < cut < cue.end_ms:
                issues.append(
                    VerifyIssue(
                        "crosses_cut",
                        "warning",
                        i,
                        f"第 {i} 条 {ms_to_timestamp(cue.start_ms)}–"
                        f"{ms_to_timestamp(cue.end_ms)} 跨过切点 "
                        f"{ms_to_timestamp(cut)}",
                    )
                )
    return issues
