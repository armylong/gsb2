"""逐词时间轴的数据模型与编辑操作.

时间统一为整数毫秒 (ms)。所有编辑操作都在 ``Timeline`` 上完成, UI 只负责
调用它并把返回的 ``OperationResult`` 展示给用户。

不变量:
  * ``entries`` 按时间 (以及文本顺序) 排列;
  * 每个 cue 满足 ``0 <= start <= end <= duration``;
  * **不**强制 cue 之间不重叠 —— 重叠是用户可能故意保留的 (例如两个读音
    叠在一起), 但 ``conflicts()`` 会把它报出来, 供导出前检查。
  * 词的阅读顺序由 ``reading_order`` 记录: 它保存 cue id 的序列, 所以合并/
    拆分/平移都不会悄悄改变「第几个字先读」。默认顺序即条目顺序。
"""

from __future__ import annotations

import copy
import difflib
import json
import os
from dataclasses import dataclass, field
from typing import Iterable, Sequence

FORMAT_NAME = "wordcue-timeline"
FORMAT_VERSION = 1

# 相邻两词间隔小于它时在边界报告里标为「贴边」。逐词打轴里 0 间隔是常态,
# 所以默认 0: 只把重叠算作错误, 贴边仅作为信息展示。
DEFAULT_EPSILON_MS = 0


