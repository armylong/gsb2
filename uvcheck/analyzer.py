"""贴图坐标缺陷分析。

输入 :mod:`uvcheck.parser` 的解析结果，输出结构化问题清单：

- ``missing_uv``     面没有贴图坐标（解析阶段已标注）
- ``out_of_range``   UV 分量超出 [0, 1] 图片范围（会导致重复寻址/采样到图外）
- ``uv_degenerate``  UV 三角形面积为 0（一条边坍缩，贴图无法正确映射）
- ``mesh_degenerate`` 三维三角形面积为 0
- ``overlap``        多个面的 UV 三角形在贴图空间相互重叠（共享同一张贴图像素）
- ``stretch``        映射各向异性过大（一个方向被明显拉伸/压缩）

每个问题都带 ``face_ids``，前端据此在双视图中联动定位；面编号与解析器一致。
"""

from __future__ import annotations

import math
from typing import Any

from .parser import ParseResult

# 浮点容差：UV 恰好落在 0/1 边界不算越界
RANGE_EPS = 1e-9
# 重叠面积小于较小三角形面积的该比例时视为边/点接触，不报重叠
OVERLAP_REL_EPS = 1e-9
OVERLAP_ABS_EPS = 1e-12


# ---------------------------------------------------------------- 基础几何
def _sub(a: tuple[float, ...], b: tuple[float, ...]) -> tuple[float, ...]:
    return tuple(x - y for x, y in zip(a, b))


def _cross3(a: tuple[float, float, float], b: tuple[float, float, float]) -> tuple[float, float, float]:
    return (
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    )


def _tri_area_3d(p0, p1, p2) -> float:
    e1 = _sub(p1, p0)
    e2 = _sub(p2, p0)
    return 0.5 * math.sqrt(sum(c * c for c in _cross3(e1, e2)))


def _tri_area_2d(t: list[tuple[float, float]]) -> float:
    (u0, v0), (u1, v1), (u2, v2) = t
    return 0.5 * abs((u1 - u0) * (v2 - v0) - (u2 - u0) * (v1 - v0))


def _jacobian_singular_values(p0, p1, p2, uv0, uv1, uv2) -> tuple[float, float, float]:
    """计算 UV(2D) -> 模型(3D) 仿射映射的两个奇异值。

    返回 (s_min, s_max, det_uv)。det_uv 为 0 表示 UV 退化，奇异值无定义。
    推导：E = J * F，其中 E 的列为三维边向量，F 的列为 UV 边向量；
    J = E * F^{-1}，再对 J^T J 这个 2x2 矩阵求特征值开方。
    """
    e1 = _sub(p1, p0)
    e2 = _sub(p2, p0)
    f1u, f1v = uv1[0] - uv0[0], uv1[1] - uv0[1]
    f2u, f2v = uv2[0] - uv0[0], uv2[1] - uv0[1]
    det = f1u * f2v - f1v * f2u
    if abs(det) < 1e-15:
        return 0.0, 0.0, det
    # F = [[f1u, f2u], [f1v, f2v]]（列是 UV 边向量 f1, f2）。
    # F^{-1} = 1/det * [[ f2v, -f2u], [-f1v,  f1u]]；
    # 这里按“列”存放：inv_cols[k] 是 F^{-1} 的第 k 列两个元素，
    # 于是 J = E·F^{-1} 的第 k 列 = inv_cols[k][0]*e1 + inv_cols[k][1]*e2。
    inv_cols = (
        (f2v / det, -f1v / det),   # F^{-1} 第 0 列
        (-f2u / det, f1u / det),   # F^{-1} 第 1 列
    )
    cols: list[tuple[float, float, float]] = []
    for col in range(2):
        c0, c1 = inv_cols[col]
        j = tuple(c0 * e1[k] + c1 * e2[k] for k in range(3))
        cols.append(j)  # type: ignore[arg-type]
    j1, j2 = cols
    # J^T J
    a = sum(x * x for x in j1)
    b = sum(x * y for x, y in zip(j1, j2))
    c = sum(x * x for x in j2)
    trace = a + c
    disc = max(0.0, trace * trace - 4.0 * (a * c - b * b))
    l1 = 0.5 * (trace + math.sqrt(disc))
    l2 = 0.5 * (trace - math.sqrt(disc))
    s_max = math.sqrt(max(0.0, l1))
    s_min = math.sqrt(max(0.0, l2))
    return s_min, s_max, det


# ------------------------------------------------------- 2D 三角形重叠
def _edge_side(p, a, b) -> float:
    return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])


def _bbox_hit(a, b) -> bool:
    return not (
        max(p[0] for p in a) < min(p[0] for p in b)
        or max(p[0] for p in b) < min(p[0] for p in a)
        or max(p[1] for p in a) < min(p[1] for p in b)
        or max(p[1] for p in b) < min(p[1] for p in a)
    )


