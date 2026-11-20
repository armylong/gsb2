"""Fixed-topology triangular control mesh and deformation validation.

The mesh is a regular ``cols x rows`` lattice of control points over the source
image.  Its triangulation is fixed at construction time and never recomputed
when points move, which is what makes the deformation a continuous
piecewise-affine map: adjacent triangles share both endpoints of their common
edge, so that edge maps to exactly the same segment in both triangles.

Coordinates live in *source image pixel* space (float64) and are completely
independent of any view zoom or pan.  A point's ``src`` is its rest position,
``dst`` its current target position; the identity deformation is
``dst == src``.

Validation rejects a candidate pose when any triangle flips orientation,
collapses to near-zero area, or when mesh edges/triangles overlap.  Rejection
is atomic: a rejected pose is never partially applied.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence

import numpy as np

MIN_GRID = 4
MAX_GRID = 8

# A triangle whose height (2*area / longest edge) falls below this many pixels
# is a sliver whose inverse map is numerically meaningless.
HEIGHT_TOLERANCE_PX = 0.5
# A triangle must retain at least this fraction of its own rest area.  This is
# only a backstop: the height test catches real near-zero-area cases.
REL_AREA_TOLERANCE = 1e-5


class MeshError(ValueError):
    """Raised when a mesh definition or a requested point position is invalid."""


def lattice_triangles(cols: int, rows: int) -> np.ndarray:
    """Return the fixed triangulation as an ``(n, 3)`` array of point indices.

    Point ``(i, j)`` (column ``i``, row ``j``) has index ``j * cols + i``.
    """
    tris: list[tuple[int, int, int]] = []
    for j in range(rows - 1):
        for i in range(cols - 1):
            p00 = j * cols + i
            p10 = p00 + 1
            p01 = p00 + cols
            p11 = p01 + 1
            tris.append((p00, p10, p11))
            tris.append((p00, p11, p01))
    return np.asarray(tris, dtype=np.int64)


def regular_grid(cols: int, rows: int, width: int, height: int) -> np.ndarray:
    """Regular lattice spanning the full image, as ``(rows*cols, 2)``.

    Boundary points sit on pixel coordinates ``0`` and ``width - 1`` /
    ``height - 1`` so every pixel centre is covered by the rest mesh.
    """
    xs = np.linspace(0.0, float(width - 1), cols)
    ys = np.linspace(0.0, float(height - 1), rows)
    gx, gy = np.meshgrid(xs, ys)
    return np.column_stack((gx.ravel(), gy.ravel())).astype(np.float64)


def triangle_edges(tris: np.ndarray) -> np.ndarray:
    """Unique undirected edges of a triangulation as ``(m, 2)`` sorted pairs."""
    edges = np.concatenate((tris[:, [0, 1]], tris[:, [1, 2]], tris[:, [2, 0]]))
    edges = np.sort(edges, axis=1)
    return np.unique(edges, axis=0)


def cross2(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """2-D cross product, elementwise over the last axis."""
    return a[..., 0] * b[..., 1] - a[..., 1] * b[..., 0]


def segment_intersection_params(
    p0: np.ndarray, p1: np.ndarray, q0: np.ndarray, q1: np.ndarray
) -> np.ndarray:
    """Proper interior intersection test for segment pairs, vectorized.

    Returns true when the *open* segments ``p0p1`` and ``q0q1`` cross in their
    interiors.  Touching at endpoints or along a collinear overlap is not a
    proper crossing; those cases are covered by the area/orientation tests or
    by topology (adjacent triangles share edges).
    """
    r = p1 - p0
    s = q1 - q0
    denom = cross2(r, s)
    scale = np.maximum(
        np.linalg.norm(r, axis=-1) * np.linalg.norm(s, axis=-1), 1e-30
    )
    parallel = np.abs(denom) <= 1e-12 * scale
    qp = q0 - p0
    safe = np.where(parallel, 1.0, denom)
    t = cross2(qp, s) / safe
    u = cross2(qp, r) / safe
    eps = 1e-9
    hit = (t > eps) & (t < 1.0 - eps) & (u > eps) & (u < 1.0 - eps)
    return hit & ~parallel


def barycentric(
    points: np.ndarray, tri: np.ndarray, eps: float = -1e-7
) -> tuple[np.ndarray, np.ndarray]:
    """Barycentric coordinates of N points relative to one triangle.

    Returns ``(inside, coords)`` where ``inside`` uses ``bary >= eps`` (a small
    negative value slightly enlarges the triangle to avoid one-pixel raster
    gaps at shared edges) and ``coords`` is ``(N, 3)`` ordered as vertices
    ``a, b, c``.
    """
    p = np.asarray(points, dtype=np.float64)
    a, b, c = tri
    v0 = b - a
    v1 = c - a
    denom = v0[0] * v1[1] - v0[1] * v1[0]
    if abs(denom) < 1e-30:
        return np.zeros(len(p), dtype=bool), np.zeros((len(p), 3), dtype=np.float64)
    v2 = p - a
    u = (v2[:, 0] * v1[1] - v2[:, 1] * v1[0]) / denom
    v = (v0[0] * v2[:, 1] - v0[1] * v2[:, 0]) / denom
    w = 1.0 - u - v
    inside = (u >= eps) & (v >= eps) & (w >= eps)
    return inside, np.column_stack((w, u, v))


@dataclass(frozen=True)
class TriangleHealth:
    """Per-triangle deformation diagnostics in target space."""

    signed_double_area: np.ndarray
    rest_double_area: np.ndarray
    min_edge: np.ndarray
    height: np.ndarray
    flipped: np.ndarray
    degenerate: np.ndarray

    @property
    def bad(self) -> np.ndarray:
        return self.flipped | self.degenerate


@dataclass(frozen=True)
class ValidationReport:
    """Problems found in a candidate target pose.

    All index arrays are sorted and refer to triangles / triangle pairs.
    ``ok`` is the single decision the editor acts on.
    """

    non_finite: bool
    flipped: np.ndarray
    degenerate: np.ndarray
    crossings: np.ndarray
    contained_vertices: np.ndarray  # (n, 2): triangle index, point index

    @property
    def ok(self) -> bool:
        return not (
            self.non_finite
            or len(self.flipped)
            or len(self.degenerate)
            or len(self.crossings)
            or len(self.contained_vertices)
        )

    @property
    def bad_triangles(self) -> np.ndarray:
        extra = self.contained_vertices[:, 0] if len(self.contained_vertices) else []
        return np.unique(
            np.concatenate(
                [self.flipped, self.degenerate, np.asarray(extra, dtype=np.int64)]
            )
        )

    def problems(self, lang: str = "en") -> list[str]:
        zh = lang == "zh"
        out: list[str] = []
        if self.non_finite:
            out.append("控制点坐标不是有限数值" if zh else "control point coordinates are not finite")
        if len(self.flipped):
            out.append(
                f"{len(self.flipped)} 个三角形翻转（编号 {_preview(self.flipped)}）"
                if zh
                else f"{len(self.flipped)} flipped triangle(s) ({_preview(self.flipped)})"
            )
        if len(self.degenerate):
            out.append(
                f"{len(self.degenerate)} 个三角形接近零面积（编号 {_preview(self.degenerate)}）"
                if zh
                else f"{len(self.degenerate)} near-zero-area triangle(s) ({_preview(self.degenerate)})"
            )
        if len(self.crossings):
            pairs = ", ".join(f"{int(a)}x{int(b)}" for a, b in self.crossings[:5])
            out.append(
                f"{len(self.crossings)} 对网格边交叉（{pairs}）"
                if zh
                else f"{len(self.crossings)} crossing mesh-edge pair(s) ({pairs})"
            )
        if len(self.contained_vertices):
            pairs = ", ".join(
                f"点 {int(p)}∈三角形 {int(t)}" if zh else f"point {int(p)}∈triangle {int(t)}"
                for t, p in self.contained_vertices[:5]
            )
            out.append(
                f"{len(self.contained_vertices)} 个控制点落入非所属三角形内部（{pairs}）"
                if zh
                else f"{len(self.contained_vertices)} vertex/containment overlap(s) ({pairs})"
            )
        return out


def _preview(indices: np.ndarray) -> str:
    head = ", ".join(f"#{int(k)}" for k in indices[:6])
    return head + (f" +{len(indices) - 6}" if len(indices) > 6 else "")


class ControlMesh:
    """Fixed-topology control lattice with source and target positions.

    Parameters
    ----------
    cols, rows:
        Lattice resolution, each in ``[4, 8]``.
    width, height:
        Source image size in pixels.  ``src`` is the regular grid over this
        canvas and target coordinates use the same space.
    """

    def __init__(self, cols: int, rows: int, width: int, height: int) -> None:
        if not (MIN_GRID <= cols <= MAX_GRID and MIN_GRID <= rows <= MAX_GRID):
            raise MeshError(
                f"grid resolution must be in [{MIN_GRID}, {MAX_GRID}], got {cols}x{rows}"
            )
        if width < 2 or height < 2:
            raise MeshError("image must be at least 2x2 pixels")
        self.cols = int(cols)
        self.rows = int(rows)
        self.width = int(width)
        self.height = int(height)
        self.src = regular_grid(cols, rows, width, height)
        self.dst = self.src.copy()
        self.tris = lattice_triangles(cols, rows)
        self.edges = triangle_edges(self.tris)
        self.locked = np.zeros(len(self.src), dtype=bool)
        self.rest_double_areas = self._rest_double_areas()

    # -- lattice access -------------------------------------------------------
    @property
    def n_points(self) -> int:
        return len(self.src)

    def index(self, i: int, j: int) -> int:
        if not (0 <= i < self.cols and 0 <= j < self.rows):
            raise IndexError(f"lattice index out of range: ({i}, {j})")
        return j * self.cols + i

    def ij(self, index: int) -> tuple[int, int]:
        return index % self.cols, index // self.cols

    def is_border(self, index: int) -> bool:
        i, j = self.ij(index)
        return i in (0, self.cols - 1) or j in (0, self.rows - 1)

    def border_indices(self) -> np.ndarray:
        return np.flatnonzero([self.is_border(k) for k in range(self.n_points)]).astype(
            np.int64
        )

    def _rest_double_areas(self) -> np.ndarray:
        a, b, c = (self.src[self.tris[:, k]] for k in range(3))
        return cross2(b - a, c - a)

    # -- deformation state ----------------------------------------------------
    @property
    def is_identity(self) -> bool:
        return bool(np.array_equal(self.src, self.dst))

    def reset_all(self) -> None:
        self.dst = self.src.copy()

    def reset_point(self, index: int) -> None:
        self.dst[int(index)] = self.src[int(index)]

    def set_all_border_locked(self, value: bool) -> None:
        self.locked[self.border_indices()] = bool(value)

    # -- validation -----------------------------------------------------------
    def triangle_health(self, dst: np.ndarray | None = None) -> TriangleHealth:
        """Orientation / area diagnostics for every triangle in a pose."""
        pts = self.dst if dst is None else np.asarray(dst, dtype=np.float64)
        a, b, c = (pts[self.tris[:, k]] for k in range(3))
        area2 = cross2(b - a, c - a)
        rest2 = self.rest_double_areas
        flipped = area2 * np.sign(rest2) <= 0.0
        edges = np.stack(
            (
                np.linalg.norm(b - a, axis=1),
                np.linalg.norm(c - b, axis=1),
                np.linalg.norm(a - c, axis=1),
            ),
            axis=1,
        )
        longest = edges.max(axis=1)
        height = np.abs(area2) / np.maximum(longest, 1e-30)
        ratio = np.abs(area2) / np.maximum(np.abs(rest2), 1e-30)
        degenerate = (height < HEIGHT_TOLERANCE_PX) | (ratio < REL_AREA_TOLERANCE)
        return TriangleHealth(area2, rest2, edges.min(axis=1), height, flipped, degenerate)

    def mesh_crossings(self, dst: np.ndarray | None = None) -> np.ndarray:
        """Pairs of mesh edges that properly cross, excluding shared vertices.

        Two triangles that merely share a vertex or an edge cannot cross there
        by construction; a proper interior crossing of two non-adjacent edges
        is an invalid fold-over even when every triangle still has positive
        area (e.g. two cells swapping places).
        """
        pts = self.dst if dst is None else np.asarray(dst, dtype=np.float64)
        e = self.edges
        n = len(e)
        if n < 2:
            return np.empty((0, 2), dtype=np.int64)
        p0 = pts[e[:, 0]][:, None, :]
        p1 = pts[e[:, 1]][:, None, :]
        q0 = pts[e[:, 0]][None, :, :]
        q1 = pts[e[:, 1]][None, :, :]
        hit = segment_intersection_params(p0, p1, q0, q1)
        upper = np.triu(np.ones((n, n), dtype=bool), k=1)
        shared = (e[:, None, 0] == e[None, :, 0]) | (e[:, None, 0] == e[None, :, 1])
        shared |= (e[:, None, 1] == e[None, :, 0]) | (e[:, None, 1] == e[None, :, 1])
        bad = np.argwhere(hit & upper & ~shared)
        return bad.astype(np.int64).reshape(-1, 2)

    def contained_vertices(self, dst: np.ndarray | None = None) -> np.ndarray:
        """Vertices lying strictly inside a triangle they do not belong to.

        Convex polygons overlap without any edge crossing exactly when one
        contains a vertex of the other, so this completes the overlap test.
        Shared vertices are excluded by the strict interior test (their
        barycentric coordinate is exactly zero).
        """
        pts = self.dst if dst is None else np.asarray(dst, dtype=np.float64)
        tri_pts = pts[self.tris]
        tri_sets = [set(map(int, t)) for t in self.tris]
        found: list[tuple[int, int]] = []
        for k in range(len(self.tris)):
            inside, _ = barycentric(pts, tri_pts[k], eps=1e-7)
            for p in np.flatnonzero(inside):
                p = int(p)
                if p not in tri_sets[k]:
                    found.append((k, p))
        return np.asarray(found, dtype=np.int64).reshape(-1, 2)

    def check_pose(self, dst: np.ndarray | None = None) -> ValidationReport:
        """Full validity report for a candidate target pose."""
        pts = self.dst if dst is None else np.asarray(dst, dtype=np.float64)
        if pts.shape != self.src.shape or not np.all(np.isfinite(pts)):
            empty = np.empty(0, dtype=np.int64)
            return ValidationReport(True, empty, empty, np.empty((0, 2), np.int64), np.empty((0, 2), np.int64))
        health = self.triangle_health(pts)
        return ValidationReport(
            non_finite=False,
            flipped=np.flatnonzero(health.flipped).astype(np.int64),
            degenerate=np.flatnonzero(health.degenerate & ~health.flipped).astype(np.int64),
            crossings=self.mesh_crossings(pts),
            contained_vertices=self.contained_vertices(pts),
        )

    def validate(self, dst: np.ndarray | None = None) -> list[str]:
        """English problem list for a candidate pose (empty means valid)."""
        return self.check_pose(dst).problems()

    # -- mutation -------------------------------------------------------------
    def attempt_move(
        self,
        indices: Sequence[int],
        positions: np.ndarray,
        *,
        respect_locks: bool = True,
    ) -> tuple[bool, str, ValidationReport | None]:
        """Try to move points, applying atomically only if the pose is valid.

        Returns ``(accepted, message, report)``.  Locked points are held at
        their current target; if every requested point is locked the attempt
        is refused with a message.  On rejection the mesh is untouched, so the
        most recent valid deformation remains active.
        """
        idx = np.asarray(indices, dtype=np.int64)
        pos = np.asarray(positions, dtype=np.float64)
        if idx.ndim != 1 or pos.shape != (len(idx), 2):
            raise MeshError("indices and positions have incompatible shapes")
        if len(idx) == 0:
            return False, "no points given", None
        if idx.min() < 0 or idx.max() >= self.n_points:
            raise MeshError("point index out of range")
        movable = ~self.locked[idx] if respect_locks else np.ones(len(idx), dtype=bool)
        if not movable.any():
            return False, "point is locked", None
        candidate = self.dst.copy()
        candidate[idx[movable]] = pos[movable]
        report = self.check_pose(candidate)
        if not report.ok:
            return False, "; ".join(report.problems()), report
        self.dst = candidate
        return True, "", report

    def try_move(
        self,
        indices: Sequence[int],
        positions: np.ndarray,
        *,
        respect_locks: bool = True,
    ) -> bool:
        """Boolean convenience wrapper around :meth:`attempt_move`."""
        accepted, _, _ = self.attempt_move(
            indices, positions, respect_locks=respect_locks
        )
        return accepted

    def set_dst(self, dst: np.ndarray) -> None:
        """Replace the whole target pose, validating it first."""
        candidate = np.asarray(dst, dtype=np.float64)
        if candidate.shape != self.src.shape:
            raise MeshError("target pose must have the same shape as the grid")
        problems = self.validate(candidate)
        if problems:
            raise MeshError("; ".join(problems))
        self.dst = candidate.copy()

    # -- queries --------------------------------------------------------------
    def source_to_target(self, src_pts: np.ndarray) -> np.ndarray:
        """Map source-space points through the piecewise-affine map.

        Points outside every rest triangle return NaN (no source coverage).
        """
        src_pts = np.asarray(src_pts, dtype=np.float64)
        out = np.full((len(src_pts), 2), np.nan, dtype=np.float64)
        src_tris = self.src[self.tris]
        for k in range(len(self.tris)):
            inside, bary = barycentric(src_pts, src_tris[k])
            if inside.any():
                out[inside] = bary[inside] @ self.dst[self.tris[k]]
        return out

    def locate_target(
        self, target_pt: np.ndarray
    ) -> tuple[np.ndarray | None, np.ndarray | None]:
        """Inverse-map a target point to ``(source_xy, barycentric)``.

        ``(None, None)`` means the deformed mesh does not cover that location.
        """
        found = self.locate_target_triangle(target_pt)
        if found is None:
            return None, None
        k, bary = found
        return bary @ self.src[self.tris[k]], bary

    def locate_target_triangle(
        self, target_pt: np.ndarray
    ) -> tuple[int, np.ndarray] | None:
        """Return ``(triangle_index, barycentric)`` for a covered target point."""
        pt = np.asarray(target_pt, dtype=np.float64)[None]
        for k in range(len(self.tris)):
            inside, bary = barycentric(pt, self.dst[self.tris[k]])
            if inside[0]:
                return k, bary[0]
        return None

