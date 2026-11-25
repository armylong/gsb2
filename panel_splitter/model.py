"""面板数据模型。

事实源只有一个: panels (矩形列表, 原图像素坐标)。缝是从面板邻接关系派生出来的,
所以「拖缝 / 补断缝 / 合并误切」都表现为对少数几个矩形的局部修改,
其它面板的元组完全不动 —— 已调好的格子位置天然保留。

所有修改走 snapshot/restore, 支持撤销; 修改后发出局部失效提示,
视图层可只重画受影响区域。
"""

from __future__ import annotations

from dataclasses import dataclass, field

Rect = tuple[int, int, int, int]


@dataclass
class ChangeHint:
    """一次修改影响到的矩形范围 (原图像素坐标), None 表示整页都要重算。"""

    dirty: Rect | None
    panels_added: list[int] = field(default_factory=list)
    panels_removed: list[int] = field(default_factory=list)
    panels_changed: list[int] = field(default_factory=list)
    full_order_reset: bool = False


def _union_rects(rects: list[Rect]) -> Rect | None:
    if not rects:
        return None
    return (
        min(r[0] for r in rects),
        min(r[1] for r in rects),
        max(r[2] for r in rects),
        max(r[3] for r in rects),
    )


class PageModel:
    def __init__(self, image_shape: tuple[int, int], panels: list[Rect]):
        self.page_h, self.page_w = image_shape[:2]
        self.panels: list[Rect] = list(panels)
        # 手工顺序覆盖: panel 序号 -> 手工阅读序号; 没覆盖的按自动顺序
        self.manual_order: list[int] | None = None
        self.direction: str = "ltr"
        self._undo: list[tuple[list[Rect], list[int] | None]] = []
        self._redo: list[tuple[list[Rect], list[int] | None]] = []

    # ---------- 撤销 / 重做 ----------
    def snapshot(self) -> None:
        self._undo.append((list(self.panels), self._copy_order()))
        self._redo.clear()

    def _copy_order(self) -> list[int] | None:
        return list(self.manual_order) if self.manual_order is not None else None

    def undo(self) -> bool:
        if not self._undo:
            return False
        self._redo.append((list(self.panels), self._copy_order()))
        self.panels, self.manual_order = self._undo.pop()
        return True

    def redo(self) -> bool:
        if not self._redo:
            return False
        self._undo.append((list(self.panels), self._copy_order()))
        self.panels, self.manual_order = self._redo.pop()
        return True

    @property
    def can_undo(self) -> bool:
        return bool(self._undo)

    @property
    def can_redo(self) -> bool:
        return bool(self._redo)

    # ---------- 查询 ----------
    def panel_at(self, x: int, y: int) -> int:
        for i in reversed(range(len(self.panels))):
            x0, y0, x1, y1 = self.panels[i]
            if x0 <= x < x1 and y0 <= y < y1:
                return i
        return -1

    def find_seam(
        self,
        orientation: str,
        pos: int,
        tolerance: int,
    ) -> list[int]:
        """找 pos 附近、沿 orientation 方向共缝的所有面板。

        h 缝: 上边界或下边界 y == pos 的面板; v 缝同理用 x。
        返回面板索引列表 (拖一整条 T 形缝时会牵动多格)。
        """
        hits: list[int] = []
        for i, (x0, y0, x1, y1) in enumerate(self.panels):
            if orientation == "h":
                if abs(y0 - pos) <= tolerance or abs(y1 - pos) <= tolerance:
                    hits.append(i)
            else:
                if abs(x0 - pos) <= tolerance or abs(x1 - pos) <= tolerance:
                    hits.append(i)
        return hits

    # ---------- 修改 ----------
    def drag_seam(
        self,
        orientation: str,
        old_pos: int,
        new_pos: int,
        tolerance: int,
    ) -> ChangeHint:
        """拖动一条缝。共享这条缝的格子一起被推 / 拉, 其它格子不动。"""
        self.snapshot()
        hits = self.find_seam(orientation, old_pos, tolerance)
        delta = new_pos - old_pos
        changed_rects: list[Rect] = []
        changed_idx: list[int] = []

        for i in hits:
            x0, y0, x1, y1 = self.panels[i]
            if orientation == "h":
                if abs(y0 - old_pos) <= tolerance:  # 上边界
                    ny0 = self._clamp(y0 + delta, 0, y1 - 2)
                    rect = (x0, ny0, x1, y1)
                elif abs(y1 - old_pos) <= tolerance:  # 下边界
                    ny1 = self._clamp(y1 + delta, y0 + 2, self.page_h)
                    rect = (x0, y0, x1, ny1)
                else:
                    continue
            else:
                if abs(x0 - old_pos) <= tolerance:
                    nx0 = self._clamp(x0 + delta, 0, x1 - 2)
                    rect = (nx0, y0, x1, y1)
                elif abs(x1 - old_pos) <= tolerance:
                    nx1 = self._clamp(x1 + delta, x0 + 2, self.page_w)
                    rect = (x0, y0, nx1, y1)
            changed_rects.append(self.panels[i])
            changed_rects.append(rect)
            self.panels[i] = rect
            changed_idx.append(i)

        self.manual_order = None
        return ChangeHint(
            dirty=_union_rects(changed_rects),
            panels_changed=changed_idx,
            full_order_reset=True,
        )

    def split_panel(
        self,
        index: int,
        orientation: str,
        pos: int,
    ) -> ChangeHint:
        """补一条断缝: 把第 index 格沿 h/v 切成两格。"""
        x0, y0, x1, y1 = self.panels[index]
        if orientation == "h":
            if not y0 + 2 <= pos <= y1 - 2:
                return ChangeHint(dirty=None)
            a = (x0, y0, x1, pos)
            b = (x0, pos, x1, y1)
        else:
            if not x0 + 2 <= pos <= x1 - 2:
                return ChangeHint(dirty=None)
            a = (x0, y0, pos, y1)
            b = (pos, y0, x1, y1)

        self.snapshot()

        self.panels[index : index + 1] = [a, b]
        self.manual_order = None
        return ChangeHint(
            dirty=(x0, y0, x1, y1),
            panels_added=[index, index + 1],
            panels_removed=[index],
            full_order_reset=True,
        )

    def apply_partial_cut(self, cut) -> ChangeHint:
        """按检测到的局部缝 (segmentation.Cut) 补刀。

        找到该缝穿过的面板 (缝坐标落在面板内部), 在 cut.pos 处切分;
        若缝已贴在某条边界上则跳过。
        """
        idx = self.panel_at(cut.pos, cut.pos)
        if idx < 0:
            return ChangeHint(dirty=None)
        x0, y0, x1, y1 = self.panels[idx]
        if cut.orientation == "v" and (
            abs(cut.pos - x0) <= 1 or abs(cut.pos - x1) <= 1
        ):
            return ChangeHint(dirty=None)
        if cut.orientation == "h" and (
            abs(cut.pos - y0) <= 1 or abs(cut.pos - y1) <= 1
        ):
            return ChangeHint(dirty=None)
        return self.split_panel(idx, cut.orientation, cut.pos)

    def merge_panels(self, indices: list[int]) -> ChangeHint:
        """合并误切的格子: 取并集矩形, 顺序位置用被合并格的最靠前序号。"""
        ids = sorted(set(indices))
        if len(ids) < 2:
            return ChangeHint(dirty=None)
        self.snapshot()
        rects = [self.panels[i] for i in ids]
        merged = _union_rects(rects)
        assert merged is not None
        keep = ids[0]
        for i in reversed(ids):
            del self.panels[i]
        self.panels.insert(keep, merged)
        self.manual_order = None
        return ChangeHint(
            dirty=merged,
            panels_added=[keep],
            panels_removed=ids,
            full_order_reset=True,
        )

    def set_manual_order(self, order: list[int]) -> None:
        """拖动排序后, 保存新的阅读顺序 (panel 索引序列)。"""
        if sorted(order) != list(range(len(self.panels))):
            raise ValueError("order must be a permutation of panel indices")
        self.snapshot()
        self.manual_order = list(order)

    def clear_manual_order(self) -> None:
        self.snapshot()
        self.manual_order = None

    @staticmethod
    def _clamp(v: int, lo: int, hi: int) -> int:
        return max(lo, min(hi, v))
