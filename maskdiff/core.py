"""Core mask-difference analysis.

Pure numpy/scipy: no Qt imports, so everything here is testable headlessly.

Coordinates are always image-frame ``(row, col)``. Physical distances use the
per-pixel row/column sizes supplied by the caller, so the heat map, the
per-sample numbers and the exported summaries all share one unit.

Two measurements coexist on purpose, because they answer different questions:

* **area** -- how many pixels are in A only / B only. A thin notch barely moves
  it.
* **boundary distance** -- how far the boundary of one mask lies from the
  boundary of the other. A thin notch, or a global shift, moves that a lot even
  when the area is almost unchanged.

Distances are always computed on the full image; an ROI only decides which
samples enter the statistics. A crop edge therefore never becomes a boundary.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from scipy import ndimage as ndi

_CROSS = np.array([[0, 1, 0], [1, 1, 1], [0, 1, 0]], dtype=bool)
_EIGHT = np.ones((3, 3), dtype=bool)


@dataclass(frozen=True)
class Calibration:
    """Physical size of one pixel plus the tolerance allowed on each side."""

    row_size: float = 1.0
    col_size: float = 1.0
    tolerance: float = 1.0
    unit: str = "px"

    def __post_init__(self) -> None:
        if not np.isfinite(self.row_size) or self.row_size <= 0:
            raise ValueError("纵向(行)像素尺寸必须为正数")
        if not np.isfinite(self.col_size) or self.col_size <= 0:
            raise ValueError("横向(列)像素尺寸必须为正数")
        if not np.isfinite(self.tolerance) or self.tolerance < 0:
            raise ValueError("允许误差不能为负数")

    @property
    def sampling(self) -> tuple[float, float]:
        # scipy EDT axis order is (row, col).
        return (float(self.row_size), float(self.col_size))

    @property
    def pixel_area(self) -> float:
        return float(self.row_size * self.col_size)

    @property
    def area_unit(self) -> str:
        return f"{self.unit}²"

    @property
    def unit_note(self) -> str:
        if self.row_size == self.col_size:
            return f"{self.col_size:g} {self.unit}/px"
        return f"列 {self.col_size:g} / 行 {self.row_size:g} {self.unit}/px"


@dataclass(frozen=True)
class Roi:
    """Half-open pixel window ``[row0, row1) x [col0, col1)``."""

    row0: int
    row1: int
    col0: int
    col1: int

    def clip(self, shape: tuple[int, int]) -> "Roi":
        h, w = shape
        r0 = min(max(self.row0, 0), h)
        r1 = min(max(self.row1, r0), h)
        c0 = min(max(self.col0, 0), w)
        c1 = min(max(self.col1, c0), w)
        return Roi(r0, r1, c0, c1)

    def is_empty(self) -> bool:
        return self.row1 <= self.row0 or self.col1 <= self.col0

    def as_slices(self) -> tuple[slice, slice]:
        return slice(self.row0, self.row1), slice(self.col0, self.col1)

    def mask(self, shape: tuple[int, int]) -> np.ndarray:
        out = np.zeros(shape, dtype=bool)
        out[self.as_slices()] = True
        return out

    def contains(self, rows: np.ndarray, cols: np.ndarray) -> np.ndarray:
        return (
            (rows >= self.row0) & (rows < self.row1)
            & (cols >= self.col0) & (cols < self.col1)
        )

    def union(self, other: "Roi") -> "Roi":
        return Roi(
            min(self.row0, other.row0),
            max(self.row1, other.row1),
            min(self.col0, other.col0),
            max(self.col1, other.col1),
        )

    def to_tuple(self) -> tuple[int, int, int, int]:
        return (self.row0, self.row1, self.col0, self.col1)


@dataclass
class BoundarySide:
    """Distances from one mask's boundary to the other mask's boundary.

    ``values`` is a full-image float32 field (``inf`` where the target has no
    boundary). ``sample_*`` are the boundary pixels of the source mask in a
    stable row-major order, with their distance and the nearest target pixel.

    The reverse lookup (source pixel nearest to a given target pixel) is built
    lazily because it is only needed to draw both ends of one abnormal edge.
    """

    source_name: str
    target_name: str
    values: np.ndarray
    sample_rows: np.ndarray
    sample_cols: np.ndarray
    sample_values: np.ndarray
    nearest: np.ndarray
    source_boundary: np.ndarray
    target_boundary: np.ndarray
    sampling: tuple[float, float] = (1.0, 1.0)
    _reverse_cache: np.ndarray | None = field(default=None, repr=False, compare=False)

    @property
    def n(self) -> int:
        return int(self.sample_values.size)

    def find_sample(self, row: int, col: int) -> int | None:
        """Index of the sample at ``(row, col)``, or None."""
        keys = self.sample_rows.astype(np.int64) * self.values.shape[1] + self.sample_cols
        key = row * self.values.shape[1] + col
        pos = int(np.searchsorted(keys, key))
        if pos < keys.size and int(keys[pos]) == key:
            return pos
        return None

    def reverse_for(self, row: int, col: int) -> tuple[int, int]:
        """Source boundary pixel nearest to target pixel ``(row, col)``."""
        if row < 0 or col < 0:
            return (-1, -1)
        if self._reverse_cache is None:
            self._reverse_cache = ndi.distance_transform_edt(
                ~self.source_boundary, sampling=self.sampling, return_indices=True
            )[1].astype(np.int32)
        return (int(self._reverse_cache[0, row, col]), int(self._reverse_cache[1, row, col]))


@dataclass
class BoundaryStats:
    n: int = 0
    mean: float = 0.0
    median: float = 0.0
    p95: float = 0.0
    maximum: float = 0.0
    over_tolerance: int = 0
    over_tolerance_ratio: float = 0.0

    def as_row(self) -> list[str]:
        if self.n == 0:
            return ["0", "—", "—", "—", "—", "—"]
        return [
            str(self.n),
            f"{self.mean:.3f}",
            f"{self.median:.3f}",
            f"{self.p95:.3f}",
            f"{self.maximum:.3f}",
            f"{self.over_tolerance} ({self.over_tolerance_ratio:.1%})",
        ]


@dataclass
class AreaStats:
    a_px: int
    b_px: int
    overlap_px: int
    only_a_px: int
    only_b_px: int
    a_area: float
    b_area: float
    overlap_area: float
    only_a_area: float
    only_b_area: float
    union_area: float
    jaccard: float

    @property
    def area_diff_ratio(self) -> float:
        """|A-B| / max(A,B) -- how different the two total areas are."""
        m = max(self.a_area, self.b_area)
        return abs(self.a_area - self.b_area) / m if m > 0 else 0.0


@dataclass
class RegionStats:
    label: int
    kind: str  # "A 独有" | "B 独有" | "A 填充 B 的孔" | "B 填充 A 的孔"
    source: str  # "A" | "B": whose extra area this is
    area_px: int
    area: float
    max_distance: float
    mean_distance: float
    centroid: tuple[float, float]
    bbox: tuple[int, int, int, int]
    in_hole: bool

    @property
    def bbox_text(self) -> str:
        r0, r1, c0, c1 = self.bbox
        return f"行 {r0}:{r1}, 列 {c0}:{c1}"


@dataclass
class HoleInfo:
    """One hole (enclosed background region) of one mask."""

    mask_name: str  # "A" | "B"
    index: int
    area_px: int
    area: float
    radius: float  # max distance from the hole interior to its rim
    centroid: tuple[float, float]
    bbox: tuple[int, int, int, int]
    only_here: bool  # the other mask has no hole overlapping this one

    @property
    def is_tiny(self) -> bool:
        return self.area_px <= 4


@dataclass
class Difference:
    shape: tuple[int, int]
    a: np.ndarray
    b: np.ndarray
    calib: Calibration
    roi: Roi
    roi_active: bool
    only_a: np.ndarray
    only_b: np.ndarray
    overlap: np.ndarray
    both_empty: bool
    a_empty: bool
    b_empty: bool
    a_outer: np.ndarray = field(repr=False)
    a_holes: np.ndarray = field(repr=False)
    b_outer: np.ndarray = field(repr=False)
    b_holes: np.ndarray = field(repr=False)
    a_hole_interior: np.ndarray = field(repr=False)
    b_hole_interior: np.ndarray = field(repr=False)
    a_to_b: BoundarySide | None = None
    b_to_a: BoundarySide | None = None
    regions: list[RegionStats] = field(default_factory=list)
    regions_omitted: int = 0
    holes: list[HoleInfo] = field(default_factory=list)

    # ------------------------------------------------------------------ state
    @property
    def boundary_available(self) -> bool:
        return self.a_to_b is not None and self.b_to_a is not None

    def side(self, side: str) -> BoundarySide | None:
        return self.a_to_b if side == "a_to_b" else self.b_to_a

    def summary_text(self) -> str:
        """One-line explanation for degenerate inputs, else an empty string."""
        if self.both_empty:
            return "两张掩膜都是空图（前景像素为 0），没有可比较的轮廓或孔。"
        if self.a_empty:
            return "只有 B 有内容：A 为空，无法定义“A 的边界到 B 的边界”距离；面积统计仍可参考。"
        if self.b_empty:
            return "只有 A 有内容：B 为空，无法定义“B 的边界到 A 的边界”距离；面积统计仍可参考。"
        return ""

    # ------------------------------------------------------------------ stats
    def area_stats(self, roi: bool = True) -> AreaStats:
        keep = self.roi.mask(self.shape) if (roi and self.roi_active) else np.ones(self.shape, bool)
        a_px = int(np.count_nonzero(self.a & keep))
        b_px = int(np.count_nonzero(self.b & keep))
        ov = int(np.count_nonzero(self.overlap & keep))
        oa = int(np.count_nonzero(self.only_a & keep))
        ob = int(np.count_nonzero(self.only_b & keep))
        pa = self.calib.pixel_area
        return AreaStats(
            a_px=a_px,
            b_px=b_px,
            overlap_px=ov,
            only_a_px=oa,
            only_b_px=ob,
            a_area=a_px * pa,
            b_area=b_px * pa,
            overlap_area=ov * pa,
            only_a_area=oa * pa,
            only_b_area=ob * pa,
            union_area=(a_px + b_px - ov) * pa,
            jaccard=ov / (a_px + b_px - ov) if (a_px + b_px - ov) else 0.0,
        )

    def _sample_keep(self, bs: BoundarySide, roi: bool) -> np.ndarray:
        keep = np.isfinite(bs.sample_values)
        if roi and self.roi_active:
            keep &= self.roi.contains(bs.sample_rows, bs.sample_cols)
        return keep

    def stats(self, side: str, roi: bool = True) -> BoundaryStats:
        bs = self.side(side)
        if bs is None or bs.n == 0:
            return BoundaryStats()
        v = bs.sample_values[self._sample_keep(bs, roi)].astype(np.float64)
        if v.size == 0:
            return BoundaryStats()
        over = v > self.calib.tolerance
        return BoundaryStats(
            n=int(v.size),
            mean=float(v.mean()),
            median=float(np.median(v)),
            p95=float(np.percentile(v, 95)),
            maximum=float(v.max()),
            over_tolerance=int(over.sum()),
            over_tolerance_ratio=float(over.mean()),
        )

    def sample_index(self, side: str, row: int, col: int) -> int | None:
        bs = self.side(side)
        if bs is None:
            return None
        return bs.find_sample(row, col)

    def sample_info(self, side: str, index: int) -> dict:
        """Full record for one sample, including both ends of the edge."""
        bs = self.side(side)
        if bs is None or not (0 <= index < bs.n):
            raise IndexError(index)
        near = (int(bs.nearest[index, 0]), int(bs.nearest[index, 1]))
        return {
            "side": side,
            "index": int(index),
            "unit": self.calib.unit,
            "tolerance": self.calib.tolerance,
            "source": (int(bs.sample_rows[index]), int(bs.sample_cols[index])),
            "nearest": near,
            "reverse": bs.reverse_for(*near),
            "distance": float(bs.sample_values[index]),
        }

    def worst_edges(self, side: str, limit: int = 8, roi: bool = True) -> list[dict]:
        """The most deviating samples, worst first, with both end points."""
        bs = self.side(side)
        if bs is None or bs.n == 0:
            return []
        keep = self._sample_keep(bs, roi)
        idx = np.nonzero(keep)[0]
        if idx.size == 0:
            return []
        idx = idx[np.argsort(bs.sample_values[idx])[::-1][:limit]]
        return [self.sample_info(side, int(i)) for i in idx]


def boundary_parts(
    mask: np.ndarray, treat_frame_as_boundary: bool = True
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Split a mask's boundary into outer rim, hole rim, and hole interior.

    ``treat_frame_as_boundary`` (default True) makes the image frame count as
    boundary where the mask touches it: that is the drawn extent, and it keeps
    a mask cut off by the frame from silently losing contour. Set it False to
    use only internal contrast.

    A one-pixel bridge belongs to both rims (it touches exterior and a hole).
    """
    mask = np.asarray(mask, dtype=bool)
    empty = np.zeros_like(mask)
    if not mask.any():
        return empty, empty.copy(), empty.copy()

    # Padding with background makes the exterior one connected component and
    # lets the frame act as silhouette for the 4-neighbour erosion.
    padded = np.pad(mask, 1, mode="constant", constant_values=False)
    labels, _ = ndi.label(~padded, structure=_CROSS)
    exterior = labels == int(labels[0, 0])
    hole_interior_p = ~padded & ~exterior
    outer_p = padded & ndi.binary_dilation(exterior, structure=_CROSS)
    hole_rim_p = padded & ndi.binary_dilation(hole_interior_p, structure=_CROSS)

    outer = outer_p[1:-1, 1:-1]
    hole_rim = hole_rim_p[1:-1, 1:-1]
    hole_interior = hole_interior_p[1:-1, 1:-1]
    if not treat_frame_as_boundary:
        # Only internal contrast counts: a mask pixel is an outer boundary
        # pixel when a 4-neighbour inside the image is background. (The frame
        # itself is not background for this definition.)
        inner_bg = np.pad(~mask, 1, mode="edge")[1:-1, 1:-1]
        outer = outer & _cross_dilate(inner_bg)
    return outer, hole_rim, hole_interior


