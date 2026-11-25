"""一次马赛克制作的完整状态：素材、参数、固定格、最近一次求解结果。

GUI、CLI、测试都通过 MosaicSession 操作，避免界面代码里散落算法细节。
"""
from __future__ import annotations

import math
import random
from dataclasses import dataclass, field
from pathlib import Path

from .config import UNLIMITED, MosaicParams
from .engine import SolveResult, solve
from .features import build_cost_matrix, similarity
from .imaging import (
    Cell, GridLayout, Tile, build_grid, load_image_rgb, load_tiles_from_folder,
)


@dataclass
class Candidate:
    tile: Tile
    distance: float

    @property
    def similarity(self) -> float:
        return similarity(self.distance)


class MosaicSession:
    def __init__(self) -> None:
        self.params: MosaicParams = MosaicParams()
        self.base_path: str | None = None
        self.base_image = None  # PIL.Image
        self.grid: GridLayout | None = None

        self.tile_folder: str | None = None
        self.tiles: list[Tile] = []
        self.tile_by_id: dict[str, Tile] = {}

        # tile_id -> 自定义配额；-1(UNLIMITED) 表示不限，0 表示禁用。
        self.quota_overrides: dict[str, int] = {}
        # cell_index -> tile_id（用户固定/手动指定的格）
        self.fixed: dict[int, str] = {}

        self.costs: list[list[float]] = []
        self.result: SolveResult | None = None
        self.last_error: str | None = None

    # ---- 素材载入 ----------------------------------------------------
    def load_base(self, path: str | Path, cell_size: int | None = None) -> GridLayout:
        self.base_image = load_image_rgb(path)
        self.base_path = str(Path(path).resolve())
        if cell_size is not None:
            self.params.cell_size = int(cell_size)
        self.rebuild_grid()
        return self.grid  # type: ignore[return-value]

    def rebuild_grid(self) -> GridLayout:
        if self.base_image is None:
            raise RuntimeError("尚未载入底图")
        self.grid = build_grid(self.base_image, self.params.cell_size)
        # 格子索引会随格子大小变化，旧固定格按位置保留更符合直觉：
        # 这里无法直接迁移，调用方应在改 cell_size 前调用 regrid 迁移方法。
        self._rebuild_costs()
        return self.grid

    def regrid(self, cell_size: int) -> None:
        """调整格子大小，并尽量按行列比例迁移已有固定格。"""
        old_grid = self.grid
        old_fixed = dict(self.fixed)
        self.params.cell_size = max(4, int(cell_size))
        self.rebuild_grid()
        new_fixed: dict[int, str] = {}
        if old_grid is not None and self.grid is not None and old_fixed:
            for old_idx, tile_id in old_fixed.items():
                if tile_id not in self.tile_by_id:
                    continue
                oc = old_grid.cells[old_idx]
                # 用归一化位置映射到新网格，尽量保住用户意图。
                nr = min(self.grid.rows - 1,
                         int((oc.row + 0.5) * self.grid.rows / old_grid.rows))
                nc = min(self.grid.cols - 1,
                         int((oc.col + 0.5) * self.grid.cols / old_grid.cols))
                new_idx = nr * self.grid.cols + nc
                new_fixed[new_idx] = tile_id
        self.fixed = new_fixed

    def load_tile_folder(self, folder: str | Path,
                         compute_hash: bool = True) -> list[Tile]:
        self.tile_folder = str(Path(folder).resolve())
        self.tiles = load_tiles_from_folder(folder, compute_hash=compute_hash)
        self.tile_by_id = {t.id: t for t in self.tiles}
        # 清掉指向不存在样块的配额覆盖与固定格。
        self.quota_overrides = {
            k: v for k, v in self.quota_overrides.items() if k in self.tile_by_id
        }
        self.fixed = {
            c: tid for c, tid in self.fixed.items() if tid in self.tile_by_id
        }
        self._rebuild_costs()
        return self.tiles

    def set_tiles(self, tiles: list[Tile], folder: str | None = None) -> None:
        """测试或程序化注入样块时使用。"""
        self.tiles = tiles
        for i, t in enumerate(self.tiles):
            t.ordinal = i
        self.tile_by_id = {t.id: t for t in self.tiles}
        self.tile_folder = folder
        self._rebuild_costs()

    def _rebuild_costs(self) -> None:
        if self.grid is not None and self.tiles:
            self.costs = build_cost_matrix(
                [c.feature for c in self.grid.cells],
                [t.feature for t in self.tiles],
                self.params,
            )
        else:
            self.costs = []

    def set_texture_weight(self, texture_w: float) -> None:
        """只调纹理权重时，按默认比例重分剩余权重。"""
        tw = max(0.0, min(0.9, float(texture_w)))
        rest = 1.0 - tw
        # 保持 color:layout = 0.25:0.45 = 5:9
        self.params.texture_weight = tw
        self.params.color_weight = rest * 5 / 14
        self.params.layout_weight = rest * 9 / 14
        self._rebuild_costs()

    # ---- 配额 --------------------------------------------------------
    def auto_quota(self) -> int:
        """自动配额：总容量约为格子数的两倍，既限集中又不易整体缺额。"""
        n = self.grid.count if self.grid else 0
        t = max(1, len(self.tiles))
        return max(2, math.ceil(2 * n / t))

    def effective_quota(self) -> list[int]:
        """每块样块当前生效的总配额（序号对齐 tiles）。"""
        auto = self.auto_quota()
        default_q = auto if self.params.max_uses == 0 else max(0, self.params.max_uses)
        quotas: list[int] = []
        for t in self.tiles:
            q = self.quota_overrides.get(t.id, default_q)
            quotas.append(UNLIMITED if q is None or q < 0 else int(q))
        return quotas

    def quota_for_tile(self, tile_id: str) -> int:
        q = self.quota_overrides.get(tile_id)
        if q is None:
            return self.auto_quota() if self.params.max_uses == 0 else self.params.max_uses
        return q

    # ---- 固定格 ------------------------------------------------------
    def set_fixed(self, cell_index: int, tile_id: str | None) -> None:
        if tile_id is None:
            self.fixed.pop(cell_index, None)
        else:
            if tile_id not in self.tile_by_id:
                raise KeyError(f"未知样块：{tile_id}")
            self.fixed[cell_index] = tile_id

    def toggle_fixed_tile(self, cell_index: int, tile_id: str) -> bool:
        """点选候选：若该格已固定为同一块则取消固定，否则固定为该块。"""
        if self.fixed.get(cell_index) == tile_id:
            self.fixed.pop(cell_index, None)
            return False
        self.fixed[cell_index] = tile_id
        return True

    # ---- 求解 --------------------------------------------------------
    def can_solve(self) -> tuple[bool, str]:
        if self.base_image is None or self.grid is None:
            return False, "请先读取底图。"
        if not self.tiles:
            return False, "请先选择包含样块图片的文件夹（或用程序生成样块）。"
        if not self.costs:
            return False, "特征矩阵尚未准备好。"
        return True, ""

    def solve(self) -> SolveResult:
        ok, msg = self.can_solve()
        if not ok:
            raise RuntimeError(msg)

        quota = self.effective_quota()
        fixed_ord: dict[int, int] = {}
        for cell_idx, tile_id in self.fixed.items():
            tile = self.tile_by_id.get(tile_id)
            if tile is not None and 0 <= cell_idx < self.grid.count:
                fixed_ord[cell_idx] = tile.ordinal

        self.result = solve(
            rows=self.grid.rows,
            cols=self.grid.cols,
            costs=self.costs,
            quota=quota,
            adjacency_radius=self.params.adjacency_radius,
            seed=self.params.seed,
            fixed=fixed_ord,
            improvement_passes=self.params.improvement_passes,
            tile_names=[t.name for t in self.tiles],
        )
        return self.result

    # ---- 候选与诊断 --------------------------------------------------
    def candidates(self, cell_index: int, limit: int | None = None) -> list[Candidate]:
        if not self.costs:
            return []
        rows = self.costs[cell_index]
        order = sorted(range(len(rows)), key=lambda j: (rows[j], j))
        if limit:
            order = order[:limit]
        return [Candidate(self.tiles[j], rows[j]) for j in order]

    def cell_similarity(self, cell_index: int) -> float | None:
        if self.result is None:
            return None
        o = self.result.outcomes[cell_index]
        return None if o.cost is None else similarity(o.cost)

    def issue_cells(self, worst_limit: int = 24) -> list[tuple[int, str, float | None]]:
        """返回需要定位的格子：未匹配优先，其后是相似度最差的已匹配格。"""
        if self.result is None:
            return []
        items: list[tuple[int, str, float | None]] = []
        unmatched: list[tuple[int, str, float | None]] = []
        matched: list[tuple[int, float]] = []
        for o in self.result.outcomes:
            if o.status == "unmatched":
                unmatched.append((o.cell, o.reason or "未匹配", None))
            elif o.cost is not None:
                matched.append((o.cell, o.cost))
        items.extend(unmatched)
        matched.sort(key=lambda x: -x[1])  # 距离越大问题越大
        for cell, cost in matched[:worst_limit]:
            items.append((cell, f"相似度偏低（{similarity(cost) * 100:.0f}%）",
                          similarity(cost)))
        return items

    def usage_rows(self) -> list[dict]:
        """配额表面板用：每块样块的配额/已用/固定/剩余。"""
        if self.result is None:
            return []
        rows = []
        for j, t in enumerate(self.tiles):
            q = self.result.quota[j]
            used = self.result.usage[j]
            fx = self.result.fixed_usage[j]
            rows.append({
                "tile_id": t.id, "name": t.name, "group": t.source_group,
                "quota": q, "used": used, "fixed": fx,
                "remaining": None if q == UNLIMITED else q - used,
            })
        return rows
