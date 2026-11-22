"""骨架 → 图结构:端点 / 分叉 / 疑似交叉 / 边 / 闭环。

坐标约定:所有点都是 (x, y) = (列, 行),与图像像素一致。
"""
from __future__ import annotations

from dataclasses import dataclass, field

import cv2
import numpy as np

NEIGH8 = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]


@dataclass
class Node:
    id: int
    kind: str            # 'endpoint' | 'branch' | 'crossing'
    pixels: list         # [(x, y), ...] 节点覆盖的骨架像素
    center: tuple        # (x, y) 浮点
    degree: int = 0      # 关联的边端数(自环计 2)


@dataclass
class Edge:
    id: int
    node_a: int
    node_b: int          # 自环时 == node_a
    points: list         # 有序 [(x, y), ...],从 node_a 侧到 node_b 侧(不含节点像素)


@dataclass
class Loop:
    id: int
    points: list         # 有序闭合环(首尾不重复)


@dataclass
class Graph:
    nodes: dict = field(default_factory=dict)   # id -> Node
    edges: dict = field(default_factory=dict)   # id -> Edge
    loops: dict = field(default_factory=dict)   # id -> Loop

    def crossings(self):
        return [n for n in self.nodes.values() if n.kind == "crossing"]


def _neighbor_count(sk: np.ndarray) -> np.ndarray:
    # 注意:OpenCV 5.x 对 uint8 的 filter2D 结果有误,统一用 float32 卷积
    kernel = np.ones((3, 3), np.float32)
    conv = cv2.filter2D(sk.astype(np.float32), -1, kernel, borderType=cv2.BORDER_CONSTANT)
    return (conv - sk).astype(np.int16)


def _order_chain(pixset: set, start: tuple) -> list:
    """把一坨 deg==2 的链像素排成有序折线。开链从一端开始;闭环从任意点绕一圈。"""
    order = [start]
    seen = {start}
    prev, cur = None, start
    while True:
        nxt = None
        for dx, dy in NEIGH8:
            p = (cur[0] + dx, cur[1] + dy)
            if p in pixset and p != prev and p not in seen:
                nxt = p
                break
        if nxt is None:
            break
        order.append(nxt)
        seen.add(nxt)
        prev, cur = cur, nxt
    return order


def build_graph(skel: np.ndarray) -> Graph:
    """从 0/1 骨架构建图。

    - 度==1 的像素 → 端点节点
    - 度>=3 的像素先按 8 连通聚成节点团,再按关联边端数分类:
      度==4 → 'crossing'(疑似交叉,可指定配对),其余 → 'branch'(真分叉)
    - 节点之间的 deg==2 链 → 边;不含任何节点的连通分量 → 闭环
    """
    sk = (skel > 0).astype(np.uint8)
    g = Graph()
    if not sk.any():
        return g

    nbc = _neighbor_count(sk)
    jmask = ((sk == 1) & (nbc >= 3)).astype(np.uint8)
    emask = ((sk == 1) & (nbc == 1)).astype(np.uint8)

    node_label = np.full(sk.shape, -1, np.int32)
    nid = 0
    # 分叉/交叉节点团
    nj, jlab = cv2.connectedComponents(jmask, connectivity=8)
    for i in range(1, nj):
        ys, xs = np.nonzero(jlab == i)
        pix = list(zip(xs.tolist(), ys.tolist()))
        g.nodes[nid] = Node(nid, "branch", pix, (float(xs.mean()), float(ys.mean())))
        node_label[jlab == i] = nid
        nid += 1
    # 端点
    ne, elab = cv2.connectedComponents(emask, connectivity=8)
    for i in range(1, ne):
        ys, xs = np.nonzero(elab == i)
        pix = list(zip(xs.tolist(), ys.tolist()))
        g.nodes[nid] = Node(nid, "endpoint", pix, (float(xs.mean()), float(ys.mean())))
        node_label[elab == i] = nid
        nid += 1

    # 节点之外的 deg==2 链
    chain = ((sk == 1) & (node_label < 0)).astype(np.uint8)
    nc, clab = cv2.connectedComponents(chain, connectivity=8)
    eid = lid = 0
    for i in range(1, nc):
        ys, xs = np.nonzero(clab == i)
        pixset = set(zip(xs.tolist(), ys.tolist()))
        # 该链相邻的节点
        adj: dict[int, list] = {}
        for (x, y) in pixset:
            for dx, dy in NEIGH8:
                nx, ny = x + dx, y + dy
                if 0 <= ny < sk.shape[0] and 0 <= nx < sk.shape[1]:
                    lb = int(node_label[ny, nx])
                    if lb >= 0:
                        adj.setdefault(lb, []).append((x, y))
        if not adj:
            # 不与任何节点相连 → 闭环(或孤立点,过滤掉)
            if len(pixset) >= 3:
                pts = _order_chain(pixset, next(iter(pixset)))
                g.loops[lid] = Loop(lid, pts)
                lid += 1
            continue
        node_ids = sorted(adj)
        na = node_ids[0]
        nb = node_ids[-1] if len(node_ids) > 1 else na
        pts = _order_chain(pixset, adj[na][0])
        g.edges[eid] = Edge(eid, na, nb, pts)
        eid += 1

    for e in g.edges.values():
        g.nodes[e.node_a].degree += 1
        g.nodes[e.node_b].degree += 1
    return postprocess(g)


