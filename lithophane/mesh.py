"""闭合三角网格构建、二进制 STL 读写与读回分析。

坐标系约定（右手系）：
  x: 0 → 板宽（图像列方向，左→右）
  y: 0 → 板高（板底→板顶），网格第 0 行对应板顶
  z: 厚度方向；z=0 为平背，z=厚度 为变化正面
因此正面朝 +z，背面为 z=0 平面，四周为连接两者的四壁。
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass
class Mesh:
    vertices: np.ndarray   # (V, 3) float64，毫米
    triangles: np.ndarray  # (T, 3) int64 顶点索引
    normals: np.ndarray    # (T, 3) float64 单位法向（右手定则，朝外）

    @property
    def n_triangles(self) -> int:
        return int(self.triangles.shape[0])


def _compute_normals(vertices: np.ndarray, triangles: np.ndarray) -> np.ndarray:
    v0 = vertices[triangles[:, 0]]
    v1 = vertices[triangles[:, 1]]
    v2 = vertices[triangles[:, 2]]
    n = np.cross(v1 - v0, v2 - v0)
    lengths = np.linalg.norm(n, axis=1, keepdims=True)
    safe = np.where(lengths == 0, 1.0, lengths)
    return n / safe


def build_mesh(thickness: np.ndarray, x_coords: np.ndarray,
               y_coords: np.ndarray) -> Mesh:
    """由高度场构建平背 + 四壁 + 变化正面的闭合网格。

    thickness: (rows, cols)，行 0 对应板顶（y 最大）。
    """
    rows, cols = thickness.shape
    nx, ny = cols, rows
    nxy = nx * ny

    xx, yy = np.meshgrid(x_coords, y_coords)           # (rows, cols)
    flat_t = np.ascontiguousarray(thickness.reshape(-1))
    front_xy = np.column_stack([xx.reshape(-1), yy.reshape(-1)])
    front_v = np.column_stack([front_xy, flat_t])
    back_v = np.column_stack([front_xy, np.zeros(nxy)])
    vertices = np.vstack([front_v, back_v])

    def fid(r: int, c: int) -> int:
        return r * nx + c

    def bid(r: int, c: int) -> int:
        return nxy + r * nx + c

    # --- 正面（朝 +z）与背面（朝 -z）---
    # 单元四角 a(左上) b(右上) c(右下) d(左下)，统一沿 b-d 对角线
    # 拆为 (a,b,d) 与 (b,c,d)，保证相邻单元共享边
    r_idx, c_idx = np.meshgrid(np.arange(rows - 1), np.arange(cols - 1),
                               indexing="ij")
    a = (r_idx * nx + c_idx).reshape(-1)
    b = a + 1
    d = a + nx
    cq = d + 1
    front_tri = np.column_stack([
        np.concatenate([a, b]),
        np.concatenate([b, cq]),
        np.concatenate([d, d]),
    ])
    back_tri = (front_tri + nxy)[:, [0, 2, 1]]  # 背面法向朝 -z

    # --- 四周侧壁：每条外边界边取法向朝外的绕序 ---
    wall: list[np.ndarray] = []
    # 边界边定义为 (节点序列, 沿边前进的切向)
    edges: list[tuple[list[tuple[int, int]], np.ndarray]] = []
    top_nodes = [(0, c) for c in range(nx)]
    bottom_nodes = [(ny - 1, c) for c in range(nx - 1, -1, -1)]
    left_nodes = [(r, 0) for r in range(ny - 1, -1, -1)]
    right_nodes = [(r, nx - 1) for r in range(ny)]
    for nodes, tang in (
        (top_nodes, np.array([1.0, 0.0, 0.0])),
        (bottom_nodes, np.array([-1.0, 0.0, 0.0])),
        (left_nodes, np.array([0.0, -1.0, 0.0])),
        (right_nodes, np.array([0.0, 1.0, 0.0])),
    ):
        edges.append((nodes, tang))

    for nodes, tang in edges:
        for k in range(len(nodes) - 1):
            p, q = nodes[k], nodes[k + 1]
            pf, qf = fid(*p), fid(*q)
            pb, qb = bid(*p), bid(*q)
            # 四边形 p(front)-q(front)-q(back)-p(back)，沿对角线 p→qb
            # 拆两个三角。先取一组绕序，按其法向与切向的关系决定方向，
            # 保证外法向 = 切向在板平面内逆时针旋转 90°。
            tri_a = np.array([pf, qf, qb])
            n_a = np.cross(vertices[tri_a[1]] - vertices[tri_a[0]],
                           vertices[tri_a[2]] - vertices[tri_a[0]])
            if float(np.dot(n_a, tang)) > 0.0:
                wall.append(tri_a)                 # (pf, qf, qb)
                wall.append(np.array([pf, qb, pb]))
            else:
                wall.append(np.array([pf, pb, qb]))
                wall.append(np.array([pf, qb, qf]))

    triangles = np.vstack([front_tri, back_tri] +
                          ([np.vstack(wall)] if wall else []))
    normals = _compute_normals(vertices, triangles)
    return Mesh(vertices=vertices, triangles=triangles, normals=normals)


def check_watertight(mesh: Mesh, tol_um: float = 1e-4) -> tuple[bool, int]:
    """检查闭合性：焊接 tol_um（毫米）内重合顶点后，每条边应恰好出现两次。

    返回 (是否闭合, 边界边数量)。
    """
    rounded = np.round(mesh.vertices / tol_um).astype(np.int64)
    _, inv = np.unique(rounded, axis=0, return_inverse=True)
    tri = inv[mesh.triangles]
    edges = np.concatenate([
        np.sort(tri[:, [0, 1]], axis=1),
        np.sort(tri[:, [1, 2]], axis=1),
        np.sort(tri[:, [2, 0]], axis=1),
    ])
    _, counts = np.unique(edges, axis=0, return_counts=True)
    boundary = int(np.count_nonzero(counts != 2))
    return boundary == 0, boundary


def write_stl_binary(path: str, mesh: Mesh) -> None:
    """写二进制 STL（80 字节头 + 三角数 + 每三角 50 字节）。"""
    t = mesh.triangles
    v = mesh.vertices
    n = mesh.normals
    with open(path, "wb") as f:
        f.write(b"lithophane binary STL".ljust(80, b"\0"))
        f.write(np.uint32(t.shape[0]))
        dt = np.dtype([
            ("normal", "<f4", (3,)),
            ("v0", "<f4", (3,)),
            ("v1", "<f4", (3,)),
            ("v2", "<f4", (3,)),
            ("attr", "<u2"),
        ])
        rec = np.empty(t.shape[0], dtype=dt)
        rec["normal"] = n.astype("<f4")
        rec["v0"] = v[t[:, 0]].astype("<f4")
        rec["v1"] = v[t[:, 1]].astype("<f4")
        rec["v2"] = v[t[:, 2]].astype("<f4")
        rec["attr"] = 0
        f.write(rec.tobytes())


def read_stl_binary(path: str) -> Mesh:
    """读回二进制 STL，重新焊接重合顶点并按右手定则重建法向。"""
    with open(path, "rb") as f:
        header = f.read(80)
        if len(header) != 80:
            raise ValueError("STL 文件头不完整")
        n_tri = int(np.frombuffer(f.read(4), dtype="<u4")[0])
        data = f.read(n_tri * 50)
        if len(data) != n_tri * 50:
            raise ValueError("STL 数据长度与三角数不符，文件可能已损坏")
    dt = np.dtype([
        ("normal", "<f4", (3,)),
        ("v0", "<f4", (3,)),
        ("v1", "<f4", (3,)),
        ("v2", "<f4", (3,)),
        ("attr", "<u2"),
    ])
    rec = np.frombuffer(data, dtype=dt, count=n_tri)
    tris_raw = np.stack([rec["v0"], rec["v1"], rec["v2"]], axis=1).astype(
        np.float64)  # (T,3,3)
    flat_v = tris_raw.reshape(-1, 3)
    rounded = np.round(flat_v, 6)
    # 焊接重合顶点，同时保持首次出现顺序
    key_to_id: dict[tuple, int] = {}
    ids = np.empty(flat_v.shape[0], dtype=np.int64)
    unique_vertices: list[np.ndarray] = []
    for idx, key in enumerate(map(tuple, rounded)):
        vid = key_to_id.get(key)
        if vid is None:
            vid = len(unique_vertices)
            key_to_id[key] = vid
            unique_vertices.append(flat_v[idx])
        ids[idx] = vid
    vertices = np.asarray(unique_vertices, dtype=np.float64)
    triangles = ids.reshape(n_tri, 3)
    normals = _compute_normals(vertices, triangles)
    return Mesh(vertices=vertices, triangles=triangles, normals=normals)


@dataclass
class MeshAnalysis:
    """STL 读回分析结果，全部单位毫米。"""

    bbox_min: np.ndarray
    bbox_max: np.ndarray
    width: float
    height: float
    depth: float
    t_min: float
    t_max: float
    min_pos: tuple[int, int]     # (网格行, 网格列)，行 0 为板顶
    max_pos: tuple[int, int]
    grid_rows: int
    grid_cols: int
    thickness_grid: np.ndarray   # 按正面顶点重建的 (rows, cols) 厚度
    n_triangles: int
    watertight: bool
    boundary_edges: int


def analyze_mesh(mesh: Mesh, grid_rows: int, grid_cols: int) -> MeshAnalysis:
    """从网格读回实体范围、最薄/最厚处并重建厚度网格。

    正面 = 法向 z 分量为正的水平三角，取其顶点 z；
    背面为 z≈0 平面，逐点厚度即正面高度。
    """
    v = mesh.vertices
    bbox_min = v.min(axis=0)
    bbox_max = v.max(axis=0)

    # 正面顶点：z 明显高于背面（z≈0）。注意侧壁顶边法向也可能朝上，
    # 不能只凭法向筛选；正面高度由网格给出，背面恒为 0。
    z_tol = max(1e-6, float(bbox_max[2]) * 1e-4)
    front_mask = v[:, 2] > z_tol
    if not front_mask.any():
        raise ValueError("读回失败：未找到任何正面顶点（厚度是否全为 0？）")
    front = v[front_mask]

    # 用 (x,y) 排序重建规则网格（STL float32 存坐标，坐标先归并到 1nm 容差）
    xs = np.unique(np.round(front[:, 0], 6))
    ys = np.unique(np.round(front[:, 1], 6))
    if xs.size != grid_cols or ys.size != grid_rows:
        raise ValueError(
            f"读回网格与预期不符：得到 {ys.size}×{xs.size}，"
            f"预期 {grid_rows}×{grid_cols}"
        )
    x_sorted = np.sort(xs)
    y_top_to_bottom = np.sort(ys)[::-1]   # 行 0 在板顶
    rx = np.round(front[:, 0], 6)
    ry = np.round(front[:, 1], 6)
    xi = np.searchsorted(x_sorted, rx)
    yi = np.searchsorted(-y_top_to_bottom, -ry)  # y 大的行号小
    xi = np.clip(xi, 0, grid_cols - 1)
    yi = np.clip(yi, 0, grid_rows - 1)
    # 同一格点多个顶点时取均值（浮点误差极小）
    grid = np.zeros((grid_rows, grid_cols), dtype=np.float64)
    counts = np.zeros_like(grid)
    np.add.at(grid, (yi, xi), front[:, 2])
    np.add.at(counts, (yi, xi), 1.0)
    if np.any(counts == 0):
        raise ValueError("读回的正面顶点未能覆盖全部网格点")
    grid = grid / counts

    flat_idx = int(np.argmin(grid))
    min_pos = np.unravel_index(flat_idx, grid.shape)
    max_pos = np.unravel_index(int(np.argmax(grid)), grid.shape)
    watertight, boundary = check_watertight(mesh)

    return MeshAnalysis(
        bbox_min=bbox_min,
        bbox_max=bbox_max,
        width=float(bbox_max[0] - bbox_min[0]),
        height=float(bbox_max[1] - bbox_min[1]),
        depth=float(bbox_max[2] - bbox_min[2]),
        t_min=float(grid.min()),
        t_max=float(grid.max()),
        min_pos=(int(min_pos[0]), int(min_pos[1])),
        max_pos=(int(max_pos[0]), int(max_pos[1])),
        grid_rows=grid_rows,
        grid_cols=grid_cols,
        thickness_grid=grid,
        n_triangles=mesh.n_triangles,
        watertight=watertight,
        boundary_edges=boundary,
    )
