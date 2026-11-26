"""核心数据模型: 逐像素色号索引 + RGBA 色表。

最重要的不变量:

    像素 (x, y) 的外观颜色 == palette[indices[y * width + x]]

即使 palette 中两个槽位的 RGBA 完全相同, 它们仍然是两个不同的色号;
任何操作都不得按颜色值合并槽位。
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Optional

RGBA = tuple[int, int, int, int]

# 色表缺失(像素引用了 >= 色表长度的色号)时的醒目标记色
MISSING_RGBA: RGBA = (255, 0, 255, 255)


class ModelError(ValueError):
    """数据模型层面的非法操作。"""


@dataclass
class IndexedImage:
    """一张索引色图的完整可编辑状态。

    indices 长度固定为 width * height, 每字节是一个 0..255 的色号;
    4 位 PNG 读入后 Pillow 也会解包成每像素一字节。
    palette 长度等于 PNG PLTE 块的真实条目数(可能小于最大色号 + 1)。
    """

    width: int
    height: int
    indices: bytearray
    palette: list[RGBA]
    bit_depth: int = 8
    source_path: Optional[str] = None
    title: str = ""

    def __post_init__(self) -> None:
        expected = self.width * self.height
        if len(self.indices) != expected:
            raise ModelError(
                f"索引数据长度 {len(self.indices)} 与 {self.width}x{self.height}={expected} 不符"
            )
        if self.width <= 0 or self.height <= 0:
            raise ModelError("宽高必须为正数")
        self.palette = [tuple(c) for c in self.palette]  # type: ignore[assignment]
        if not (1 <= len(self.palette) <= 256):
            raise ModelError(f"色表条目数必须在 1..256, 当前 {len(self.palette)}")

    # ---- 基础 -----------------------------------------------------------
    def clone(self) -> "IndexedImage":
        return IndexedImage(
            width=self.width,
            height=self.height,
            indices=bytearray(self.indices),
            palette=[tuple(c) for c in self.palette],  # type: ignore[arg-type]
            bit_depth=self.bit_depth,
            source_path=self.source_path,
            title=self.title,
        )

    @property
    def palette_size(self) -> int:
        return len(self.palette)

    def in_bounds(self, x: int, y: int) -> bool:
        return 0 <= x < self.width and 0 <= y < self.height

    def index_at(self, x: int, y: int) -> int:
        return self.indices[y * self.width + x]

    def rgba_at(self, x: int, y: int) -> RGBA:
        idx = self.index_at(x, y)
        if 0 <= idx < len(self.palette):
            return self.palette[idx]
        return MISSING_RGBA

    # ---- 统计 / 诊断 ----------------------------------------------------
    def counts(self) -> list[int]:
        """返回 256 个色号各自的像素数量(包含色表里不存在的色号)。"""
        result = [0] * 256
        for v in self.indices:
            result[v] += 1
        return result

    def max_index(self) -> int:
        return max(self.indices) if self.indices else 0

    def gap_indices(self) -> list[int]:
        """被像素使用、但超出当前色表长度的色号。"""
        n = len(self.palette)
        return sorted({v for v in self.indices if v >= n})

    def gap_positions(self, limit_per_index: Optional[int] = None) -> dict[int, list[tuple[int, int]]]:
        """指出每个“色表不足”的色号具体出现在哪些 (x, y)。"""
        n = len(self.palette)
        found: dict[int, list[tuple[int, int]]] = {}
        for y in range(self.height):
            row = y * self.width
            for x in range(self.width):
                v = self.indices[row + x]
                if v >= n:
                    lst = found.setdefault(v, [])
                    if limit_per_index is None or len(lst) < limit_per_index:
                        lst.append((x, y))
        return found

    def positions_of(self, index: int) -> list[tuple[int, int]]:
        """某个确切色号覆盖的全部像素坐标 —— 同色异号不会被算进来。"""
        out: list[tuple[int, int]] = []
        for y in range(self.height):
            base = y * self.width
            for x in range(self.width):
                if self.indices[base + x] == index:
                    out.append((x, y))
        return out

    # ---- 操作: 改色 / 交换外观 / 重排编号 ------------------------------
    def set_color(self, index: int, rgba: RGBA) -> None:
        """只改某色号的 RGBA, 索引数组一动不动。

        与它 RGBA 恰好相同的其他色号不受影响 —— 这是本程序的核心。
        """
        if not (0 <= index < len(self.palette)):
            raise ModelError(f"色号 {index} 不在色表(0..{len(self.palette) - 1})内")
        r, g, b, a = rgba
        if not all(0 <= v <= 255 for v in (r, g, b, a)):
            raise ModelError(f"颜色分量越界: {rgba!r}")
        self.palette[index] = (int(r), int(g), int(b), int(a))

    def swap_appearance(self, a: int, b: int) -> None:
        """交换色表两格的外观(RGBA), 像素色号不变。

        结果: 原来用 a 号的区域现在显示 b 号旧颜色, 两块图面交换颜色。
        与 reorder_slots(..., 交换 a/b) 的区别是那个操作会连像素编号一起换。
        """
        n = len(self.palette)
        if not (0 <= a < n and 0 <= b < n):
            raise ModelError(f"色号越界: {a}, {b} (色表共 {n} 格)")
        if a == b:
            return
        self.palette[a], self.palette[b] = self.palette[b], self.palette[a]

    def apply_order(self, order: list[int]) -> None:
        """按 order 重排色表, 并把全部像素重映射到新编号以保持图面不变。

        order[new_index] = old_index, 即新色表第 k 格放原来的第 order[k] 格。
        对于色表长度之外的缺失色号(诊断状态), 重映射时保持原号。
        """
        n = len(self.palette)
        if sorted(order) != list(range(n)):
            raise ModelError("order 必须是 0..n-1 的一个排列")

        new_palette = [self.palette[old] for old in order]

        old_to_new = list(range(256))  # 超出 n 的色号默认恒等映射
        for new_i, old_i in enumerate(order):
            old_to_new[old_i] = new_i

        self.indices = bytearray(old_to_new[v] for v in self.indices)
        self.palette = new_palette

    def move_slot(self, old_index: int, new_index: int) -> None:
        """把 old_index 槽位移动到 new_index, 像素同步改号, 图面保持一致。"""
        n = len(self.palette)
        if not (0 <= old_index < n and 0 <= new_index < n):
            raise ModelError("移动目标越界")
        if old_index == new_index:
            return
        order = list(range(n))
        item = order.pop(old_index)
        order.insert(new_index, item)
        self.apply_order(order)


def swapped_number_order(n: int, a: int, b: int) -> list[int]:
    """生成“交换 a/b 两个编号”的排列(用于保外观的重编号)。"""
    order = list(range(n))
    order[a], order[b] = order[b], order[a]
    return order


# ---------------------------------------------------------------------------
# 历史: 每一步都是完整快照(颜色 + 编号), 可跳回任意一步
# ---------------------------------------------------------------------------


@dataclass
class HistoryStep:
    label: str
    doc: IndexedImage
    key: Optional[str] = None
    when: float = 0.0


class History:
    """快照式历史栈。

    steps[0] 永远是起点; cursor 指向当前步。
    连续的同类微调(例如拖动 RGBA 数字框)可用相同 key 在短时间内合并,
    避免一次取色产生几十步; 离散操作 key=None, 一律单独成步。
    """

    COALESCE_SECONDS = 2.5

    def __init__(self, initial: IndexedImage, initial_label: str = "起点(读入文件)") -> None:
        self.steps: list[HistoryStep] = [
            HistoryStep(initial_label, initial.clone(), when=time.monotonic())
        ]
        self.cursor = 0

    @property
    def current(self) -> IndexedImage:
        return self.steps[self.cursor].doc

    def can_undo(self) -> bool:
        return self.cursor > 0

    def can_redo(self) -> bool:
        return self.cursor < len(self.steps) - 1

    def commit(
        self,
        label: str,
        doc: IndexedImage,
        key: Optional[str] = None,
        now: Optional[float] = None,
    ) -> HistoryStep:
        now = time.monotonic() if now is None else now
        # 仅当停在最新一步、key 相同且距上次提交足够近时合并
        if key is not None and self.cursor == len(self.steps) - 1:
            last = self.steps[-1]
            if last.key == key and 0 <= now - last.when <= self.COALESCE_SECONDS:
                last.doc = doc
                last.label = label
                last.when = now
                return last

        if self.cursor < len(self.steps) - 1:
            del self.steps[self.cursor + 1 :]
        step = HistoryStep(label=label, doc=doc, key=key, when=now)
        self.steps.append(step)
        self.cursor = len(self.steps) - 1
        return step

    def goto(self, index: int) -> IndexedImage:
        self.cursor = max(0, min(index, len(self.steps) - 1))
        return self.current

    def undo(self) -> IndexedImage:
        if self.can_undo():
            self.cursor -= 1
        return self.current

    def redo(self) -> IndexedImage:
        if self.can_redo():
            self.cursor += 1
        return self.current


@dataclass
class EditContext:
    """一个可编辑上下文: 主编号图 或 某个换色版本。

    base 是该上下文的冻结起点(左侧“原图/起点”视图与索引核对基准),
    history 的第 0 步就是 base 的快照。
    """

    key: str
    title: str
    base: IndexedImage
    initial_label: str = "起点"
    history: History = field(init=False)

    def __post_init__(self) -> None:
        self.base = self.base.clone()  # 防御性拷贝, 多个版本不得共享可变对象
        self.history = History(self.base, self.initial_label)

    @property
    def doc(self) -> IndexedImage:
        return self.history.current
