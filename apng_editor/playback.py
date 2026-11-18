"""Qt-free playback clock used by the GUI and the tests.

Loop semantics match the APNG ``num_plays`` field and the UI text:

* ``loop_count == 0``: infinite, the animation only stops when paused;
* ``loop_count == N > 0``: play the whole sequence N times, then stop on the
  last frame.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Sequence


@dataclass
class PlaybackClock:
    durations_ms: list[int] = field(default_factory=list)
    loop_count: int = 0
    index: int = 0
    elapsed_ms: float = 0.0
    plays_completed: int = 0
    playing: bool = False
    finished: bool = False

    def __post_init__(self) -> None:
        self.durations_ms = [int(v) for v in self.durations_ms]
        if any(v <= 0 for v in self.durations_ms):
            raise ValueError("每帧时长必须为正整数毫秒")
        if self.loop_count < 0:
            raise ValueError("循环次数不能为负数")

    @property
    def frame_count(self) -> int:
        return len(self.durations_ms)

    def set_durations(self, durations: Sequence[int]) -> None:
        previous = self.index
        self.durations_ms = [int(v) for v in durations]
        if self.durations_ms:
            self.index = min(previous, len(self.durations_ms) - 1)
        else:
            self.index = 0
            self.pause()
            self.finished = True
        self.elapsed_ms = 0.0

    def set_loop_count(self, count: int) -> None:
        self.loop_count = max(0, int(count))
        if self.loop_count == 0:
            self.finished = False

    def start(self) -> None:
        """Start from frame 0 so finite play counts are unambiguous."""

        if not self.durations_ms:
            self.playing = False
            self.finished = True
            return
        self.index = 0
        self.elapsed_ms = 0.0
        self.plays_completed = 0
        self.playing = True
        self.finished = False

    def pause(self) -> None:
        self.playing = False

    def tick(self, delta_ms: float) -> bool:
        """Advance by ``delta_ms``; return True when the shown frame changed.

        When a finite animation finishes, the clock stays on the last frame
        and ``finished`` becomes True.  Paused clocks never advance.
        """

        if not self.playing or self.finished or not self.durations_ms:
            return False
        if delta_ms < 0:
            raise ValueError("时间增量不能为负数")
        self.elapsed_ms += float(delta_ms)
        changed = False
        guard = 0
        while self.elapsed_ms >= self.durations_ms[self.index]:
            guard += 1
            if guard > 100000:  # defensive: absurdly large delta
                self.elapsed_ms = 0.0
                break
            self.elapsed_ms -= self.durations_ms[self.index]
            if self.index + 1 < len(self.durations_ms):
                self.index += 1
                changed = True
            else:
                self.plays_completed += 1
                if self.loop_count != 0 and self.plays_completed >= self.loop_count:
                    self.index = len(self.durations_ms) - 1
                    self.elapsed_ms = 0.0
                    self.playing = False
                    self.finished = True
                    return True
                self.index = 0
                changed = True
        return changed

    def step(self, delta: int) -> None:
        """Pause and move the selection by ``delta`` frames (clamped)."""

        self.pause()
        if not self.durations_ms:
            return
        self.index = max(0, min(len(self.durations_ms) - 1, self.index + int(delta)))
        self.elapsed_ms = 0.0

    def cycle_label(self) -> str:
        if self.loop_count == 0:
            return f"无限循环 · 已完成 {self.plays_completed} 遍"
        if self.finished:
            return f"已播放 {self.plays_completed}/{self.loop_count} 遍，播放结束"
        return f"第 {self.plays_completed + 1}/{self.loop_count} 遍"