def _cross_dilate(seed: np.ndarray) -> np.ndarray:
    return ndi.binary_dilation(seed, structure=_CROSS)


def hole_inventory(
    mask_name: str,
    mask: np.ndarray,
    hole_interior: np.ndarray,
    hole_rim: np.ndarray,
    other_hole_interior: np.ndarray,
    calib: Calibration,
) -> list[HoleInfo]:
    """Every hole, with no size threshold -- tiny holes included."""
    if not hole_interior.any():
        return []
    labels, count = ndi.label(hole_interior, structure=_EIGHT)
    rim_dist = (
        ndi.distance_transform_edt(~hole_rim, sampling=calib.sampling)
        if hole_rim.any()
        else np.zeros(mask.shape)
    )
    out: list[HoleInfo] = []
    pixel_area = calib.pixel_area
    for i, sl in enumerate(ndi.find_objects(labels), start=1):
        if sl is None:
            continue
        comp = labels[sl] == i
        area_px = int(comp.sum())
        cy, cx = ndi.center_of_mass(comp)
        radius = float(rim_dist[sl][comp].max())
        only_here = not bool((comp & other_hole_interior[sl]).any())
        out.append(
            HoleInfo(
                mask_name=mask_name,
                index=i,
                area_px=area_px,
                area=area_px * pixel_area,
                radius=radius,
                centroid=(sl[0].start + cy, sl[1].start + cx),
                bbox=(sl[0].start, sl[0].stop, sl[1].start, sl[1].stop),
                only_here=only_here,
            )
        )
    out.sort(key=lambda h: (h.area_px, h.centroid))
    return out


