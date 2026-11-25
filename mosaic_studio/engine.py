"""受限样块分配引擎（不依赖 Pillow / GUI，可独立测试）。

约束
----
1. 每个格子选一块样块，代价是图像特征距离（见 features.py）；
2. 全图配额：每块样块最多使用 quota[j] 次（UNLIMITED 表示不限）；
3. 相邻重复：同一样块在切比雪夫半径 adjacency_radius 内不能出现两次；
4. 固定格：调用方指定的格子-样块关系永远保留，配额与邻接限制都把它们
   当作既成事实；若固定格自身超过配额，记录 fixed_conflicts 但不改动固定格。

算法
----
- 用整数位掩码维护每个未决格“当前仍可行”的样块集合；
- 可行性只会单调减少（配额耗尽 / 邻格落子带来的封锁），用惰性二叉堆
  实现 MRV（可行候选最少的格子先选），配额紧张时优先处理最挑剔的格；
- 没有可行样块的格子立即判定 unmatched，并给出配额/邻接原因；
- 同种子、同输入下，格子的随机优先级与遍历顺序完全确定，可重现排版；
- 贪心结束后做若干轮“保持约束”的替换/交换优化以降低总代价。
"""
from __future__ import annotations

import heapq
import random
from dataclasses import dataclass, field

from .config import UNLIMITED

_PENDING = 0
_ASSIGNED = 1
_DEAD = 2


@dataclass
class CellOutcome:
    cell: int
    row: int
    col: int
    tile: int | None                 # 样块序号；未匹配为 None
    fixed: bool
    cost: float | None
    status: str                      # "fixed" | "matched" | "unmatched"
    reason_code: str | None = None   # "quota" | "adjacency" | "no_tiles"
    reason: str = ""
    quota_blockers: list[int] = field(default_factory=list)
    adjacency_blockers: list[int] = field(default_factory=list)
    best_tile: int | None = None
    best_cost: float | None = None


@dataclass
class FixedConflict:
    kind: str                        # "quota" | "adjacency"
    tile: int
    cells: list[int]
    detail: str


@dataclass
class SolveResult:
    rows: int
    cols: int
    cell_count: int
    tile_count: int
    seed: int
    outcomes: list[CellOutcome]
    choice: list[int]                # 每格样块序号，未匹配=-1
    is_fixed: list[bool]
    usage: list[int]                 # 每块总使用次数（含固定）
    fixed_usage: list[int]
    quota: list[int]
    remaining: list[int]            # 求解结束后的剩余配额（优化后可能 >0）
    fixed_conflicts: list[FixedConflict]
    capacity_total: int | None       # None 表示存在不限配额的样块
    free_capacity: int | None        # 扣除固定格后还能放多少块
    free_deficit: int                # 相对非固定格数的配额缺口
    assigned_count: int
    unmatched_count: int
    elapsed_ms: int = 0

    def outcome_at(self, row: int, col: int) -> CellOutcome:
        return self.outcomes[row * self.cols + col]


def neighbor_offsets(radius: int) -> list[tuple[int, int]]:
    if radius <= 0:
        return []
    return [
        (dr, dc)
        for dr in range(-radius, radius + 1)
        for dc in range(-radius, radius + 1)
        if not (dr == 0 and dc == 0)
    ]


