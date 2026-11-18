"""帧率转换的帧选取规则。

纯 Python 实现, 不依赖 ffmpeg, 可独立单测。UI、导出与核对共用同一份规则,
保证"时间表、预览画面和转换设置"三者永远一致。

公布规则(同时展示在界面的"转换规则"页)
--------------------------------------
1. 时间轴零点 = 第一个可显示画面的显示时间戳。源帧 i 的零点时间
   s_i = pts_i - pts_0, 原始 pts 仍保留在 source_raw_time 中。
2. 输出为恒定帧率 fps, 输出帧 k (k=0,1,...) 的请求时间 t_k = k / fps,
   严格等间距、严格递增。
3. 选取规则(向下取整 / floor): 在所有满足 s_i <= t_k 的源帧中,
   取序号最大的一帧; 即"不晚于请求时刻的最近源帧"。请求落在两帧之间时,
   记录真实选中的帧及前后时间差, 绝不会把请求时间回填成帧时间。
4. 总帧数 N = floor(s_last * fps) + 1, 其中 s_last 是最后一个源帧的
   零点时间。因此输出末帧请求时间 t_{N-1} <= s_last, 不会请求不存在的画面。
5. 边界: 首帧 t_0 = 0 必选源第 0 帧; 末帧选到的是真实存在的源帧。
   输出时长 t_{N-1} 与源跨度 s_last 之差小于一个输出帧 (1/fps)。
6. 连续两个输出帧选中同一源帧即为"重复帧"; 从未被选中的源帧即为"丢弃帧"。
   只做丢帧/重复帧, 不做运动补偿或插帧, 内容播放速度不变。
"""
from __future__ import annotations

import bisect
import math
from dataclasses import dataclass

# 浮点比较容差: 容器时间基量化与十进制解析带来的误差远小于此值
_EPS = 1e-9

RULE_TEXT = __doc__


@dataclass
class OutputFrame:
    """一个输出帧的完整对应关系。"""

    index: int                 # 输出帧序号(0 起)
    out_time: float            # 实际输出时间 = index / fps(严格栅格)
    request_time: float        # 请求时间(规则上等于 out_time, 保留命名以便核对)
    source_index: int          # 实际选中的源帧序号
    source_time: float         # 源帧零点时间
    source_raw_time: float     # 源帧原始 pts
    repeated: bool             # 是否与上一输出帧复用同一源帧
    gap_before: float          # 请求时间 - 选中源帧时间(>=0)
    gap_after: float | None    # 下一源帧时间 - 请求时间(末帧为 None)


@dataclass
class MappingResult:
    fps: int
    frames: list[OutputFrame]
    source_count: int
    source_span: float
    used_indices: set[int]
    unused_indices: list[int]
    repeat_count: int          # 复用源帧的输出帧个数(不含每组首帧)
    source_usage: dict[int, int]   # 源帧 -> 被多少个输出帧使用

    @property
    def output_count(self) -> int:
        return len(self.frames)

    @property
    def output_span(self) -> float:
        """末帧输出时间戳。"""
        return self.frames[-1].out_time if self.frames else 0.0

    @property
    def duration_diff(self) -> float:
        """源跨度与输出末帧时间之差(小于一个输出帧)。"""
        return self.source_span - self.output_span


def select_source(source_zero_ts: list[float], request_time: float) -> int:
    """floor 规则: 返回满足 s_i <= request_time 的最大 i。"""
    i = bisect.bisect_right(source_zero_ts, request_time + _EPS) - 1
    if i < 0:  # 理论上只在异常时间轴下发生, 兜底取首帧
        return 0
    return i


def build_mapping(
    source_zero_ts: list[float],
    source_raw_pts: list[float],
    fps: int,
) -> MappingResult:
    """按公布规则生成完整帧对应表。"""
    if fps <= 0:
        raise ValueError("fps 必须为正整数")
    n = len(source_zero_ts)
    if n == 0:
        raise ValueError("没有源帧")
    s_last = source_zero_ts[-1]
    total = int(math.floor(s_last * fps + _EPS)) + 1

    frames: list[OutputFrame] = []
    usage: dict[int, int] = {}
    prev_source = -1
    repeat_count = 0
    for k in range(total):
        t = k / fps
        i = select_source(source_zero_ts, t)
        repeated = i == prev_source
        if repeated:
            repeat_count += 1
        prev_source = i
        usage[i] = usage.get(i, 0) + 1
        gap_after = (
            source_zero_ts[i + 1] - t if i + 1 < n else None
        )
        frames.append(
            OutputFrame(
                index=k,
                out_time=t,
                request_time=t,
                source_index=i,
                source_time=source_zero_ts[i],
                source_raw_time=source_raw_pts[i],
                repeated=repeated,
                gap_before=t - source_zero_ts[i],
                gap_after=gap_after,
            )
        )

    used = set(usage)
    unused = [i for i in range(n) if i not in used]
    return MappingResult(
        fps=fps,
        frames=frames,
        source_count=n,
        source_span=s_last,
        used_indices=used,
        unused_indices=unused,
        repeat_count=repeat_count,
        source_usage=usage,
    )
