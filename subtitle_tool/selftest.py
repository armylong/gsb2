"""Headless self-test: builds the bundled example, exports, re-imports and
verifies.  Used by ``--self-test`` and by CI where no display is available."""

from __future__ import annotations

import os
import tempfile

from .examples import build_example_project
from .export import (
    collect_unresolved,
    export_merged,
    verify_against_manifest,
    verify_srt_against_project,
)
from .pairing import apply_all_suggestions, build_pairing_suggestions
from .session import Session


def run_self_test(verbose: bool = True) -> int:
    lines = []

    def say(msg: str) -> None:
        lines.append(msg)
        if verbose:
            print(msg)

    project = build_example_project()
    suggestions = build_pairing_suggestions(project, "en")
    kinds = {}
    for s in suggestions:
        kinds[s.kind] = kinds.get(s.kind, 0) + 1
    say(f"配对建议: {kinds}")
    if kinds.get("split") != 1 or kinds.get("missing") != 1:
        say("自检失败：示例应有一处拆分和一处缺翻译")
        return 1

    apply_all_suggestions(project, suggestions)
    events = project.sorted_events()
    say(f"合并事件: {len(events)} 条")
    at_screen = project.rows_at(12_500)
    say(f"12.5s 此刻显示 {len(at_screen)} 行")
    if not any(row.lang == "en" for _ev, row in at_screen):
        say("自检失败：12.5s 应显示英文原文（中文缺翻译）")
        return 1

    issues = collect_unresolved(project)
    say(f"未解决项: {issues.counts}")

    with tempfile.TemporaryDirectory() as tmp:
        srt = os.path.join(tmp, "merged.srt")
        manifest = os.path.join(tmp, "merged.manifest.json")
        export_merged(project, srt, manifest)
        report = verify_srt_against_project(project, open(srt, encoding="utf-8").read())
        report2 = verify_against_manifest(project, srt, manifest)
        say(report.summary())
        say("清单核对: " + report2.summary())
        if not (report.ok and report2.ok):
            for issue in report.issues + report2.issues:
                say(f"  {issue.kind}: {issue.message}")
            return 1

    session = Session(build_example_project())
    session.apply_suggestions(session.suggestions(), lock=True)
    locked_before = [e.to_dict() for e in session.project.events if e.locked]
    session.rebuild_unlocked()
    locked_after = [e.to_dict() for e in session.project.events if e.locked]
    if locked_before != locked_after:
        say("自检失败：重建未锁定改动了已锁定事件")
        return 1
    say(f"锁定保护: {len(locked_after)} 条锁定事件在重建后保持不变")

    say("自检通过")
    return 0