def solve(
    rows: int,
    cols: int,
    costs: list[list[float]],
    quota: list[int],
    *,
    adjacency_radius: int = 1,
    seed: int = 0,
    fixed: dict[int, int] | None = None,
    improvement_passes: int = 2,
    tile_names: list[str] | None = None,
) -> SolveResult:
    """执行分配。``costs[cell][tile]`` 为距离代价；``fixed`` 为 cell->tile 序号。"""
    import time
    t0 = time.perf_counter()

    fixed = dict(fixed or {})
    n = rows * cols
    t_count = len(quota)
    if len(costs) != n:
        raise ValueError(f"costs 行数 {len(costs)} 与格子数 {n} 不一致")
    for row_costs in costs:
        if len(row_costs) != t_count:
            raise ValueError("costs 列数与 quota 长度不一致")

    names = tile_names or [f"样块#{j + 1}" for j in range(t_count)]
    offsets = neighbor_offsets(adjacency_radius)

    # 预计算每格的邻格（切比雪夫半径内）。
    neighbors: list[tuple[int, ...]] = [()] * n
    for r in range(rows):
        for c in range(cols):
            idx = r * cols + c
            near: list[int] = []
            for dr, dc in offsets:
                rr, cc = r + dr, c + dc
                if 0 <= rr < rows and 0 <= cc < cols:
                    near.append(rr * cols + cc)
            neighbors[idx] = tuple(near)

    # 每个格子一个确定性的随机优先级，决定 MRV 并列时的顺序。
    rng = random.Random(seed)
    priority = [rng.getrandbits(64) for _ in range(n)]

    all_mask = (1 << t_count) - 1 if t_count else 0

    # ---- 固定格校验与配额初始化 -------------------------------------
    fixed_usage = [0] * t_count
    valid_fixed: dict[int, int] = {}
    fixed_conflicts: list[FixedConflict] = []
    for cell, tile in fixed.items():
        if not (0 <= cell < n) or not (0 <= tile < t_count):
            continue
        valid_fixed[cell] = tile
        fixed_usage[tile] += 1

    for j in range(t_count):
        if quota[j] != UNLIMITED and fixed_usage[j] > quota[j]:
            fixed_conflicts.append(FixedConflict(
                kind="quota", tile=j,
                cells=[c for c, tj in valid_fixed.items() if tj == j],
                detail=(f"「{names[j]}」被固定使用 {fixed_usage[j]} 次，"
                        f"超过配额 {quota[j]} 次；固定格仍全部保留，"
                        f"其他格子不能再使用该样块。"),
            ))

    # 固定格之间若自身违反邻接规则，也明确报告（用户显式指定，不能擅改）。
    seen_pairs: set[tuple[int, int]] = set()
    for cell, tile in valid_fixed.items():
        for q in neighbors[cell]:
            if valid_fixed.get(q) == tile:
                pair = (min(cell, q), max(cell, q))
                if pair not in seen_pairs:
                    seen_pairs.add(pair)
                    fixed_conflicts.append(FixedConflict(
                        kind="adjacency", tile=tile,
                        cells=[pair[0], pair[1]],
                        detail=(f"「{names[tile]}」被固定在相邻格子 "
                                f"({pair[0] // cols + 1},{pair[0] % cols + 1}) 与 "
                                f"({pair[1] // cols + 1},{pair[1] % cols + 1})，"
                                f"固定优先于相邻限制。"),
                    ))

    remaining = list(quota)
    for j in range(t_count):
        if remaining[j] != UNLIMITED:
            remaining[j] -= fixed_usage[j]

    def quota_available(j: int) -> bool:
        return quota[j] == UNLIMITED or remaining[j] > 0

    avail_mask = 0
    for j in range(t_count):
        if quota_available(j):
            avail_mask |= 1 << j

    state = [_PENDING] * n
    tile_of = [-1] * n
    is_fixed = [False] * n
    usage = list(fixed_usage)
    holders: list[set[int]] = [set() for _ in range(t_count)]

    blocked_mask = [0] * n

    # 先把固定格落到状态里，并把它们使用的样块加入邻格封锁位。
    for cell, tile in valid_fixed.items():
        state[cell] = _ASSIGNED
        tile_of[cell] = tile
        is_fixed[cell] = True
        holders[tile].add(cell)
        bit = 1 << tile
        for q in neighbors[cell]:
            blocked_mask[q] |= bit

    feasible_mask = [0] * n
    heap: list[tuple[int, int, int]] = []
    for cell in range(n):
        if state[cell] != _PENDING:
            continue
        m = all_mask & avail_mask & ~blocked_mask[cell]
        feasible_mask[cell] = m
        heapq.heappush(heap, (m.bit_count(), priority[cell], cell))

    # ---- MRV 贪心 ----------------------------------------------------
    # 惰性堆的正确性要点：feasible_mask 每次变小时都会压入一条新的
    # (新计数,...)，所以弹出过期条目时，堆里必然已有一条与当前计数一致的
    # 新条目（若该格已被处理则直接跳过），过期条目直接丢弃即可，
    # 不能再按“当前计数”重复入堆，否则会造成指数级的重复弹出。
    while heap:
        count, _prio, cell = heapq.heappop(heap)
        if state[cell] != _PENDING:
            continue
        actual = feasible_mask[cell].bit_count()
        if count != actual:
            continue

        if actual == 0 or t_count == 0:
            state[cell] = _DEAD
            continue

        m = feasible_mask[cell]
        best_tile = -1
        best_cost = float("inf")
        bits = m
        while bits:
            lsb = bits & -bits
            j = lsb.bit_length() - 1
            co = costs[cell][j]
            if co < best_cost:  # 严格小于：同代价时序号小者胜，保证确定
                best_cost = co
                best_tile = j
            bits ^= lsb

        bit = 1 << best_tile
        state[cell] = _ASSIGNED
        tile_of[cell] = best_tile
        usage[best_tile] += 1
        if quota[best_tile] != UNLIMITED:
            remaining[best_tile] -= 1
        holders[best_tile].add(cell)

        # 邻格封锁该样块。
        for q in neighbors[cell]:
            if state[q] == _PENDING and (feasible_mask[q] & bit):
                feasible_mask[q] &= ~bit
                heapq.heappush(
                    heap, (feasible_mask[q].bit_count(), priority[q], q))

        # 配额耗尽：从所有未决格的可行集合里摘掉该样块。
        if quota[best_tile] != UNLIMITED and remaining[best_tile] == 0:
            avail_mask &= ~bit
            for q in range(n):
                if state[q] == _PENDING and (feasible_mask[q] & bit):
                    feasible_mask[q] &= ~bit
                    heapq.heappush(
                        heap, (feasible_mask[q].bit_count(), priority[q], q))

    # 理论上不会有遗留 PENDING（每个 pending 初始都入堆且变化必入新条目），
    # 保险起见把任何遗留格标记为未匹配。
    for cell in range(n):
        if state[cell] == _PENDING:
            state[cell] = _DEAD

    # ---- 保约束局部优化 ---------------------------------------------
    if improvement_passes > 0 and t_count > 0:
        _improve(
            rows, cols, neighbors, costs, quota, remaining, holders,
            state, tile_of, is_fixed, usage, priority,
            passes=improvement_passes,
        )

    # 优化阶段的交换可能搬走了封锁死格的样块，按确定性顺序补填一轮：
    # 访问某死格时若仍有可行样块就填掉；没有则此后约束只会更紧，不必再回访。
    dead_cells = [c for c in range(n) if state[c] == _DEAD]
    dead_cells.sort(key=lambda c: priority[c])
    for cell in dead_cells:
        candidates = [
            j for j in range(t_count)
            if (quota[j] == UNLIMITED or remaining[j] > 0)
            and _adj_ok(cell, j, -1, neighbors, tile_of)
        ]
        if not candidates:
            continue
        best_tile = min(candidates, key=lambda j: (costs[cell][j], j))
        state[cell] = _ASSIGNED
        tile_of[cell] = best_tile
        usage[best_tile] += 1
        if quota[best_tile] != UNLIMITED:
            remaining[best_tile] -= 1
        holders[best_tile].add(cell)

    # 优化阶段直接维护 remaining；这里以 usage 为准重算一次，避免漂移。
    for j in range(t_count):
        if quota[j] == UNLIMITED:
            remaining[j] = UNLIMITED
        else:
            remaining[j] = quota[j] - usage[j]

    # ---- 汇总未匹配原因 ---------------------------------------------
    outcomes: list[CellOutcome] = []
    assigned_count = 0
    for cell in range(n):
        r, c = divmod(cell, cols)
        tj = tile_of[cell]
        best_tile = min(range(t_count), key=lambda j: costs[cell][j]) if t_count else None
        best_cost = costs[cell][best_tile] if best_tile is not None else None

        if state[cell] == _ASSIGNED:
            assigned_count += 1
            outcomes.append(CellOutcome(
                cell=cell, row=r, col=c, tile=tj,
                fixed=is_fixed[cell], cost=costs[cell][tj],
                status="fixed" if is_fixed[cell] else "matched",
                best_tile=best_tile, best_cost=best_cost,
            ))
            continue

        quota_blockers: list[int] = []
        adjacency_blockers: list[int] = []
        for j in range(t_count):
            quota_full = quota[j] != UNLIMITED and usage[j] >= quota[j]
            if quota_full:
                quota_blockers.append(j)
            elif _adjacency_blocks(cell, j, neighbors, tile_of):
                adjacency_blockers.append(j)
            # 否则该样块在最终布局里仍可放：补填轮保证这种格已被填掉，
            # 走到这里只会是未匹配，故不会出现“仍可行”的遗漏项。

        if t_count == 0:
            code = "no_tiles"
            reason = "样块文件夹里没有可用图片。"
        elif quota_blockers and adjacency_blockers:
            code = "mixed"
            reason = (f"约束冲突：{len(quota_blockers)} 种样块配额已经用尽，"
                      f"其余有配额的样块中有 {len(adjacency_blockers)} 种"
                      f"落在该格邻域内，该格未能匹配。")
        elif quota_blockers:
            code = "quota"
            reason = (f"配额不足：{len(quota_blockers)} 种样块的全图配额都已用完，"
                      f"该格未能匹配。")
        else:
            code = "adjacency"
            reason = (f"相邻重复限制：仍有配额的样块都已出现在该格的邻域内"
                      f"（{len(adjacency_blockers)} 种被挡）。")

        if best_tile is not None:
            if best_tile in quota_blockers:
                reason += f" 最相似的是「{names[best_tile]}」，但配额已用完。"
            elif best_tile in adjacency_blockers:
                reason += f" 最相似的是「{names[best_tile]}」，但就在相邻位置。"

        outcomes.append(CellOutcome(
            cell=cell, row=r, col=c, tile=None, fixed=False, cost=None,
            status="unmatched", reason_code=code, reason=reason,
            quota_blockers=quota_blockers,
            adjacency_blockers=adjacency_blockers,
            best_tile=best_tile, best_cost=best_cost,
        ))

    # ---- 容量缺口 ----------------------------------------------------
    has_unlimited = any(q == UNLIMITED for q in quota)
    if has_unlimited:
        capacity_total = None
        free_capacity = None
        free_deficit = 0
    else:
        capacity_total = sum(quota)
        free_capacity = sum(max(0, quota[j] - fixed_usage[j]) for j in range(t_count))
        free_cells = n - len(valid_fixed)
        free_deficit = max(0, free_cells - free_capacity)

    elapsed_ms = int((time.perf_counter() - t0) * 1000)
    return SolveResult(
        rows=rows, cols=cols, cell_count=n, tile_count=t_count, seed=seed,
        outcomes=outcomes, choice=tile_of, is_fixed=is_fixed,
        usage=usage, fixed_usage=fixed_usage, quota=list(quota),
        remaining=remaining, fixed_conflicts=fixed_conflicts,
        capacity_total=capacity_total, free_capacity=free_capacity,
        free_deficit=free_deficit, assigned_count=assigned_count,
        unmatched_count=n - assigned_count, elapsed_ms=elapsed_ms,
    )


