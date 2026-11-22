"""把图链接成可测量路径;处理四向交叉点的配对(哪两段相连)。"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

from .graph import Graph


@dataclass
class Path:
    id: int
    kind: str                 # 'open' | 'closed'
    points: list              # 完整折线 [(x, y), ...],含节点中心
    edge_ids: list = field(default_factory=list)
    loop_id: int | None = None
    via_crossings: list = field(default_factory=list)  # 途经的交叉节点 id


def _half_vec(graph: Graph, edge_id: int, end: int, center: tuple) -> tuple:
    """从节点中心指向半边外侧的方向向量(取链上第几个像素以稳定方向)。"""
    pts = graph.edges[edge_id].points
    idx = min(4, len(pts) - 1)
    q = pts[idx] if end == 0 else pts[-1 - idx]
    return (q[0] - center[0], q[1] - center[1])


def pairing_options(graph: Graph, node_id: int) -> list:
    """交叉节点的所有配对方案,按"对直程度"从优到劣排序。

    返回 [[((e1,end1),(e2,end2)), ((e3,end3),(e4,end4))], ...]
    """
    node = graph.nodes[node_id]
    halves = []
    for e in graph.edges.values():
        if e.node_a == node_id:
            halves.append((e.id, 0))
        if e.node_b == node_id:
            halves.append((e.id, 1))
    if len(halves) < 2 or len(halves) % 2 != 0:
        return []
    vecs = [_half_vec(graph, eid, end, node.center) for (eid, end) in halves]

    def cos_ij(i, j):
        a, b = vecs[i], vecs[j]
        na, nb = math.hypot(*a), math.hypot(*b)
        if na == 0 or nb == 0:
            return 1.0
        return (a[0] * b[0] + a[1] * b[1]) / (na * nb)

    def matchings(items):
        if not items:
            yield []
            return
        first = items[0]
        for k in items[1:]:
            rest = [x for x in items[1:] if x != k]
            for m in matchings(rest):
                yield [(first, k)] + m

    opts = []
    for m in matchings(list(range(len(halves)))):
        score = sum(cos_ij(i, j) for i, j in m)  # 越负越接近直线
        opts.append((score, m))
    opts.sort(key=lambda t: t[0])
    return [[(halves[i], halves[j]) for (i, j) in m] for _, m in opts]


def build_paths(graph: Graph, overrides: dict | None = None) -> list:
    """按当前交叉配对把边链接成路径。

    overrides: {crossing_node_id: 配对方案序号}
    - 交叉节点按配对把两条半边接起来穿过
    - 分叉/端点节点处路径终止(保留各支)
    - 无节点的闭环自成一条 closed 路径
    """
    overrides = overrides or {}
    conn: dict = {}
    for nid, node in graph.nodes.items():
        if node.kind != "crossing":
            continue
        opts = pairing_options(graph, nid)
        if not opts:
            continue
        idx = min(overrides.get(nid, 0), len(opts) - 1)
        for h1, h2 in opts[idx]:
            conn[h1] = h2
            conn[h2] = h1

    visited: set = set()
    paths: list[Path] = []

    def node_of(edge, end):
        return edge.node_a if end == 0 else edge.node_b

    def walk(start_half):
        pts, eids, via = [], [], []
        e0 = graph.edges[start_half[0]]
        n0 = graph.nodes[node_of(e0, start_half[1])]
        pts.append(n0.center)
        h = start_half
        closed = False
        while True:
            e = graph.edges[h[0]]
            seg = e.points if h[1] == 0 else e.points[::-1]
            pts.extend(seg)
            eids.append(e.id)
            visited.add(h)
            arr = (h[0], 1 - h[1])
            visited.add(arr)
            arr_nid = node_of(e, arr[1])
            arr_node = graph.nodes[arr_nid]
            pts.append(arr_node.center)
            nxt = conn.get(arr)
            if nxt is None:
                break
            via.append(arr_nid)
            h = nxt
            if h == start_half:
                closed = True
                break
            if h in visited:
                break
        return pts, eids, closed, via

    # 1) 从端点/分叉节点出发的半边
    for e in graph.edges.values():
        for end in (0, 1):
            nid = node_of(e, end)
            if graph.nodes[nid].kind != "crossing" and (e.id, end) not in visited:
                pts, eids, closed, via = walk((e.id, end))
                paths.append(Path(-1, "closed" if closed else "open", pts, eids, None, via))
    # 2) 只穿过交叉点的环(所有半边都在交叉节点上)
    for e in graph.edges.values():
        for end in (0, 1):
            if (e.id, end) not in visited:
                pts, eids, closed, via = walk((e.id, end))
                paths.append(Path(-1, "closed" if closed else "open", pts, eids, None, via))
    # 3) 无节点闭环
    for lp in graph.loops.values():
        pts = list(lp.points) + [lp.points[0]]
        paths.append(Path(-1, "closed", pts, [], lp.id, []))

    for i, p in enumerate(paths):
        p.id = i
    return paths
