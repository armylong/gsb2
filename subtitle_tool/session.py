"""Command layer used by the GUI (and by tests): undo, locking, edits.

Every mutating command snapshots the project first and only commits the
snapshot when the command succeeds.  Locked events are never modified by a
command that would move, split, merge or rebuild them.
"""

from __future__ import annotations

from typing import List, Optional, Sequence, Tuple

from .export import (
    ExportOptions,
    UnresolvedReport,
    VerifyReport,
    collect_unresolved,
    export_merged,
    export_unresolved,
    verify_merged_file,
    verify_against_manifest,
    verify_scene_coverage,
)
from .model import Project, TimeChangeResult, Track
from .cuts import move_event_off_cuts, split_at_cut
from .pairing import (
    PairingSuggestion,
    apply_suggestion,
    apply_all_suggestions,
    build_pairing_suggestions,
)
from .srt import parse_cut_list, parse_srt


class Session:
    def __init__(self, project: Optional[Project] = None) -> None:
        self.project = project or Project()
        self._undo: List[str] = []
        self._redo: List[str] = []
        self._last_was_coalesce = False
        self.dirty = False

    # -- undo -------------------------------------------------------------
    def _snapshot(self) -> str:
        return self.project.to_json()

    def _commit(self, snapshot: str, coalesce: bool = False) -> None:
        """Record an undo point.

        *coalesce* merges a burst of same-kind edits (typing into a text
        field) into one undo step: the first edit pushes the pre-burst state,
        later ones in the same burst keep it.
        """
        if not (coalesce and self._last_was_coalesce and self._undo):
            self._undo.append(snapshot)
            if len(self._undo) > 80:
                self._undo.pop(0)
        self._last_was_coalesce = coalesce
        self._redo.clear()
        self.dirty = True

    def can_undo(self) -> bool:
        return bool(self._undo)

    def can_redo(self) -> bool:
        return bool(self._redo)

    def undo(self) -> bool:
        if not self._undo:
            return False
        self._redo.append(self.project.to_json())
        self.project = Project.from_json(self._undo.pop())
        self._last_was_coalesce = False
        self.dirty = True
        return True

    def redo(self) -> bool:
        if not self._redo:
            return False
        self._undo.append(self.project.to_json())
        self.project = Project.from_json(self._redo.pop())
        self._last_was_coalesce = False
        self.dirty = True
        return True

    # -- loading ----------------------------------------------------------
    def new_project(self, lang_a: str = "en", lang_b: str = "zh") -> None:
        self.project = Project(lang_order=[lang_a, lang_b])
        self.project.ensure_language(lang_a)
        self.project.ensure_language(lang_b)
        self._undo.clear()
        self._redo.clear()
        self._last_was_coalesce = False
        self.dirty = False

    def load_track(self, lang: str, path: str, text: str) -> int:
        snapshot = self._snapshot()
        cues = parse_srt(text)
        self.project.ensure_language(lang)
        self.project.add_track(Track.from_srt(lang, path, cues))
        self._commit(snapshot)
        return len(cues)

    def set_cuts_text(self, text: str) -> int:
        snapshot = self._snapshot()
        self.project.cuts = parse_cut_list(text)
        self._commit(snapshot)
        return len(self.project.cuts)

    def set_cuts(self, cuts: Sequence[int]) -> None:
        snapshot = self._snapshot()
        self.project.cuts = sorted(set(int(c) for c in cuts))
        self._commit(snapshot)

    def load_project(self, text: str) -> None:
        self.project = Project.from_json(text)
        self._undo.clear()
        self._redo.clear()
        self._last_was_coalesce = False
        self.dirty = False

    def save_project(self, path: str) -> None:
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(self.project.to_json())
        self.dirty = False

    # -- pairing ----------------------------------------------------------
    def suggestions(
        self,
        anchor_lang: Optional[str] = None,
        skip_used: bool = False,
    ) -> List[PairingSuggestion]:
        return build_pairing_suggestions(
            self.project, anchor_lang, skip_used=skip_used
        )

    def apply_suggestions(
        self,
        suggestions: Sequence[PairingSuggestion],
        align: str = "anchor",
        lock: bool = False,
    ) -> List[str]:
        if not suggestions:
            return []
        snapshot = self._snapshot()
        created = apply_all_suggestions(
            self.project, suggestions, align=align
        )
        if lock:
            for eid in created:
                ev = self.project.event_by_id(eid)
                if ev:
                    ev.locked = True
        self._commit(snapshot)
        return created

    def apply_suggestion(
        self,
        suggestion: PairingSuggestion,
        align: str = "anchor",
        lock: bool = False,
    ) -> List[str]:
        snapshot = self._snapshot()
        created = apply_suggestion(
            self.project, suggestion, align=align, lock=lock
        )
        self._commit(snapshot)
        return created

    def manual_pair(
        self,
        anchor_lang: str,
        anchor_uids: Sequence[str],
        other_lang: str,
        other_uids: Sequence[str],
        align: str = "anchor",
        lock: bool = False,
    ) -> List[str]:
        """Pair hand-picked cues into events (manual pairing / manual split)."""
        cues = self.project.all_cues()
        anchor = [cues[u] for u in anchor_uids if u in cues]
        other = [cues[u] for u in other_uids if u in cues]
        if not anchor and not other:
            return []
        if anchor and other:
            kind = "pair" if len(anchor) == 1 and len(other) == 1 else "split"
            suggestion = PairingSuggestion(
                kind,
                anchor_lang,
                other_lang,
                [c.uid for c in anchor],
                [c.uid for c in other],
                1.0,
                "手工配对",
                min(c.start_ms for c in anchor + other),
                max(c.end_ms for c in anchor + other),
            )
        elif anchor:
            suggestion = PairingSuggestion(
                "missing",
                anchor_lang,
                other_lang,
                [c.uid for c in anchor],
                [],
                1.0,
                "手工标记缺翻译",
                min(c.start_ms for c in anchor),
                max(c.end_ms for c in anchor),
            )
        else:
            suggestion = PairingSuggestion(
                "missing",
                anchor_lang,
                other_lang,
                [],
                [c.uid for c in other],
                1.0,
                "手工标记缺翻译",
                min(c.start_ms for c in other),
                max(c.end_ms for c in other),
            )
        return self.apply_suggestion(suggestion, align=align, lock=lock)

    def rebuild_unlocked(self, anchor_lang: Optional[str] = None) -> List[str]:
        """Throw away unlocked events and re-pair everything else.

        Locked events and every cue they use are preserved untouched.
        """
        snapshot = self._snapshot()
        self.project.events = [ev for ev in self.project.events if ev.locked]
        suggestions = build_pairing_suggestions(
            self.project, anchor_lang, skip_used=True
        )
        created = apply_all_suggestions(
            self.project, suggestions, align="anchor"
        )
        self.project.sort_events()
        self._commit(snapshot)
        return created

    # -- event edits ------------------------------------------------------
    def lock_event(self, eid: str, locked: bool) -> bool:
        ev = self.project.event_by_id(eid)
        if ev is None or ev.locked == locked:
            return False
        snapshot = self._snapshot()
        ev.locked = locked
        self._commit(snapshot)
        return True

    def set_event_window(
        self, eid: str, start: int, end: int, acknowledge: bool = False
    ) -> TimeChangeResult:
        snapshot = self._snapshot()
        result = self.project.set_event_window(
            eid, start, end, acknowledge=acknowledge
        )
        if result.applied:
            self._commit(snapshot)
        return result

    def set_event_text(self, eid: str, lang: str, text: str) -> None:
        snapshot = self._snapshot()
        self.project.set_event_text(eid, lang, text)
        self._commit(snapshot, coalesce=True)

    def end_text_edit_burst(self) -> None:
        """Close the current coalesced text-edit undo group."""
        self._last_was_coalesce = False

    def split_event(self, eid: str, at_ms: int) -> Tuple[Optional[str], str]:
        snapshot = self._snapshot()
        new_id, error = self.project.split_event(eid, at_ms)
        if error:
            return None, error
        self._commit(snapshot)
        return new_id, ""

    def merge_events(
        self, eids: Sequence[str], lock: bool = False
    ) -> Tuple[Optional[str], str]:
        evs = [self.project.event_by_id(eid) for eid in eids]
        if any(e is None for e in evs):
            return None, "选择的事件不存在"
        if any(e.locked for e in evs if e):
            return None, "所选事件中有已锁定的，请先解锁再合并"
        snapshot = self._snapshot()
        target = self.project.merge_events(eids, lock=lock)
        if target is None:
            return None, "至少需要两条事件才能合并"
        self._commit(snapshot)
        return target.eid, ""

    def unpair_event(self, eid: str) -> Tuple[List[str], str]:
        ev = self.project.event_by_id(eid)
        if ev is None:
            return [], "事件不存在"
        if ev.locked:
            return [], "该事件已锁定，请先解锁再拆配"
        snapshot = self._snapshot()
        ids = self.project.unpair_event(eid)
        if ids:
            self._commit(snapshot)
        return ids, ""

    def add_missing_language(self, eid: str, lang: str) -> bool:
        snapshot = self._snapshot()
        ok = self.project.add_missing_placeholder(eid, lang)
        if ok:
            self._commit(snapshot)
        return ok

    def add_placeholder_event(
        self, lang: str, start: int, end: int
    ) -> Optional[str]:
        snapshot = self._snapshot()
        ev = self.project.make_placeholder_event(lang, start, end)
        if ev is None:
            return None
        self._commit(snapshot)
        return ev.eid

    def move_event_off_cuts(self, eid: str, mode: str = "shrink") -> Tuple[bool, str]:
        ev = self.project.event_by_id(eid)
        if ev is None:
            return False, "事件不存在"
        snapshot = self._snapshot()
        ok, message = move_event_off_cuts(self.project, ev, mode)
        if ok:
            self._commit(snapshot)
        return ok, message

    def split_at_cut(self, eid: str, cut: Optional[int] = None) -> Tuple[Optional[str], str]:
        ev = self.project.event_by_id(eid)
        if ev is None:
            return None, "事件不存在"
        if ev.locked:
            return None, "该事件已锁定，请先解锁再拆分"
        snapshot = self._snapshot()
        new_id, error = split_at_cut(self.project, ev, cut)
        if error:
            return None, error
        self._commit(snapshot)
        return new_id, ""

    def tidy(self, acknowledge: bool = False) -> TimeChangeResult:
        snapshot = self._snapshot()
        result = self.project.tidy_timings(acknowledge=acknowledge)
        if result.applied:
            self._commit(snapshot)
        return result

    # -- settings ---------------------------------------------------------
    def set_profile(
        self,
        lang: str,
        max_cps: Optional[float] = None,
        max_lines: Optional[int] = None,
        max_chars_per_line: Optional[int] = None,
    ) -> None:
        snapshot = self._snapshot()
        prof = self.project.ensure_language(lang)
        if max_cps is not None:
            prof.max_cps = float(max_cps)
        if max_lines is not None:
            prof.max_lines = int(max_lines)
        if max_chars_per_line is not None:
            prof.max_chars_per_line = int(max_chars_per_line)
        self._commit(snapshot)

    def set_total_lines_budget(self, budget: int) -> None:
        snapshot = self._snapshot()
        self.project.total_lines_budget = max(1, int(budget))
        self._commit(snapshot)

    # -- export / verify --------------------------------------------------
    def export_merged(
        self,
        srt_path: str,
        manifest_path: Optional[str] = None,
        options: Optional[ExportOptions] = None,
    ):
        return export_merged(self.project, srt_path, manifest_path, options)

    def export_unresolved(
        self, json_path: str, txt_path: Optional[str] = None
    ) -> UnresolvedReport:
        return export_unresolved(self.project, json_path, txt_path)

    def verify_file(self, srt_path: str) -> VerifyReport:
        report = verify_merged_file(self.project, srt_path)
        with open(srt_path, "r", encoding="utf-8-sig") as fh:
            extra = verify_scene_coverage(self.project, fh.read())
        report.issues.extend(extra)
        return report

    def verify_manifest(
        self, srt_path: str, manifest_path: str
    ) -> VerifyReport:
        return verify_against_manifest(self.project, srt_path, manifest_path)

    def unresolved(self) -> UnresolvedReport:
        return collect_unresolved(self.project)