def _adjacency_blocks(cell: int, tile: int,
                      neighbors: list[tuple[int, ...]],
                      tile_of: list[int]) -> bool:
    for q in neighbors[cell]:
        if tile_of[q] == tile:
            return True
    return False


def _adj_ok(cell: int, tile: int, ignore: int,
            neighbors: list[tuple[int, ...]], tile_of: list[int]) -> bool:
    for q in neighbors[cell]:
        if q == ignore:
            continue
        if tile_of[q] == tile:
            return False
    return True


def _improve(rows, cols, neighbors, costs, quota, remaining, holders,
             state, tile_of, is_fixed, usage, priority, *, passes: int) -> None:
    """贪心后的保约束替换/交换。任何改动都不破坏配额与邻接约束。"""
    n = len(tile_of)
    t_count = len(quota)
    eps = 1e-9

    movable = [c for c in range(n)
               if state[c] == _ASSIGNED and not is_fixed[c]]
    # 代价高的格子优先修；同代价用确定性优先级。
    movable.sort(key=lambda c: (-costs[c][tile_of[c]], priority[c]))

    for _pass in range(max(1, passes)):
        changed_any = False
        for c in movable:
            cur = tile_of[c]
            if cur < 0:
                continue
            cur_cost = costs[c][cur]
            best_gain = -eps
            best_kind = None      # "replace" | "swap"
            best_tile = -1
            best_partner = -1

            # 只考虑比当前更像的前若干候选，控制复杂度。
            ranked = sorted(
                range(t_count),
                key=lambda j: costs[c][j],
            )[:10]

            for j in ranked:
                if j == cur or costs[c][j] >= cur_cost - eps:
                    continue

                if quota[j] == UNLIMITED or remaining[j] > 0:
                    if _adj_ok(c, j, -1, neighbors, tile_of):
                        gain = cur_cost - costs[c][j]
                        if gain > best_gain:
                            best_gain = gain
                            best_kind = "replace"
                            best_tile = j
                            best_partner = -1
                else:
                    # j 配额已满：找一个非固定的 j 持有者交换。
                    # 大网格 + 大配额时持有者可能很多，限制扫描数量，
                    # 取到的是“足够好”的确定性优化而非全局最优交换。
                    holders_j = sorted(holders[j])
                    scanned = 0
                    for d in holders_j:
                        if is_fixed[d] or d == c:
                            continue
                        scanned += 1
                        if scanned > 64:
                            break
                        old_at_d = tile_of[d]  # 必为 j
                        if old_at_d != j:
                            continue
                        if not _adj_ok(c, j, d, neighbors, tile_of):
                            continue
                        if not _adj_ok(d, cur, c, neighbors, tile_of):
                            continue
                        delta = ((costs[c][j] + costs[d][cur])
                                 - (cur_cost + costs[d][j]))
                        gain = -delta
                        if gain > best_gain:
                            best_gain = gain
                            best_kind = "swap"
                            best_tile = j
                            best_partner = d

            if best_kind is None:
                continue

            j = best_tile
            if best_kind == "replace":
                old = cur
                holders[old].discard(c)
                usage[old] -= 1
                if quota[old] != UNLIMITED:
                    remaining[old] += 1
                tile_of[c] = j
                holders[j].add(c)
                usage[j] += 1
                if quota[j] != UNLIMITED:
                    remaining[j] -= 1
            else:
                d = best_partner
                old = cur
                # 配额用量不变，只换位置与持有者集合。
                holders[old].discard(c)
                holders[j].discard(d)
                tile_of[c] = j
                tile_of[d] = old
                holders[j].add(c)
                holders[old].add(d)
            changed_any = True

        if not changed_any:
            break
