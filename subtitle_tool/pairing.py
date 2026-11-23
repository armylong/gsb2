"""Pairing suggestions for two independently timed subtitle tracks.

Cues are linked by time overlap into connected components.  A component with
one cue on each side is a pair (possibly with slightly different boundaries);
one cue on one side against several on the other is a split; a component with
cues on only one side is an untranslated run.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Optional, Sequence, Tuple

from .model import CueRef, Event, Project, Row
from .srt import ms_to_timestamp, overlap_ratio, time_overlap


@dataclass
class PairingSuggestion:
    kind: str  # "pair" | "split" | "missing"
    anchor_lang: str
    other_lang: str
    anchor_uids: List[str]
    other_uids: List[str]
    score: float
    reason: str
    start_ms: int
    end_ms: int

    @property
    def uids(self) -> List[str]:
        return self.anchor_uids + self.other_uids

    @property
    def label(self) -> str:
        n_a, n_b = len(self.anchor_uids), len(self.other_uids)
        if self.kind == "missing":
            return "缺翻译"
        if n_a == 1 and n_b == 1:
            return "1:1 配对"
        return f"{n_a}:{n_b} 拆分"

    def to_dict(self) -> dict:
        return {
            "kind": self.kind,
            "anchor_lang": self.anchor_lang,
            "other_lang": self.other_lang,
            "anchor_uids": self.anchor_uids,
            "other_uids": self.other_uids,
            "score": round(self.score, 3),
            "label": self.label,
            "reason": self.reason,
            "start": ms_to_timestamp(self.start_ms),
            "end": ms_to_timestamp(self.end_ms),
        }


def _find(components: Dict[str, int], x: str) -> int:
    while components[x] != x:
        components[x] = components[components[x]]
        x = components[x]
    return x


def _union(components: Dict[str, int], a: str, b: str) -> None:
    ra, rb = _find(components, a), _find(components, b)
    if ra != rb:
        components[rb] = ra


def _cue_gap(a: CueRef, b: CueRef) -> int:
    """Silence between two cues in ms (0 when they overlap)."""
    return max(0, max(b.start_ms - a.end_ms, a.start_ms - b.end_ms))


def _cue_center(c: CueRef) -> float:
    return (c.start_ms + c.end_ms) / 2.0


def overlapping_components(
    a_cues: Sequence[CueRef],
    b_cues: Sequence[CueRef],
    min_link: float = 0.30,
    max_gap_ms: int = 400,
) -> List[Tuple[List[CueRef], List[CueRef]]]:
    """Group cues from both tracks into time-overlap components.

    Two cues are linked when they overlap enough (relative to the shorter cue),
    or when they merely sit next to each other across a small gap *and* are
    each other's nearest cue.  The gap rule catches subtitle boundaries that
    slipped apart by a few frames without chaining a whole track together the
    way a plain "any nearby cue" rule would.
    """
    rank: Dict[str, int] = {}
    for cue in list(a_cues) + list(b_cues):
        rank[cue.uid] = len(rank)
    parent = {uid: uid for uid in rank}
    for ca in a_cues:
        for cb in b_cues:
            if (
                overlap_ratio(ca.start_ms, ca.end_ms, cb.start_ms, cb.end_ms)
                >= min_link
            ):
                _union(parent, ca.uid, cb.uid)

    # nearest neighbours, used only for the small-gap rule
    nearest_a = {}
    for ca in a_cues:
        if b_cues:
            nearest_a[ca.uid] = min(
                b_cues, key=lambda c: abs(_cue_center(c) - _cue_center(ca))
            ).uid
    nearest_b = {}
    for cb in b_cues:
        if a_cues:
            nearest_b[cb.uid] = min(
                a_cues, key=lambda c: abs(_cue_center(c) - _cue_center(cb))
            ).uid
    for ca in a_cues:
        for cb in b_cues:
            if _cue_gap(ca, cb) > max_gap_ms:
                continue
            if nearest_a.get(ca.uid) == cb.uid and nearest_b.get(cb.uid) == ca.uid:
                _union(parent, ca.uid, cb.uid)

    groups: Dict[int, Tuple[List[CueRef], List[CueRef]]] = {}
    for cue in a_cues:
        root = _find(parent, cue.uid)
        groups.setdefault(root, ([], []))[0].append(cue)
    for cue in b_cues:
        root = _find(parent, cue.uid)
        groups.setdefault(root, ([], []))[1].append(cue)
    result = []
    for root in sorted(groups, key=lambda r: rank[next(iter(
        [c.uid for c in groups[r][0]] + [c.uid for c in groups[r][1]]
    ))]):
        a_list, b_list = groups[root]
        a_list.sort(key=lambda c: (c.start_ms, c.end_ms))
        b_list.sort(key=lambda c: (c.start_ms, c.end_ms))
        result.append((a_list, b_list))
    return result


def _boundary_delta(ca: CueRef, cb: CueRef) -> int:
    return max(abs(ca.start_ms - cb.start_ms), abs(ca.end_ms - cb.end_ms))


def _component_score(a_cues: Sequence[CueRef], b_cues: Sequence[CueRef]) -> float:
    if not a_cues or not b_cues:
        return 0.0
    ratios = []
    for ca in a_cues:
        best = 0.0
        for cb in b_cues:
            best = max(
                best,
                overlap_ratio(ca.start_ms, ca.end_ms, cb.start_ms, cb.end_ms),
            )
        ratios.append(best)
    for cb in b_cues:
        best = 0.0
        for ca in a_cues:
            best = max(
                best,
                overlap_ratio(ca.start_ms, ca.end_ms, cb.start_ms, cb.end_ms),
            )
        ratios.append(best)
    overlap_score = sum(ratios) / len(ratios)
    a_span = (min(c.start_ms for c in a_cues), max(c.end_ms for c in a_cues))
    b_span = (min(c.start_ms for c in b_cues), max(c.end_ms for c in b_cues))
    delta = max(
        abs(a_span[0] - b_span[0]), abs(a_span[1] - b_span[1])
    )
    closeness = max(0.0, 1.0 - delta / 2000.0)
    return 0.65 * overlap_score + 0.35 * closeness


def build_pairing_suggestions(
    project: Project,
    anchor_lang: Optional[str] = None,
    min_score: float = 0.0,
    skip_used: bool = False,
) -> List[PairingSuggestion]:
    """Suggest how cues from the two tracks should be paired.

    The result is derived from the imported tracks, so it stays valid no
    matter which events have already been created.  With *skip_used* every
    component touching a cue that already appears in an event is omitted —
    used by 「重建未锁定」 so locked pairings keep their cues.
    """
    langs = [l for l in project.lang_order if project.tracks.get(l)]
    for extra in project.tracks:
        if extra not in langs:
            langs.append(extra)
    if len(langs) < 2:
        return []
    anchor_lang = anchor_lang or langs[0]
    other_lang = next(l for l in langs if l != anchor_lang)
    a_cues = project.tracks[anchor_lang].cues
    b_cues = project.tracks[other_lang].cues
    if not a_cues or not b_cues:
        return []
    used = project.used_origins() if skip_used else set()

    aligned: List[PairingSuggestion] = []
    for a_list, b_list in overlapping_components(a_cues, b_cues):
        if used and any(
            c.uid in used for c in list(a_list) + list(b_list)
        ):
            continue
        start = min([c.start_ms for c in a_list + b_list])
        end = max([c.end_ms for c in a_list + b_list])
        score = _component_score(a_list, b_list)
        if not b_list:
            for ca in a_list:
                if ca.uid in used:
                    continue
                aligned.append(
                    PairingSuggestion(
                        "missing",
                        anchor_lang,
                        other_lang,
                        [ca.uid],
                        [],
                        0.25,
                        f"{ms_to_timestamp(ca.start_ms)} 的{project.lang_label(anchor_lang)}"
                        f"字幕在{project.lang_label(other_lang)}轨没有重叠内容",
                        ca.start_ms,
                        ca.end_ms,
                    )
                )
            continue
        if not a_list:
            for cb in b_list:
                if cb.uid in used:
                    continue
                aligned.append(
                    PairingSuggestion(
                        "missing",
                        anchor_lang,
                        other_lang,
                        [],
                        [cb.uid],
                        0.25,
                        f"{ms_to_timestamp(cb.start_ms)} 的{project.lang_label(other_lang)}"
                        f"字幕在{project.lang_label(anchor_lang)}轨没有重叠内容",
                        cb.start_ms,
                        cb.end_ms,
                    )
                )
            continue
        kind = "pair" if len(a_list) == 1 and len(b_list) == 1 else "split"
        if kind == "pair":
            delta = _boundary_delta(a_list[0], b_list[0])
            reason = (
                f"两边时间重叠，{a_list[0].uid} 与 {b_list[0].uid} "
                f"边界相差 {delta} ms"
            )
        else:
            reason = (
                f"{len(a_list)} 条{project.lang_label(anchor_lang)} 对 "
                f"{len(b_list)} 条{project.lang_label(other_lang)}，"
                "应用时按较密一侧切分，另一侧文字按时间比例拆开并标为关联"
            )
        if score >= min_score:
            aligned.append(
                PairingSuggestion(
                    kind,
                    anchor_lang,
                    other_lang,
                    [c.uid for c in a_list],
                    [c.uid for c in b_list],
                    score,
                    reason,
                    start,
                    end,
                )
            )
    aligned.sort(key=lambda s: (s.start_ms, s.end_ms))
    return aligned


# ---------------------------------------------------------------------------
# Applying suggestions
# ---------------------------------------------------------------------------


def _aligned_span(
    anchors: Sequence[CueRef],
    others: Sequence[CueRef],
    align: str,
) -> Tuple[int, int]:
    a_span = (min(c.start_ms for c in anchors), max(c.end_ms for c in anchors))
    b_span = (min(c.start_ms for c in others), max(c.end_ms for c in others))
    if align == "anchor":
        return a_span
    if align == "other":
        return b_span
    return (min(a_span[0], b_span[0]), max(a_span[1], b_span[1]))


def _split_text_by_weights(
    text: str, weights: Sequence[float]
) -> List[str]:
    from .textsplit import split_text_by_weights

    return split_text_by_weights(text, weights)


def apply_suggestion(
    project: Project,
    suggestion: PairingSuggestion,
    align: str = "anchor",
    lock: bool = False,
) -> List[str]:
    """Create events for *suggestion*; returns the new event ids.

    For a split component the denser side defines the event boundaries; text
    on the sparser side is divided by time and every produced event shares a
    ``split_group`` so the relation stays visible and can be unlocked/edited.
    """
    cues = project.all_cues()
    a_cues = [cues[u] for u in suggestion.anchor_uids if u in cues]
    b_cues = [cues[u] for u in suggestion.other_uids if u in cues]
    a_cues.sort(key=lambda c: (c.start_ms, c.end_ms))
    b_cues.sort(key=lambda c: (c.start_ms, c.end_ms))
    created: List[str] = []

    if suggestion.kind == "missing":
        for cue in a_cues:
            ev = Event(
                project.new_event_id(),
                cue.start_ms,
                cue.end_ms,
                [
                    Row(cue.lang, cue.text, cue.uid),
                    Row(suggestion.other_lang, "", missing=True),
                ],
                locked=lock,
                note="缺少另一语言译文，保留原文",
            )
            project.add_event(ev)
            created.append(ev.eid)
        for cue in b_cues:
            ev = Event(
                project.new_event_id(),
                cue.start_ms,
                cue.end_ms,
                [
                    Row(suggestion.anchor_lang, "", missing=True),
                    Row(cue.lang, cue.text, cue.uid),
                ],
                locked=lock,
                note="缺少另一语言译文，保留原文",
            )
            project.add_event(ev)
            created.append(ev.eid)
        return created

    if len(a_cues) == 1 and len(b_cues) == 1:
        ca, cb = a_cues[0], b_cues[0]
        start, end = _aligned_span(a_cues, b_cues, align)
        ev = Event(
            project.new_event_id(),
            start,
            end,
            [Row(ca.lang, ca.text, ca.uid), Row(cb.lang, cb.text, cb.uid)],
            locked=lock,
        )
        project.add_event(ev)
        return [ev.eid]

    # Choose the denser side to define boundaries.  Ties go to the anchor.
    # Each dense cue becomes one event; sparse text that covers several
    # segments is divided by time share.
    if len(b_cues) > len(a_cues):
        dense, sparse = b_cues, a_cues
    else:
        dense, sparse = a_cues, b_cues

    segments: List[Tuple[int, int]] = [(c.start_ms, c.end_ms) for c in dense]
    # Stretch the outer segments of a run so that the merged event covers the
    # timing the alignment asks for.  Without this a split run shrinks to the
    # denser track and silently loses the first/last few hundred ms of the
    # anchor cue.
    stretch_langs = set()
    if align == "anchor":
        stretch_langs = {suggestion.anchor_lang}
    elif align == "union":
        stretch_langs = {suggestion.anchor_lang, suggestion.other_lang}
    for cue in sparse:
        if cue.lang not in stretch_langs:
            continue
        touched = [
            i for i, (s, e) in enumerate(segments)
            if time_overlap(s, e, cue.start_ms, cue.end_ms) > 0
        ]
        if not touched:
            continue
        first, last = touched[0], touched[-1]
        segments[first] = (min(segments[first][0], cue.start_ms), segments[first][1])
        segments[last] = (segments[last][0], max(segments[last][1], cue.end_ms))
    segments = [(s, e) for s, e in segments if e > s]
    # weights per segment for every sparse cue
    split_parts: Dict[str, List[str]] = {}
    split_needed = False
    for cue in sparse:
        weights = [
            max(1, time_overlap(cue.start_ms, cue.end_ms, s, e))
            for s, e in segments
        ]
        if sum(w > 1 for w in weights) > 1:
            split_needed = True
            split_parts[cue.uid] = _split_text_by_weights(cue.text, weights)
        else:
            split_parts[cue.uid] = [cue.text]
    group = ""
    if split_needed:
        group = f"split-{project.next_id}-{segments[0][0]}"
    ids: List[str] = []
    for i, (s, e) in enumerate(segments):
        rows: List[Row] = []
        for c in dense:
            if time_overlap(c.start_ms, c.end_ms, s, e) > 0:
                rows.append(Row(c.lang, c.text, c.uid))
        for cue in sparse:
            parts = split_parts[cue.uid]
            if len(parts) == 1:
                if time_overlap(cue.start_ms, cue.end_ms, s, e) > 0:
                    rows.append(Row(cue.lang, parts[0], cue.uid))
            else:
                if i < len(parts) and parts[i].strip():
                    rows.append(Row(cue.lang, parts[i], cue.uid))
        # language order for display/export
        rows.sort(key=lambda r: project.lang_order.index(r.lang)
                  if r.lang in project.lang_order else 99)
        ev = Event(
            project.new_event_id(),
            s,
            e,
            rows,
            locked=lock,
            split_group=group,
            note="自动拆分，请核对文字" if group else "",
        )
        project.add_event(ev)
        ids.append(ev.eid)
    created.extend(ids)
    return created


def apply_all_suggestions(
    project: Project,
    suggestions: Sequence[PairingSuggestion],
    align: str = "anchor",
    only_kinds: Optional[Sequence[str]] = None,
) -> List[str]:
    if only_kinds is not None:
        suggestions = [s for s in suggestions if s.kind in only_kinds]
    created: List[str] = []
    for suggestion in suggestions:
        created.extend(apply_suggestion(project, suggestion, align=align))
    project.sort_events()
    return created
