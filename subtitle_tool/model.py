"""Core document model: tracks, merged events, constraints and checks.

The tool merges two independently timed subtitle tracks into *events*.  An
event is one on-screen block (one SRT cue in the merged export); it holds one
row per language, or several rows for the same language when a sentence was
split across cues.
"""

from __future__ import annotations

import copy
import json
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Sequence, Tuple

from .srt import SrtCue, ms_to_timestamp

# ---------------------------------------------------------------------------
# Language profiles
# ---------------------------------------------------------------------------

DEFAULT_PROFILE_TABLE = {
    "en": ("英文", 17.0, 2, 42),
    "zh": ("中文", 9.0, 2, 20),
    "ja": ("日文", 8.0, 2, 20),
    "ko": ("韩文", 9.0, 2, 20),
}


@dataclass
class LanguageProfile:
    code: str
    label: str
    max_cps: float = 15.0
    max_lines: int = 2
    max_chars_per_line: int = 42

    @classmethod
    def default_for(cls, code: str) -> "LanguageProfile":
        code = (code or "xx").strip() or "xx"
        label, cps, lines, chars = DEFAULT_PROFILE_TABLE.get(
            code, (code.upper(), 15.0, 2, 42)
        )
        return cls(code, label, cps, lines, chars)

    def to_dict(self) -> dict:
        return {
            "code": self.code,
            "label": self.label,
            "max_cps": self.max_cps,
            "max_lines": self.max_lines,
            "max_chars_per_line": self.max_chars_per_line,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "LanguageProfile":
        base = cls.default_for(data.get("code", "xx"))
        return cls(
            data.get("code", base.code),
            data.get("label", base.label),
            float(data.get("max_cps", base.max_cps)),
            int(data.get("max_lines", base.max_lines)),
            int(data.get("max_chars_per_line", base.max_chars_per_line)),
        )


# ---------------------------------------------------------------------------
# Tracks / cues
# ---------------------------------------------------------------------------


@dataclass
class CueRef:
    """An imported cue with a stable id scoped to its track."""

    uid: str
    lang: str
    start_ms: int
    end_ms: int
    text: str

    @classmethod
    def from_srt(cls, lang: str, index: int, cue: SrtCue) -> "CueRef":
        return cls(f"{lang}#{index + 1}", lang, cue.start_ms, cue.end_ms, cue.text)

    def to_dict(self) -> dict:
        return {
            "uid": self.uid,
            "lang": self.lang,
            "start_ms": self.start_ms,
            "end_ms": self.end_ms,
            "text": self.text,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "CueRef":
        return cls(
            data["uid"],
            data["lang"],
            int(data["start_ms"]),
            int(data["end_ms"]),
            data.get("text", ""),
        )


@dataclass
class Track:
    lang: str
    path: str
    cues: List[CueRef]

    @classmethod
    def from_srt(cls, lang: str, path: str, cues: Sequence[SrtCue]) -> "Track":
        return cls(lang, path, [CueRef.from_srt(lang, i, c) for i, c in enumerate(cues)])

    def by_uid(self) -> Dict[str, CueRef]:
        return {c.uid: c for c in self.cues}

    def to_dict(self) -> dict:
        return {
            "lang": self.lang,
            "path": self.path,
            "cues": [c.to_dict() for c in self.cues],
        }

    @classmethod
    def from_dict(cls, data: dict) -> "Track":
        return cls(
            data.get("lang", "xx"),
            data.get("path", ""),
            [CueRef.from_dict(c) for c in data.get("cues", [])],
        )


# ---------------------------------------------------------------------------
# Events
# ---------------------------------------------------------------------------


@dataclass
class Row:
    lang: str
    text: str
    origin: str = ""
    missing: bool = False

    @property
    def visible(self) -> bool:
        return (not self.missing) and bool(self.text.strip())

    @property
    def lines(self) -> List[str]:
        return [ln.rstrip() for ln in self.text.splitlines() if ln.strip()]

    def clone(self) -> "Row":
        return Row(self.lang, self.text, self.origin, self.missing)

    def to_dict(self) -> dict:
        return {
            "lang": self.lang,
            "text": self.text,
            "origin": self.origin,
            "missing": self.missing,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "Row":
        return cls(
            data.get("lang", "xx"),
            data.get("text", ""),
            data.get("origin", ""),
            bool(data.get("missing", False)),
        )


@dataclass
class Event:
    eid: str
    start_ms: int
    end_ms: int
    rows: List[Row] = field(default_factory=list)
    locked: bool = False
    split_group: str = ""
    note: str = ""

    # --- convenience -----------------------------------------------------
    @property
    def duration_ms(self) -> int:
        return self.end_ms - self.start_ms

    def rows_for(self, lang: str) -> List[Row]:
        return [r for r in self.rows if r.lang == lang]

    def visible_rows(self) -> List[Row]:
        return [r for r in self.rows if r.visible]

    def text_for(self, lang: str) -> str:
        return "\n".join(r.text for r in self.rows_for(lang) if r.visible)

    def all_text(self) -> str:
        return "\n".join(r.text for r in self.rows if r.visible)

    def clone(self) -> "Event":
        return Event(
            self.eid,
            self.start_ms,
            self.end_ms,
            [r.clone() for r in self.rows],
            self.locked,
            self.split_group,
            self.note,
        )

    def to_dict(self) -> dict:
        return {
            "eid": self.eid,
            "start_ms": self.start_ms,
            "end_ms": self.end_ms,
            "rows": [r.to_dict() for r in self.rows],
            "locked": self.locked,
            "split_group": self.split_group,
            "note": self.note,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "Event":
        return cls(
            data["eid"],
            int(data["start_ms"]),
            int(data["end_ms"]),
            [Row.from_dict(r) for r in data.get("rows", [])],
            bool(data.get("locked", False)),
            data.get("split_group", ""),
            data.get("note", ""),
        )


# ---------------------------------------------------------------------------
# Issues
# ---------------------------------------------------------------------------

SEVERITY_ORDER = {"error": 0, "warning": 1, "info": 2}


@dataclass
class Issue:
    kind: str
    severity: str
    event_id: str
    message: str
    time_ms: int = 0
    lang: str = ""

    @property
    def time(self) -> str:
        return ms_to_timestamp(self.time_ms)

    def to_dict(self) -> dict:
        return {
            "kind": self.kind,
            "severity": self.severity,
            "event": self.event_id,
            "time_ms": self.time_ms,
            "time": ms_to_timestamp(self.time_ms),
            "lang": self.lang,
            "message": self.message,
        }


def _count_text_chars(text: str) -> int:
    return len("".join(text.split()))


def _is_blank_row(row: Row) -> bool:
    return row.missing or not row.text.strip()


@dataclass
class TimeChangeResult:
    applied: bool
    warnings: List[str] = field(default_factory=list)
    error: str = ""


# ---------------------------------------------------------------------------
# Project
# ---------------------------------------------------------------------------


class Project:
    """The whole editable document.

    ``tracks`` keep the imported cues (needed for pairing suggestions);
    ``events`` are the merged blocks that get previewed and exported.
    """

    def __init__(
        self,
        lang_order: Optional[Sequence[str]] = None,
        profiles: Optional[Dict[str, LanguageProfile]] = None,
    ) -> None:
        self.lang_order: List[str] = list(lang_order or [])
        self.profiles: Dict[str, LanguageProfile] = dict(profiles or {})
        self.tracks: Dict[str, Track] = {}
        self.cuts: List[int] = []
        self.events: List[Event] = []
        self.total_lines_budget: int = 2
        self.min_gap_ms: int = 40
        self.pair_tolerance_ms: int = 1400
        self.next_id: int = 1

    # -- language helpers -------------------------------------------------
    def ensure_language(self, code: str) -> LanguageProfile:
        if code not in self.profiles:
            self.profiles[code] = LanguageProfile.default_for(code)
        if code not in self.lang_order:
            self.lang_order.append(code)
        return self.profiles[code]

    def lang_label(self, code: str) -> str:
        prof = self.profiles.get(code)
        return prof.label if prof else code.upper()

    # -- ids --------------------------------------------------------------
    def new_event_id(self) -> str:
        eid = f"ev{self.next_id}"
        self.next_id += 1
        return eid

    # -- tracks -----------------------------------------------------------
    def add_track(self, track: Track) -> None:
        self.ensure_language(track.lang)
        self.tracks[track.lang] = track

    def all_cues(self) -> Dict[str, CueRef]:
        out: Dict[str, CueRef] = {}
        for track in self.tracks.values():
            for cue in track.cues:
                out[cue.uid] = cue
        return out

    def used_origins(self) -> set:
        used = set()
        for ev in self.events:
            for row in ev.rows:
                if row.origin:
                    used.add(row.origin)
        return used

    # -- events -----------------------------------------------------------
    def event_by_id(self, eid: str) -> Optional[Event]:
        for ev in self.events:
            if ev.eid == eid:
                return ev
        return None

    def sorted_events(self) -> List[Event]:
        return sorted(self.events, key=lambda e: (e.start_ms, e.end_ms, e.eid))

    def sort_events(self) -> None:
        self.events.sort(key=lambda e: (e.start_ms, e.end_ms, e.eid))

    def project_duration(self) -> int:
        if self.events:
            return max(ev.end_ms for ev in self.events)
        ends = [cue.end_ms for track in self.tracks.values() for cue in track.cues]
        return max(ends) if ends else 60_000

    def rows_at(self, t: int) -> List[Tuple[Event, Row]]:
        """Rows actually on screen at time *t*."""
        out: List[Tuple[Event, Row]] = []
        for ev in self.sorted_events():
            if ev.start_ms <= t < ev.end_ms:
                for row in ev.visible_rows():
                    out.append((ev, row))
        return out

    # -- editing ----------------------------------------------------------
    def add_event(self, ev: Event) -> None:
        self.events.append(ev)
        self.sort_events()

    def remove_event(self, eid: str) -> Optional[Event]:
        ev = self.event_by_id(eid)
        if ev is not None:
            self.events.remove(ev)
        return ev

    def lock_event(self, eid: str, locked: bool = True) -> None:
        ev = self.event_by_id(eid)
        if ev is not None:
            ev.locked = locked

    def _time_warnings(self, ev: Event, start: int, end: int) -> List[str]:
        warnings: List[str] = []
        old_start, old_end = ev.start_ms, ev.end_ms
        old_cuts = {c for c in self.cuts if old_start < c < old_end}
        new_cuts = [c for c in self.cuts if start < c < end]
        for cut in new_cuts:
            if cut not in old_cuts:
                warnings.append(
                    f"会把字幕移过场景切点 {ms_to_timestamp(cut)}"
                )
        for other in self.sorted_events():
            if other is ev:
                continue
            if ev.split_group and other.split_group == ev.split_group:
                continue
            collides_new = not (
                other.end_ms + self.min_gap_ms <= start
                or end + self.min_gap_ms <= other.start_ms
            )
            collides_old = not (
                other.end_ms + self.min_gap_ms <= old_start
                or old_end + self.min_gap_ms <= other.start_ms
            )
            if collides_new and not collides_old:
                direction = (
                    "后一条" if other.start_ms >= ev.start_ms else "前一条"
                )
                warnings.append(
                    f"会挤住{direction}字幕（{ms_to_timestamp(other.start_ms)}–"
                    f"{ms_to_timestamp(other.end_ms)}），间隔小于 "
                    f"{self.min_gap_ms} ms"
                )
        # reading speed that gets worse because the window shrank
        if end > start:
            old_map = {i.message for i in self.check_event(ev) if i.kind == "reading_speed"}
            trial = ev.clone()
            trial.start_ms, trial.end_ms = start, end
            new_speed = [
                i for i in self.check_event(trial)
                if i.kind == "reading_speed" and i.message not in old_map
            ]
            for issue in new_speed:
                warnings.append(issue.message)
        return warnings

    def set_event_window(
        self,
        eid: str,
        start: int,
        end: int,
        acknowledge: bool = False,
    ) -> TimeChangeResult:
        ev = self.event_by_id(eid)
        if ev is None:
            return TimeChangeResult(False, error="找不到该事件")
        if ev.locked:
            return TimeChangeResult(False, error="该事件已锁定，请先解锁再调整时间")
        if start < 0:
            return TimeChangeResult(False, error="开始时间不能为负")
        if end <= start:
            return TimeChangeResult(False, error="结束时间必须晚于开始时间")
        warnings = self._time_warnings(ev, start, end)
        if warnings and not acknowledge:
            return TimeChangeResult(False, warnings=warnings)
        ev.start_ms, ev.end_ms = start, end
        self.sort_events()
        return TimeChangeResult(True, warnings=warnings)

    def set_event_text(self, eid: str, lang: str, text: str) -> None:
        ev = self.event_by_id(eid)
        if ev is None:
            return
        rows = ev.rows_for(lang)
        if not rows:
            ev.rows.append(Row(lang, text))
            return
        if len(rows) == 1:
            rows[0].text = text
            rows[0].missing = not bool(text.strip())
            return
        if not text.strip():
            for r in rows:
                r.text = ""
                r.missing = True
            return
        # Several rows of one language (a split sentence).  Redistribute the
        # edited text back over the same rows so the split relation survives.
        weights = [max(1, len("".join(r.text.split()))) for r in rows]
        from .textsplit import split_text_by_weights

        parts = split_text_by_weights(text, weights)
        for row, part in zip(rows, parts):
            row.text = part
            row.missing = not bool(part.strip())
        for extra in rows[len(parts):]:
            extra.text = ""

    # -- splitting --------------------------------------------------------
    @staticmethod
    def _split_text(text: str, ratio: float) -> Tuple[str, str]:
        from .textsplit import split_text

        return split_text(text, ratio)

    def split_event(self, eid: str, at_ms: int) -> Tuple[Optional[str], str]:
        """Split an event in two at *at_ms*; returns (new_event_id, error)."""
        ev = self.event_by_id(eid)
        if ev is None:
            return None, "找不到该事件"
        if ev.locked:
            return None, "该事件已锁定，请先解锁再拆分"
        if not (ev.start_ms < at_ms < ev.end_ms):
            return None, "拆分点必须落在该字幕的时间范围内"
        ratio = (at_ms - ev.start_ms) / max(1, ev.end_ms - ev.start_ms)
        group = ev.split_group or f"split-{ev.eid}-{self.next_id}"
        new_rows: List[Row] = []
        for row in ev.rows:
            if row.missing:
                new_rows.append(row.clone())
                continue
            a, b = self._split_text(row.text, ratio)
            row.text = a
            new_rows.append(Row(row.lang, b, row.origin, missing=not b.strip()))
        new_ev = Event(
            self.new_event_id(),
            at_ms,
            ev.end_ms,
            new_rows,
            False,
            group,
        )
        ev.end_ms = at_ms
        ev.split_group = group
        self.add_event(new_ev)
        return new_ev.eid, ""

    # -- pairing helpers --------------------------------------------------
    def merge_events(self, eids: Sequence[str], lock: bool = False) -> Optional[Event]:
        evs = [e for e in (self.event_by_id(eid) for eid in eids) if e]
        if len(evs) < 2:
            return evs[0] if evs else None
        if any(e.locked for e in evs):
            # merging locked content requires an explicit unlock first
            return None
        start = min(e.start_ms for e in evs)
        end = max(e.end_ms for e in evs)
        rows: List[Row] = []
        for lang in self.lang_order:
            for e in evs:
                rows.extend(r.clone() for r in e.rows_for(lang))
        target = evs[0]
        target.start_ms, target.end_ms = start, end
        target.rows = rows
        target.locked = lock
        target.split_group = ""
        for e in evs[1:]:
            self.events.remove(e)
        self.sort_events()
        return target

    def unpair_event(self, eid: str) -> List[str]:
        """Split an event back into one event per language (origins kept)."""
        ev = self.event_by_id(eid)
        if ev is None:
            return []
        if ev.locked:
            return []
        visible_langs = [lang for lang in self.lang_order if ev.rows_for(lang)]
        if len(visible_langs) <= 1:
            return [ev.eid]
        created: List[str] = []
        cues = self.all_cues()
        first = ev
        first_rows = [r for r in ev.rows if r.lang == visible_langs[0]]
        other_lists = {
            lang: [r.clone() for r in ev.rows if r.lang == lang]
            for lang in visible_langs[1:]
        }
        first.rows = first_rows
        for lang in visible_langs[1:]:
            rows = other_lists[lang]
            starts = [cues[r.origin].start_ms for r in rows if r.origin in cues]
            ends = [cues[r.origin].end_ms for r in rows if r.origin in cues]
            new = Event(
                self.new_event_id(),
                min(starts) if starts else ev.start_ms,
                max(ends) if ends else ev.end_ms,
                rows,
            )
            self.add_event(new)
            created.append(new.eid)
        # restore first event timing from its origins when possible
        starts = [
            cues[r.origin].start_ms for r in first.rows if r.origin in cues
        ]
        ends = [cues[r.origin].end_ms for r in first.rows if r.origin in cues]
        if starts and ends:
            first.start_ms, first.end_ms = min(starts), max(ends)
        created.insert(0, first.eid)
        self.sort_events()
        return created

    def add_missing_placeholder(self, eid: str, lang: str) -> bool:
        ev = self.event_by_id(eid)
        if ev is None or ev.rows_for(lang):
            return False
        ev.rows.append(Row(lang, "", missing=True))
        self.sort_events()
        return True

    def make_placeholder_event(
        self, lang: str, start: int, end: int, note: str = ""
    ) -> Optional[Event]:
        if end <= start:
            return None
        self.ensure_language(lang)
        rows = [Row(l, "", missing=(l != lang)) for l in self.lang_order]
        ev = Event(self.new_event_id(), start, end, rows, note=note)
        self.add_event(ev)
        return ev

    # -- checks -----------------------------------------------------------
    def check_event(self, ev: Event) -> List[Issue]:
        issues: List[Issue] = []
        dur = ev.end_ms - ev.start_ms
        if dur <= 0:
            issues.append(
                Issue("non_positive_duration", "error", ev.eid,
                      "字幕时长不为正", ev.start_ms)
            )
        for cut in self.cuts:
            if ev.start_ms < cut < ev.end_ms:
                issues.append(
                    Issue(
                        "crosses_cut",
                        "warning",
                        ev.eid,
                        f"跨过场景切点 {ms_to_timestamp(cut)}；"
                        "导出前需确认是否拆开或锁定",
                        ev.start_ms,
                    )
                )
        total_lines = 0
        any_visible = False
        for lang in self.lang_order:
            rows = ev.rows_for(lang)
            visible = [r for r in rows if r.visible]
            prof = self.profiles.get(lang) or LanguageProfile.default_for(lang)
            line_count = sum(len(r.lines) for r in visible)
            total_lines += line_count
            if visible:
                any_visible = True
            else:
                if ev.rows and dur > 0:
                    issues.append(
                        Issue(
                            "missing_translation",
                            "warning",
                            ev.eid,
                            f"缺少「{prof.label}」译文；已保留其他语言原文",
                            ev.start_ms,
                            lang,
                        )
                    )
                continue
            if dur > 0 and line_count:
                chars = sum(_count_text_chars(r.text) for r in visible)
                cps = chars / (dur / 1000.0)
                if cps > prof.max_cps + 1e-9:
                    issues.append(
                        Issue(
                            "reading_speed",
                            "warning",
                            ev.eid,
                            f"「{prof.label}」阅读速度 {cps:.1f} 字/秒，"
                            f"超过上限 {prof.max_cps:.1f}",
                            ev.start_ms,
                            lang,
                        )
                    )
            if line_count > prof.max_lines:
                issues.append(
                    Issue(
                        "too_many_lang_lines",
                        "warning",
                        ev.eid,
                        f"「{prof.label}」占 {line_count} 行，"
                        f"超过单语上限 {prof.max_lines} 行",
                        ev.start_ms,
                        lang,
                    )
                )
            for r in visible:
                for idx, line in enumerate(r.lines, start=1):
                    if len(line) > prof.max_chars_per_line:
                        issues.append(
                            Issue(
                                "line_too_long",
                                "warning",
                                ev.eid,
                                f"「{prof.label}」第 {idx} 行 {len(line)} 字，"
                                f"超过 {prof.max_chars_per_line} 字",
                                ev.start_ms,
                                lang,
                            )
                        )
        if ev.rows and not any_visible:
            issues.append(
                Issue("empty_event", "warning", ev.eid, "该事件没有可显示的文字",
                      ev.start_ms)
            )
        if total_lines > self.total_lines_budget:
            issues.append(
                Issue(
                    "too_many_lines",
                    "warning",
                    ev.eid,
                    f"合并后共 {total_lines} 行，超过总行数预算 "
                    f"{self.total_lines_budget} 行",
                    ev.start_ms,
                )
            )
        return issues

    def all_issues(self) -> List[Issue]:
        issues: List[Issue] = []
        events = self.sorted_events()
        for idx, ev in enumerate(events):
            issues.extend(self.check_event(ev))
            if idx + 1 < len(events):
                nxt = events[idx + 1]
                if ev.split_group and ev.split_group == nxt.split_group:
                    continue
                if ev.end_ms > nxt.start_ms:
                    issues.append(
                        Issue(
                            "overlap_next",
                            "warning",
                            ev.eid,
                            f"与下一条重叠 {- (nxt.start_ms - ev.end_ms)} ms",
                            ev.start_ms,
                        )
                    )
                else:
                    gap = nxt.start_ms - ev.end_ms
                    if gap < self.min_gap_ms:
                        issues.append(
                            Issue(
                                "gap_next",
                                "info"
                                if gap == 0
                                else "warning",
                                ev.eid,
                                f"与下一条间隔 {gap} ms，小于 {self.min_gap_ms} ms",
                                ev.start_ms,
                            )
                        )
        issues.sort(key=lambda i: (i.time_ms, SEVERITY_ORDER.get(i.severity, 9), i.kind))
        return issues

    def issues_for_event(self, eid: str) -> List[Issue]:
        return [i for i in self.all_issues() if i.event_id == eid]

    def event_status(self, ev: Event) -> str:
        iss = self.check_event(ev)
        if any(i.severity == "error" for i in iss):
            return "error"
        if any(i.severity == "warning" for i in iss):
            return "warning"
        return "ok"

    def counts(self) -> Dict[str, int]:
        issues = self.all_issues()
        return {
            "events": len(self.events),
            "errors": sum(1 for i in issues if i.severity == "error"),
            "warnings": sum(1 for i in issues if i.severity == "warning"),
            "infos": sum(1 for i in issues if i.severity == "info"),
            "locked": sum(1 for e in self.events if e.locked),
        }

    # -- tidy / reflow ----------------------------------------------------
    def tidy_timings(self, acknowledge: bool = False) -> TimeChangeResult:
        """Resolve overlaps by pushing *unlocked* events later, in order.

        Processing runs left to right and each shift is measured against the
        already-updated previous event, so chains of overlaps are fully
        resolved.  Locked events are never touched.  A shift that would cross
        a scene cut or push into a locked neighbour is reported, and nothing
        is applied unless *acknowledge* is true.
        """
        events = self.sorted_events()
        plans: List[Tuple[Event, int, int]] = []
        warnings: List[str] = []
        occupied_end: Optional[int] = None
        occupied_split = ""
        for ev in events:
            if occupied_end is not None:
                same_group = bool(
                    occupied_split and ev.split_group == occupied_split
                )
                if not same_group and ev.start_ms < occupied_end + self.min_gap_ms:
                    delta = occupied_end + self.min_gap_ms - ev.start_ms
                    if ev.locked:
                        warnings.append(
                            f"{ms_to_timestamp(ev.start_ms)} 的字幕已锁定，"
                            f"无法为前一条让出 {delta} ms"
                        )
                    else:
                        new_start, new_end = ev.start_ms + delta, ev.end_ms + delta
                        cut_blocked = any(
                            new_start < c < new_end
                            and not (ev.start_ms < c < ev.end_ms)
                            for c in self.cuts
                        )
                        if cut_blocked:
                            warnings.append(
                                f"顺延 {ms_to_timestamp(ev.start_ms)} 的字幕"
                                "会跨过场景切点"
                            )
                        plans.append((ev, new_start, new_end))
                        occupied_end = new_end
                        occupied_split = ev.split_group
                        continue
            occupied_end = ev.end_ms
            occupied_split = ev.split_group
        if not plans:
            return TimeChangeResult(True, warnings)
        if warnings and not acknowledge:
            return TimeChangeResult(False, warnings)
        for ev, ns, ne in plans:
            ev.start_ms, ev.end_ms = ns, ne
        self.sort_events()
        return TimeChangeResult(True, warnings)

    # -- serialisation ----------------------------------------------------
    def to_dict(self) -> dict:
        return {
            "format": "subtitle-reflow/1",
            "lang_order": self.lang_order,
            "profiles": {k: v.to_dict() for k, v in self.profiles.items()},
            "tracks": {k: v.to_dict() for k, v in self.tracks.items()},
            "cuts": self.cuts,
            "events": [e.to_dict() for e in self.sorted_events()],
            "total_lines_budget": self.total_lines_budget,
            "min_gap_ms": self.min_gap_ms,
            "pair_tolerance_ms": self.pair_tolerance_ms,
            "next_id": self.next_id,
        }

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), ensure_ascii=False, indent=2)

    @classmethod
    def from_dict(cls, data: dict) -> "Project":
        project = cls(
            data.get("lang_order", []),
            {
                k: LanguageProfile.from_dict(v)
                for k, v in data.get("profiles", {}).items()
            },
        )
        project.tracks = {
            k: Track.from_dict(v) for k, v in data.get("tracks", {}).items()
        }
        project.cuts = sorted(int(c) for c in data.get("cuts", []))
        project.events = [Event.from_dict(e) for e in data.get("events", [])]
        project.total_lines_budget = int(data.get("total_lines_budget", 2))
        project.min_gap_ms = int(data.get("min_gap_ms", 40))
        project.pair_tolerance_ms = int(data.get("pair_tolerance_ms", 1400))
        project.next_id = int(data.get("next_id", 1))
        for ev in project.events:
            if ev.eid.startswith("ev") and ev.eid[2:].isdigit():
                project.next_id = max(project.next_id, int(ev.eid[2:]) + 1)
        project.sort_events()
        return project

    @classmethod
    def from_json(cls, text: str) -> "Project":
        return cls.from_dict(json.loads(text))

    def clone(self) -> "Project":
        return copy.deepcopy(self)
