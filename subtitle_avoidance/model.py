"""字幕避让窗口：领域模型与 JSON 工程持久化。"""

from __future__ import annotations

import json
import math
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Iterable


@dataclass(frozen=True)
class Rect:
    """原视频像素坐标系中的矩形。"""

    x: float
    y: float
    w: float
    h: float

    def __post_init__(self) -> None:
        if self.w < 0 or self.h < 0:
            raise ValueError("Rect 的宽高不能为负")

    @property
    def left(self) -> float:
        return self.x

    @property
    def top(self) -> float:
        return self.y

    @property
    def right(self) -> float:
        return self.x + self.w

    @property
    def bottom(self) -> float:
        return self.y + self.h

    @property
    def center_x(self) -> float:
        return self.x + self.w / 2

    @property
    def center_y(self) -> float:
        return self.y + self.h / 2

    def normalized(self) -> "Rect":
        x, w = self.x, self.w
        y, h = self.y, self.h
        if w < 0:
            x += w
            w = -w
        if h < 0:
            y += h
            h = -h
        return Rect(x, y, w, h)

    def rounded(self) -> "Rect":
        x0 = math.floor(self.x)
        y0 = math.floor(self.y)
        x1 = math.ceil(self.right)
        y1 = math.ceil(self.bottom)
        return Rect(x0, y0, max(0, x1 - x0), max(0, y1 - y0))

    def inflated(self, px: float) -> "Rect":
        return Rect(self.x - px, self.y - px, self.w + px * 2, self.h + px * 2)

    def intersects(self, other: "Rect", gap: float = 0.0) -> bool:
        """gap>0 时把间距小于 gap 的两框也视为相碰。

        只膨胀一侧即可：两框边距为 d 时，膨胀 self gap 后恰好会在 d<gap
        时相交；两侧各膨胀 gap 会把容差翻倍。
        """
        a = self.inflated(gap)
        b = other
        return not (
            a.right <= b.left
            or b.right <= a.left
            or a.bottom <= b.top
            or b.bottom <= a.top
        )

    def intersection(self, other: "Rect") -> "Rect | None":
        x = max(self.left, other.left)
        y = max(self.top, other.top)
        r = min(self.right, other.right)
        b = min(self.bottom, other.bottom)
        if r <= x or b <= y:
            return None
        return Rect(x, y, r - x, b - y)

    def contains_point(self, x: float, y: float, margin: float = 0.0) -> bool:
        return (
            self.left - margin <= x <= self.right + margin
            and self.top - margin <= y <= self.bottom + margin
        )

    def clamped_to(self, bounds: "Rect") -> "Rect":
        w = min(self.w, bounds.w)
        h = min(self.h, bounds.h)
        x = min(max(self.x, bounds.left), bounds.right - w)
        y = min(max(self.y, bounds.top), bounds.bottom - h)
        return Rect(x, y, w, h)

    def to_dict(self) -> dict[str, float]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Rect":
        return cls(
            x=float(data["x"]),
            y=float(data["y"]),
            w=float(data["w"]),
            h=float(data["h"]),
        )

    @classmethod
    def from_points(cls, x1: float, y1: float, x2: float, y2: float) -> "Rect":
        return cls(x1, y1, x2 - x1, y2 - y1).normalized()


@dataclass
class Cue:
    id: str
    index: int
    start: float
    end: float
    text: str

    def contains(self, t: float) -> bool:
        return self.start <= t < self.end

    def touches_interval(self, start: float, end: float) -> bool:
        """两个半开区间是否有正长度重叠。"""
        return max(self.start, start) < min(self.end, end)


@dataclass
class Obstacle:
    """用户标出的禁放矩形；时间单位均为秒，区间为 [start, end)。"""

    id: str
    name: str
    rect: Rect
    start: float
    end: float
    color: str = "#ff4d4f"

    def active_at(self, t: float) -> bool:
        return self.start <= t < self.end

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "rect": self.rect.to_dict(),
            "start": self.start,
            "end": self.end,
            "color": self.color,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Obstacle":
        return cls(
            id=str(data["id"]),
            name=str(data.get("name", data["id"])),
            rect=Rect.from_dict(data["rect"]),
            start=float(data["start"]),
            end=float(data["end"]),
            color=str(data.get("color", "#ff4d4f")),
        )


@dataclass(frozen=True)
class Placement:
    cue_id: str
    slot_id: str
    box: Rect
    safe: bool
    manual: bool = False
    collisions: tuple[str, ...] = ()
    checked_obstacle_ids: tuple[str, ...] = ()

    def same_result(self, other: "Placement | None") -> bool:
        if other is None:
            return False
        return (
            self.slot_id == other.slot_id
            and self.box.rounded() == other.box.rounded()
            and self.safe == other.safe
            and self.manual == other.manual
            and self.collisions == other.collisions
            and self.checked_obstacle_ids == other.checked_obstacle_ids
        )


@dataclass
class ConflictIssue:
    cue_id: str
    time: float
    end_time: float
    marker_times: list[float] = field(default_factory=list)
    obstacle_ids: list[str] = field(default_factory=list)
    message: str = ""


@dataclass
class VideoInfo:
    path: str
    width: int
    height: int
    fps: float
    duration: float
    has_audio: bool = False


@dataclass
class Project:
    video_path: str | None = None
    srt_path: str | None = None
    width: int = 1280
    height: int = 720
    fps: float = 30.0
    duration: float = 0.0
    obstacles: list[Obstacle] = field(default_factory=list)
    #: 应用内修改后的字幕会随工程保存；为空时回退读取 srt_path。
    cues: list[dict[str, Any]] = field(default_factory=list)
    #: cue_id -> 人工指定框左上角；框尺寸仍由实际换行结果决定
    manual_positions: dict[str, dict[str, float]] = field(default_factory=dict)
    style: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "version": 1,
            "video_path": self.video_path,
            "srt_path": self.srt_path,
            "width": self.width,
            "height": self.height,
            "fps": self.fps,
            "duration": self.duration,
            "obstacles": [o.to_dict() for o in self.obstacles],
            "cues": list(self.cues),
            "manual_positions": self.manual_positions,
            "style": self.style,
        }

    def save(self, path: str | Path) -> None:
        Path(path).write_text(
            json.dumps(self.to_dict(), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Project":
        return cls(
            video_path=data.get("video_path"),
            srt_path=data.get("srt_path"),
            width=int(data.get("width", 1280)),
            height=int(data.get("height", 720)),
            fps=float(data.get("fps", 30.0)),
            duration=float(data.get("duration", 0.0)),
            obstacles=[Obstacle.from_dict(x) for x in data.get("obstacles", [])],
            cues=[dict(x) for x in data.get("cues", [])],
            manual_positions=dict(data.get("manual_positions", {})),
            style=dict(data.get("style", {})),
        )

    @classmethod
    def load(cls, path: str | Path) -> "Project":
        return cls.from_dict(json.loads(Path(path).read_text(encoding="utf-8")))


def obstacles_at(obstacles: Iterable[Obstacle], t: float) -> list[Obstacle]:
    return [o for o in obstacles if o.active_at(t)]


def time_events(
    cues: Iterable[Cue], obstacles: Iterable[Obstacle]
) -> list[float]:
    values: set[float] = {0.0}
    for c in cues:
        values.add(max(0.0, c.start))
        values.add(max(0.0, c.end))
    for o in obstacles:
        values.add(max(0.0, o.start))
        values.add(max(0.0, o.end))
    return sorted(round(t, 6) for t in values if math.isfinite(t))
