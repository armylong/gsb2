"""分段模型、校验与 源时间 <-> 输出时间 双向映射。

边界归属约定（左右两侧一致，任何时刻都有且仅有一个归属段）：
  - 源侧：每段为左闭右开区间 [start, end)，最后一段右端点包含在内。
  - 输出侧：同样左闭右开 [out_start, out_end)，最后一段右端点包含在内。
  - 由于分段在源侧连续无缝，边界处无论从哪一侧映射都得到同一个源时间点，
    不存在重复归属或无法定位的时间。
"""
from __future__ import annotations

from dataclasses import dataclass

MAX_SEGMENTS = 5
MIN_SPEED = 0.5
MAX_SPEED = 2.0
EPS = 1e-6  # 浮点容差（秒）


class SegmentError(ValueError):
    """分段参数不合法，message 为可直接展示的中文提示。"""


@dataclass
class Segment:
    start: float  # 源起点（含）
    end: float    # 源终点（不含；最后一段含）
    speed: float  # 速度倍率，[0.5, 2.0]


@dataclass
class PlanRow:
    index: int
    src_start: float
    src_end: float
    speed: float
    out_start: float
    out_end: float

    @property
    def src_len(self) -> float:
        return self.src_end - self.src_start

    @property
    def out_len(self) -> float:
        return self.out_end - self.out_start

    def as_dict(self) -> dict:
        return {
            "index": self.index,
            "src_start": self.src_start,
            "src_end": self.src_end,
            "speed": self.speed,
            "out_start": self.out_start,
            "out_end": self.out_end,
            "src_len": self.src_len,
            "out_len": self.out_len,
        }


def validate(segments: list[Segment], duration: float) -> list[Segment]:
    """校验分段，返回按源时间排序且边界吸附后的列表；不合法抛 SegmentError。"""
    if not segments:
        raise SegmentError("至少需要一个分段")
    if len(segments) > MAX_SEGMENTS:
        raise SegmentError(f"最多支持 {MAX_SEGMENTS} 个分段，当前 {len(segments)} 个")

    for i, s in enumerate(segments):
        if s.end - s.start <= EPS:
            raise SegmentError(
                f"第 {i + 1} 段长度为零或为负（{s.start:.3f} ~ {s.end:.3f}），每段必须大于 0 秒"
            )
        if not (MIN_SPEED - EPS <= s.speed <= MAX_SPEED + EPS):
            raise SegmentError(
                f"第 {i + 1} 段速度 {s.speed} 超出允许范围 [{MIN_SPEED}, {MAX_SPEED}]"
            )
        if s.start < -EPS or s.end > duration + EPS:
            raise SegmentError(
                f"第 {i + 1} 段（{s.start:.3f} ~ {s.end:.3f}）超出源片范围 [0, {duration:.3f}]"
            )

    segs = sorted(segments, key=lambda s: s.start)

    if segs[0].start > EPS:
        raise SegmentError(
            f"分段必须从 0 开始，当前首段从 {segs[0].start:.3f} 开始，开头存在空洞"
        )
    for i in range(1, len(segs)):
        prev, cur = segs[i - 1], segs[i]
        if cur.start < prev.end - EPS:
            raise SegmentError(
                f"第 {i} 段与第 {i + 1} 段重叠：前一段结束于 {prev.end:.3f}，后一段从 {cur.start:.3f} 开始"
            )
        if cur.start > prev.end + EPS:
            raise SegmentError(
                f"第 {i} 段与第 {i + 1} 段之间存在空洞：{prev.end:.3f} ~ {cur.start:.3f} 未被覆盖"
            )
    if abs(segs[-1].end - duration) > EPS:
        raise SegmentError(
            f"分段必须完整覆盖原片：末段结束于 {segs[-1].end:.3f}，原片时长 {duration:.3f}"
        )

    # 吸附微小浮点误差，保证严格连续
    segs[0].start = 0.0
    for i in range(1, len(segs)):
        segs[i].start = segs[i - 1].end
    segs[-1].end = duration
    return segs


def build_plan(segments: list[Segment], duration: float) -> list[PlanRow]:
    """校验并计算每段的输出起止时间（累计 源长/速度）。"""
    segs = validate(segments, duration)
    plan: list[PlanRow] = []
    t = 0.0
    for i, s in enumerate(segs):
        out_len = (s.end - s.start) / s.speed
        plan.append(PlanRow(i, s.start, s.end, s.speed, t, t + out_len))
        t += out_len
    return plan


def total_duration(plan: list[PlanRow]) -> float:
    return plan[-1].out_end


def src_to_out(plan: list[PlanRow], t: float) -> float:
    """源时间 -> 输出时间。边界属于后一段，但两侧结果相同。"""
    last = plan[-1]
    if t < -EPS or t > last.src_end + EPS:
        raise SegmentError(f"源时间 {t:.3f} 超出范围 [0, {last.src_end:.3f}]")
    t = min(max(t, 0.0), last.src_end)
    for row in plan:
        if t < row.src_end or row is last:
            return row.out_start + (t - row.src_start) / row.speed
    raise AssertionError("unreachable")


def out_to_src(plan: list[PlanRow], t: float) -> float:
    """输出时间 -> 源时间。边界属于后一段，但两侧结果相同。"""
    last = plan[-1]
    if t < -EPS or t > last.out_end + EPS:
        raise SegmentError(f"输出时间 {t:.3f} 超出范围 [0, {last.out_end:.3f}]")
    t = min(max(t, 0.0), last.out_end)
    for row in plan:
        if t < row.out_end or row is last:
            return row.src_start + (t - row.out_start) * row.speed
    raise AssertionError("unreachable")


def locate(plan: list[PlanRow], t: float, side: str) -> tuple[int, float]:
    """返回 (段号, 映射后时间)。side 为 'src' 或 'out'。"""
    if side == "src":
        out = src_to_out(plan, t)
        idx = next(r.index for r in plan if t < r.src_end or r is plan[-1])
        return idx, out
    if side == "out":
        src = out_to_src(plan, t)
        idx = next(r.index for r in plan if t < r.out_end or r is plan[-1])
        return idx, src
    raise ValueError(f"unknown side: {side}")
