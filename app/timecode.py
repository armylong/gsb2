"""时间码核心换算: 帧序号 <-> 素材时间码.

支持三种计数制式:
  - 25 fps 不丢帧 (PAL)
  - 30000/1001 (29.97) 不丢帧 (NDF, 按 30 计数)
  - 30000/1001 (29.97) 丢帧补偿 (DF, 每分钟跳过 2 个帧编号, 整十分钟除外)

所有换算都以「从第一帧数起的帧序号」(0 起) 为准, 时间码只是帧序号的一种写法.
跨午夜时小时数按 24 取模, 另记日期偏移 (day), 显示为 "+1天" 后缀,
因此 23:59:59:24 之后的一帧是 00:00:00:00+1天, 不会被归到片头.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from enum import Enum


class TimecodeError(ValueError):
    """时间码非法, 或命中丢帧补偿跳过的编号."""


class DroppedFrameError(TimecodeError):
    """输入的编号在丢帧补偿制式下不存在 (如 00:01:00;00 / 00:01:00;01)."""


class RateMode(Enum):
    NDF_25 = "25fps 不丢帧"
    NDF_2997 = "29.97 (30000/1001) 不丢帧"
    DF_2997 = "29.97 (30000/1001) 丢帧补偿"

    @property
    def nominal_fps(self) -> int:
        """计数用的整数帧率."""
        return 25 if self is RateMode.NDF_25 else 30

    @property
    def drop(self) -> bool:
        return self is RateMode.DF_2997

    @property
    def separator(self) -> str:
        return ";" if self.drop else ":"

    @property
    def frame_duration(self) -> float:
        """一帧的实际时长(秒), 用于显示相对播放时间."""
        if self is RateMode.NDF_25:
            return 1.0 / 25.0
        return 1001.0 / 30000.0


# 丢帧补偿: 每分钟跳过的编号数 (整十分钟不跳)
_DROP = 2
# 30fps 丢帧制式下, 每 10 分钟实际帧数 = 30*60*10 - 2*9
_FRAMES_PER_10MIN = 30 * 600 - _DROP * 9  # 17982
# 每普通分钟实际帧数
_FRAMES_PER_MIN = 30 * 60 - _DROP  # 1798


@dataclass(frozen=True)
class Timecode:
    """一个具体的时间码读数. day 为跨午夜后的日期偏移 (0 起)."""

    hh: int
    mm: int
    ss: int
    ff: int
    day: int = 0

    def __post_init__(self):
        if not (0 <= self.mm < 60 and 0 <= self.ss < 60 and 0 <= self.hh < 24):
            raise TimecodeError(f"时间码分量越界: {self}")
        if self.ff < 0 or self.day < 0:
            raise TimecodeError(f"时间码分量越界: {self}")


def frame_to_tc(n: int, mode: RateMode) -> Timecode:
    """帧序号 (0 起) -> 时间码."""
    if n < 0:
        raise TimecodeError(f"帧序号不能为负: {n}")
    fps = mode.nominal_fps
    count = n  # 按 nominal_fps 计数的「编号帧数」
    if mode.drop:
        d, m = divmod(n, _FRAMES_PER_10MIN)
        if m < _DROP:
            dropped = 18 * d
        else:
            dropped = 18 * d + _DROP * ((m - _DROP) // _FRAMES_PER_MIN)
        count = n + dropped
    hh, rem = divmod(count, fps * 3600)
    mm, rem = divmod(rem, fps * 60)
    ss, ff = divmod(rem, fps)
    day, hh = divmod(hh, 24)
    return Timecode(hh, mm, ss, ff, day)


def tc_to_frame(tc: Timecode, mode: RateMode) -> int:
    """时间码 -> 帧序号 (0 起). 丢帧制式下命中被跳过的编号会抛 DroppedFrameError."""
    fps = mode.nominal_fps
    if tc.ff >= fps:
        raise TimecodeError(f"帧号 {tc.ff} 超出 {fps}fps 范围")
    if mode.drop and tc.ss == 0 and tc.mm % 10 != 0 and tc.ff < _DROP:
        raise DroppedFrameError(
            f"{format_tc(tc, mode)} 是丢帧补偿跳过的编号, 不存在对应画面 "
            f"(每分钟前两号 {tc.mm:02d}:00;00/{tc.mm:02d}:00;01 被跳过, 整十分钟除外)"
        )
    count = ((tc.day * 24 + tc.hh) * 3600 + tc.mm * 60 + tc.ss) * fps + tc.ff
    if mode.drop:
        total_min = (tc.day * 24 + tc.hh) * 60 + tc.mm
        count -= _DROP * (total_min - total_min // 10)
    return count


def format_tc(tc: Timecode, mode: RateMode) -> str:
    s = f"{tc.hh:02d}:{tc.mm:02d}:{tc.ss:02d}{mode.separator}{tc.ff:02d}"
    if tc.day:
        s += f"+{tc.day}天"
    return s


def format_frame(n: int, mode: RateMode) -> str:
    return format_tc(frame_to_tc(n, mode), mode)


_TC_RE = re.compile(
    r"^\s*(?P<hh>\d{1,3})[:：](?P<mm>\d{1,2})[:：](?P<ss>\d{1,2})[:;；:：]"
    r"(?P<ff>\d{1,2})\s*(?:\+\s*(?P<day>\d+)\s*(?:天|d|D))?\s*$"
)


def parse_tc(text: str, mode: RateMode) -> Timecode:
    """解析用户输入. 接受 HH:MM:SS:FF / HH:MM:SS;FF, 可带 "+1天" 后缀,
    小时允许超过 23 (自动折算成日期偏移)."""
    m = _TC_RE.match(text)
    if not m:
        raise TimecodeError(f"无法识别的时间码: {text!r} (格式 HH:MM:SS:FF, 可带 +1天)")
    hh, mm, ss, ff = (int(m.group(k)) for k in ("hh", "mm", "ss", "ff"))
    day = int(m.group("day") or 0)
    extra, hh = divmod(hh, 24)
    day += extra
    tc = Timecode(hh, mm, ss, ff, day)
    # 借 tc_to_frame 做合法性校验 (帧号范围 / 丢帧跳过编号)
    tc_to_frame(tc, mode)
    return tc


def relative_time(n: int, mode: RateMode) -> str:
    """从第一帧算起的实际播放时长, 即播放器从 0 开始显示的读数."""
    total = n * mode.frame_duration
    hh = int(total // 3600)
    mm = int((total % 3600) // 60)
    ss = total % 60
    return f"{hh:02d}:{mm:02d}:{ss:06.3f}"