def _recenter(node: Node):
    xs = [p[0] for p in node.pixels]
    ys = [p[1] for p in node.pixels]
    node.center = (sum(xs) / len(xs), sum(ys) / len(ys))


def _absorb_tiny_self_loops(g: Graph, max_len: int = 3):
    """长度 <= max_len 的自环边是节点团边缘的像素毛刺,并入节点,不计度数。"""
    for eid, e in [(eid, e) for eid, e in g.edges.items()
                   if e.node_a == e.node_b and len(e.points) <= max_len]:
        n = g.nodes[e.node_a]
        n.pixels.extend(e.points)
        _recenter(n)
        del g.edges[eid]


def _ordered_node_pixels(node: Node, p_from: tuple) -> list:
    """把节点像素排成从 p_from 附近进入的有序序列,保证合并边时不截弯取直。"""
    pixset = set(node.pixels)
    if not pixset:
        return []
    start = min(pixset, key=lambda q: (q[0] - p_from[0]) ** 2 + (q[1] - p_from[1]) ** 2)
    return _order_chain(pixset, start)


def _dissolve_degree2_nodes(g: Graph):
    """度为 2 的非端点节点只是线上的弯折,合并两侧边,恢复成一条边。"""
    changed = True
    while changed:
        changed = False
        for nid, n in list(g.nodes.items()):
            if n.kind == "endpoint":
                continue
            incident = [(e.id, e) for e in g.edges.values()
                        if e.node_a == nid or e.node_b == nid]
            deg = sum((e.node_a == nid) + (e.node_b == nid) for _, e in incident)
            if deg != 2:
                continue
            if len(incident) == 1:
                # 唯一的边是自环:节点其实是环上的毛刺 → 转成闭环
                e = incident[0][1]
                pts = list(e.points) + _ordered_node_pixels(n, e.points[-1])
                g.loops[max(g.loops.keys(), default=-1) + 1] = Loop(
                    max(g.loops.keys(), default=-1) + 1, pts)
                del g.edges[e.id]
                del g.nodes[nid]
                changed = True
                break
            (id1, e1), (id2, e2) = incident
            # pts1 定向为 "止于 n",pts2 定向为 "始于 n"
            pts1 = e1.points if e1.node_b == nid else e1.points[::-1]
            pts2 = e2.points if e2.node_a == nid else e2.points[::-1]
            other1 = e1.node_a if e1.node_b == nid else e1.node_b
            other2 = e2.node_b if e2.node_a == nid else e2.node_a
            mid = _ordered_node_pixels(n, pts1[-1] if pts1 else n.center)
            merged = Edge(id1, other1, other2, list(pts1) + mid + list(pts2))
            g.edges[id1] = merged
            del g.edges[id2]
            del g.nodes[nid]
            changed = True
            break


def postprocess(g: Graph) -> Graph:
    """清理骨架毛刺造成的假节点(弯折处的 1px 自环、度2 节点团)。"""
    _absorb_tiny_self_loops(g)
    _dissolve_degree2_nodes(g)
    # 重新计算度数与分类
    for n in g.nodes.values():
        n.degree = 0
    for e in g.edges.values():
        g.nodes[e.node_a].degree += 1
        g.nodes[e.node_b].degree += 1
    for n in g.nodes.values():
        if n.kind == "endpoint":
            continue
        n.kind = "crossing" if n.degree == 4 else "branch"
    return g
