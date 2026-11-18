"""纯时间数学: 帧信息、选帧、重叠区间。不依赖 Qt / ffmpeg, 可独立单测。"""
from __future__ import annotations

import bisect
from dataclasses import dataclass

EPS = 1e-6

# 需求约束
MAX_DURATION_SECONDS = 15.0
MAX_HEIGHT = 720
MAX_WIDTH = 1280


@dataclass(frozen=True)
class VideoInfo:
    """一段视频的静态信息(帧 PTS 表是后续所有选帧的唯一依据)。"""

    path: str
    width: int
    height: int
    duration: float
    pts: tuple[float, ...]
    has_audio: bool
    frame_rate_nominal: float | None

    @property
    def frame_count(self) -> int:
        return len(self.pts)

    @property
    def avg_interval(self) -> float:
        if len(self.pts) >= 2:
            return (self.pts[-1] - self.pts[0]) / (len(self.pts) - 1)
        return 0.0

    @property
    def is_variable_frame_rate(self) -> bool:
        if len(self.pts) < 3:
            return False
        intervals = [self.pts[i + 1] - self.pts[i] for i in range(len(self.pts) - 1)]
        avg = sum(intervals) / len(intervals)
        return max(intervals) - min(intervals) > 0.25 * avg


@dataclass(frozen=True)
class FrameChoice:
    """一次选帧请求的结果。

    within=False 时 index/pts 为 None, reason 给出越界原因:
    'before' 请求早于首帧; 'after' 请求不早于时长(内容已结束); 'no-frames' 空流。
    """

    request_time: float
    index: int | None
    pts: float | None
    within: bool
    reason: str | None

    @property
    def lag(self) -> float | None:
        """请求时间与实际选中帧时间之差, 恒 >= 0 且小于一个帧间隔。"""
        if self.pts is None:
            return None
        return self.request_time - self.pts


def choose_frame(info: VideoInfo, request_time: float) -> FrameChoice:
    """按 floor 规则选帧: 不晚于 request_time 的最近帧。

    内容区间按半开 [0, duration) 处理: 请求恰好到达 duration 即视为结束,
    不允许停在末帧伪装仍在同步。
    """
    pts = info.pts
    if not pts:
        return FrameChoice(request_time, None, None, False, "no-frames")

    if request_time < pts[0] - EPS:
        return FrameChoice(request_time, None, None, False, "before")
    if request_time >= info.duration - EPS:
        return FrameChoice(request_time, None, None, False, "after")

    idx = bisect.bisect_right(pts, request_time + EPS) - 1
    if idx < 0:
        return FrameChoice(request_time, None, None, False, "before")
    return FrameChoice(request_time, idx, pts[idx], True, None)


def overlap_interval(
    duration_a: float, duration_b: float, offset: float
) -> tuple[float, float] | None:
    """计算主时间轴上两边内容都有效的重叠区间 [lo, hi)。

    B 在主时间 t 处有效等价于 0 <= t + offset < duration_b,
    即 t 属于 [-offset, duration_b - offset); 与 A 的 [0, duration_a) 取交。
    没有正长度重叠时返回 None(此时禁止启动循环, 但仍允许调整偏移)。
    """
    lo = max(0.0, -offset)
    hi = min(duration_a, duration_b - offset)
    if hi - lo <= EPS:
        return None
    return lo, hi


def wrap_into(value: float, lo: float, hi: float) -> float:
    """把主时间折回半开循环区间 [lo, hi)。"""
    if hi <= lo:
        return lo
    span = hi - lo
    return lo + ((value - lo) % span)


def format_time(value: float | None) -> str:
    """mm:ss.mmm 格式; None 显示占位符。"""
    if value is None:
        return "--:--.---"
    value = max(0.0, value)
    minutes, seconds = divmod(value, 60.0)
    return f"{int(minutes):02d}:{seconds:06.3f}"


def validate(info: VideoInfo) -> list[str]:
    """需求约束校验, 返回问题字符串列表(空列表表示通过)。"""
    problems: list[str] = []
    if info.duration > MAX_DURATION_SECONDS + 0.5:
        problems.append(
            f"时长 {info.duration:.2f}s 超过上限 {MAX_DURATION_SECONDS}s"
        )
    if info.height > MAX_HEIGHT or info.width > MAX_WIDTH:
        problems.append(
            f"分辨率 {info.width}x{info.height} 超过 720p 上限"
            f"({MAX_WIDTH}x{MAX_HEIGHT})"
        )
    if info.frame_count == 0:
        problems.append("视频流中没有可解码的帧")
    return problems
