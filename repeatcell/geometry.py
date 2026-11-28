"""平面晶体学几何: 重复基矢、平行四边形单元、与图像边界的求交。

坐标约定
--------
* 图像像素 ``(x, y)`` 指第 ``y`` 行第 ``x`` 列像素, 该像素覆盖 ``[x, x+1] x [y, y+1]``。
* 图像的有效区域是 ``[0, W) x [0, H)``, 越界即为"图外"。
* 平移向量 ``t1`` / ``t2`` 以像素为单位, 允许小数 (测量结果本来就可以落在小数像素上)。
* 单元用 ``origin + s1*t1 + s2*t2, (s1, s2) in [0,1)^2`` 表示; 这保证了 t1/t2 反向或
  交换时单元覆盖的像素点集完全一致。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Optional, Sequence, Tuple

import numpy as np

Point = Tuple[float, float]
Vec = Tuple[float, float]


# ---------------------------------------------------------------------------
# 平移向量 -> 基矢
# ---------------------------------------------------------------------------

def det2(a: Vec, b: Vec) -> float:
    return float(a[0] * b[1] - a[1] * b[0])


def solve_basis(t1: Vec, t2: Vec) -> np.ndarray:
    """求从基矢到平移向量的 2x2 矩阵 ``B`` (列向量是 t1, t2)。

    ``B @ (n1, n2) = n1*t1 + n2*t2``。
    """
    B = np.array([[t1[0], t2[0]], [t1[1], t2[1]]], dtype=float)
    if abs(float(np.linalg.det(B))) < 1e-9:
        raise ValueError("两个重复方向共线, 无法构成平行四边形单元")
    return B


def inverse_basis(B: np.ndarray) -> np.ndarray:
    return np.linalg.inv(B)


def snap_vectors_to_lattice(a: Vec, b: Vec) -> Tuple[Vec, Vec]:
    """把两个平移向量换成同一组点阵里"最短、最像理由基"的等价基矢。

    同一张点阵有无穷多组基。这里枚举幺模变换 (行列式 ±1) 得到的所有邻域基矢,
    取两根都尽量短、且 t1 尽量接近水平的一组。覆盖的像素集完全不变, 只影响显示
    与导出的两个平移量是否好读。
    """
    va = np.array(a, dtype=float)
    vb = np.array(b, dtype=float)
    if abs(det2(va, vb)) < 1e-9:
        return (float(va[0]), float(va[1])), (float(vb[0]), float(vb[1]))

    best = None
    best_key = None
    span = range(-3, 4)
    candidates = [(va, vb)]
    for k1 in span:
        for l1 in span:
            for k2 in span:
                for l2 in span:
                    if k2 * 0 + l2 * 0:  # 占位, 下面用行列式判断
                        pass
                    if k1 * l2 - k2 * l1 not in (1, -1):
                        continue
                    candidates.append((k1 * va + l1 * vb, k2 * va + l2 * vb))
    for u, v in candidates:
        nu, nv = float(np.hypot(*u)), float(np.hypot(*v))
        if nu < 1e-6 or nv < 1e-6:
            continue
        for p, q in ((u, v), (v, u)):
            if det2(p, q) < 0:      # 右手系, 便于保持一致
                q = -q
            np_, nq_ = float(np.hypot(*p)), float(np.hypot(*q))
            # 先比最长边, 再比总长, 最后让 t1 尽量接近水平
            key = (max(np_, nq_), np_ + nq_, abs(float(np.arctan2(p[1], p[0]))))
            if best_key is None or key < best_key:
                best_key = key
                best = (p, q)
    assert best is not None
    p, q = best
    return (float(p[0]), float(p[1])), (float(q[0]), float(q[1]))


# ---------------------------------------------------------------------------
# 单元 / 网格
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class CellBasis:
    origin: Vec
    t1: Vec
    t2: Vec

    @property
    def matrix(self) -> np.ndarray:
        return solve_basis(self.t1, self.t2)

    @property
    def area(self) -> float:
        return abs(det2(self.t1, self.t2))

    def corners(self, scale: float = 1.0) -> np.ndarray:
        """单元四个角, 顺序为 (0,0) (1,0) (1,1) (0,1), 形状 (4, 2)。"""
        M = self.matrix * scale
        o = np.array(self.origin, dtype=float)
        return np.array(
            [o, o + M[:, 0], o + M[:, 0] + M[:, 1], o + M[:, 1]], dtype=float
        )

    def lattice_points(self, n1: int, n2: int) -> np.ndarray:
        """``n1 x n2`` 个网格点 (角点), 返回 (n1*n2, 2)。"""
        o = np.array(self.origin, dtype=float)
        M = self.matrix
        pts = []
        for i in range(n1):
            for j in range(n2):
                pts.append(o + i * M[:, 0] + j * M[:, 1])
        return np.array(pts, dtype=float)

    def shifted(self, n1: int, n2: int) -> "CellBasis":
        """沿整数格点平移原点, 覆盖的像素集不变。"""
        M = self.matrix
        o = np.array(self.origin, dtype=float) + n1 * M[:, 0] + n2 * M[:, 1]
        return CellBasis((float(o[0]), float(o[1])), self.t1, self.t2)

    def to_local(self, pts: np.ndarray) -> np.ndarray:
        """世界坐标 -> 单元局部坐标 (0..1 为单元内)。"""
        M_inv = inverse_basis(self.matrix)
        o = np.array(self.origin, dtype=float)
        return (np.asarray(pts, dtype=float) - o) @ M_inv.T

    def to_world(self, local: np.ndarray) -> np.ndarray:
        M = self.matrix
        o = np.array(self.origin, dtype=float)
        return o + np.asarray(local, dtype=float) @ M.T

    def contains_local(self, local: np.ndarray, eps: float = 1e-9) -> np.ndarray:
        local = np.asarray(local, dtype=float)
        return (
            (local[..., 0] >= -eps)
            & (local[..., 0] < 1.0 + eps)
            & (local[..., 1] >= -eps)
            & (local[..., 1] < 1.0 + eps)
        )

    def with_t(self, t1: Vec, t2: Vec) -> "CellBasis":
        return CellBasis(self.origin, t1, t2)

    def as_dict(self) -> dict:
        return {
            "origin": [float(self.origin[0]), float(self.origin[1])],
            "t1": [float(self.t1[0]), float(self.t1[1])],
            "t2": [float(self.t2[0]), float(self.t2[1])],
        }

    @staticmethod
    def from_dict(d: dict) -> "CellBasis":
        o = tuple(float(v) for v in d["origin"])
        a = tuple(float(v) for v in d["t1"])
        b = tuple(float(v) for v in d["t2"])
        return CellBasis(o, a, b)  # type: ignore[arg-type]


def bbox_inside(corners: np.ndarray, img_w: int, img_h: int,
                eps: float = 1e-7) -> np.ndarray:
    return (
        (corners[..., 0] >= -eps)
        & (corners[..., 0] <= img_w + eps)
        & (corners[..., 1] >= -eps)
        & (corners[..., 1] <= img_h + eps)
    )


# ---------------------------------------------------------------------------
# 多边形与图像矩形求交 (精确面积, 不做超采样)
# ---------------------------------------------------------------------------

def clip_polygon_to_rect(poly: Sequence[Point], x0: float, y0: float,
                         x1: float, y1: float) -> list[Point]:
    """Sutherland–Hodgman: 凸/非凸多边形对轴对齐矩形的裁剪。"""
    def clip_edge(pts: list[Point], inside, intersect) -> list[Point]:
        out: list[Point] = []
        n = len(pts)
        for i in range(n):
            cur = pts[i]
            prev = pts[i - 1]
            cur_in = inside(cur)
            prev_in = inside(prev)
            if cur_in:
                if not prev_in:
                    out.append(intersect(prev, cur))
                out.append(cur)
            elif prev_in:
                out.append(intersect(prev, cur))
        return out

    def ix_vertical(p: Point, q: Point, x: float) -> Point:
        t = (x - p[0]) / (q[0] - p[0])
        return (x, p[1] + t * (q[1] - p[1]))

    def ix_horizontal(p: Point, q: Point, y: float) -> Point:
        t = (y - p[1]) / (q[1] - p[1])
        return (p[0] + t * (q[0] - p[0]), y)

    pts = [tuple(map(float, p)) for p in poly]
    for inside, intersect in (
        (lambda p: p[0] >= x0, lambda p, q: ix_vertical(p, q, x0)),
        (lambda p: p[0] <= x1, lambda p, q: ix_vertical(p, q, x1)),
        (lambda p: p[1] >= y0, lambda p, q: ix_horizontal(p, q, y0)),
        (lambda p: p[1] <= y1, lambda p, q: ix_horizontal(p, q, y1)),
    ):
        if not pts:
            break
        pts = clip_edge(pts, inside, intersect)
    return pts


def polygon_area(poly: Sequence[Point]) -> float:
    if len(poly) < 3:
        return 0.0
    s = 0.0
    for i in range(len(poly)):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % len(poly)]
        s += x1 * y2 - x2 * y1
    return abs(s) / 2.0


def coverage_fraction(corners: np.ndarray, img_w: int, img_h: int) -> float:
    """单元面积落在图像有效区域内的比例 (0..1)。"""
    poly = [tuple(map(float, p)) for p in corners]
    total = polygon_area(poly)
    if total <= 0:
        return 0.0
    clipped = clip_polygon_to_rect(poly, 0.0, 0.0, float(img_w), float(img_h))
    return float(min(1.0, max(0.0, polygon_area(clipped) / total)))


# ---------------------------------------------------------------------------
# 在图像里找一块完整可用的单元
# ---------------------------------------------------------------------------

def enumerate_cells(basis: CellBasis, img_w: int, img_h: int,
                    extra: int = 1) -> Iterable[CellBasis]:
    """枚举原点落在图像附近的整数平移单元 (可能含伸出图外的单元)。

    做法: 把图像矩形的四个角换算成"格坐标", 取它们的范围, 再各向外扩
    ``extra`` 格。这样既不会漏掉贴边的单元, 也不会枚举到太远的地方。
    """
    M_inv = inverse_basis(basis.matrix)
    corners = np.array([[0.0, 0.0], [img_w, 0.0], [0.0, img_h],
                        [img_w, img_h]], dtype=float)
    local = (corners - np.array(basis.origin, dtype=float)) @ M_inv.T
    i_lo = int(np.floor(local[:, 0].min())) - extra
    i_hi = int(np.ceil(local[:, 0].max())) + extra
    j_lo = int(np.floor(local[:, 1].min())) - extra
    j_hi = int(np.ceil(local[:, 1].max())) + extra
    for i in range(i_lo, i_hi + 1):
        for j in range(j_lo, j_hi + 1):
            yield basis.shifted(i, j)


def fully_inside_cells(basis: CellBasis, img_w: int, img_h: int,
                       eps: float = 1e-6) -> list[CellBasis]:
    out = []
    for cell in enumerate_cells(basis, img_w, img_h, extra=1):
        if np.all(bbox_inside(cell.corners(), img_w, img_h, eps)):
            out.append(cell)
    # 去重 (不同整数平移可能落到同一个原点)
    seen = set()
    uniq = []
    for c in out:
        key = (round(c.origin[0], 6), round(c.origin[1], 6))
        if key not in seen:
            seen.add(key)
            uniq.append(c)
    return uniq


def border_margin(cell: CellBasis, img_w: int, img_h: int) -> float:
    c = cell.corners()
    return float(min(c[:, 0].min(), c[:, 1].min(),
                     img_w - c[:, 0].max(), img_h - c[:, 1].max()))


def choose_complete_cell(basis: CellBasis, img_w: int, img_h: int,
                         prefer_point: Optional[Point] = None) -> Optional[CellBasis]:
    """选一个完整落在图内的等价单元。

    优先靠近用户点选的区域 (来源渐变最接近), 再要求离图边留有余量。
    """
    candidates = fully_inside_cells(basis, img_w, img_h)
    if not candidates:
        return None
    if prefer_point is None:
        prefer_point = basis.origin

    def score(cell: CellBasis) -> Tuple[float, float]:
        center = cell.corners().mean(axis=0)
        d = float(np.hypot(center[0] - prefer_point[0], center[1] - prefer_point[1]))
        return (d, -border_margin(cell, img_w, img_h))

    return min(candidates, key=score)


# ---------------------------------------------------------------------------
# 平移向量的合法性 (基于图内实际重叠内容)
# ---------------------------------------------------------------------------

def normalize_basis(origin: Vec, t1: Vec, t2: Vec,
                    img_w: int, img_h: int) -> CellBasis:
    """把用户给的原点挪到离图像中心最近的一个等价格点上。

    原点在格点上的整数平移不改变单元覆盖的像素集, 但会决定单元是否伸出图外。
    """
    basis = CellBasis(origin, t1, t2)
    try:
        M_inv = inverse_basis(basis.matrix)
    except np.linalg.LinAlgError:
        return basis
    center_local = (np.array([img_w / 2.0, img_h / 2.0])
                    - np.array(origin, dtype=float)) @ M_inv.T
    i = int(np.floor(center_local[0]))
    j = int(np.floor(center_local[1]))
    p = np.array(origin, dtype=float) + i * basis.matrix[:, 0] + j * basis.matrix[:, 1]
    # 让原点落在图像附近: 若中心在 (i,j) 单元里, 就取那个单元的角
    return CellBasis((float(p[0]), float(p[1])), t1, t2)
