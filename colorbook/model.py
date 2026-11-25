"""区域模型：维护连通区域、邻接关系、小碎块合并与可撤销状态。"""

from __future__ import annotations

from dataclasses import dataclass, replace

import numpy as np
from PIL import Image

from .ccl import label_connected, to_rgb_array

MAX_UNDO = 12


@dataclass
class Region:
    """一个需要各填一次颜色的连通区域。"""

    id: int
    color: tuple[int, int, int]
    area: int
    bbox: tuple[int, int, int, int]  # min_y, min_x, max_y, max_x（含端点）
    protected: bool = False  # 受保护的"岛"：自动合并不动它


@dataclass
class _Snapshot:
    labels: np.ndarray
    regions: dict[int, Region]
    adjacency: dict[int, set[int]]


class RegionModel:
    """标签图 + 区域元数据。合并直接改写标签图并增量更新邻接。"""

    def __init__(self, image: Image.Image) -> None:
        self.source_image = image.convert("RGB")
        rgb = to_rgb_array(image)
        result = label_connected(rgb)
        self.labels: np.ndarray = result["labels"]
        self.height, self.width = self.labels.shape
        # 背景约定为左上角像素所在的连通块（涂色页里通常是白纸）
        self.background_id: int = int(self.labels[0, 0])
        self.regions: dict[int, Region] = {}
        for lid in range(len(result["areas"])):
            self.regions[lid] = Region(
                id=lid,
                color=tuple(int(v) for v in result["colors"][lid]),
                area=int(result["areas"][lid]),
                bbox=tuple(int(v) for v in result["bboxes"][lid]),
            )
        self.adjacency: dict[int, set[int]] = self._compute_adjacency()
        self._undo: list[_Snapshot] = []
        self._redo: list[_Snapshot] = []
        # region id -> 手动指定的标签锚点 (x, y)，图像坐标
        self.manual_anchors: dict[int, tuple[int, int]] = {}
        self._color_numbers: dict[int, int] = self._build_color_numbers()

    # ------------------------------------------------------------------ #
    # 基础查询
    # ------------------------------------------------------------------ #
    def region_at(self, x: int, y: int) -> int | None:
        if 0 <= y < self.height and 0 <= x < self.width:
            lid = int(self.labels[y, x])
            return lid if lid in self.regions else None
        return None

    def neighbors_of(self, region_id: int) -> set[int]:
        return set(self.adjacency.get(region_id, ()))

    def color_number(self, region_id: int) -> int:
        """同色区域共享同一个颜色编号；按颜色首次出现顺序编号。"""
        return self._color_numbers[region_id]

    def color_number_map(self) -> dict[tuple[int, int, int], int]:
        """颜色 -> 编号，供图例使用。背景不参与编号（涂色页不填背景）。"""
        seen: dict[tuple[int, int, int], int] = {}
        for lid in sorted(self.regions):
            if lid == self.background_id:
                continue
            color = self.regions[lid].color
            if color not in seen:
                seen[color] = len(seen) + 1
        return seen

    def _build_color_numbers(self) -> dict[int, int]:
        mapping = self.color_number_map()
        numbers = {}
        for lid, r in self.regions.items():
            # 背景没有颜色编号
            numbers[lid] = mapping.get(r.color, 0)
        return numbers

    def regions_of_color(self, color: tuple[int, int, int]) -> list[int]:
        return sorted(
            lid for lid, r in self.regions.items() if r.color == color
        )

    def region_ids(self) -> list[int]:
        return sorted(self.regions)

    # ------------------------------------------------------------------ #
    # 邻接
    # ------------------------------------------------------------------ #
    def _compute_adjacency(self) -> dict[int, set[int]]:
        adj: dict[int, set[int]] = {lid: set() for lid in self.regions}
        lab = self.labels
        right = lab[:, :-1]
        down = lab[:-1, :]
        mask_h = right != lab[:, 1:]
        pairs_h = np.unique(
            np.stack([right[mask_h], lab[:, 1:][mask_h]], axis=1), axis=0
        )
        mask_v = down != lab[1:, :]
        pairs_v = np.unique(
            np.stack([down[mask_v], lab[1:, :][mask_v]], axis=1), axis=0
        )
        pairs = pairs_h
        if len(pairs_v):
            pairs = np.unique(np.concatenate([pairs, pairs_v]), axis=0)
        for a, b in pairs:
            a, b = int(a), int(b)
            adj.setdefault(a, set()).add(b)
            adj.setdefault(b, set()).add(a)
        return adj

    # ------------------------------------------------------------------ #
    # 撤销 / 重做
    # ------------------------------------------------------------------ #
    def _push_undo(self) -> None:
        self._undo.append(
            _Snapshot(
                labels=self.labels.copy(),
                regions={lid: replace(r) for lid, r in self.regions.items()},
                adjacency={lid: set(ns) for lid, ns in self.adjacency.items()},
            )
        )
        del self._undo[:-MAX_UNDO]
        self._redo.clear()

    def _take_snapshot(self) -> _Snapshot:
        return _Snapshot(
            labels=self.labels.copy(),
            regions={lid: replace(r) for lid, r in self.regions.items()},
            adjacency={lid: set(ns) for lid, ns in self.adjacency.items()},
        )

    def _restore(self, snap: _Snapshot) -> None:
        self.labels = snap.labels.copy()
        self.regions = {lid: replace(r) for lid, r in snap.regions.items()}
        self.adjacency = {lid: set(ns) for lid, ns in snap.adjacency.items()}
        self.manual_anchors.clear()
        self._color_numbers = self._build_color_numbers()

    def undo(self) -> bool:
        if not self._undo:
            return False
        self._redo.append(self._take_snapshot())
        self._restore(self._undo.pop())
        return True

    def redo(self) -> bool:
        if not self._redo:
            return False
        self._undo.append(self._take_snapshot())
        self._restore(self._redo.pop())
        return True

    # ------------------------------------------------------------------ #
    # 保护岛
    # ------------------------------------------------------------------ #
    def set_protected(self, region_id: int, protected: bool) -> None:
        if region_id in self.regions:
            self.regions[region_id].protected = protected

    def toggle_protected(self, region_id: int) -> bool:
        region = self.regions.get(region_id)
        if region is None:
            return False
        region.protected = not region.protected
        return region.protected

    # ------------------------------------------------------------------ #
    # 合并
    # ------------------------------------------------------------------ #
    def merge_into(self, small_id: int, target_id: int) -> bool:
        """把 small_id 区域合入 target_id，标签、元数据、邻接、边界一并更新。"""
        if small_id == target_id:
            return False
        if small_id not in self.regions or target_id not in self.regions:
            return False
        if target_id not in self.adjacency.get(small_id, set()):
            return False

        self._push_undo()
        self.labels[self.labels == small_id] = target_id

        small = self.regions.pop(small_id)
        target = self.regions[target_id]
        target.area += small.area
        target.bbox = (
            min(target.bbox[0], small.bbox[0]),
            min(target.bbox[1], small.bbox[1]),
            max(target.bbox[2], small.bbox[2]),
            max(target.bbox[3], small.bbox[3]),
        )

        # 增量更新邻接：small 的邻居改为与 target 相邻
        neighbors = self.adjacency.pop(small_id)
        neighbors.discard(target_id)
        self.adjacency[target_id].discard(small_id)
        for nid in neighbors:
            self.adjacency[nid].discard(small_id)
            if nid != target_id:
                self.adjacency[target_id].add(nid)
                self.adjacency[nid].add(target_id)

        self.manual_anchors.pop(small_id, None)
        self._color_numbers = self._build_color_numbers()
        return True

    def _best_merge_target(self, small_id: int) -> int | None:
        """选共享边界最长的邻居；并列时选面积更大的。"""
        lab = self.labels
        ys, xs = np.nonzero(lab == small_id)
        border_counts: dict[int, int] = {}
        # 四方向统计与各邻居的共享边数
        for dy, dx in ((0, 1), (0, -1), (1, 0), (-1, 0)):
            ny = np.clip(ys + dy, 0, self.height - 1)
            nx = np.clip(xs + dx, 0, self.width - 1)
            vals = lab[ny, nx]
            mask = vals != small_id
            others, counts = np.unique(vals[mask], return_counts=True)
            for other, count in zip(others, counts):
                other = int(other)
                if other in self.regions:
                    border_counts[other] = border_counts.get(other, 0) + int(count)
        if not border_counts:
            return None

        # 优先并入彩色邻居；只有碎块完全被背景包围时才并入背景，
        # 避免正常图形被纸面吃掉
        non_bg = {k: v for k, v in border_counts.items() if k != self.background_id}
        pool = non_bg if non_bg else border_counts

        def sort_key(item: tuple[int, int]) -> tuple[int, int]:
            nid, border = item
            return border, self.regions[nid].area

        return max(pool.items(), key=sort_key)[0]

    def merge_small_regions(
        self, min_area: int, ignore_protected: bool = True
    ) -> list[tuple[int, int]]:
        """把所有面积 < min_area 的未保护碎块合入相邻区域。

        从小到大处理，直到没有合格碎块；返回 (被合并id, 目标id) 列表。
        整个操作只占一个撤销步。背景（纸面）既不会被当作碎块合并，
        也只在没有其他彩色邻居时才作为合并目标，避免图形被"吃进白纸"。
        """
        merged: list[tuple[int, int]] = []
        if min_area <= 0:
            return merged

        self._push_undo()
        while True:
            candidates = [
                lid
                for lid, r in self.regions.items()
                if r.area < min_area
                and not (ignore_protected and r.protected)
                and lid != self.background_id
            ]
            if not candidates:
                break
            # 每轮取最小的，保证大块不会先吃掉小块导致顺序不可控
            small_id = min(candidates, key=lambda lid: self.regions[lid].area)
            target = self._best_merge_target(small_id)
            if target is None:
                # 没有邻居（整图单色等极端情况），跳过避免死循环
                break
            # merge_into 会再压一次撤销栈，这里直接内联合并逻辑
            self._apply_merge(small_id, target)
            merged.append((small_id, target))

        if not merged:
            # 没有可合并的，撤回刚才占位的撤销快照
            self._undo.pop()
        return merged

    def _apply_merge(self, small_id: int, target_id: int) -> None:
        """merge_into 的内联版本，不单独压栈（供批量合并使用）。"""
        self.labels[self.labels == small_id] = target_id
        small = self.regions.pop(small_id)
        target = self.regions[target_id]
        target.area += small.area
        target.bbox = (
            min(target.bbox[0], small.bbox[0]),
            min(target.bbox[1], small.bbox[1]),
            max(target.bbox[2], small.bbox[2]),
            max(target.bbox[3], small.bbox[3]),
        )
        neighbors = self.adjacency.pop(small_id)
        neighbors.discard(target_id)
        self.adjacency[target_id].discard(small_id)
        for nid in neighbors:
            self.adjacency[nid].discard(small_id)
            if nid != target_id:
                self.adjacency[target_id].add(nid)
                self.adjacency[nid].add(target_id)
        self.manual_anchors.pop(small_id, None)
        self._color_numbers = self._build_color_numbers()

    # ------------------------------------------------------------------ #
    # 手动标签锚点
    # ------------------------------------------------------------------ #
    def set_manual_anchor(self, region_id: int, x: int, y: int) -> bool:
        if region_id not in self.regions:
            return False
        self.manual_anchors[region_id] = (int(x), int(y))
        return True

    def clear_manual_anchor(self, region_id: int) -> None:
        self.manual_anchors.pop(region_id, None)
