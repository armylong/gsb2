"""盲听轮次会话状态机。

一轮的生命周期:
  idle -> start_round -> listening (X 已随机选定, 可反复试听)
       -> submit (作答, 揭示答案) -> answered -> 下一轮
       -> cancel (整轮取消, 不计分, 不进导出) -> idle

约束:
- 每轮 X 在 A/B 间独立随机选择, 轮内保持不变
- 轮次进行中设置被快照冻结, 换参数只能取消整轮
- 已完成轮次永久保留作答时的设置快照
"""
from __future__ import annotations

import secrets
from dataclasses import asdict, dataclass
from typing import Any


@dataclass(frozen=True)
class SessionSettings:
    setting_a: dict
    setting_b: dict
    source_name: str
    alignment: bool
    loudness_match: bool
    blind: bool


@dataclass
class Round:
    index: int
    x_is: str                    # "A" | "B", 盲听期间对 UI 隐藏
    status: str = "listening"    # listening | answered | canceled
    guess: str | None = None
    correct: bool | None = None
    settings: SessionSettings | None = None
    started_at: str = ""
    answered_at: str = ""

    def to_record(self) -> dict[str, Any]:
        assert self.settings is not None
        return {
            "round": self.index,
            "x_was": self.x_is,
            "guess": self.guess,
            "correct": self.correct,
            "started_at": self.started_at,
            "answered_at": self.answered_at,
            "settings": asdict(self.settings),
        }


class Session:
    def __init__(self, settings: SessionSettings):
        self._settings = settings
        self._rounds: list[Round] = []
        self._current: Round | None = None
        self._seq = 0

    # -- 查询 -------------------------------------------------------------- #
    @property
    def settings(self) -> SessionSettings:
        return self._settings

    @property
    def current(self) -> Round | None:
        return self._current

    @property
    def in_round(self) -> bool:
        return self._current is not None and self._current.status == "listening"

    @property
    def rounds(self) -> list[Round]:
        return list(self._rounds)

    def answered_rounds(self) -> list[Round]:
        return [r for r in self._rounds if r.status == "answered"]

    def score(self) -> tuple[int, int]:
        done = self.answered_rounds()
        hits = sum(1 for r in done if r.correct)
        return hits, len(done)

    # -- 状态转移 ---------------------------------------------------------- #
    def start_round(self, started_at: str) -> Round:
        if self.in_round:
            raise RuntimeError("当前轮次尚未结束")
        self._seq += 1
        rnd = Round(
            index=self._seq,
            # 每轮独立二选一, 用密码学随机源避免任何可预测性
            x_is=secrets.choice(["A", "B"]),
            settings=self._settings,
            started_at=started_at,
        )
        self._rounds.append(rnd)
        self._current = rnd
        return rnd

    def submit(self, guess: str, answered_at: str) -> Round:
        if not self.in_round or self._current is None:
            raise RuntimeError("没有进行中的轮次")
        if guess not in ("A", "B"):
            raise ValueError("guess 必须是 A 或 B")
        rnd = self._current
        rnd.guess = guess
        rnd.correct = guess == rnd.x_is
        rnd.status = "answered"
        rnd.answered_at = answered_at
        self._current = None
        return rnd

    def cancel(self) -> Round:
        if not self.in_round or self._current is None:
            raise RuntimeError("没有进行中的轮次")
        rnd = self._current
        rnd.status = "canceled"
        self._current = None
        return rnd

    # -- 导出 -------------------------------------------------------------- #
    def export_record(self) -> dict[str, Any]:
        """只含已答轮次; 取消/未开始的轮次不计分也不出现。"""
        answered = self.answered_rounds()
        hits, total = self.score()
        return {
            "schema": "blindabx-record/v1",
            "summary": {
                "answered_rounds": total,
                "correct": hits,
                "accuracy": (hits / total) if total else None,
            },
            "rounds": [r.to_record() for r in answered],
        }
