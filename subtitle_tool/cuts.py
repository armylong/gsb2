"""Scene-cut helpers: map cue boundaries to cuts and split there."""

from __future__ import annotations

from typing import List, Optional, Tuple

from .model import Event, Project
from .srt import ms_to_timestamp


def cuts_inside(project: Project, ev: Event) -> List[int]:
    return [c for c in project.cuts if ev.start_ms < c < ev.end_ms]


def nearest_cut(project: Project, ev: Event) -> Optional[int]:
    inside = cuts_inside(project, ev)
    if not inside:
        return None
    mid = (ev.start_ms + ev.end_ms) / 2
    return min(inside, key=lambda c: abs(c - mid))


def move_event_off_cuts(
    project: Project, ev: Event, mode: str = "shrink"
) -> Tuple[bool, str]:
    """Remove cut points from an event's span without touching neighbours.

    ``shrink`` trims the side that loses less text (uses cue origins when
    available); ``shift`` slides the whole event to the closer side of the cut.
    The event's split_group is preserved so its partner rows stay associated.
    """
    if ev.locked:
        return False, "该事件已锁定"
    inside = cuts_inside(project, ev)
    if not inside:
        return False, "该事件没有跨切点"
    cut = nearest_cut(project, ev)
    assert cut is not None
    if mode == "shift":
        left = cut - ev.start_ms
        right = ev.end_ms - cut
        prefs = []
        if left <= right:
            prefs = [-(left + project.min_gap_ms), right + project.min_gap_ms]
        else:
            prefs = [right + project.min_gap_ms, -(left + project.min_gap_ms)]
        for shift in prefs:
            new_start, new_end = ev.start_ms + shift, ev.end_ms + shift
            if new_start < 0:
                continue
            blocked = False
            for other in project.events:
                if other is ev:
                    continue
                if not (other.end_ms <= new_start or other.start_ms >= new_end):
                    blocked = True
                    break
            if blocked:
                continue
            if any(new_start < c < new_end for c in project.cuts):
                continue
            ev.start_ms, ev.end_ms = new_start, new_end
            project.sort_events()
            return True, (
                f"已整体移动 {-shift:+d} ms 到切点 {ms_to_timestamp(cut)} 的一侧"
            )
        return False, "两侧都没有空位可整体移动，请改用收拢或拆分"
    # shrink: prefer keeping the full duration, so trim the side with more air
    if cut - ev.start_ms >= ev.end_ms - cut:
        ev.start_ms = cut
    else:
        ev.end_ms = cut
    project.sort_events()
    return True, f"已收拢到切点 {ms_to_timestamp(cut)} 的一侧"


def split_at_cut(
    project: Project, ev: Event, cut: Optional[int] = None
) -> Tuple[Optional[str], str]:
    inside = cuts_inside(project, ev)
    if not inside:
        return None, "该事件没有跨切点"
    cut = cut if cut in inside else nearest_cut(project, ev)
    assert cut is not None
    return project.split_event(ev.eid, cut)