def _edt_to(seed: np.ndarray, calib: Calibration) -> tuple[np.ndarray, np.ndarray]:
    """Full-image distance / indices to ``seed``; empty seed yields inf / -1."""
    if not seed.any():
        h, w = seed.shape
        return (
            np.full((h, w), np.inf, dtype=np.float64),
            np.full((2, h, w), -1, dtype=np.int32),
        )
    return ndi.distance_transform_edt(
        ~seed, sampling=calib.sampling, return_indices=True
    )


def _build_side(
    source_name: str,
    target_name: str,
    source_boundary: np.ndarray,
    target_boundary: np.ndarray,
    calib: Calibration,
) -> BoundarySide:
    dist, idx = _edt_to(target_boundary, calib)
    rows, cols = np.nonzero(source_boundary)
    sample_values = dist[rows, cols].astype(np.float64)
    nearest = np.stack((idx[0, rows, cols], idx[1, rows, cols]), axis=1).astype(np.int32)
    values = np.where(np.isfinite(dist), dist, np.inf).astype(np.float32)
    return BoundarySide(
        source_name=source_name,
        target_name=target_name,
        values=values,
        sample_rows=rows.astype(np.int32),
        sample_cols=cols.astype(np.int32),
        sample_values=sample_values,
        nearest=nearest,
        source_boundary=source_boundary,
        target_boundary=target_boundary,
        sampling=calib.sampling,
    )


