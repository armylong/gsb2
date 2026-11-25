"""引擎约束测试：配额、邻接、固定格、种子重现、随机不变量。"""
import random

import pytest

from mosaic_studio.config import UNLIMITED
from mosaic_studio.engine import neighbor_offsets, solve


def _flat_costs(n: int, t: int, seed: int = 0) -> list[list[float]]:
    rng = random.Random(seed)
    return [[rng.random() * 0.5 for _ in range(t)] for _ in range(n)]


def _assert_invariants(res, quota, radius):
    n, cols = res.cell_count, res.cols
    rows = res.rows
    # 配额：用量不得超过配额（固定格导致的超额只允许出现在 fixed_usage 冲突里，
    # 但 usage 仍可能 > quota，这是“固定优先”的刻意行为，因此这里只检查
    # 非固定部分没有继续使用超额样块）。
    for j, q in enumerate(quota):
        if q == UNLIMITED:
            continue
        nonfixed_used = res.usage[j] - res.fixed_usage[j]
        assert nonfixed_used <= max(0, q - res.fixed_usage[j]) + 0
        # 总用量超出配额的部分只能来自固定格。
        assert res.usage[j] <= max(q, res.fixed_usage[j])

    # 邻接：任意两个非固定匹配格不得在半径内同样块；
    # 固定格与自动格之间也必须满足（自动格会避让固定格）。
    offsets = neighbor_offsets(radius)
    violations = []
    for r in range(rows):
        for c in range(cols):
            i = r * cols + c
            t = res.choice[i]
            if t < 0:
                continue
            for dr, dc in offsets:
                rr, cc = r + dr, c + dc
                if not (0 <= rr < rows and 0 <= cc < cols):
                    continue
                j = rr * cols + cc
                if j <= i:
                    continue
                if res.choice[j] == t and not (
                    res.is_fixed[i] and res.is_fixed[j]
                ):
                    # 两个都是固定格时允许（用户显式覆盖），其余皆违规。
                    violations.append((i, j, t))
    assert violations == []


def test_quota_capacity_shortage_explains_every_cell():
    # 5x4=20 格，5 块样块每块配额 2 -> 总容量 10，至少 10 格未匹配。
    rows, cols, t = 4, 5, 5
    costs = _flat_costs(rows * cols, t, seed=1)
    quota = [2] * t
    res = solve(rows, cols, costs, quota,
                adjacency_radius=0, seed=7, improvement_passes=1)

    assert res.assigned_count == 10
    assert res.unmatched_count == 10
    assert res.free_deficit == 10
    assert sorted(res.usage) == [2, 2, 2, 2, 2]
    for o in res.outcomes:
        if o.status == "unmatched":
            assert o.reason_code in ("quota", "mixed")
            assert o.reason
            assert o.quota_blockers  # 每格都要指出是哪些块配额挡住了
    _assert_invariants(res, quota, 0)


def test_adjacency_blocks_clustering():
    # 3x3 只有一种无限配额样块、八邻域限制：最多放 4 个角。
    rows = cols = 3
    costs = [[0.1] for _ in range(9)]
    quota = [UNLIMITED]
    res = solve(rows, cols, costs, quota, adjacency_radius=1, seed=1)
    assert 1 <= res.assigned_count <= 4
    assert res.unmatched_count >= 5
    assert all(o.reason_code == "adjacency"
               for o in res.outcomes if o.status == "unmatched")
    _assert_invariants(res, quota, 1)


def test_fixed_cells_respected_and_consume_quota():
    rows = cols = 2
    # 每格对两块样块代价相同，结果由确定性 tie-break 决定也没关系。
    costs = [[0.1, 0.2] for _ in range(4)]
    quota = [1, 100]
    fixed = {0: 0, 3: 0}  # 同一格块被固定两次，超过配额 1
    res = solve(rows, cols, costs, quota, adjacency_radius=1,
                seed=3, fixed=fixed)

    assert res.choice[0] == 0 and res.is_fixed[0]
    assert res.choice[3] == 0 and res.is_fixed[3]
    assert res.fixed_usage[0] == 2
    assert any(fc.kind == "quota" and fc.tile == 0
               for fc in res.fixed_conflicts)
    # 其他自动格不得再使用已经被固定超额占用的 0 号样块。
    for i in (1, 2):
        if res.choice[i] >= 0:
            assert res.choice[i] != 0
    _assert_invariants(res, quota, 1)


def test_same_seed_reproduces_layout():
    rows, cols, t = 8, 10, 12
    costs = _flat_costs(rows * cols, t, seed=99)
    quota = [6] * t
    r1 = solve(rows, cols, costs, quota, adjacency_radius=1, seed=1234)
    r2 = solve(rows, cols, costs, quota, adjacency_radius=1, seed=1234)
    assert r1.choice == r2.choice
    assert [o.status for o in r1.outcomes] == [o.status for o in r2.outcomes]
    r3 = solve(rows, cols, costs, quota, adjacency_radius=1, seed=4321)
    # 不同种子大概率产生不同布局（MRV 并列优先级不同）。
    assert r1.choice != r3.choice


@pytest.mark.parametrize("seed", range(8))
def test_random_constraint_invariants(seed):
    rng = random.Random(1000 + seed)
    rows, cols = rng.randint(3, 9), rng.randint(3, 9)
    n = rows * cols
    t = rng.randint(1, 10)
    costs = [[rng.random() for _ in range(t)] for _ in range(n)]
    quota = [rng.choice([1, 2, 3, max(1, n // t), UNLIMITED])
             for _ in range(t)]
    radius = rng.choice([0, 1, 1, 2])
    fixed = {}
    for _ in range(rng.randint(0, 3)):
        fixed[rng.randrange(n)] = rng.randrange(t)
    res = solve(rows, cols, costs, quota,
                adjacency_radius=radius, seed=seed, fixed=fixed)
    assert len(res.outcomes) == n
    for c, tj in fixed.items():
        assert res.choice[c] == tj and res.is_fixed[c]
    _assert_invariants(res, quota, radius)
