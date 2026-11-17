"""全局布局：连通分量、参考锚定、首尾闭环联合优化。

逐张 BFS 接龙会把每对的小误差沿链累积；当首尾也存在可信重叠（闭环）时，
把所有边的对应点放进同一个 Levenberg-Marquardt 优化，最小化全部重投影
误差之和，使闭环约束真正参与全局解，而不是事后强行平移。
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from scipy import optimize

from . import geometry as geo
from .config import Config


@dataclass
class Edge:
    a: int
    b: int
    H_ab: np.ndarray            # a -> b
    correspondences: np.ndarray  # Nx4: x_a,y_a,x_b,y_b
    confidence: float
    overlap_frac: float
    manual: bool = False


@dataclass
class LayoutResult:
    ok: bool
    reasons: list[str]
    # 每张照片 -> 全局（参考照片）坐标系的单应
    globals_H: dict[int, np.ndarray] = field(default_factory=dict)
    component: list[int] = field(default_factory=list)
    excluded: list[int] = field(default_factory=list)
    has_loop: bool = False
    loop_closure_gain: float = 0.0
    # 每条边优化前后的 RMSE（像素）
    edge_rmse_before: dict[tuple[int, int], float] = field(default_factory=dict)
    edge_rmse_after: dict[tuple[int, int], float] = field(default_factory=dict)
    global_rmse: float = 0.0
    max_corner_drift_px: float = 0.0


def connected_components(n: int, edges: list[Edge]) -> list[list[int]]:
    adj: dict[int, set[int]] = {i: set() for i in range(n)}
    for e in edges:
        adj[e.a].add(e.b)
        adj[e.b].add(e.a)
    seen: set[int] = set()
    comps: list[list[int]] = []
    for start in range(n):
        if start in seen:
            continue
        stack, comp = [start], []
        while stack:
            u = stack.pop()
            if u in seen:
                continue
            seen.add(u)
            comp.append(u)
            stack.extend(adj[u] - seen)
        comps.append(sorted(comp))
    comps.sort(key=len, reverse=True)
    return comps


def _spanning_tree_globals(
    comp: list[int], edges: list[Edge], ref: int
) -> dict[int, np.ndarray]:
    """BFS 生成树，给出初始全局单应（参考照片为单位阵）。"""
    by_node: dict[int, list[Edge]] = {i: [] for i in comp}
    for e in edges:
        by_node[e.a].append(e)
        by_node[e.b].append(e)
    G = {ref: geo.identity()}
    queue = [ref]
    while queue:
        u = queue.pop(0)
        for e in by_node[u]:
            v = e.b if e.a == u else e.a
            if v in G:
                continue
            # G[u]: u 坐标 -> 全局坐标；H_vu: v 坐标 -> u 坐标
            # 故 G[v] = G[u] ∘ H_vu（先 v->u，再 u->全局）
            H_vu = geo.invert(e.H_ab) if e.a == u else e.H_ab
            G[v] = geo.compose(H_vu, G[u])
            queue.append(v)
    return G


def _unpack_homographies(
    theta: np.ndarray, nodes: list[int], ref: int, norms: dict[int, np.ndarray]
) -> dict[int, np.ndarray]:
    """把 8 参数块还原为“节点坐标 -> 全局坐标”的单应（含坐标反归一化）。"""
    maps: dict[int, np.ndarray] = {ref: geo.identity()}
    t = 0
    for node in nodes:
        if node == ref:
            continue
        Hn = np.eye(3)
        Hn.flat[[0, 1, 2, 3, 4, 5, 6, 7]] = theta[t: t + 8]
        t += 8
        maps[node] = Hn @ norms[node]
    return maps


def _residuals(
    theta: np.ndarray,
    nodes: list[int],
    ref: int,
    edges: list[Edge],
    weights: np.ndarray,
    norms: dict[int, np.ndarray],
) -> np.ndarray:
    # 参考节点固定为单位单应，消除坐标系自由度（gauge freedom）
    maps = _unpack_homographies(theta, nodes, ref, norms)
    res = []
    for e, w in zip(edges, weights):
        Ha, Hb = maps[e.a], maps[e.b]
        pts = e.correspondences
        pa = np.concatenate(
            [pts[:, :2], np.ones((len(pts), 1))], axis=1
        )  # a 系齐次
        pb = np.concatenate(
            [pts[:, 2:], np.ones((len(pts), 1))], axis=1
        )  # b 系齐次
        ga = (Ha @ pa.T).T
        gb = (Hb @ pb.T).T
        ga = ga[:, :2] / ga[:, 2:3]
        gb = gb[:, :2] / gb[:, 2:3]
        # 同一物理点在全局系下应重合
        d = (gb - ga).reshape(-1)
        res.append(d * w)
    return np.concatenate(res) if res else np.zeros(0)


def _edge_rmse(
    globals_H: dict[int, np.ndarray], edges: list[Edge]
) -> dict[tuple[int, int], float]:
    out: dict[tuple[int, int], float] = {}
    for e in edges:
        # G_a: a->全局，G_b: b->全局；求 a->b = G_b^-1 ∘ G_a
        # compose(X, Y) = Y @ X，故 compose(G_a, G_b^-1) = G_b^-1 @ G_a
        H_ag, H_bg = globals_H[e.a], globals_H[e.b]
        H_ba = geo.compose(H_ag, geo.invert(H_bg))
        src = e.correspondences[:, :2]
        dst = e.correspondences[:, 2:]
        out[(e.a, e.b)] = geo.reprojection_rmse(H_ba, src, dst)
    return out


def build_layout(
    n: int,
    edges: list[Edge],
    sizes: dict[int, tuple[int, int]],
    cfg: Config,
    ref_index: int | None = None,
) -> LayoutResult:
    reasons: list[str] = []
    if n == 0:
        return LayoutResult(False, ["没有照片"])
    ref = cfg.ref_index if ref_index is None else ref_index
    ref = max(0, min(ref, n - 1))

    comps = connected_components(n, edges)
    main = next((c for c in comps if ref in c), comps[0])
    excluded = [i for c in comps if c is not main for i in c]
    comp_edges = [
        e for e in edges if e.a in main and e.b in main
    ]
    if len(main) < 2:
        reasons.append("参考照片与其它照片没有可信重叠，无法组成全景")

    # ---- 生成树初值 ----
    G0 = _spanning_tree_globals(main, comp_edges, ref)

    before = _edge_rmse(G0, comp_edges)

    # ---- 判定闭环：非树边数量 > 0 ----
    tree_pairs: set[tuple[int, int]] = set()
    seen_nodes = {ref}
    queue = [ref]
    adj: dict[int, list[Edge]] = {i: [] for i in main}
    for e in comp_edges:
        adj[e.a].append(e)
        adj[e.b].append(e)
    while queue:
        u = queue.pop(0)
        for e in adj[u]:
            v = e.b if e.a == u else e.a
            if v in seen_nodes:
                continue
            seen_nodes.add(v)
            tree_pairs.add((e.a, e.b))
            queue.append(v)
    loop_edges = [e for e in comp_edges if (e.a, e.b) not in tree_pairs]
    has_loop = bool(loop_edges)

    # ---- 联合优化：每节点完整 8 自由度单应，坐标归一化保证数值稳定 ----
    nodes = main
    opt_nodes = [node for node in nodes if node != ref]

    # 归一化变换 T_node：像素坐标 -> 均值 0、平均尺度 1 的归一化坐标
    norms: dict[int, np.ndarray] = {}
    for node in nodes:
        w, h = sizes[node]
        scale = np.sqrt((w * h) / 4.0)
        norms[node] = np.array(
            [[1 / scale, 0, -w / (2 * scale)],
             [0, 1 / scale, -h / (2 * scale)],
             [0, 0, 1]],
            dtype=np.float64,
        )

    # 初值：G0（像素单应）转成归一化形式 Hn = G0 @ T^-1
    theta_parts = []
    for node in opt_nodes:
        Hn = G0[node] @ geo.invert(norms[node])
        Hn = Hn / Hn[2, 2]
        theta_parts.append(Hn.flat[[0, 1, 2, 3, 4, 5, 6, 7]])
    theta0 = np.concatenate(theta_parts)
    weights = np.array(
        [np.sqrt(max(e.confidence, 0.05)) for e in comp_edges]
    )

    try:
        sol = optimize.least_squares(
            _residuals,
            theta0,
            args=(nodes, ref, comp_edges, weights, norms),
            method="trf",
            x_scale="jac",
            max_nfev=cfg.lm_max_iter * 20,
        )
        theta = sol.x
    except (ValueError, np.linalg.LinAlgError) as exc:  # pragma: no cover
        reasons.append(f"全局优化失败：{exc}，回退到生成树布局")
        theta = theta0

    globals_H = _unpack_homographies(theta, nodes, ref, norms)
    # 数值归一，便于后续比较
    for node in globals_H:
        globals_H[node] = globals_H[node] / globals_H[node][2, 2]

    after = _edge_rmse(globals_H, comp_edges)

    # ---- 全局尺度安全检查 ----
    bad_scale = []
    for node in main:
        w, h = sizes[node]
        rep = geo.check_homography_sanity(globals_H[node], w, h, cfg)
        sv = geo._jacobian_scales(globals_H[node], w, h)
        if sv.max() > cfg.max_transform_scale or sv.min() < 1.0 / cfg.max_transform_scale:
            bad_scale.append(node)
        if not rep.ok:
            reasons.append(f"照片 {node} 全局变换异常：{'; '.join(rep.reasons)}")
    if bad_scale:
        reasons.append(
            f"照片 {bad_scale} 的全局变换尺度过大，已阻止失控画布"
        )

    rmses = np.array(list(after.values())) if after else np.array([0.0])
    global_rmse = float(np.sqrt(np.mean(rmses**2)))

    # 闭环收益：首尾边在接龙初值 vs 联合优化后的 RMSE 改善
    gain = 0.0
    if has_loop:
        lb = np.mean([before[(e.a, e.b)] for e in loop_edges])
        la = np.mean([after[(e.a, e.b)] for e in loop_edges])
        gain = max(0.0, lb - la)

    # 与纯接龙相比，参考系下角点最大漂移（量化累积偏移修正量）
    drift = 0.0
    for node in main:
        w, h = sizes[node]
        c = geo.image_corners(w, h)
        d = np.linalg.norm(
            geo.warp_points(globals_H[node], c) - geo.warp_points(G0[node], c),
            axis=1,
        )
        drift = max(drift, float(d.max()))

    ok = not bad_scale
    return LayoutResult(
        ok=ok,
        reasons=reasons,
        globals_H=globals_H,
        component=main,
        excluded=excluded,
        has_loop=has_loop,
        loop_closure_gain=gain,
        edge_rmse_before=before,
        edge_rmse_after=after,
        global_rmse=global_rmse,
        max_corner_drift_px=drift,
    )