MAX_REGIONS = 2000


def _region_stats(
    labels: np.ndarray,
    count: int,
    dist: np.ndarray,
    calib: Calibration,
    base_kind: str,
    source: str,
    in_hole: np.ndarray,
    limit: int | None = None,
) -> tuple[list[RegionStats], int]:
    """Statistics for up to ``limit`` regions, largest first.

    A hand-traced mask has tens of regions; pathologically noisy input can have
    hundreds of thousands, and per-region measurement then dominates runtime.
    The largest ``limit`` are measured; the rest are still counted and reported
    as omitted, so nothing silently disappears from the verdict.
    """
    out: list[RegionStats] = []
    if count == 0:
        return out, 0
    if limit is None:
        limit = MAX_REGIONS
    areas = np.bincount(labels.ravel(), minlength=count + 1)
    pixel_area = calib.pixel_area
    if count > limit:
        chosen = (np.argsort(areas[1:])[::-1][:limit] + 1).tolist()
    else:
        chosen = list(range(1, count + 1))
    slices = ndi.find_objects(labels)
    for i in chosen:
        sl = slices[i - 1]
        if sl is None:
            continue
        comp = labels[sl] == i
        area_px = int(areas[i])
        vals = dist[sl][comp]
        vals = vals[np.isfinite(vals)]
        max_d = float(vals.max()) if vals.size else float("nan")
        mean_d = float(vals.mean()) if vals.size else float("nan")
        cy, cx = ndi.center_of_mass(comp)
        is_hole = bool((comp & in_hole[sl]).any())
        kind = base_kind if not is_hole else (
            "B 填充 A 的孔" if source == "B" else "A 填充 B 的孔"
        )
        out.append(
            RegionStats(
                label=i,
                kind=kind,
                source=source,
                area_px=area_px,
                area=area_px * pixel_area,
                max_distance=max_d,
                mean_distance=mean_d,
                centroid=(sl[0].start + cy, sl[1].start + cx),
                bbox=(sl[0].start, sl[0].stop, sl[1].start, sl[1].stop),
                in_hole=is_hole,
            )
        )
    out.sort(key=lambda r: r.area_px, reverse=True)
    return out, max(0, count - len(out))


