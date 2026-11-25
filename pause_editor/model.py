"""停顿整理的核心模型与拼接引擎 (纯 numpy, 不依赖 Qt)。

设计要点
========
1. 所有位置一律用**采样序号** (半开区间 ``[start, end)``), 毫秒只在界面层换算。
2. 两个修改区挨住 (end == start) 或重叠即判冲突; 冲突区整体不参与拼接,
   保证同一段声音绝不会被扣两遍。
3. 区间长度不足"想保留的停顿时长"时, 原样放过 (状态 ``too_short``)。
4. 交叉淡变 (等功率) 严格限制在选中区间内部: 区间外的样本逐帧原样复制,
   响声不会被过渡部分吃掉; 没有过渡空间时退化为原样拼接或硬切并给出告警。
5. 引擎记录完整的"原声区间 -> 成品位置"账本, 支持双向定位与标注重映射。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional, Sequence, Tuple

import numpy as np

# ---- 区间状态 ----------------------------------------------------------------
EDIT = "edit"            # 会被执行
CONFLICT = "conflict"    # 与相邻修改区挨住/重叠, 不动
TOO_SHORT = "too_short"  # 区间短于想保留的长度, 原样放过
INVALID = "invalid"      # 区间本身非法 (空区间/越界等), 不动


@dataclass
class EditRegion:
    """一个手工确认过的修改区 (半开区间, 单位: 采样)。"""

    start: int
    end: int
    keep_ms: float = 120.0          # 想保留的停顿长度 (毫秒)
    enabled: bool = True
    note: str = ""

    def length(self) -> int:
        return int(self.end - self.start)


@dataclass
class Conflict:
    """一对相互挨住或重叠的修改区, 按输入列表的序号给出。"""

    index_a: int
    index_b: int
    start: int
    end: int
    reason: str


@dataclass
class PlannedRegion:
    """build_plan 对单个区间的裁决。"""

    index: int
    region: EditRegion
    status: str
    keep_samples: int = 0
    transition_samples: int = 0          # 实际可用的单侧淡变长度
    requested_transition: int = 0
    warnings: List[str] = field(default_factory=list)


@dataclass
class Segment:
    """一段逐帧原样保留的声音 (原声与成品长度相同, 一一对应)。"""

    src_start: int
    src_end: int
    dst_start: int
    dst_end: int


@dataclass
class Junction:
    """一次交叉淡变在成品中的位置, 以及它在原声里取的两段。"""

    dst_start: int
    dst_end: int
    src_a_start: int   # 淡变块 A (头部, fade-out) 在原声的起点
    src_a_end: int
    src_b_start: int   # 淡变块 B (尾部, fade-in) 在原声的起点
    src_b_end: int
    region_index: int


@dataclass
class DeletedSpan:
    """原声里被实际删掉的一段, 以及成品中对应的拼接位置。"""

    region_index: int
    src_start: int
    src_end: int
    dst_start: int
    dst_end: int       # 硬切时 dst_start == dst_end


@dataclass
class SrcMap:
    """成品某采样对应的原声位置。"""

    src_sample: int
    kind: str                  # keep / junction_a / junction_b
    junction_index: int = -1


@dataclass
class DstMap:
    """原声某采样在成品中的去向。"""

    dst_sample: int
    kind: str                  # keep / junction_a / junction_b / deleted
    region_index: int = -1
    junction_index: int = -1


# ---- 冲突检测 ----------------------------------------------------------------

def find_conflicts(regions: Sequence[EditRegion]) -> List[Conflict]:
    """找出挨住或重叠的区间对。返回按输入序号描述的冲突列表。"""
    order = sorted(range(len(regions)), key=lambda i: (regions[i].start, regions[i].end))
    conflicts: List[Conflict] = []
    for p in range(len(order) - 1):
        i, j = order[p], order[p + 1]
        a, b = regions[i], regions[j]
        if a.end >= b.start:  # 挨住 (==) 或重叠 (>) 都算
            reason = "相互重叠" if a.start < b.end and b.start < a.end else "首尾挨住"
            conflicts.append(
                Conflict(
                    index_a=i,
                    index_b=j,
                    start=min(a.start, b.start),
                    end=max(a.end, b.end),
                    reason=reason,
                )
            )
    return conflicts


def build_plan(
    n_samples: int,
    sample_rate: int,
    regions: Sequence[EditRegion],
    transition_ms: float = 30.0,
) -> List[PlannedRegion]:
    """对全部区间做裁决, 返回与输入等长、同序的计划列表。"""
    conflicts = find_conflicts(regions)
    conflicted: set = set()
    for c in conflicts:
        conflicted.add(c.index_a)
        conflicted.add(c.index_b)

    requested = int(round(transition_ms / 1000.0 * sample_rate))
    plan: List[PlannedRegion] = []
    for i, r in enumerate(regions):
        pr = PlannedRegion(
            index=i, region=r, status=EDIT, requested_transition=max(0, requested)
        )
        start = max(0, min(int(r.start), n_samples))
        end = max(0, min(int(r.end), n_samples))
        if start != r.start or end != r.end:
            pr.warnings.append(f"区间已夹到文件边界 [{start}, {end})")
        if end <= start:
            pr.status = INVALID
            pr.warnings.append("空区间或起止反转, 跳过")
            plan.append(pr)
            continue
        if i in conflicted:
            pr.status = CONFLICT
            plan.append(pr)
            continue

        keep = int(round(float(r.keep_ms) / 1000.0 * sample_rate))
        length = end - start
        if keep >= length:
            pr.status = TOO_SHORT
            pr.keep_samples = length
            pr.warnings.append(
                f"区间长 {length} 采样, 想保留 {keep} 采样; 不足则原样放过"
            )
            plan.append(pr)
            continue

        pr.keep_samples = keep
        half = keep // 2
        # 淡变块必须整个落在区间内部: 单侧淡变不得超过两侧各自保留量
        k_max = min(half, keep - half)
        k = min(max(0, requested), k_max)
        pr.transition_samples = k
        if requested > k_max:
            pr.warnings.append(
                f"过渡 {requested} 采样过长, 限制为 {k} 采样 (保留段内可用空间)"
            )
        if k == 0:
            if keep == 0:
                pr.warnings.append("保留长度为 0, 将硬切 (无过渡样本)")
            else:
                pr.warnings.append("保留段内没有过渡空间, 保留样本原样拼接")
        plan.append(pr)
    return plan


# ---- 拼接引擎 ----------------------------------------------------------------

class EditEngine:
    """执行计划并持有原声<->成品的完整账本。"""

    def __init__(
        self,
        samples: np.ndarray,
        sample_rate: int,
        plan: Sequence[PlannedRegion],
        output: np.ndarray,
        segments: List[Segment],
        junctions: List[Junction],
        deleted: List[DeletedSpan],
        warnings: List[str],
    ):
        self.samples = samples
        self.sample_rate = sample_rate
        self.plan = plan
        self.output = output
        self.segments = segments
        self.junctions = junctions
        self.deleted = deleted
        self.warnings = warnings

    # -- 基本属性 --
    @property
    def n_src(self) -> int:
        return int(self.samples.shape[0])

    @property
    def n_dst(self) -> int:
        return int(self.output.shape[0])

    @property
    def n_channels(self) -> int:
        return int(self.samples.shape[1])

    # -- 成品位置 -> 原声 (1 或 2 个来源) --
    def map_destination(self, dst: int) -> List[SrcMap]:
        d = int(max(0, min(dst, self.n_dst - 1))) if self.n_dst else 0
        for seg in self.segments:
            if seg.dst_start <= d < seg.dst_end:
                return [SrcMap(seg.src_start + (d - seg.dst_start), "keep")]
        for ji, jc in enumerate(self.junctions):
            if jc.dst_start <= d < jc.dst_end:
                off = d - jc.dst_start
                return [
                    SrcMap(jc.src_a_start + off, "junction_a", ji),
                    SrcMap(jc.src_b_start + off, "junction_b", ji),
                ]
        # 落点在硬切点等缝隙上: 取最近的有效位置
        return self._nearest_destination(d)

    def _nearest_destination(self, d: int) -> List[SrcMap]:
        cand: List[Tuple[int, SrcMap]] = []
        for seg in self.segments:
            for dd, ss in ((seg.dst_start, seg.src_start), (seg.dst_end - 1, seg.src_end - 1)):
                cand.append((abs(dd - d), SrcMap(ss, "keep")))
        for jc in self.junctions:
            cand.append((abs(jc.dst_start - d), SrcMap(jc.src_a_start, "junction_a")))
        if not cand:
            return [SrcMap(0, "keep")]
        cand.sort(key=lambda t: t[0])
        return [cand[0][1]]

    # -- 原声位置 -> 成品 --
    def map_source(self, src: int) -> DstMap:
        s = int(max(0, min(src, self.n_src - 1))) if self.n_src else 0
        for ji, jc in enumerate(self.junctions):
            if jc.src_a_start <= s < jc.src_a_end:
                return DstMap(
                    jc.dst_start + (s - jc.src_a_start), "junction_a",
                    jc.region_index, ji,
                )
            if jc.src_b_start <= s < jc.src_b_end:
                return DstMap(
                    jc.dst_start + (s - jc.src_b_start), "junction_b",
                    jc.region_index, ji,
                )
        for seg in self.segments:
            if seg.src_start <= s < seg.src_end:
                return DstMap(seg.dst_start + (s - seg.src_start), "keep")
        for span in self.deleted:
            if span.src_start <= s < span.src_end:
                return DstMap(span.dst_start, "deleted", span.region_index)
        # 理论上不会到这里 (整段原声都被账本覆盖), 兜底夹到最近
        return self._nearest_source(s)

    def _nearest_source(self, s: int) -> DstMap:
        cand: List[Tuple[int, DstMap]] = []
        for seg in self.segments:
            cand.append((abs(seg.src_start - s), DstMap(seg.dst_start, "keep")))
        for span in self.deleted:
            cand.append((
                abs(span.src_start - s),
                DstMap(span.dst_start, "deleted", span.region_index),
            ))
        cand.sort(key=lambda t: t[0])
        return cand[0][1] if cand else DstMap(0, "keep")

    # -- 供界面/导出用 --
    def deleted_count(self) -> int:
        """真正消失、不出现在成品里的原声帧数 (不含交叉淡变的叠加帧)。"""
        return sum(sp.src_end - sp.src_start for sp in self.deleted)

    def total_removed(self) -> int:
        """成品相对原声的总缩短量 = 删除帧 + 交叉淡变叠加帧。"""
        overlay = sum(j.dst_end - j.dst_start for j in self.junctions)
        return self.deleted_count() + overlay

    def is_source_deleted(self, src_sample: int) -> Optional[DeletedSpan]:
        for sp in self.deleted:
            if sp.src_start <= src_sample < sp.src_end:
                return sp
        return None


def apply_edits(samples: np.ndarray, sample_rate: int, plan: Sequence[PlannedRegion]) -> EditEngine:
    """按计划拼接。``samples`` 形状 (n, channels)。只动状态为 ``edit`` 的区间。"""
    if samples.ndim == 1:
        samples = samples[:, None]
    n = samples.shape[0]
    warnings: List[str] = []
    pieces: List[np.ndarray] = []
    segments: List[Segment] = []
    junctions: List[Junction] = []
    deleted: List[DeletedSpan] = []

    editable = sorted(
        (p for p in plan if p.status == EDIT),
        key=lambda p: max(0, min(p.region.start, n)),
    )

    cursor = 0       # 原声消费位置
    d = 0            # 成品写入位置

    def emit_keep(s0: int, s1: int) -> None:
        nonlocal d
        if s1 <= s0:
            return
        pieces.append(samples[s0:s1, :].copy())
        segments.append(Segment(s0, s1, d, d + (s1 - s0)))
        d += s1 - s0

    for pr in editable:
        r = pr.region
        start = max(0, min(int(r.start), n))
        end = max(0, min(int(r.end), n))
        if end <= start:
            continue
        emit_keep(cursor, start)  # 区间外: 逐帧原样

        keep = pr.keep_samples
        half = keep // 2
        head_end = start + half                 # 头部保留块结束
        tail_start = end - (keep - half)        # 尾部保留块开始
        k = pr.transition_samples

        if keep == 0:
            # 硬切: 整个区间消失, 不留过渡样本
            deleted.append(DeletedSpan(pr.index, start, end, d, d))
            cursor = end
            continue
        # 区间内部分区:
        # [start, head_end-k) 原样 | [head_end-k, head_end) fade-out
        # [head_end, tail_start) 删除
        # [tail_start, tail_start+k) fade-in | [tail_start+k, end) 原样
        emit_keep(start, head_end - k)

        if k > 0:
            t = (np.arange(k, dtype=np.float64) + 0.5) / k
            gain_out = np.sqrt(1.0 - t)[:, None]
            gain_in = np.sqrt(t)[:, None]
            head = samples[head_end - k:head_end, :] * gain_out
            tail = samples[tail_start:tail_start + k, :] * gain_in
            js = d
            pieces.append(head + tail)
            je = d + k
            junctions.append(
                Junction(
                    dst_start=js, dst_end=je,
                    src_a_start=head_end - k, src_a_end=head_end,
                    src_b_start=tail_start, src_b_end=tail_start + k,
                    region_index=pr.index,
                )
            )
            # 删除段只记真正消失的帧; 淡变块在 Junction 里单独记账
            deleted.append(DeletedSpan(pr.index, head_end, tail_start, js, je))
            d = je
        else:
            # 无过渡空间: 保留样本原样相接 (都在停顿内, 静音相接无爆音)
            deleted.append(DeletedSpan(pr.index, head_end, tail_start, d, d))

        emit_keep(tail_start + k, end)
        # 整个区间 [start, end) 至此全部处理完 (保留块/淡变块/删除块), 推进消费位置,
        # 否则区间之间的声音会漏出账本
        cursor = end

    emit_keep(cursor, n)
    output = np.vstack(pieces) if pieces else np.zeros((0, samples.shape[1]))
    return EditEngine(samples, sample_rate, plan, output, segments, junctions, deleted, warnings)


# ---- 标注重映射 --------------------------------------------------------------

@dataclass
class RemappedMark:
    label: str
    src_sample: int
    dst_sample: int
    deleted: bool
    region_index: int = -1


def remap_marks(engine: EditEngine, marks: Sequence[Tuple[str, int]]) -> List[RemappedMark]:
    """把原声标注点搬到成品坐标; 落在被删段里的点单独标红, 不影响邻近点。"""
    out: List[RemappedMark] = []
    for label, src in marks:
        m = engine.map_source(int(src))
        out.append(
            RemappedMark(
                label=label,
                src_sample=int(src),
                dst_sample=int(m.dst_sample),
                deleted=(m.kind == "deleted"),
                region_index=m.region_index,
            )
        )
    return out


# ---- 时间格式化 --------------------------------------------------------------

def format_time(sample_rate: int, sample: int) -> str:
    secs = int(sample) / sample_rate
    m, s = divmod(secs, 60.0)
    return f"{int(m):02d}:{s:06.3f}"


def ms_to_samples(sample_rate: int, ms: float) -> int:
    return int(round(float(ms) / 1000.0 * sample_rate))
