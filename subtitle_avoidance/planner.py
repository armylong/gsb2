"""候选安全位、整条字幕时间窗检查和增量放置。"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable

from .layout import LayoutEngine
from .model import (
    ConflictIssue,
    Cue,
    Obstacle,
    Placement,
    Rect,
    obstacles_at,
)

# 距画面边缘的比例；下方前三个是常用字幕位，上方三个用于避让角板。
DEFAULT_SLOTS: tuple[tuple[str, str, float], ...] = (
    ("bottom_1", "bottom", 0.055),
    ("bottom_2", "bottom", 0.145),
    ("bottom_3", "bottom", 0.235),
    ("top_1", "top", 0.055),
    ("top_2", "top", 0.145),
    ("top_3", "top", 0.235),
)


@dataclass(frozen=True)
class Slot:
    id: str
    zone: str
    edge_ratio: float

    def box_for(self, width: int, height: int, box_w: float, box_h: float) -> Rect:
        margin = height * self.edge_ratio
        x = (width - box_w) / 2
        if self.zone == "bottom":
            y = height - margin - box_h
        else:
            y = margin
        return Rect(x, y, box_w, box_h).rounded()


SLOTS = tuple(Slot(*row) for row in DEFAULT_SLOTS)
SLOT_BY_ID = {s.id: s for s in SLOTS}


@dataclass
class Moment:
    time: float
    cue_id: str | None
    reason: str
    safe_slot_ids: list[str] = field(default_factory=list)


@dataclass
class UpdateOutcome:
    changed_ids: list[str]
    recomputed_ids: list[str]


class PlacementPlanner:
    def __init__(
        self,
        width: int,
        height: int,
        style: dict | None = None,
        slots: tuple[Slot, ...] = SLOTS,
    ):
        self.width = int(width)
        self.height = int(height)
        self.layouts = LayoutEngine(width, height, style)
        self.style = self.layouts.style
        self.slots = slots
        self.gap = float(self.style.get("collision_gap", 2.0))

    def candidate_boxes(self, text: str) -> tuple[object, dict[str, Rect]]:
        laid = self.layouts.layout(text)
        boxes = {
            slot.id: slot.box_for(self.width, self.height, laid.box_w, laid.box_h)
            for slot in self.slots
        }
        return laid, boxes

    def relevant_obstacles(
        self, cue: Cue, obstacles: Iterable[Obstacle]
    ) -> list[Obstacle]:
        # 关键：不是只看字幕开始这一瞬间，而是取整条字幕存活期内任何
        # 时刻出现过的禁放区。这样中途滑入/消失的矩形也会参与检查。
        return [
            o
            for o in obstacles
            if cue.touches_interval(o.start, o.end)
        ]

    def collisions_for_box(
        self, box: Rect, obstacles: Iterable[Obstacle]
    ) -> list[Obstacle]:
        return [o for o in obstacles if box.intersects(o.rect, gap=self.gap)]

    def plan_cue(
        self,
        cue: Cue,
        obstacles: list[Obstacle],
        previous: Placement | None = None,
        manual_position: dict[str, float] | None = None,
    ) -> Placement:
        laid, boxes = self.candidate_boxes(cue.text)
        relevant = self.relevant_obstacles(cue, obstacles)
        checked_ids = tuple(sorted(o.id for o in relevant))

        if manual_position is not None:
            box = Rect(
                float(manual_position["x"]),
                float(manual_position["y"]),
                laid.box_w,
                laid.box_h,
            ).rounded()
            box = box.clamped_to(Rect(0, 0, self.width, self.height))
            collisions = tuple(
                o.id for o in self.collisions_for_box(box, relevant)
            )
            return Placement(
                cue_id=cue.id,
                slot_id="manual",
                box=box,
                safe=not collisions,
                manual=True,
                collisions=collisions,
                checked_obstacle_ids=checked_ids,
            )

        safe: dict[str, tuple[bool, tuple[str, ...]]] = {}
        for slot_id, box in boxes.items():
            hits = tuple(o.id for o in self.collisions_for_box(box, relevant))
            safe[slot_id] = (not hits, hits)

        ordered_ids: list[str] = []
        preferred_box: Rect | None = None
        # 只有上一条确实安全时才“沿用安全位置”；未解决的兜底碰撞位不应成为偏好。
        if previous is not None and previous.safe:
            if not previous.manual and previous.slot_id in boxes:
                ordered_ids.append(previous.slot_id)
            elif previous.slot_id == "previous_position" or previous.manual:
                preferred_box = Rect(
                    previous.box.x, previous.box.y, laid.box_w, laid.box_h
                ).rounded()

        for slot in self.slots:
            if slot.id not in ordered_ids:
                ordered_ids.append(slot.id)

        if preferred_box is not None:
            hits = tuple(
                o.id for o in self.collisions_for_box(preferred_box, relevant)
            )
            if not hits:
                return Placement(
                    cue_id=cue.id,
                    slot_id="previous_position",
                    box=preferred_box,
                    safe=True,
                    collisions=(),
                    checked_obstacle_ids=checked_ids,
                )

        for slot_id in ordered_ids:
            is_safe, hits = safe[slot_id]
            if is_safe:
                return Placement(
                    cue_id=cue.id,
                    slot_id=slot_id,
                    box=boxes[slot_id],
                    safe=True,
                    collisions=(),
                    checked_obstacle_ids=checked_ids,
                )

        # 全部候选都相碰时，给出确定的兜底框和碰撞详情；UI 会要求人工指定。
        fallback_id = self._least_bad_slot(boxes, relevant)
        fallback_box = boxes[fallback_id]
        hits = tuple(o.id for o in self.collisions_for_box(fallback_box, relevant))
        return Placement(
            cue_id=cue.id,
            slot_id=fallback_id,
            box=fallback_box,
            safe=False,
            collisions=hits,
            checked_obstacle_ids=checked_ids,
        )

    def _least_bad_slot(
        self, boxes: dict[str, Rect], obstacles: list[Obstacle]
    ) -> str:
        def score(slot_id: str) -> tuple[int, float, str]:
            box = boxes[slot_id]
            hits = self.collisions_for_box(box, obstacles)
            overlap_area = 0.0
            for o in hits:
                inter = box.intersection(o.rect)
                if inter is not None:
                    overlap_area += inter.w * inter.h
            return len(hits), overlap_area, slot_id

        return min(boxes, key=score)

    def active_cue(self, cues: list[Cue], t: float) -> Cue | None:
        for cue in cues:
            if cue.contains(t):
                return cue
        return None

    def safe_slots_at_time(
        self, cue: Cue, t: float, obstacles: list[Obstacle]
    ) -> tuple[list[str], dict[str, tuple[str, ...]]]:
        _, boxes = self.candidate_boxes(cue.text)
        active = obstacles_at(obstacles, t)
        result: list[str] = []
        collisions: dict[str, tuple[str, ...]] = {}
        for slot_id, box in boxes.items():
            hits = tuple(o.id for o in self.collisions_for_box(box, active))
            collisions[slot_id] = hits
            if not hits:
                result.append(slot_id)
        return result, collisions

    def candidate_change_moments(
        self, cues: list[Cue], obstacles: list[Obstacle], duration: float
    ) -> list[Moment]:
        events = sorted(
            {
                0.0,
                float(duration),
                *(t for c in cues for t in (c.start, c.end)),
                *(t for o in obstacles for t in (o.start, o.end)),
            }
        )
        events = [round(t, 6) for t in events if 0 <= t <= duration]

        def signature(t: float) -> tuple:
            cue = self.active_cue(cues, t)
            if cue is None:
                return (None, ())
            safe, _ = self.safe_slots_at_time(cue, t, obstacles)
            active_ids = tuple(sorted(o.id for o in obstacles_at(obstacles, t)))
            return (cue.id, tuple(safe), active_ids)

        moments: list[Moment] = []
        for i, t in enumerate(events):
            if i == 0:
                left_t = t
            else:
                left_t = (events[i - 1] + t) / 2
            if i + 1 < len(events):
                right_t = (t + events[i + 1]) / 2
            else:
                right_t = t
            left_sig = signature(left_t)
            right_sig = signature(right_t)
            # 边界时刻采用“start 已生效、end 已失效”的右状态。
            at_sig = signature(t + 1e-7 if t < duration else t)
            if left_sig != at_sig or (i < len(events) - 1 and at_sig != right_sig):
                cue = self.active_cue(cues, min(t + 1e-7, max(0, duration - 1e-7)))
                safe: list[str] = []
                if cue is not None:
                    safe, _ = self.safe_slots_at_time(cue, t + 1e-7, obstacles)
                reasons = []
                if any(abs(t - c.start) < 1e-5 for c in cues):
                    reasons.append("字幕开始")
                if any(abs(t - c.end) < 1e-5 for c in cues):
                    reasons.append("字幕结束")
                if any(abs(t - o.start) < 1e-5 for o in obstacles):
                    reasons.append("禁放区开始")
                if any(abs(t - o.end) < 1e-5 for o in obstacles):
                    reasons.append("禁放区消失")
                moments.append(
                    Moment(
                        time=t,
                        cue_id=cue.id if cue else None,
                        reason="、".join(reasons) or "候选安全集变化",
                        safe_slot_ids=safe,
                    )
                )
        # 去重并保证至少能在字幕/禁区事件之间步进。
        dedup: dict[float, Moment] = {m.time: m for m in moments}
        return [dedup[t] for t in sorted(dedup)]

    def detect_conflicts(
        self,
        cues: list[Cue],
        obstacles: list[Obstacle],
        manual_positions: dict[str, dict[str, float]],
        placements: dict[str, Placement],
    ) -> list[ConflictIssue]:
        issues: list[ConflictIssue] = []
        for cue in cues:
            placement = placements.get(cue.id)
            if placement is not None and placement.manual:
                continue
            if placement is not None and placement.safe:
                continue

            relevant = self.relevant_obstacles(cue, obstacles)
            _, boxes = self.candidate_boxes(cue.text)
            any_safe = any(
                not self.collisions_for_box(box, relevant)
                for box in boxes.values()
            )
            if any_safe:
                continue

            markers = [round(cue.start, 6)]
            for o in relevant:
                for t in (o.start, o.end):
                    if cue.start < t < cue.end:
                        markers.append(round(t, 6))
            markers = sorted(set(markers))
            issues.append(
                ConflictIssue(
                    cue_id=cue.id,
                    time=cue.start,
                    end_time=cue.end,
                    marker_times=markers,
                    obstacle_ids=[o.id for o in relevant],
                    message=(
                        f"字幕 {cue.index}（{cue.start:.2f}–{cue.end:.2f}s）"
                        "没有能避开整条时间窗内所有禁放区的候选位"
                    ),
                )
            )
        return issues


class PlacementStore:
    """保存顺序放置结果，并支持单条字幕后的增量传播。"""

    def __init__(
        self,
        width: int,
        height: int,
        cues: list[Cue],
        obstacles: list[Obstacle],
        manual_positions: dict[str, dict[str, float]] | None = None,
        style: dict | None = None,
    ):
        self.planner = PlacementPlanner(width, height, style)
        self.cues = cues
        self.obstacles = obstacles
        # 注意：不能写 `manual_positions or {}`，因为空字典也是合法且会在
        # 之后继续写入的同一个工程状态对象。
        self.manual_positions = {} if manual_positions is None else manual_positions
        self.placements: dict[str, Placement] = {}

    def rebuild(self) -> list[str]:
        changed: list[str] = []
        previous: Placement | None = None
        for cue in self.cues:
            placement = self.planner.plan_cue(
                cue,
                self.obstacles,
                previous,
                self.manual_positions.get(cue.id),
            )
            old = self.placements.get(cue.id)
            if not placement.same_result(old):
                changed.append(cue.id)
            self.placements[cue.id] = placement
            previous = placement
        return changed

    def cue_text_edited(self, cue_id: str) -> UpdateOutcome:
        """从被改字幕开始向后传播；一旦某条结果未变，后续也不会变。"""
        start_index = next(
            (i for i, c in enumerate(self.cues) if c.id == cue_id), None
        )
        if start_index is None:
            return UpdateOutcome([], [])

        changed: list[str] = []
        recomputed: list[str] = []
        previous = (
            self.placements.get(self.cues[start_index - 1].id)
            if start_index > 0
            else None
        )
        for i in range(start_index, len(self.cues)):
            cue = self.cues[i]
            recomputed.append(cue.id)
            old = self.placements.get(cue.id)
            new = self.planner.plan_cue(
                cue,
                self.obstacles,
                previous,
                self.manual_positions.get(cue.id),
            )
            if not new.same_result(old):
                self.placements[cue.id] = new
                changed.append(cue.id)
                previous = new
            else:
                # 输出位置/安全状态完全一致，下一条得到的“上一条安全位”
                # 输入也一致，因此不必继续传播。
                if old is not None:
                    self.placements[cue.id] = old
                break
        return UpdateOutcome(changed, recomputed)

    def refresh_all(self) -> list[str]:
        return self.rebuild()

    def issues(self) -> list[ConflictIssue]:
        return self.planner.detect_conflicts(
            self.cues, self.obstacles, self.manual_positions, self.placements
        )