def analyze(
    a: np.ndarray,
    b: np.ndarray,
    calib: Calibration | None = None,
    roi: Roi | None = None,
    ignore_hole_boundaries: bool = False,
) -> Difference:
    """Compare two binary masks of equal shape.

    ``roi`` restricts *statistics* to a window; distances always use the
    full-image boundaries, so the crop edge never becomes a fake boundary.
    Hole rims are boundary samples by default, with no minimum hole size: a
    one-pixel pinhole is measured and listed. ``ignore_hole_boundaries`` is an
    explicit opt-out for users who only care about outer contours; the hole
    inventory is still produced.
    """
    a = np.asarray(a, dtype=bool)
    b = np.asarray(b, dtype=bool)
    if a.ndim != 2 or b.ndim != 2:
        raise ValueError("掩膜必须是二维二值图")
    if a.shape != b.shape:
        raise ValueError(f"两张掩膜尺寸不一致: A {a.shape} vs B {b.shape}")
    calib = calib or Calibration()
    h, w = a.shape
    roi_active = roi is not None
    roi = (roi or Roi(0, h, 0, w)).clip((h, w))
    if roi.is_empty():
        roi = Roi(0, h, 0, w)
        roi_active = False

    a_outer, a_hole_rim, a_hole_int = boundary_parts(a)
    b_outer, b_hole_rim, b_hole_int = boundary_parts(b)

    a_seed = a_outer if ignore_hole_boundaries else (a_outer | a_hole_rim)
    b_seed = b_outer if ignore_hole_boundaries else (b_outer | b_hole_rim)

    holes: list[HoleInfo] = []
    holes += hole_inventory("A", a, a_hole_int, a_hole_rim, b_hole_int, calib)
    holes += hole_inventory("B", b, b_hole_int, b_hole_rim, a_hole_int, calib)

    diff = Difference(
        shape=(h, w),
        a=a,
        b=b,
        calib=calib,
        roi=roi,
        roi_active=roi_active,
        only_a=a & ~b,
        only_b=b & ~a,
        overlap=a & b,
        both_empty=not a.any() and not b.any(),
        a_empty=not a.any(),
        b_empty=not b.any(),
        a_outer=a_outer,
        a_holes=a_hole_rim,
        b_outer=b_outer,
        b_holes=b_hole_rim,
        a_hole_interior=a_hole_int,
        b_hole_interior=b_hole_int,
        holes=holes,
    )

    if diff.both_empty or diff.a_empty or diff.b_empty:
        # Distances to a non-existent boundary are undefined. Keep the
        # difference maps and the explicit empty flags; skip distances.
        return diff

    diff.a_to_b = _build_side("A", "B", a_seed, b_seed, calib)
    diff.b_to_a = _build_side("B", "A", b_seed, a_seed, calib)

    # Region statistics are local when a ROI is set: regions are the connected
    # difference areas *inside* the window, and their max/mean distance uses the
    # global distance field, so the crop edge still never acts as a boundary.
    keep = roi.mask((h, w)) if roi_active else np.ones((h, w), dtype=bool)
    regions: list[RegionStats] = []
    omitted = 0
    only_a_local = diff.only_a & keep
    only_b_local = diff.only_b & keep
    if only_a_local.any():
        lab, n = ndi.label(only_a_local, structure=_EIGHT)
        stats, dropped = _region_stats(
            lab, n, diff.a_to_b.values, calib, "A 独有", "A", b_hole_int
        )
        regions += stats
        omitted += dropped
    if only_b_local.any():
        lab, n = ndi.label(only_b_local, structure=_EIGHT)
        stats, dropped = _region_stats(
            lab, n, diff.b_to_a.values, calib, "B 独有", "B", a_hole_int
        )
        regions += stats
        omitted += dropped
    regions.sort(key=lambda r: r.area_px, reverse=True)
    diff.regions = regions
    diff.regions_omitted = omitted
    return diff