def ms_to_srt(ms: int) -> str:
    ms = max(0, int(round(ms)))
    h, rem = divmod(ms, 3_600_000)
    m, rem = divmod(rem, 60_000)
    s, milli = divmod(rem, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{milli:03d}"


def srt_to_ms(text: str) -> int:
    text = text.strip().replace(".", ",")
    hms, _, frac = text.partition(",")
    parts = [float(p) for p in hms.split(":")]
    while len(parts) < 3:
        parts.insert(0, 0.0)
    h, m, s = parts[-3:]
    return int(round((h * 3600 + m * 60 + s) * 1000 + (int(frac) if frac else 0)))


def format_ms(ms: int) -> str:
    """1:02.345 形式, 便于阅读。"""
    ms = max(0, int(round(ms)))
    m, rem = divmod(ms, 60_000)
    s, milli = divmod(rem, 1000)
    return f"{m}:{s:02d}.{milli:03d}"


@dataclass
class Cue:
    """一个词 (或一处停顿 / 呼吸) 在音轨上的区间。"""

    id: int
    text: str
    start: int  # ms, 含
    end: int    # ms, 不含 (半开区间), end > start 为有效区间
    kind: str = "word"          # "word" | "pause"
    note: str = ""

    @property
    def duration(self) -> int:
        return self.end - self.start

    @property
    def is_timed(self) -> bool:
        """0 长度视为「尚未打轴」(与 0 毫秒处的空区间区分开, 后者没有意义)。"""
        return self.end > self.start

    def clone(self, **changes) -> "Cue":
        data = dict(id=self.id, text=self.text, start=self.start,
                    end=self.end, kind=self.kind, note=self.note)
        data.update(changes)
        return Cue(**data)

    def overlaps(self, other: "Cue") -> bool:
        return self.start < other.end and other.start < self.end


@dataclass
class Issue:
    """一次编辑操作中被拦下的 / 需要用户知晓的问题。"""

    level: str          # "error" | "warning" | "info"
    message: str
    cue_ids: tuple[int, ...] = ()

    def __str__(self) -> str:
        return self.message


@dataclass
class OperationResult:
    ok: bool
    issues: list[Issue] = field(default_factory=list)
    changed_ids: list[int] = field(default_factory=list)

    def add(self, level: str, message: str, *cue_ids: int) -> None:
        self.issues.append(Issue(level, message, tuple(cue_ids)))
        if level == "error":
            self.ok = False

    def messages(self, levels: Iterable[str] = ("error", "warning")) -> list[str]:
        return [i.message for i in self.issues if i.level in levels]

    @property
    def errors(self) -> list[str]:
        return self.messages(("error",))

    @property
    def warnings(self) -> list[str]:
        return self.messages(("warning",))


@dataclass
class Timeline:
    """一条完整的打轴结果。"""

    audio_path: str = ""
    text: str = ""
    duration: int = 0                  # 音轨总长 (ms)
    cues: list[Cue] = field(default_factory=list)
    reading_order: list[int] = field(default_factory=list)
    sample_rate: int = 48000           # 载入音频时填写
    title: str = ""
    _next_id: int = 1

    # ------------------------------------------------------------------ 基本
    def cue(self, cue_id: int) -> Cue:
        for c in self.cues:
            if c.id == cue_id:
                return c
        raise KeyError(cue_id)

    def index_of(self, cue_id: int) -> int:
        for i, c in enumerate(self.cues):
            if c.id == cue_id:
                return i
        raise KeyError(cue_id)

    def new_id(self) -> int:
        value = self._next_id
        self._next_id += 1
        return value

    def sort_cues(self) -> None:
        self.cues.sort(key=lambda c: (c.start, c.end, c.id))

    def _sync_order(self) -> None:
        """把 reading_order 中已删除的 id 去掉, 新 id 追加到末尾。"""
        known = {c.id for c in self.cues}
        seen: list[int] = []
        for cid in self.reading_order:
            if cid in known and cid not in seen:
                seen.append(cid)
        for c in self.cues:
            if c.id not in seen:
                seen.append(c.id)
        self.reading_order = seen

    def ordered_cues(self) -> list[Cue]:
        self._sync_order()
        by_id = {c.id: c for c in self.cues}
        return [by_id[i] for i in self.reading_order]

    # ------------------------------------------------------------ 冲突检查
    def conflicts(self, max_gap_ms: int = 800, min_cue_ms: int = 30) -> list[Issue]:
        """返回当前时间轴上的全部边界问题.

        * error: 区间无效 / 越界 / 相邻两词重叠;
        * warning: 阅读顺序相邻但时间上被隔开超过 ``max_gap_ms``, 或单词
          短于 ``min_cue_ms``, 或分属不同词的两个区间相互覆盖;
        * info: 阅读顺序与时间顺序不一致 (可能是刻意的倒叙, 仅提示)。
        """
        issues: list[Issue] = []
        ordered = sorted(self.cues, key=lambda c: (c.start, c.end, c.id))
        for c in ordered:
            if c.end < c.start:
                issues.append(Issue("error", f"「{c.text}」结束早于开始 ({format_ms(c.start)} → {format_ms(c.end)})", (c.id,)))
            elif not c.is_timed:
                issues.append(Issue("warning", f"「{c.text}」尚未打轴 (0 长度)", (c.id,)))
            elif c.duration < min_cue_ms:
                issues.append(Issue("warning", f"「{c.text}」只有 {c.duration} ms, 听感上可能被吞掉", (c.id,)))
            if c.start < 0:
                issues.append(Issue("error", f"「{c.text}」开始时间为负", (c.id,)))
            if self.duration and c.end > self.duration:
                issues.append(Issue("error", f"「{c.text}」超出音频长度 ({format_ms(c.end)} > {format_ms(self.duration)})", (c.id,)))
        for a, b in zip(ordered, ordered[1:]):
            gap = b.start - a.end
            if gap < 0:
                issues.append(Issue("error",
                                    f"相邻词重叠: 「{a.text}」({format_ms(a.start)}–{format_ms(a.end)}) "
                                    f"与「{b.text}」({format_ms(b.start)}–{format_ms(b.end)}) 重叠 {-gap} ms",
                                    (a.id, b.id)))
        # 按阅读顺序检查: 选词顺序就是朗读顺序, 相邻两词中若有长空隙, 提示漏标。
        read = self.ordered_cues()
        for a, b in zip(read, read[1:]):
            gap = b.start - a.end
            if gap > max_gap_ms and a.end <= b.start:
                issues.append(Issue("warning",
                                    f"「{a.text}」与「{b.text}」之间空了 {gap} ms, 确认没有漏标", (a.id, b.id)))
        time_ids = [c.id for c in ordered]
        order_ids = [c.id for c in read]
        if time_ids != order_ids:
            issues.append(Issue("info", "阅读顺序与时间顺序不一致; 导出视频时按阅读顺序串联字幕"))
        return issues

    def invalid_ids(self) -> set[int]:
        bad: set[int] = set()
        for issue in self.conflicts():
            if issue.level == "error":
                bad.update(issue.cue_ids)
        return bad

    # ------------------------------------------------------- 阅读顺序不变量
    def _order_breaks(self, starts: dict[int, int]) -> list[tuple[Cue, Cue]]:
        """给定「假设的」每词开始时间, 返回阅读顺序被颠倒的相邻词对。

        词的内部顺序必须保持: 如果某个词在文本里排在另一个前面, 它的开始
        时间就不能跑到后面去 (允许同时开始)。重叠由单独的冲突检查负责。
        """
        order = self.ordered_cues()
        breaks: list[tuple[Cue, Cue]] = []
        for a, b in zip(order, order[1:]):
            if starts[a.id] > starts[b.id]:
                breaks.append((a, b))
        return breaks

    # ------------------------------------------------------------ 编辑操作
    def move_cue(self, cue_id: int, new_start: int, new_end: int | None = None,
                 force: bool = False) -> OperationResult:
        """把单个 cue 移到新位置; 默认保持长度。

        不会移动其他词; 因此新位置若压到别的词、或违反了词的先后顺序, 就报
        error 并拒绝 (勾选 force 可写入重叠, 但仍拒绝颠倒顺序)。
        """
        res = OperationResult(True)
        cue = self.cue(cue_id)
        length = cue.duration if new_end is None else new_end - new_start
        if new_end is None:
            new_end = new_start + length
        if new_start < 0:
            res.add("error", f"「{cue.text}」新的开始时间不能为负")
            return res
        if self.duration and new_end > self.duration:
            res.add("error", f"「{cue.text}」新的结束时间 {format_ms(new_end)} 超出音频长度 {format_ms(self.duration)}")
            return res
        if new_end <= new_start:
            res.add("error", "结束时间必须晚于开始时间")
            return res
        probe = cue.clone(start=new_start, end=new_end)
        for other in self.cues:
            if other.id == cue.id:
                continue
            if probe.overlaps(other):
                res.add("error",
                        f"移动后会与「{other.text}」重叠 ("
                        f"{format_ms(other.start)}–{format_ms(other.end)})", cue.id, other.id)
        starts = {c.id: c.start for c in self.cues}
        starts[cue.id] = new_start
        for a, b in self._order_breaks(starts):
            res.add("error",
                    f"会颠倒朗读顺序: 「{a.text}」将晚于「{b.text}」开始", a.id, b.id)
        if not res.ok:
            if not force:
                res.issues.append(Issue("info", "已取消移动; 如需强制写入重叠请勾选「允许重叠」"))
                return res
            # force 只放过重叠, 不放过顺序错误
            if any("颠倒朗读顺序" in i.message for i in res.issues):
                return res
        cue.start, cue.end = new_start, new_end
        res.changed_ids = [cue.id]
        if not res.ok:
            res.add("warning", "已按「允许重叠」写入, 导出前请处理重叠")
        return res

    def set_edge(self, cue_id: int, edge: str, value: int,
                 ripple: bool = False) -> OperationResult:
        """拖动 / 键入单个边界.

        ``edge`` 为 ``"start"`` 或 ``"end"``。改动一个词的开始边界时, 前一个词
        的结束边界会跟着移动 (gap 保持不变) —— 这是逐词打轴的常规操作, 保证
        相邻词之间不凭空出现空隙或重叠。关闭 ``ripple`` 时只改当前词, 由冲突
        检查兜底。

        后续词的时间一律不动。
        """
        res = OperationResult(True)
        cue = self.cue(cue_id)
        value = int(value)
        if edge not in ("start", "end"):
            raise ValueError(edge)
        if value < 0:
            res.add("error", "时间不能为负")
            return res
        if self.duration and value > self.duration:
            res.add("error", f"超出音频长度 {format_ms(self.duration)}")
            return res
        partner: Cue | None = None
        if edge == "start":
            if value >= cue.end:
                res.add("error", f"「{cue.text}」的开始必须早于结束 ({format_ms(cue.end)})")
                return res
            order = self.ordered_cues()
            idx = order.index(cue)
            if idx > 0 and order[idx - 1].is_timed and order[idx - 1].end > value:
                partner = order[idx - 1]
                if not ripple:
                    res.add("error",
                            f"会与前一个词「{partner.text}」重叠 (它到 {format_ms(partner.end)} 结束)", partner.id)
                    return res
                if value <= partner.start:
                    res.add("error",
                            f"会把前一个词「{partner.text}」压成 0 长度, 请改选「加长前词」或关闭联动",
                            partner.id)
                    return res
                res.add("info", f"前一个词「{partner.text}」的结束同步到 {format_ms(value)}")
            if not ripple:
                for other in self.cues:
                    if other.id == cue.id:
                        continue
                    if value < other.end and other.start < cue.end:
                        res.add("warning", f"开始边界落进「{other.text}」的区间", other.id)
        else:
            if value <= cue.start:
                res.add("error", f"「{cue.text}」的结束必须晚于开始 ({format_ms(cue.start)})")
                return res
            order = self.ordered_cues()
            idx = order.index(cue)
            if idx + 1 < len(order) and order[idx + 1].is_timed and value > order[idx + 1].start:
                partner = order[idx + 1]
                if not ripple:
                    res.add("error",
                            f"会与后一个词「{partner.text}」重叠 (它从 {format_ms(partner.start)} 开始)", partner.id)
                    return res
                if value >= partner.end:
                    res.add("error",
                            f"会把后一个词「{partner.text}」压成 0 长度, 请改选「缩短前词」或关闭联动",
                            partner.id)
                    return res
                res.add("info", f"后一个词「{partner.text}」的开始同步到 {format_ms(value)}")
            if not ripple:
                for other in self.cues:
                    if other.id == cue.id:
                        continue
                    if cue.start < other.end and other.start < value:
                        res.add("warning", f"结束边界落进「{other.text}」的区间", other.id)
        if edge == "start":
            cue.start = value
            if partner is not None:
                partner.end = value
                res.changed_ids = [cue.id, partner.id]
            else:
                res.changed_ids = [cue.id]
        else:
            cue.end = value
            if partner is not None:
                partner.start = value
                res.changed_ids = [cue.id, partner.id]
            else:
                res.changed_ids = [cue.id]
        self.sort_cues()
        return res

    # ---------------------------------------------------- 批量平移 (带预检)
    def preview_shift(self, cue_ids: Sequence[int], delta: int) -> OperationResult:
        """预检: 若把这些 cue 整体平移 delta ms, 会发生什么.

        返回的 issues 里, 与未选中词的重叠/越界为 error; 选中词之间原本就
        重叠的不再重复报。``ok`` 为真表示可以安全应用。
        """
        res = OperationResult(True)
        existing = {c.id for c in self.cues}
        stale = [i for i in cue_ids if i not in existing]
        selected = {i for i in cue_ids if i in existing}
        if stale:
            res.add("info", f"忽略 {len(stale)} 个已不存在的词")
        if not selected:
            res.add("info", "没有选中任何词")
            return res
        if delta == 0:
            res.add("info", "位移为 0, 无需移动")
            return res
        moving = [self.cue(i) for i in selected]
        for c in moving:
            ns, ne = c.start + delta, c.end + delta
            if ns < 0:
                res.add("error", f"「{c.text}」会移动到负时间 ({format_ms(ns)})", c.id)
            if self.duration and ne > self.duration:
                res.add("error", f"「{c.text}」会超出音频末尾 ({format_ms(ne)} > {format_ms(self.duration)})", c.id)
        stationary = [c for c in self.cues if c.id not in selected]
        for c in moving:
            for other in stationary:
                if c.start + delta < other.end and other.start < c.end + delta:
                    res.add("error",
                            f"「{c.text}」平移后会与未选中的「{other.text}」"
                            f"({format_ms(other.start)}–{format_ms(other.end)}) 重叠", c.id, other.id)
        # 平移内部: 原本不重叠的选中词, 平移不会改变它们之间的相对关系, 所以不报。
        starts = {c.id: c.start + delta if c.id in selected else c.start for c in self.cues}
        for a, b in self._order_breaks(starts):
            involved = a.id in selected or b.id in selected
            if involved:
                res.add("error",
                        f"平移后朗读顺序会被颠倒: 「{a.text}」将晚于「{b.text}」开始", a.id, b.id)
        if res.ok:
            res.add("info", f"可以平移 {len(moving)} 个词 {delta:+d} ms")
        return res

    def shift_cues(self, cue_ids: Sequence[int], delta: int) -> OperationResult:
        """先预检; 若有 error 则整体拒绝 (原子操作)。"""
        preview = self.preview_shift(cue_ids, delta)
        if not preview.ok or delta == 0:
            return preview
        ids = [i for i in dict.fromkeys(cue_ids) if any(c.id == i for c in self.cues)]
        changes: dict[int, tuple[int, int]] = {}
        for cid in ids:
            c = self.cue(cid)
            changes[cid] = (c.start, c.end)
        for cid, (s, e) in changes.items():
            c = self.cue(cid)
            c.start, c.end = s + delta, e + delta
        self.sort_cues()
        preview.changed_ids = list(changes)
        preview.issues = [i for i in preview.issues if i.level != "info"]
        preview.add("info", f"已平移 {len(changes)} 个词 {delta:+d} ms")
        return preview

    # --------------------------------------------------------------- 合并
    def preview_merge(self, cue_ids: Sequence[int]) -> OperationResult:
        res = OperationResult(True)
        existing = {c.id for c in self.cues}
        ids = [i for i in dict.fromkeys(cue_ids) if i in existing]
        if len(ids) < 2:
            res.add("error", "合并至少需要选中 2 个词")
            return res
        order = self.ordered_cues()
        positions = {c.id: i for i, c in enumerate(order)}
        if any(i not in positions for i in ids):
            res.add("error", "选中的词不在当前文本中")
            return res
        sel_positions = sorted(positions[i] for i in ids)
        if sel_positions != list(range(sel_positions[0], sel_positions[1] + 1)):
            res.add("error", "只能合并阅读顺序上连续的一段词 (中间夹着的词也要选中)")
            return res
        cues = [self.cue(i) for i in ids]
        by_pos = sorted(cues, key=lambda c: positions[c.id])
        start = min(c.start for c in by_pos)
        end = max(c.end for c in by_pos)
        res.add("info", f"合并后区间 {format_ms(start)}–{format_ms(end)}")
        for other in self.cues:
            if other.id in ids:
                continue
            if start < other.end and other.start < end:
                res.add("warning", f"合并区间会覆盖未选中的「{other.text}」({format_ms(other.start)}–{format_ms(other.end)})", other.id)
        return res

    def merge_cues(self, cue_ids: Sequence[int]) -> OperationResult:
        preview = self.preview_merge(cue_ids)
        if not preview.ok:
            return preview
        ids = list(dict.fromkeys(cue_ids))
        id_set = set(ids)
        positions = {c.id: i for i, c in enumerate(self.ordered_cues())}
        ordered = sorted((self.cue(i) for i in ids), key=lambda c: positions[c.id])
        first = ordered[0]
        text = "".join(c.text for c in ordered)
        note = " ".join(dict.fromkeys(c.note for c in ordered if c.note))
        merged = first.clone(text=text, start=min(c.start for c in ordered),
                             end=max(c.end for c in ordered), note=note)
        old_ids = [c.id for c in ordered]
        remaining = [c for c in self.cues if c.id not in id_set]
        idx = self.cues.index(first)
        remaining.insert(min(idx, len(remaining)), merged)
        self.cues = remaining
        self._sync_order()
        preview.changed_ids = [merged.id]
        preview.issues = [i for i in preview.issues if i.level not in ("info", "warning")]
        preview.add("info", f"已合并 {len(old_ids)} 个词为「{text}」, 保留原 id {merged.id}")
        return preview

    # --------------------------------------------------------------- 拆分
    def preview_split(self, cue_id: int, at_char: int) -> OperationResult:
        res = OperationResult(True)
        cue = self.cue(cue_id)
        if at_char <= 0 or at_char >= len(cue.text):
            res.add("error", f"拆分位置必须在词内部 (1..{len(cue.text) - 1})")
            return res
        ratio = at_char / len(cue.text)
        cut = cue.start + int(round(cue.duration * ratio))
        res.add("info", f"按字数比例拆分于 {format_ms(cut)}: 「{cue.text[:at_char]}」/「{cue.text[at_char:]}」")
        if cut <= cue.start or cut >= cue.end:
            res.add("error", "拆分点落在词的边界上, 请调整位置")
        return res

    def split_cue(self, cue_id: int, at_char: int, cut_ms: int | None = None) -> OperationResult:
        """把 cue 在字符 ``at_char`` 处拆成两个词.

        新词沿用原词的 id, 后半段获得新 id —— 这样 ``reading_order``、
        UI 选中状态和用户对「后续词」的时间安排都尽可能保留。原 cue 之后
        的条目一概不动。
        """
        preview = self.preview_split(cue_id, at_char)
        if not preview.ok:
            return preview
        cue = self.cue(cue_id)
        if cut_ms is None:
            cut_ms = cue.start + int(round(cue.duration * at_char / len(cue.text)))
        cut_ms = max(cue.start, min(cue.end, cut_ms))
        tail = cue.clone(id=self.new_id(), text=cue.text[at_char:], start=cut_ms)
        cue.text = cue.text[:at_char]
        cue.end = cut_ms
        pos = self.cues.index(cue)
        self.cues.insert(pos + 1, tail)
        order = self.reading_order
        if tail.id in order:
            order.remove(tail.id)
        if cue.id in order:
            order.insert(order.index(cue.id) + 1, tail.id)
        self._sync_order()
        self.sort_cues()
        preview.changed_ids = [cue.id, tail.id]
        preview.issues = [i for i in preview.issues if i.level != "info"]
        preview.add("info", f"已拆分为「{cue.text}」/「{tail.text}」")
        return preview

    # ------------------------------------------------------------ 新增/删除
    def add_cue(self, text: str, start: int, end: int, kind: str = "word",
                after_id: int | None = None) -> OperationResult:
        res = OperationResult(True)
        text = text.strip()
        if not text:
            res.add("error", "文本不能为空")
            return res
        if end <= start:
            res.add("error", "结束时间必须晚于开始时间")
            return res
        if start < 0 or (self.duration and end > self.duration):
            res.add("error", "区间超出音频范围")
            return res
        cue = Cue(self.new_id(), text, start, end, kind)
        for other in self.cues:
            if cue.overlaps(other):
                res.add("warning", f"新词与「{other.text}」重叠", other.id)
        self.cues.append(cue)
        self.sort_cues()
        if after_id is not None:
            order = self.ordered_cues()
            ids = [c.id for c in order]
            ids.remove(cue.id)
            try:
                idx = ids.index(after_id) + 1
            except ValueError:
                idx = len(ids)
            ids.insert(idx, cue.id)
            self.reading_order = ids
        self._sync_order()
        res.changed_ids = [cue.id]
        res.add("info", f"已添加「{text}」")
        return res

    def set_cue_text(self, cue_id: int, text: str) -> OperationResult:
        """改词条文本; 时间与顺序保持不变。"""
        res = OperationResult(True)
        cue = self.cue(cue_id)
        text = text.strip()
        if not text:
            res.add("error", "文本不能为空; 如需删除请使用「删除词」")
            return res
        cue.text = text
        res.changed_ids = [cue.id]
        return res

    def set_cue_kind(self, cue_id: int, kind: str) -> OperationResult:
        res = OperationResult(True)
        if kind not in ("word", "pause"):
            res.add("error", f"未知类型 {kind}")
            return res
        self.cue(cue_id).kind = kind
        res.changed_ids = [cue_id]
        return res

    def set_cue_note(self, cue_id: int, note: str) -> OperationResult:
        self.cue(cue_id).note = note
        return OperationResult(True, changed_ids=[cue_id])

    def assign_untimed(self, start_ms: int = 0, end_ms: int | None = None,
                       gap_ms: int = 60) -> OperationResult:
        """把尚未打轴 (0 长度) 的词按字数比例铺到 [start, end) 上.

        只动 0 长度的词; 已打好时间的词和它们之间的空隙原样保留, 所以
        「导入新文本」之后可以先把新词临时铺开, 再逐个细调。
        """
        res = OperationResult(True)
        end_ms = self.duration if end_ms is None else min(end_ms, self.duration)
        if end_ms <= start_ms:
            res.add("error", "区间无效")
            return res
        untimed = [c for c in self.ordered_cues() if not c.is_timed]
        if not untimed:
            res.add("info", "所有词都已打轴")
            return res
        total_weight = sum(max(1, len(c.text)) for c in untimed)
        span = (end_ms - start_ms) - gap_ms * (len(untimed) - 1)
        if span <= len(untimed):
            span = end_ms - start_ms
            gap_ms = 0
        cursor = float(start_ms)
        for i, cue in enumerate(untimed):
            share = span * max(1, len(cue.text)) / total_weight
            cue.start = int(round(cursor))
            cue.end = max(cue.start + 1, int(round(cursor + share)))
            cursor += share + gap_ms
            if cue.end > self.duration:
                cue.end = self.duration
        self.sort_cues()
        res.changed_ids = [c.id for c in untimed]
        res.add("info", f"已把 {len(untimed)} 个未打轴的词铺到 {format_ms(start_ms)}–{format_ms(end_ms)}")
        for issue in self.conflicts():
            if issue.level == "error":
                res.add("warning", issue.message, *issue.cue_ids)
        return res

    def delete_cues(self, cue_ids: Sequence[int]) -> OperationResult:
        res = OperationResult(True)
        ids = set(cue_ids)
        if not ids:
            res.add("error", "没有选中任何词")
            return res
        self.cues = [c for c in self.cues if c.id not in ids]
        self._sync_order()
        res.changed_ids = []
        res.add("info", f"已删除 {len(ids)} 个词; 其余词的时间不变")
        return res

    def set_reading_order(self, ids: Sequence[int]) -> OperationResult:
        res = OperationResult(True)
        if sorted(ids) != sorted(c.id for c in self.cues):
            res.add("error", "阅读顺序必须覆盖全部词且不能重复")
            return res
        self.reading_order = list(ids)
        return res

    # ------------------------------------------------------------ 序列化
    def to_dict(self) -> dict:
        return {
            "format": FORMAT_NAME,
            "version": FORMAT_VERSION,
            "title": self.title,
            "audio_path": self.audio_path,
            "duration": self.duration,
            "sample_rate": self.sample_rate,
            "text": self.text,
            "next_id": self._next_id,
            "cues": [dict(id=c.id, text=c.text, start=c.start, end=c.end,
                          kind=c.kind, note=c.note) for c in self.cues],
            "reading_order": list(self.reading_order),
        }

    @classmethod
    def from_dict(cls, data: dict) -> "Timeline":
        if data.get("format") != FORMAT_NAME:
            raise ValueError("不是 wordcue 时间轴文件")
        if int(data.get("version", 0)) > FORMAT_VERSION:
            raise ValueError(f"时间轴版本 {data.get('version')} 高于本程序支持的 {FORMAT_VERSION}")
        cues = [Cue(int(c["id"]), str(c["text"]), int(c["start"]), int(c["end"]),
                    str(c.get("kind", "word")), str(c.get("note", "")))
                for c in data.get("cues", [])]
        tl = cls(
            audio_path=str(data.get("audio_path", "")),
            text=str(data.get("text", "")),
            duration=int(data.get("duration", 0)),
            cues=cues,
            reading_order=[int(x) for x in data.get("reading_order", [])],
            sample_rate=int(data.get("sample_rate", 48000)),
            title=str(data.get("title", "")),
            _next_id=int(data.get("next_id", max((c.id for c in cues), default=0) + 1)),
        )
        tl._sync_order()
        return tl

    def save(self, path: str) -> None:
        payload = self.to_dict()
        tmp = f"{path}.tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
        os.replace(tmp, path)

    @classmethod
    def load(cls, path: str) -> "Timeline":
        with open(path, encoding="utf-8") as fh:
            return cls.from_dict(json.load(fh))

    def clone(self) -> "Timeline":
        return copy.deepcopy(self)

    # ------------------------------------------------------------- 文本来源
    def text_from_cues(self) -> str:
        return "".join(c.text for c in self.ordered_cues())

    def reflow_from_text(self, text: str) -> OperationResult:
        """当文本被整体替换时, 按字符序列重建 cue.

        用 difflib 对齐新旧文本: 相同的字符保留原来的时间与 id; 新增/改动
        的字符按相邻旧 cue 的时间插值, 避免静默丢轴。文本完全没变时不做任何事。
        """
        res = OperationResult(True)
        if text == self.text_from_cues():
            self.text = text
            return res
        old = self.ordered_cues()
        flat_text: list[str] = []
        flat_cue: list[Cue] = []
        for c in old:
            if not c.text:
                continue
            share = max(1, c.duration // len(c.text))
            for k, ch in enumerate(c.text):
                flat_text.append(ch)
                flat_cue.append(c.clone(start=c.start + k * share,
                                         end=c.start + (k + 1) * share))
        new_chars = list(text)
        matcher = difflib.SequenceMatcher(None, flat_text, new_chars, autojunk=False)
        built: list[Cue] = []
        for tag, i1, i2, j1, j2 in matcher.get_opcodes():
            if tag == "equal":
                for k in range(i2 - i1):
                    src = flat_cue[i1 + k]
                    built.append(Cue(src.id, new_chars[j1 + k], src.start, src.end,
                                     src.kind, src.note))
            elif tag == "replace":
                span_start = flat_cue[i1].start
                span_end = flat_cue[i2 - 1].end
                n = j2 - j1
                step = max(1, (span_end - span_start) // max(1, n))
                for k in range(n):
                    s = span_start + k * step
                    e = span_start + (k + 1) * step
                    built.append(Cue(self.new_id(), new_chars[j1 + k], s, e))
                if i2 - i1 != j2 - j1:
                    res.add("warning", "部分文本被替换, 新字符的时间为估算值")
            elif tag == "insert":
                anchor = flat_cue[i1 - 1].end if i1 > 0 else (
                    flat_cue[0].start if flat_cue else 0)
                for k in range(j2 - j1):
                    built.append(Cue(self.new_id(), new_chars[j1 + k], anchor, anchor))
                res.add("warning", "新增的字符没有对应时间, 已用 0 长度占位")
            # delete: 字符被删除, 对应 cue 一并消失 (时间缺口保留给相邻词)
        # 相邻等值的 0 长度占位会显得拥挤; 保持原样, 交给用户处理。
        self.cues = built
        self.text = text
        self.reading_order = [c.id for c in built]
        if any(c.end <= c.start for c in built):
            res.add("warning", "存在未打轴的字符 (0 长度), 请手动补时间")
        return res
