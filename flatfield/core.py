"""Numeric core: reference modelling, defect detection, correction, metrics.

No Qt imports here so the pipeline can be unit-tested and used from the CLI.
All working buffers are float32 (16-bit samples are exactly representable);
loaded originals are never modified.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Iterable, Literal, Sequence

import numpy as np

from .io import Meta

FULL_SCALE = 65535
_EPS = 1e-6


# --------------------------------------------------------------------------- #
# Frames & statistics
# --------------------------------------------------------------------------- #

@dataclass
class Frame:
    """One loaded 16-bit grayscale image."""

    array: np.ndarray
    name: str = ""
    meta: Meta = field(default_factory=Meta)
    path: str = ""

    def __post_init__(self) -> None:
        arr = np.asarray(self.array)
        if arr.ndim != 2 or arr.dtype != np.uint16:
            raise TypeError("Frame expects a 2-D uint16 array")
        self.array = np.ascontiguousarray(arr)
        if not self.name:
            self.name = self.path or "frame"

    @property
    def shape(self) -> tuple[int, int]:
        return self.array.shape  # type: ignore[return-value]

    def sat_mask(self, sat_value: int = FULL_SCALE) -> np.ndarray:
        return self.array >= sat_value


def frame_mean(frames: Sequence[Frame]) -> np.ndarray:
    """Pixel-wise mean in float64, returned as float32."""
    if not frames:
        raise ValueError("no frames")
    acc = np.zeros(frames[0].shape, np.float64)
    for frame in frames:
        if frame.shape != acc.shape:
            raise ValueError(f"{frame.name}: size differs from the reference set")
        acc += frame.array
    acc /= len(frames)
    return acc.astype(np.float32)


def frame_mean_std(frames: Sequence[Frame]) -> tuple[np.ndarray, np.ndarray]:
    """Pixel-wise mean / sample standard deviation across frames."""
    if not frames:
        raise ValueError("no frames")
    shape = frames[0].shape
    acc = np.zeros(shape, np.float64)
    acc2 = np.zeros(shape, np.float64)
    for frame in frames:
        if frame.shape != shape:
            raise ValueError(f"{frame.name}: size differs from the reference set")
        values = frame.array.astype(np.float64)
        acc += values
        acc2 += values * values
    n = len(frames)
    mean = acc / n
    var = np.maximum(acc2 / n - mean * mean, 0.0) * (n / max(n - 1, 1))
    return mean.astype(np.float32), np.sqrt(var).astype(np.float32)


@dataclass
class FrameStats:
    name: str
    shape: tuple[int, int]
    vmin: int
    vmax: int
    mean: float
    median: float
    p01: float
    p99: float
    sat_count: int
    zero_count: int
    sat_bbox: tuple[int, int, int, int] | None
    sat_centroid: tuple[float, float] | None
    meta: Meta
    approximate: bool = False

    @property
    def sat_fraction(self) -> float:
        h, w = self.shape
        return self.sat_count / float(h * w) if h and w else 0.0

    def bbox_text(self) -> str:
        if self.sat_bbox is None:
            return "—"
        r0, c0, r1, c1 = self.sat_bbox
        return f"行 {r0}-{r1}, 列 {c0}-{c1}"


def frame_stats(frame: Frame, sat_value: int = FULL_SCALE) -> FrameStats:
    arr = frame.array
    h, w = arr.shape
    total = h * w
    vmin = int(arr.min()) if total else 0
    vmax = int(arr.max()) if total else 0
    mean = float(arr.mean()) if total else 0.0
    step = max(1, int(math.ceil(math.sqrt(total / 2_000_000))))  # cap percentile cost
    sample = arr[::step, ::step].ravel()
    approximate = step > 1
    median = float(np.median(sample)) if sample.size else 0.0
    p01, p99 = (float(v) for v in np.percentile(sample, [1, 99])) if sample.size else (0.0, 0.0)
    sat = arr >= sat_value
    sat_count = int(np.count_nonzero(sat))
    bbox = None
    centroid = None
    if sat_count:
        rows = np.flatnonzero(sat.any(axis=1))
        cols = np.flatnonzero(sat.any(axis=0))
        r0, r1 = int(rows[0]), int(rows[-1])
        c0, c1 = int(cols[0]), int(cols[-1])
        bbox = (r0, c0, r1, c1)
        rr, cc = np.nonzero(sat)
        centroid = (float(rr.mean()), float(cc.mean()))
    return FrameStats(
        name=frame.name,
        shape=(int(h), int(w)),
        vmin=vmin,
        vmax=vmax,
        mean=mean,
        median=median,
        p01=p01,
        p99=p99,
        sat_count=sat_count,
        zero_count=int(np.count_nonzero(arr == 0)),
        sat_bbox=bbox,
        sat_centroid=centroid,
        meta=frame.meta,
        approximate=approximate,
    )


@dataclass
class GroupStats:
    label: str
    frames: list[FrameStats]
    vmin: int
    vmax: int
    mean: float
    sat_count: int
    sat_any: int
    sat_persistent: int
    sat_bbox: tuple[int, int, int, int] | None
    persistent_mask: np.ndarray | None
    union_mask: np.ndarray | None

    @property
    def count(self) -> int:
        return len(self.frames)

    @property
    def shape(self) -> tuple[int, int] | None:
        return self.frames[0].shape if self.frames else None

    def sat_text(self, sat_value: int = FULL_SCALE) -> str:
        if not self.frames:
            return "—"
        if self.sat_any == 0:
            return "无饱和像素"
        if self.count > 1:
            text = (f"任意帧饱和 {self.sat_any} px · 每帧均饱和 {self.sat_persistent} px"
                    f" (阈值 {sat_value})")
        else:
            text = f"饱和 {self.sat_any} px (阈值 {sat_value})"
        if self.sat_bbox:
            r0, c0, r1, c1 = self.sat_bbox
            text += f" · 区域 行 {r0}-{r1}, 列 {c0}-{c1}"
        return text


def group_stats(frames: Sequence[Frame], label: str, sat_value: int = FULL_SCALE) -> GroupStats:
    stats = [frame_stats(f, sat_value) for f in frames]
    if not frames:
        return GroupStats(label, [], 0, 0, 0.0, 0, 0, 0, None, None, None)
    shape = frames[0].shape
    union = np.zeros(shape, bool)
    counts = np.zeros(shape, np.uint16)
    for frame in frames:
        if frame.shape != shape:
            raise ValueError("frames in one group must share dimensions")
        sat = frame.sat_mask(sat_value)
        union |= sat
        counts += sat
    persistent = counts >= len(frames)
    sat_count = int(np.count_nonzero(union))
    bbox = None
    if sat_count:
        rows = np.flatnonzero(union.any(axis=1))
        cols = np.flatnonzero(union.any(axis=0))
        bbox = (int(rows[0]), int(cols[0]), int(rows[-1]), int(cols[-1]))
    return GroupStats(
        label=label,
        frames=stats,
        vmin=min(s.vmin for s in stats),
        vmax=max(s.vmax for s in stats),
        mean=float(np.mean([s.mean for s in stats])) if stats else 0.0,
        sat_count=sat_count,
        sat_any=sat_count,
        sat_persistent=int(np.count_nonzero(persistent)),
        sat_bbox=bbox,
        persistent_mask=persistent,
        union_mask=union,
    )


# --------------------------------------------------------------------------- #
# Validation
# --------------------------------------------------------------------------- #

@dataclass(frozen=True)
class Conditions:
    dark_exposure_ms: float | None = None
    light_exposure_ms: float | None = None
    sample_exposure_ms: float | None = None
    gain_db: float | None = None
    exposure_tolerance: float = 0.01  # relative
    gain_tolerance_db: float = 0.15

    def exposure_for(self, group: Literal["dark", "light", "sample"]) -> float | None:
        return {
            "dark": self.dark_exposure_ms,
            "light": self.light_exposure_ms,
            "sample": self.sample_exposure_ms,
        }[group]


@dataclass(frozen=True)
class Issue:
    severity: Literal["error", "warning", "info"]
    code: str
    message: str
    detail: str = ""

    @property
    def blocks(self) -> bool:
        return self.severity == "error"


def _fmt(value: float | None) -> str:
    return "未设定" if value is None else f"{value:g}"


def _compare_exposure(expected: float, actual: float, tol: float) -> bool:
    if expected == 0:
        return actual == 0
    return abs(actual - expected) / abs(expected) <= tol


def validate_set(
    darks: Sequence[Frame],
    lights: Sequence[Frame],
    sample: Frame | None,
    conditions: Conditions | None = None,
) -> list[Issue]:
    """Check completeness, dimensions and acquisition conditions.

    Errors block processing; warnings are shown and require acknowledgement.
    """
    issues: list[Issue] = []
    conditions = conditions or Conditions()
    if not darks:
        issues.append(Issue("error", "missing_dark", "没有导入暗场图片。"))
    if not lights:
        issues.append(Issue("error", "missing_light", "没有导入亮场图片。"))
    if sample is None:
        issues.append(Issue("error", "missing_sample", "没有导入样品图。"))
    if not darks or not lights or sample is None:
        return issues

    # --- dimensions -------------------------------------------------------
    target = sample.shape
    groups: list[tuple[str, Sequence[Frame]]] = [
        ("暗场", darks), ("亮场", lights), ("样品", [sample])]
    mismatched: list[str] = []
    for label, frames in groups:
        for frame in frames:
            if frame.shape != target:
                mismatched.append(
                    f"{label} {frame.name}: {frame.shape[1]}×{frame.shape[0]}")
    for label, frames in groups[:2]:
        shapes = {f.shape for f in frames}
        if len(shapes) > 1 and not mismatched:
            mismatched.append(f"{label}组内部尺寸不一致: {sorted(shapes)}")
    if mismatched:
        issues.append(Issue(
            "error", "size_mismatch",
            f"图像尺寸不一致（样品为 {target[1]}×{target[0]}），无法逐像素校正。",
            "\n".join(mismatched)))

    # --- acquisition conditions ------------------------------------------
    group_frames = {"dark": darks, "light": lights, "sample": [sample]}
    group_label = {"dark": "暗场", "light": "亮场", "sample": "样品"}
    expected_gain = conditions.gain_db
    for key in ("dark", "light", "sample"):
        frames = group_frames[key]
        expected = conditions.exposure_for(key)  # type: ignore[arg-type]
        mismatches: list[str] = []
        missing_meta = 0
        for frame in frames:
            meta = frame.meta
            if expected is not None:
                if meta.exposure_ms is None:
                    missing_meta += 1
                elif not _compare_exposure(expected, meta.exposure_ms,
                                            conditions.exposure_tolerance):
                    mismatches.append(f"{frame.name}: {meta.exposure_ms:g} ms")
            if expected_gain is not None and meta.gain_db is not None and \
                    abs(meta.gain_db - expected_gain) > conditions.gain_tolerance_db:
                mismatches.append(f"{frame.name}: 增益 {meta.gain_db:g} dB")
        if mismatches:
            what = "曝光" if expected is not None else "增益"
            issues.append(Issue(
                "warning", f"conditions_mismatch_{key}",
                f"{group_label[key]}组的{what}与设定条件不一致（设定曝光 "
                f"{_fmt(expected)} ms、增益 {_fmt(expected_gain)} dB）。",
                "\n".join(mismatches[:12]) +
                (f"\n… 共 {len(mismatches)} 项" if len(mismatches) > 12 else "")))
        if expected is not None and missing_meta:
            issues.append(Issue(
                "info", f"conditions_unknown_{key}",
                f"{group_label[key]}组有 {missing_meta} 张图没有曝光元数据，无法核对设定条件。"))

    dark_exp = conditions.dark_exposure_ms
    sample_exp = conditions.sample_exposure_ms
    if dark_exp is not None and sample_exp is not None and \
            not _compare_exposure(dark_exp, sample_exp, conditions.exposure_tolerance):
        issues.append(Issue(
            "warning", "dark_sample_exposure",
            f"暗场曝光 {dark_exp:g} ms 与样品曝光 {sample_exp:g} ms 不同；"
            "直接扣除暗场可能残留偏置或暗电流。"))

    # per-group internal exposure spread (only when no explicit expectation)
    for key in ("dark", "light"):
        values = {f.meta.exposure_ms for f in group_frames[key]
                  if f.meta.exposure_ms is not None}
        if len(values) > 1 and conditions.exposure_for(key) is None:  # type: ignore[arg-type]
            issues.append(Issue(
                "warning", f"exposure_spread_{key}",
                f"{group_label[key]}组内曝光不统一: "
                + ", ".join(f"{v:g} ms" for v in sorted(values))))
    return issues


def has_blocking(issues: Iterable[Issue]) -> bool:
    return any(issue.blocks for issue in issues)


# --------------------------------------------------------------------------- #
# Defect analysis
# --------------------------------------------------------------------------- #

@dataclass
class DefectConfig:
    low_frac: float = 0.08          # flat signal below this fraction of the median
    sat_value: int = FULL_SCALE     # 16-bit saturation threshold
    sat_persist_frac: float = 0.5   # saturated in at least this fraction of frames
    unstable_k: float = 6.0         # spatial outlier in robust sigmas
    unstable_min_rel: float = 0.05  # ... and at least this relative deviation
    temporal_k: float = 6.0         # temporal noise outlier in robust sigmas
    spatial_radius: int = 4
    large_region_px: int = 400      # connected invalid area treated as "large"
    patch_radius: int = 3


@dataclass(frozen=True)
class Component:
    id: int
    area: int
    bbox: tuple[int, int, int, int]  # r0, c0, r1, c1 inclusive
    centroid: tuple[float, float]
    category: str
    large: bool

    @property
    def center(self) -> tuple[int, int]:
        r0, c0, r1, c1 = self.bbox
        return (r0 + r1) // 2, (c0 + c1) // 2

    def area_text(self) -> str:
        return f"{self.area} px"


@dataclass
class Defects:
    low: np.ndarray
    saturated: np.ndarray
    unstable: np.ndarray
    labels: np.ndarray
    components: list[Component]

    @property
    def invalid(self) -> np.ndarray:
        return self.low | self.saturated | self.unstable

    @property
    def large_components(self) -> list[Component]:
        return [c for c in self.components if c.large]

    @property
    def small_components(self) -> list[Component]:
        return [c for c in self.components if not c.large]

    def category_at(self, row: int, col: int) -> str:
        tags = []
        if self.low[row, col]:
            tags.append("亮场接近零")
        if self.saturated[row, col]:
            tags.append("长期饱和")
        if self.unstable[row, col]:
            tags.append("起伏很大")
        return " / ".join(tags) if tags else "正常"


def box_mean(arr: np.ndarray, radius: int) -> np.ndarray:
    """Mean over a clipped (2r+1)² window using an integral image."""
    a = np.asarray(arr, np.float64)
    h, w = a.shape
    integral = np.zeros((h + 1, w + 1), np.float64)
    integral[1:, 1:] = a.cumsum(axis=0).cumsum(axis=1)
    r = max(int(radius), 0)
    y0 = np.clip(np.arange(h) - r, 0, h)
    y1 = np.clip(np.arange(h) + r + 1, 0, h)
    x0 = np.clip(np.arange(w) - r, 0, w)
    x1 = np.clip(np.arange(w) + r + 1, 0, w)
    total = (integral[y1[:, None], x1[None, :]]
             - integral[y0[:, None], x1[None, :]]
             - integral[y1[:, None], x0[None, :]]
             + integral[y0[:, None], x0[None, :]])
    count = (y1 - y0)[:, None] * (x1 - x0)[None, :]
    return total / np.maximum(count, 1)


# --- connected components (run union-find, 8-connectivity) ----------------- #

def _find(parent: list[int], i: int) -> int:
    root = i
    while parent[root] != root:
        root = parent[root]
    while parent[i] != root:
        parent[i], i = root, parent[i]
    return root


def _union(parent: list[int], a: int, b: int) -> None:
    ra, rb = _find(parent, a), _find(parent, b)
    if ra != rb:
        parent[max(ra, rb)] = min(ra, rb)


def _row_runs(row: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    padded = np.concatenate(([False], row, [False]))
    diff = np.diff(padded.astype(np.int8))
    starts = np.flatnonzero(diff == 1)
    ends = np.flatnonzero(diff == -1) - 1  # inclusive
    return starts, ends


def connected_components(mask: np.ndarray) -> tuple[np.ndarray, list[tuple[int, int, int, int, int, float, float]]]:
    """8-connected labelling of a boolean mask.

    Returns (labels, stats) where stats entries are
    (label, area, r0, c0, r1, c1, centroid_r, centroid_c).
    Implemented over runs of foreground pixels so large invalid regions
    (one run per row) stay fast.
    """
    mask = np.ascontiguousarray(mask, bool)
    h, w = mask.shape
    labels = np.zeros((h, w), np.int32)
    parent: list[int] = [0]
    prev_runs: np.ndarray | None = None
    prev_ends: np.ndarray | None = None
    prev_labels: list[int] = []
    next_label = 1
    for r in range(h):
        starts, ends = _row_runs(mask[r])
        if starts.size == 0:
            prev_runs = prev_ends = None
            prev_labels = []
            continue
        run_labels: list[int] = []
        for s, e in zip(starts, ends):
            label = 0
            if prev_runs is not None:
                # previous runs sorted; overlap in 8-connectivity (gap <= 1)
                j = np.searchsorted(prev_ends, s - 1, side="left")
                while j < prev_runs.size and prev_runs[j] <= e + 1:
                    other = prev_labels[j]
                    if label == 0:
                        label = other
                    else:
                        _union(parent, label, other)
                    j += 1
            if label == 0:
                label = next_label
                parent.append(label)
                next_label += 1
            run_labels.append(label)
            labels[r, s:e + 1] = label
        prev_runs, prev_ends, prev_labels = starts, ends, run_labels

    if next_label > 1:
        remap = np.array([_find(parent, i) for i in range(next_label)], np.int32)
        remap_inv = np.zeros(next_label, np.int32)
        uniq = np.unique(remap[1:])
        for new_id, old in enumerate(uniq, start=1):
            remap_inv[old] = new_id
        labels = remap_inv[labels]

    if not mask.any():
        return labels, []
    flat = labels.ravel()
    n = next_label
    area = np.bincount(flat, minlength=n)
    rr, cc = np.divmod(np.arange(flat.size, dtype=np.int64), w)
    rows_sum = np.bincount(flat, weights=rr, minlength=n)
    cols_sum = np.bincount(flat, weights=cc, minlength=n)
    r_min = np.full(n, h, np.int64)
    r_max = np.full(n, -1, np.int64)
    c_min = np.full(n, w, np.int64)
    c_max = np.full(n, -1, np.int64)
    np.minimum.at(r_min, flat, rr)
    np.maximum.at(r_max, flat, rr)
    np.minimum.at(c_min, flat, cc)
    np.maximum.at(c_max, flat, cc)
    stats = []
    for lab in range(1, n):
        a = int(area[lab])
        if a == 0:
            continue
        stats.append((lab, a, int(r_min[lab]), int(c_min[lab]),
                      int(r_max[lab]), int(c_max[lab]),
                      float(rows_sum[lab]) / a, float(cols_sum[lab]) / a))
    return labels, stats


def _component_stats(fast: list[tuple[int, int, int, int, int, float, float]],
                     labels: np.ndarray,
                     categories: dict[str, np.ndarray],
                     config: DefectConfig) -> list[Component]:
    components = []
    max_label = int(labels.max()) if labels.size else 0
    cat_counts = {name: np.bincount(labels[mask], minlength=max_label + 1)
                  for name, mask in categories.items()}
    for label, area, r0, c0, r1, c1, cr, cc in fast:
        counts = {name: int(cat_counts[name][label]) for name in categories}
        category = max(counts, key=counts.get) if counts else "无效"
        components.append(Component(
            id=label, area=area, bbox=(r0, c0, r1, c1),
            centroid=(cr, cc), category=category,
            large=area >= config.large_region_px))
    components.sort(key=lambda c: (-c.area, c.bbox))
    return components


def detect_defects(
    darks: Sequence[Frame],
    lights: Sequence[Frame],
    dark_mean: np.ndarray,
    light_mean: np.ndarray,
    light_std: np.ndarray,
    config: DefectConfig | None = None,
) -> Defects:
    config = config or DefectConfig()
    flat_signal = (light_mean.astype(np.float64) - dark_mean.astype(np.float64)).astype(np.float32)
    positive = flat_signal[flat_signal > 0]
    if positive.size == 0:
        raise ValueError("亮场与暗场几乎相同，无法得到亮场响应")
    scale = float(np.median(positive))
    low_threshold = max(config.low_frac * scale, 1.0)
    low = flat_signal <= low_threshold

    sat_value = int(config.sat_value)
    n_light = len(lights)
    light_sat_count = np.zeros(flat_signal.shape, np.uint16)
    for frame in lights:
        light_sat_count += frame.array >= sat_value
    dark_sat_count = np.zeros(flat_signal.shape, np.uint16)
    for frame in darks:
        dark_sat_count += frame.array >= sat_value
    n_dark = len(darks)
    saturated = (light_sat_count >= max(1, math.ceil(config.sat_persist_frac * n_light)))
    if n_dark:
        saturated |= (dark_sat_count >= max(1, math.ceil(config.sat_persist_frac * n_dark)))

    # temporal instability: relative fluctuation across the light frames
    usable = flat_signal > low_threshold
    rel_std = np.zeros(flat_signal.shape, np.float32)
    np.divide(light_std, flat_signal, out=rel_std, where=usable)
    rel_vals = rel_std[usable]
    median_rel = float(np.median(rel_vals)) if rel_vals.size else 0.0
    temporal_limit = max(config.unstable_min_rel, config.temporal_k * median_rel)
    unstable = usable & (rel_std > temporal_limit)

    # spatial instability: robust outlier against a local box mean
    norm = np.zeros(flat_signal.shape, np.float64)
    np.divide(flat_signal, scale, out=norm, where=usable)
    finite = usable.astype(np.float64)
    local = box_mean(norm * finite, config.spatial_radius) / \
        np.maximum(box_mean(finite, config.spatial_radius), _EPS)
    residual = np.where(usable, norm - local, 0.0)
    abs_res = np.abs(residual[usable])
    if abs_res.size:
        sigma = 1.4826 * float(np.median(abs_res))
        sigma = max(sigma, 1e-4)
        limit = max(config.unstable_min_rel, config.unstable_k * sigma)
        unstable |= usable & (np.abs(residual) > limit)

    invalid = low | saturated | unstable
    labels, fast = connected_components(invalid)
    components = _component_stats(
        fast, labels,
        {"亮场接近零": low, "长期饱和": saturated, "起伏很大": unstable},
        config)
    return Defects(low=low, saturated=saturated, unstable=unstable,
                   labels=labels, components=components)


# --------------------------------------------------------------------------- #
# Reference model
# --------------------------------------------------------------------------- #

PatchPolicy = Literal["none", "small", "all", "selected"]


@dataclass
class ReferenceModel:
    dark_mean: np.ndarray
    dark_std: np.ndarray
    light_mean: np.ndarray
    light_std: np.ndarray
    flat_signal: np.ndarray          # unpatched mean(light) - mean(dark)
    flat_scale: float
    flat_norm: np.ndarray            # normalized flat after applying patches
    flat_norm_raw: np.ndarray        # normalized flat without patches
    defects: Defects
    valid_mask: np.ndarray
    patched_mask: np.ndarray
    patch_ids: tuple[int, ...]
    patch_policy: str = "none"
    notes: list[str] = field(default_factory=list)
    config: DefectConfig = field(default_factory=DefectConfig)

    @property
    def shape(self) -> tuple[int, int]:
        return self.flat_norm.shape  # type: ignore[return-value]

    @property
    def valid_fraction(self) -> float:
        return float(np.count_nonzero(self.valid_mask)) / self.valid_mask.size

    def summary(self) -> dict[str, float]:
        valid = self.valid_mask
        flat_vals = self.flat_norm[valid]
        return {
            "valid_fraction": self.valid_fraction,
            "low_count": int(np.count_nonzero(self.defects.low)),
            "saturated_count": int(np.count_nonzero(self.defects.saturated)),
            "unstable_count": int(np.count_nonzero(self.defects.unstable)),
            "component_count": len(self.defects.components),
            "large_component_count": len(self.defects.large_components),
            "patched_pixels": int(np.count_nonzero(self.patched_mask)),
            "flat_min": float(flat_vals.min()) if flat_vals.size else 0.0,
            "flat_median": float(np.median(flat_vals)) if flat_vals.size else 0.0,
            "flat_max": float(flat_vals.max()) if flat_vals.size else 0.0,
        }


def _patch_flat(base_signal: np.ndarray, defects: Defects, ids: Iterable[int],
                valid: np.ndarray, radius: int) -> tuple[np.ndarray, np.ndarray]:
    out = base_signal.astype(np.float64, copy=True)
    patched = np.zeros(base_signal.shape, bool)
    by_id = {c.id: c for c in defects.components}
    h, w = out.shape
    for cid in ids:
        comp = by_id.get(cid)
        if comp is None:
            continue
        r0, c0, r1, c1 = comp.bbox
        pr0, pc0 = max(0, r0 - radius), max(0, c0 - radius)
        pr1, pc1 = min(h, r1 + radius + 1), min(w, c1 + radius + 1)
        target = defects.labels[pr0:pr1, pc0:pc1] == cid
        neighborhood = valid[pr0:pr1, pc0:pc1]
        values = base_signal[pr0:pr1, pc0:pc1][neighborhood]
        if values.size:
            fill = float(np.median(values))
        else:
            fill = float(np.median(base_signal[valid])) if np.any(valid) else 0.0
        sub = out[pr0:pr1, pc0:pc1]
        sub[target] = fill
        patched[pr0:pr1, pc0:pc1] |= target
    return out.astype(np.float32), patched


def reference_notes(defects: Defects, valid_fraction: float,
                    config: DefectConfig) -> list[str]:
    notes = []
    large = defects.large_components
    if large:
        biggest = max(large, key=lambda c: c.area)
        r0, c0, r1, c1 = biggest.bbox
        notes.append(
            f"检测到 {len(large)} 片连续无效区域，最大 {biggest.area} px "
            f"(行 {r0}-{r1}, 列 {c0}-{c1})。这类区域通常来自遮挡或镜头结构，"
            f"默认保留为无效，不自动插值。")
    if valid_fraction < 0.8:
        notes.append(f"有效像素仅占 {valid_fraction:.1%}，校正结果可参考的区域较小。")
    low = int(np.count_nonzero(defects.low))
    sat = int(np.count_nonzero(defects.saturated))
    unst = int(np.count_nonzero(defects.unstable))
    if low or sat or unst:
        notes.append(f"缺陷像素：亮场接近零 {low}，长期饱和 {sat}，起伏很大 {unst}；"
                     f"大面积阈值 {config.large_region_px} px。")
    return notes


def _validity(defects: Defects, patched_mask: np.ndarray) -> np.ndarray:
    """Invalid pixels stay invalid unless a patch supplied a measured value."""
    return ~defects.invalid | patched_mask


def build_reference(
    darks: Sequence[Frame],
    lights: Sequence[Frame],
    config: DefectConfig | None = None,
    patch_policy: PatchPolicy = "none",
    patch_ids: Iterable[int] = (),
) -> ReferenceModel:
    if not darks or not lights:
        raise ValueError("需要至少一张暗场和一张亮场")
    config = config or DefectConfig()
    dark_mean, dark_std = frame_mean_std(darks)
    light_mean, light_std = frame_mean_std(lights)
    flat_signal = (light_mean.astype(np.float64) - dark_mean.astype(np.float64)).astype(np.float32)
    positive = flat_signal[flat_signal > 0]
    if positive.size == 0:
        raise ValueError("亮场与暗场几乎相同，无法计算亮场归一化")
    scale = float(np.median(positive))

    defects = detect_defects(darks, lights, dark_mean, light_mean, light_std, config)
    observed_valid = ~defects.invalid

    if patch_policy == "small":
        ids = {c.id for c in defects.small_components}
    elif patch_policy == "all":
        ids = {c.id for c in defects.components}
    elif patch_policy == "selected":
        ids = set(int(i) for i in patch_ids)
    else:
        ids = set()
    if ids:
        patched_signal, patched_mask = _patch_flat(flat_signal, defects, ids,
                                                   observed_valid, config.patch_radius)
    else:
        patched_signal = flat_signal
        patched_mask = np.zeros(flat_signal.shape, bool)

    valid = _validity(defects, patched_mask)
    flat_norm_raw = flat_signal / np.float32(scale)
    flat_norm = patched_signal / np.float32(scale)
    # keep unmeasured pixels numerically finite for display; they are masked
    flat_norm = np.nan_to_num(flat_norm, nan=0.0, posinf=0.0, neginf=0.0)
    flat_norm_raw = np.nan_to_num(flat_norm_raw, nan=0.0, posinf=0.0, neginf=0.0)
    valid_fraction = float(np.count_nonzero(valid)) / valid.size
    model = ReferenceModel(
        dark_mean=dark_mean,
        dark_std=dark_std,
        light_mean=light_mean,
        light_std=light_std,
        flat_signal=flat_signal,
        flat_scale=scale,
        flat_norm=flat_norm.astype(np.float32),
        flat_norm_raw=flat_norm_raw.astype(np.float32),
        defects=defects,
        valid_mask=valid,
        patched_mask=patched_mask,
        patch_ids=tuple(sorted(ids)),
        patch_policy=patch_policy,
        config=config,
    )
    model.notes = reference_notes(defects, valid_fraction, config)
    return model


def apply_patch_policy(model: ReferenceModel, policy: PatchPolicy,
                       patch_ids: Iterable[int] = ()) -> ReferenceModel:
    """Return a model with a different patch decision (detection unchanged)."""
    ids: set[int]
    if policy == "small":
        ids = {c.id for c in model.defects.small_components}
    elif policy == "all":
        ids = {c.id for c in model.defects.components}
    elif policy == "selected":
        ids = set(int(i) for i in patch_ids)
    else:
        ids = set()
    if ids:
        patched_signal, patched_mask = _patch_flat(
            model.flat_signal, model.defects, ids, ~model.defects.invalid,
            model.config.patch_radius)
    else:
        patched_signal = model.flat_signal
        patched_mask = np.zeros(model.flat_signal.shape, bool)
    flat_norm = np.nan_to_num(patched_signal / np.float32(model.flat_scale))
    out = ReferenceModel(
        dark_mean=model.dark_mean, dark_std=model.dark_std,
        light_mean=model.light_mean, light_std=model.light_std,
        flat_signal=model.flat_signal, flat_scale=model.flat_scale,
        flat_norm=flat_norm.astype(np.float32),
        flat_norm_raw=model.flat_norm_raw,
        defects=model.defects, valid_mask=_validity(model.defects, patched_mask),
        patched_mask=patched_mask, patch_ids=tuple(sorted(ids)),
        patch_policy=policy, notes=list(model.notes), config=model.config)
    return out


# --------------------------------------------------------------------------- #
# Correction
# --------------------------------------------------------------------------- #

@dataclass
class CorrectionResult:
    corrected: np.ndarray          # float32 ADU after correction, NaN where invalid
    corrected_u16: np.ndarray      # export-ready uint16 (0 on invalid pixels)
    dark_corrected: np.ndarray     # float32, after dark removal (before flat)
    apply_dark: bool
    apply_light: bool
    valid_mask: np.ndarray         # model valid AND sample not clipped
    flat_invalid_mask: np.ndarray
    sample_saturated: np.ndarray
    clipped_low: int
    clipped_high: int

    @property
    def source(self) -> str:
        if self.apply_dark and self.apply_light:
            return "暗场 + 亮场校正"
        if self.apply_dark:
            return "仅暗场修正"
        if self.apply_light:
            return "仅亮场修正"
        return "未校正原图"


def sample_clipping(sample: Frame, sat_value: int = FULL_SCALE) -> np.ndarray:
    return sample.array >= sat_value


def correct(
    sample: Frame | np.ndarray,
    model: ReferenceModel,
    apply_dark: bool = True,
    apply_light: bool = True,
    sat_value: int | None = None,
) -> CorrectionResult:
    arr = sample.array if isinstance(sample, Frame) else np.asarray(sample)
    if arr.shape != model.shape:
        raise ValueError("样品尺寸与参考集不一致")
    sat_value = model.config.sat_value if sat_value is None else sat_value
    values = arr.astype(np.float32)
    dark_corrected = values - model.dark_mean if apply_dark else values.copy()
    if apply_light:
        norm = np.maximum(model.flat_norm, 1e-4).astype(np.float32)
        corrected = dark_corrected / norm
    else:
        corrected = dark_corrected

    flat_invalid = ~model.valid_mask
    sample_sat = arr >= sat_value
    valid = model.valid_mask & ~sample_sat
    corrected = np.where(valid, corrected, np.nan).astype(np.float32)
    finite = np.isfinite(corrected)
    clipped_low = int(np.count_nonzero(finite & (corrected < 0)))
    clipped_high = int(np.count_nonzero(finite & (corrected > FULL_SCALE)))
    export = np.zeros(arr.shape, np.uint16)
    if np.any(finite):
        rounded = np.rint(np.clip(corrected[finite], 0, FULL_SCALE))
        export[finite] = rounded.astype(np.uint16)
    return CorrectionResult(
        corrected=corrected,
        corrected_u16=export,
        dark_corrected=dark_corrected.astype(np.float32),
        apply_dark=apply_dark,
        apply_light=apply_light,
        valid_mask=valid,
        flat_invalid_mask=flat_invalid,
        sample_saturated=sample_sat,
        clipped_low=clipped_low,
        clipped_high=clipped_high,
    )


def reference_preview(model: ReferenceModel) -> np.ndarray:
    """16-bit view of the normalized flat (for display/export)."""
    return np.clip(np.rint(model.flat_norm * model.flat_scale), 0,
                   FULL_SCALE).astype(np.uint16)


def dark_preview(model: ReferenceModel) -> np.ndarray:
    return np.clip(np.rint(model.dark_mean), 0, FULL_SCALE).astype(np.uint16)


# --------------------------------------------------------------------------- #
# Profiles & region metrics
# --------------------------------------------------------------------------- #

@dataclass
class Profile:
    name: str
    axis: Literal["row", "col"]
    position: int
    x: np.ndarray
    y: np.ndarray
    mean: float
    median: float
    vmin: float
    vmax: float


def flat_profile_reference(model: "ReferenceModel", scale: float | None = None,
                           edge_frac: float = 0.05) -> list[Profile]:
    """Profiles of the normalized flat scaled to the current data level.

    Overlaid on a corrected/sample view it shows what a perfectly flat field
    would look like, i.e. how much illumination structure remains.
    """
    if scale is None:
        values = model.flat_norm[model.valid_mask]
        scale = float(np.median(values)) if values.size else 1.0
    data = (model.flat_norm.astype(np.float32) * np.float32(scale))
    data = np.where(model.valid_mask, data, np.nan)
    return make_profiles(data, model.valid_mask, edge_frac)


def make_profiles(arr: np.ndarray, valid: np.ndarray | None = None,
                  edge_frac: float = 0.05) -> list[Profile]:
    h, w = arr.shape
    data = arr.astype(np.float32, copy=False)
    if valid is not None:
        data = np.where(valid, data, np.nan).astype(np.float32)
    center_row, center_col = h // 2, w // 2
    edge_row = int(np.clip(round(h * edge_frac), 1, h - 2))
    edge_col = int(np.clip(round(w * edge_frac), 1, w - 2))

    entries = [
        (f"中心水平 (行 {center_row})", "row", center_row, data[center_row, :]),
        (f"中心垂直 (列 {center_col})", "col", center_col, data[:, center_col]),
        (f"边缘水平 (行 {edge_row})", "row", edge_row, data[edge_row, :]),
        (f"边缘垂直 (列 {edge_col})", "col", edge_col, data[:, edge_col]),
    ]
    profiles = []
    for name, axis, pos, values in entries:
        finite = values[np.isfinite(values)]
        if finite.size:
            mean = float(finite.mean())
            median = float(np.median(finite))
            vmin, vmax = float(finite.min()), float(finite.max())
        else:
            mean = median = vmin = vmax = float("nan")
        x = np.arange(values.size, dtype=np.float32)
        profiles.append(Profile(name=name, axis=axis, position=pos, x=x,
                                y=values.astype(np.float32), mean=mean,
                                median=median, vmin=vmin, vmax=vmax))
    return profiles


def _sample_grid(h: int, w: int, limit: int = 250_000) -> tuple[slice, slice]:
    step = max(1, int(math.ceil(math.sqrt(h * w / limit))))
    return slice(0, h, step), slice(0, w, step)


def plane_residual_stats(arr: np.ndarray, valid: np.ndarray | None) -> dict[str, float]:
    """Robust flatness: std of the residual after a plane fit over valid pixels."""
    data = np.asarray(arr, np.float32)
    h, w = data.shape
    rs, cs = _sample_grid(h, w)
    sub = data[rs, cs].astype(np.float64)
    if valid is not None:
        sub_valid = valid[rs, cs]
    else:
        sub_valid = np.isfinite(sub)
    sub_valid &= np.isfinite(sub)
    if np.count_nonzero(sub_valid) < 3:
        return {"plane_std": float("nan"), "robust_p1p99_pct": float("nan")}
    yy, xx = np.nonzero(sub_valid)
    values = sub[sub_valid]
    design = np.column_stack([np.ones(xx.size), xx, yy])
    coeff, *_ = np.linalg.lstsq(design, values, rcond=None)
    residual = values - design @ coeff
    med = float(np.median(values))
    p1, p99 = np.percentile(values, [1, 99])
    return {
        "plane_std": float(np.std(residual)),
        "plane_std_pct": float(np.std(residual) / med * 100.0) if med else float("nan"),
        "robust_p1p99_pct": float((p99 - p1) / med * 100.0) if med else float("nan"),
        "median": med,
        "mean": float(values.mean()),
    }


@dataclass
class RegionSummary:
    center_mean: float
    center_median: float
    center_std: float
    edge_mean: float
    edge_median: float
    edge_std: float
    corner_mean: float
    edge_center_ratio: float
    plane_std_pct: float
    p1p99_pct: float
    valid_fraction: float


def local_roughness_pct(arr: np.ndarray, valid: np.ndarray | None = None,
                        radius: int = 1) -> float:
    """Median |pixel - local box mean| relative to the median level (%).

    Unlike a plane fit this is barely affected by sample structure (edges are a
    small fraction of pixels), so it reads as background flatness on real data.
    """
    data = np.asarray(arr, np.float32)
    finite = np.isfinite(data)
    usable = finite if valid is None else finite & valid
    if np.count_nonzero(usable) < 16:
        return float("nan")
    smooth = box_mean(np.where(usable, data, 0.0).astype(np.float64), radius)
    count = box_mean(usable.astype(np.float64), radius)
    local = smooth / np.maximum(count, 1e-9)
    residual = np.abs(data - local)[usable]
    level = abs(float(np.median(data[usable])))
    if level == 0:
        return float("nan")
    return float(np.median(residual) / level * 100.0)


def region_summary(arr: np.ndarray, valid: np.ndarray | None = None,
                   center_frac: float = 0.2, edge_frac: float = 0.1) -> RegionSummary:
    data = np.asarray(arr, np.float32)
    h, w = data.shape
    if valid is None:
        valid = np.isfinite(data)
    visible = valid & np.isfinite(data)
    ch = max(1, int(round(h * center_frac)))
    cw = max(1, int(round(w * center_frac)))
    r0, r1 = (h - ch) // 2, (h + ch) // 2
    c0, c1 = (w - cw) // 2, (w + cw) // 2
    center_vals = data[r0:r1, c0:c1][visible[r0:r1, c0:c1]]
    band = max(2, int(round(min(h, w) * edge_frac)))
    edge_mask = np.zeros((h, w), bool)
    edge_mask[:band, :] = True
    edge_mask[-band:, :] = True
    edge_mask[:, :band] = True
    edge_mask[:, -band:] = True
    edge_vals = data[edge_mask & visible]
    corner = max(1, int(round(min(h, w) * edge_frac)))
    corners = []
    for rslice, cslice in ((slice(0, corner), slice(0, corner)),
                           (slice(0, corner), slice(-corner, None)),
                           (slice(-corner, None), slice(0, corner)),
                           (slice(-corner, None), slice(-corner, None))):
        vals = data[rslice, cslice][visible[rslice, cslice]]
        if vals.size:
            corners.append(float(vals.mean()))
    center_mean = float(center_vals.mean()) if center_vals.size else float("nan")
    edge_mean = float(edge_vals.mean()) if edge_vals.size else float("nan")
    stats = plane_residual_stats(data, visible)
    return RegionSummary(
        center_mean=center_mean,
        center_median=float(np.median(center_vals)) if center_vals.size else float("nan"),
        center_std=float(center_vals.std()) if center_vals.size else float("nan"),
        edge_mean=edge_mean,
        edge_median=float(np.median(edge_vals)) if edge_vals.size else float("nan"),
        edge_std=float(edge_vals.std()) if edge_vals.size else float("nan"),
        corner_mean=float(np.mean(corners)) if corners else float("nan"),
        edge_center_ratio=(edge_mean / center_mean) if center_mean else float("nan"),
        plane_std_pct=stats.get("plane_std_pct", float("nan")),
        p1p99_pct=stats.get("robust_p1p99_pct", float("nan")),
        valid_fraction=float(np.count_nonzero(visible)) / visible.size,
    )


# --------------------------------------------------------------------------- #
# Display helpers (never touch data)
# --------------------------------------------------------------------------- #

def display_limits(arr: np.ndarray, valid: np.ndarray | None = None,
                   low_pct: float = 0.5, high_pct: float = 99.5) -> tuple[float, float]:
    data = np.asarray(arr, np.float64)
    finite = np.isfinite(data)
    if valid is not None:
        finite &= valid
    values = data[finite]
    if values.size == 0:
        return 0.0, float(FULL_SCALE)
    trimmed = _trim_extremes(values, low_pct, high_pct)
    if trimmed is not None:
        return trimmed
    lo, hi = np.percentile(values, [low_pct, high_pct])
    if not np.isfinite(lo) or not np.isfinite(hi):
        lo, hi = float(values.min()), float(values.max())
    return _expand_degenerate(lo, hi, values)


def _expand_degenerate(lo: float, hi: float, values: np.ndarray) -> tuple[float, float]:
    if hi > lo:
        return float(lo), float(hi)
    # nearly all pixels share one level: widen the window just enough to keep a
    # usable preview without letting isolated outliers dominate it
    spread = max(1.0, abs(lo) * 0.01)
    return float(lo) - spread, float(hi) + spread


def _trim_extremes(values: np.ndarray, low_pct: float,
                    high_pct: float) -> tuple[float, float] | None:
    """Percentile window that drops isolated outliers when the data supports it."""
    if values.size < 64:
        return None
    lo, hi = np.percentile(values, [low_pct, high_pct])
    if not np.isfinite(lo) or not np.isfinite(hi):
        return None
    return float(lo), float(hi)


def to_display_u8(arr: np.ndarray, lo: float, hi: float) -> np.ndarray:
    """Map data to 8-bit for preview only; NaN/ +-inf become 0."""
    if hi <= lo:
        hi = lo + 1.0
    scaled = (np.asarray(arr, np.float32) - np.float32(lo)) * np.float32(
        255.0 / (hi - lo))
    out = np.clip(scaled, 0, 255)
    out = np.where(np.isfinite(out), out, 0).astype(np.uint8)
    return out