def boundary_band(
    diff: "Difference", side: str, band_px: float = 3.0
) -> tuple[np.ndarray, np.ndarray] | None:
    """Pixels near the source boundary, each carrying that boundary's distance.

    The interior of a shape has no meaningful "distance to the other boundary",
    so painting it as a distance would invent data. A narrow band around the
    contour keeps the silhouette readable while every coloured pixel maps to a
    real sample.
    """
    bs = diff.side(side)
    if bs is None or bs.n == 0:
        return None
    seed = np.zeros(diff.shape, dtype=bool)
    seed[bs.sample_rows, bs.sample_cols] = True
    dist, idx = ndi.distance_transform_edt(~seed, return_indices=True)
    band = dist <= float(band_px)
    sample_value = np.zeros(diff.shape, dtype=np.float64)
    sample_value[bs.sample_rows, bs.sample_cols] = bs.sample_values
    vals = sample_value[idx[0], idx[1]]
    vals = np.where(np.isfinite(vals), vals, 0.0)
    return band, vals


def percentile_scale(values: np.ndarray, q: float = 99.0) -> float:
    """Robust upper end for a colour scale; never zero."""
    finite = np.asarray(values, dtype=np.float64)
    finite = finite[np.isfinite(finite)]
    if finite.size == 0:
        return 1.0
    v = float(np.percentile(finite, q))
    return v if v > 0 else 1.0