def _sat_overlap(a, b) -> bool:
    """分离轴定理：两三角形投影在所有边法向上都相交才可能重叠。"""
    for tri in (a, b):
        for i in range(3):
            p = tri[i]
            q = tri[(i + 1) % 3]
            dx, dy = q[0] - p[0], q[1] - p[1]
            pa = [dx * t[1] - dy * t[0] for t in a]
            pb = [dx * t[1] - dy * t[0] for t in b]
            if max(pa) < min(pb) or max(pb) < min(pa):
                return False
    return True


def _clip_polygon(subject: list[tuple[float, float]],
                  clip: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """Sutherland–Hodgman：用 clip 凸多边形裁剪 subject，返回交多边形。"""
    output = list(subject)
    cp_count = len(clip)
    for i in range(cp_count):
        a = clip[i]
        b = clip[(i + 1) % cp_count]
        inputs = output
        output = []
        if not inputs:
            break
        s = inputs[-1]
        s_inside = _edge_side(s, a, b) >= 0
        for e in inputs:
            e_inside = _edge_side(e, a, b) >= 0
            if e_inside:
                if not s_inside:
                    t = _edge_side(s, a, b) / (_edge_side(s, a, b) - _edge_side(e, a, b))
                    output.append((s[0] + t * (e[0] - s[0]), s[1] + t * (e[1] - s[1])))
                output.append(e)
            elif s_inside:
                t = _edge_side(s, a, b) / (_edge_side(s, a, b) - _edge_side(e, a, b))
                output.append((s[0] + t * (e[0] - s[0]), s[1] + t * (e[1] - s[1])))
            s = e
            s_inside = e_inside
    return output


def _polygon_area(poly: list[tuple[float, float]]) -> float:
    if len(poly) < 3:
        return 0.0
    area = 0.0
    for i in range(len(poly)):
        x0, y0 = poly[i]
        x1, y1 = poly[(i + 1) % len(poly)]
        area += x0 * y1 - x1 * y0
    return 0.5 * abs(area)


class _UnionFind:
    def __init__(self, n: int):
        self.parent = list(range(n))

    def find(self, x: int) -> int:
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def union(self, a: int, b: int) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[rb] = ra


def _detect_overlaps(uv_tris: dict[int, list[tuple[float, float]]]) -> list[list[int]]:
    """空间哈希 + SAT + 裁剪面积，返回重叠面簇列表（每簇面 id 升序）。"""
    if len(uv_tris) < 2:
        return []
    min_u = min(min(p[0] for p in t) for t in uv_tris.values())
    max_u = max(max(p[0] for p in t) for t in uv_tris.values())
    min_v = min(min(p[1] for p in t) for t in uv_tris.values())
    max_v = max(max(p[1] for p in t) for t in uv_tris.values())
    span_u = max(max_u - min_u, 1e-12)
    span_v = max(max_v - min_v, 1e-12)
    grid_n = 32
    cell_w = span_u / grid_n
    cell_h = span_v / grid_n

    buckets: dict[tuple[int, int], list[int]] = {}
    for fid, tri in uv_tris.items():
        c0u = max(0, int((min(p[0] for p in tri) - min_u) / cell_w))
        c1u = min(grid_n - 1, int((max(p[0] for p in tri) - min_u) / cell_w))
        c0v = max(0, int((min(p[1] for p in tri) - min_v) / cell_h))
        c1v = min(grid_n - 1, int((max(p[1] for p in tri) - min_v) / cell_h))
        for cu in range(c0u, c1u + 1):
            for cv in range(c0v, c1v + 1):
                buckets.setdefault((cu, cv), []).append(fid)

    candidate_pairs: set[tuple[int, int]] = set()
    for ids in buckets.values():
        for i in range(len(ids)):
            for j in range(i + 1, len(ids)):
                candidate_pairs.add((ids[i], ids[j]))

    uf = _UnionFind(max(uv_tris) + 1)
    pair_count = 0
    for a_id, b_id in sorted(candidate_pairs):
        ta, tb = uv_tris[a_id], uv_tris[b_id]
        if not _bbox_hit(ta, tb) or not _sat_overlap(ta, tb):
            continue
        inter = _clip_polygon(ta, tb)
        area = _polygon_area(inter)
        smaller = min(_tri_area_2d(ta), _tri_area_2d(tb))
        if area <= OVERLAP_ABS_EPS or area < smaller * OVERLAP_REL_EPS:
            continue  # 仅边/点接触
        pair_count += 1
        uf.union(a_id, b_id)

    clusters: dict[int, list[int]] = {}
    for fid in uv_tris:
        root = uf.find(fid)
        clusters.setdefault(root, []).append(fid)
    groups = [sorted(members) for members in clusters.values() if len(members) > 1]
    groups.sort(key=lambda g: (g[0], len(g)))
    return groups


# ----------------------------------------------------------------- 主入口
ISSUE_META = {
    "missing_uv":     {"severity": "error", "label": "缺少贴图坐标"},
    "out_of_range":   {"severity": "warning", "label": "UV 超出贴图范围 [0,1]"},
    "uv_degenerate":  {"severity": "error", "label": "UV 三角形退化（面积为 0）"},
    "mesh_degenerate": {"severity": "warning", "label": "三维三角形退化（面积为 0）"},
    "overlap":        {"severity": "warning", "label": "UV 区域重叠"},
    "stretch":        {"severity": "warning", "label": "贴图明显拉伸"},
}


def analyze(parsed: ParseResult, stretch_threshold: float = 3.0,
            include_overlap: bool = True) -> dict[str, Any]:
    """对解析结果执行全部检查，返回可直接 JSON 序列化的报告。"""
    issues: list[dict[str, Any]] = []
    triangle_metrics: dict[int, dict[str, Any]] = {}
    triangle_issues: dict[int, list[str]] = {t.id: [] for t in parsed.triangles}

    def add_issue(kind: str, face_ids: list[int], detail: str) -> None:
        issue = {
            "type": kind,
            "severity": ISSUE_META[kind]["severity"],
            "label": ISSUE_META[kind]["label"],
            "face_ids": sorted(face_ids),
            "detail": detail,
        }
        issues.append(issue)
        for fid in face_ids:
            triangle_issues.setdefault(fid, []).append(kind)

    uv_tris_for_overlap: dict[int, list[tuple[float, float]]] = {}

    for tri in parsed.triangles:
        p0 = parsed.vertices[tri.verts[0]]
        p1 = parsed.vertices[tri.verts[1]]
        p2 = parsed.vertices[tri.verts[2]]
        area3 = _tri_area_3d(p0, p1, p2)
        metrics: dict[str, Any] = {
            "area_3d": area3,
            "area_uv": None,
            "anisotropy": None,
            "scale_min": None,
            "scale_max": None,
        }

        if area3 <= 1e-15:
            add_issue("mesh_degenerate", [tri.id],
                      f"面 {tri.id + 1} 的三维面积为 0，顶点共线或重合")

        if tri.uvs is None:
            add_issue("missing_uv", [tri.id],
                      f"面 {tri.id + 1} 没有贴图坐标，无法参与 UV 检查（几何仍可在三维视图查看）")
            triangle_metrics[tri.id] = metrics
            continue

        uv0 = parsed.uvs[tri.uvs[0]]
        uv1 = parsed.uvs[tri.uvs[1]]
        uv2 = parsed.uvs[tri.uvs[2]]
        uv_tri = [uv0, uv1, uv2]
        area_uv = _tri_area_2d(uv_tri)
        metrics["area_uv"] = area_uv

        # 1) 越界
        bad_comps = []
        for corner, (u, v) in enumerate(uv_tri):
            if u < -RANGE_EPS or u > 1.0 + RANGE_EPS or v < -RANGE_EPS or v > 1.0 + RANGE_EPS:
                bad_comps.append(f"角{corner + 1}=({u:.4f},{v:.4f})")
        if bad_comps:
            add_issue("out_of_range", [tri.id],
                      f"面 {tri.id + 1} 的 UV 超出 [0,1]: {'; '.join(bad_comps)}")

        # 2) UV 退化
        if area_uv <= 1e-15:
            add_issue("uv_degenerate", [tri.id],
                      f"面 {tri.id + 1} 的 UV 三角形面积为 0，贴图在该面上坍缩成线/点")
        else:
            uv_tris_for_overlap[tri.id] = uv_tri
            # 3) 拉伸（UV 退化时雅可比无定义）
            if area3 > 1e-15:
                s_min, s_max, _ = _jacobian_singular_values(p0, p1, p2, uv0, uv1, uv2)
                aniso = s_max / s_min if s_min > 1e-12 else float("inf")
                metrics["anisotropy"] = None if math.isinf(aniso) else aniso
                metrics["scale_min"] = s_min
                metrics["scale_max"] = s_max
                if aniso >= stretch_threshold:
                    shown = "∞" if math.isinf(aniso) else f"{aniso:.2f}"
                    add_issue(
                        "stretch", [tri.id],
                        f"面 {tri.id + 1} 各向异性比 {shown} ≥ 阈值 {stretch_threshold:g}，"
                        f"一个方向被明显拉伸（局部缩放 {s_min:.3f} ~ {s_max:.3f}）",
                    )

        triangle_metrics[tri.id] = metrics

    # 4) 重叠（按连通簇聚合，方便“查看具体涉及哪些面”）
    if include_overlap and uv_tris_for_overlap:
        groups = _detect_overlaps(uv_tris_for_overlap)
        for group in groups:
            add_issue(
                "overlap", group,
                "以下 " + str(len(group)) + " 个面的 UV 区域相互重叠，会采样同一块贴图像素: "
                + ", ".join(str(f + 1) for f in group),
            )

    counts = {kind: 0 for kind in ISSUE_META}
    for issue in issues:
        counts[issue["type"]] += 1

    return {
        "issues": issues,
        "triangle_issues": {str(k): v for k, v in triangle_issues.items()},
        "triangle_metrics": {
            str(k): {kk: (None if isinstance(vv, float) and math.isinf(vv) else vv)
                     for kk, vv in v.items()}
            for k, v in triangle_metrics.items()
        },
        "thresholds": {"stretch_anisotropy": stretch_threshold},
        "counts": counts,
        "issue_meta": ISSUE_META,
    }
