from __future__ import annotations

import math
from dataclasses import dataclass, field, asdict
from typing import Sequence

import numpy as np

METHOD_BRIGHTEN = "brighten"
METHOD_COUNT = "count"
VALID_METHODS = {METHOD_BRIGHTEN, METHOD_COUNT}


@dataclass
class StackParams:
    """All tunable stacking parameters.

    The frame range and exclusions live here too so a version can be serialized
    or reproduced.  The UI usually fills start/end/excluded from its shared
    frame model before running a version.
    """

    method: str = METHOD_BRIGHTEN
    start: int = 1
    end: int | None = None
    excluded: set[int] = field(default_factory=set)

    lum_threshold: int = 34
    excess_threshold: float = 18.0
    min_occurrences: int = 2
    max_occurrences: int = 0  # 0 means no upper bound

    temporal_support: bool = True
    motion_radius: int = 14
    anti_flash: bool = True
    flash_sensitivity: float = 3.0
    flash_min_score: float = 18.0
    flash_hard_score: float = 72.0

    suppress_isolated: bool = True
    min_component_area: int = 8
    min_component_span: int = 0

    baseline_mode: str = "minimum"  # "minimum" or "median"

    def __post_init__(self) -> None:
        if self.method not in VALID_METHODS:
            raise ValueError(f"未知叠法: {self.method}")
        self.excluded = set(self.excluded or set())

    def to_dict(self) -> dict:
        data = asdict(self)
        data["excluded"] = sorted(self.excluded)
        return data

    @classmethod
    def from_dict(cls, data: dict) -> "StackParams":
        data = dict(data)
        if "excluded" in data:
            data["excluded"] = set(data["excluded"])
        known = {f for f in cls.__dataclass_fields__}  # type: ignore[attr-defined]
        return cls(**{k: v for k, v in data.items() if k in known})


@dataclass(frozen=True)
class LockRegion:
    x: int
    y: int
    width: int
    height: int
    note: str = ""

    def clipped(self, width: int, height: int) -> "LockRegion":
        x0 = max(0, min(int(self.x), width))
        y0 = max(0, min(int(self.y), height))
        x1 = max(0, min(int(self.x + self.width), width))
        y1 = max(0, min(int(self.y + self.height), height))
        if x1 < x0:
            x0, x1 = x1, x0
        if y1 < y0:
            y0, y1 = y1, y0
        return LockRegion(x0, y0, max(0, x1 - x0), max(0, y1 - y0), self.note)

    def as_rect(self) -> tuple[int, int, int, int]:
        return self.x, self.y, self.width, self.height


@dataclass
class FrameStat:
    original_index: int
    included: bool
    in_range: bool
    excluded: bool
    candidate_pixels: int = 0
    contributed_pixels: int = 0
    flash_score: float = 0.0
    flash_detected: bool = False
    reason: str = ""


@dataclass
class StackResult:
    image: np.ndarray
    baseline: np.ndarray
    count_map: np.ndarray
    retained_mask: np.ndarray
    source_map: np.ndarray
    lock_mask: np.ndarray
    params: StackParams
    width: int
    height: int
    original_indices: list[int]
    active_indices: list[int]
    frame_stats: list[FrameStat]
    flash_indices: list[int]
    warnings: list[str] = field(default_factory=list)

    def stat_for(self, original_index: int) -> FrameStat | None:
        for stat in self.frame_stats:
            if stat.original_index == original_index:
                return stat
        return None


@dataclass
class RoiContribution:
    original_index: int
    included: bool
    candidate_pixels: int
    retained_pixels: int
    max_excess: float
    flash_detected: bool = False
    source_number: int | None = None
    file_name: str = ""


def luminance(rgb: np.ndarray) -> np.ndarray:
    arr = np.asarray(rgb, dtype=np.float32)
    return arr[..., 0] * 0.2126 + arr[..., 1] * 0.7152 + arr[..., 2] * 0.0722


def _dilate_bool(mask: np.ndarray, radius: int) -> np.ndarray:
    """Square-window dilation using an integral image (no scipy dependency)."""
    mask = np.asarray(mask, dtype=bool)
    if radius <= 0:
        return mask.copy()
    h, w = mask.shape
    integral = np.zeros((h + 1, w + 1), dtype=np.int64)
    integral[1:, 1:] = np.cumsum(np.cumsum(mask.astype(np.int64), axis=0), axis=1)

    ys, xs = np.mgrid[0:h, 0:w]
    y0 = np.maximum(ys - radius, 0)
    y1 = np.minimum(ys + radius + 1, h)
    x0 = np.maximum(xs - radius, 0)
    x1 = np.minimum(xs + radius + 1, w)
    totals = integral[y1, x1] - integral[y0, x1] - integral[y1, x0] + integral[y0, x0]
    return totals > 0


class _UnionFind:
    def __init__(self, size: int) -> None:
        self.parent = list(range(size))

    def find(self, a: int) -> int:
        root = a
        while self.parent[root] != root:
            root = self.parent[root]
        while self.parent[a] != a:
            nxt = self.parent[a]
            self.parent[a] = root
            a = nxt
        return root

    def union(self, a: int, b: int) -> int:
        ra, rb = self.find(a), self.find(b)
        if ra == rb:
            return ra
        if ra > rb:
            ra, rb = rb, ra
        self.parent[rb] = ra
        return ra


def connected_components(mask: np.ndarray) -> tuple[np.ndarray, int]:
    """Four-connected components.  Bright masks in this app are sparse."""
    mask = np.asarray(mask, dtype=bool)
    h, w = mask.shape
    labels = np.zeros((h, w), dtype=np.int32)
    uf = _UnionFind(1)
    next_label = 1

    ys, xs = np.nonzero(mask)
    for y, x in zip(ys.tolist(), xs.tolist()):
        up = int(labels[y - 1, x]) if y > 0 else 0
        left = int(labels[y, x - 1]) if x > 0 else 0
        if up == 0 and left == 0:
            labels[y, x] = next_label
            uf.parent.append(next_label)
            next_label += 1
        elif up and not left:
            labels[y, x] = up
        elif left and not up:
            labels[y, x] = left
        else:
            root = uf.union(up, left)
            labels[y, x] = root

    remap = {0: 0}
    lookup = np.zeros(next_label, dtype=np.int32)
    count = 0
    for old in range(1, next_label):
        root = uf.find(old)
        if root not in remap:
            count += 1
            remap[root] = count
        lookup[old] = remap[root]
    out = lookup[labels]
    return out, count


def remove_isolated_components(
    mask: np.ndarray,
    min_area: int,
    min_span: int = 0,
    protect: np.ndarray | None = None,
) -> np.ndarray:
    mask = np.asarray(mask, dtype=bool)
    if not mask.any():
        return np.zeros_like(mask)
    labels, count = connected_components(mask)
    if count == 0:
        return np.zeros_like(mask)

    flat_labels = labels.ravel()
    areas = np.bincount(flat_labels, minlength=count + 1)
    protected_labels = set(np.unique(labels[protect]).tolist()) if protect is not None and protect.any() else set()
    protected_labels.discard(0)

    keep = np.zeros(count + 1, dtype=bool)
    for label in range(1, count + 1):
        if label in protected_labels:
            keep[label] = True
            continue
        if int(areas[label]) >= max(1, int(min_area)):
            keep[label] = True
            continue
        if min_span > 0:
            ys, xs = np.nonzero(labels == label)
            if ys.size:
                span = max(int(xs.max() - xs.min() + 1), int(ys.max() - ys.min() + 1))
                if span >= min_span:
                    keep[label] = True

    return keep[labels]


def _normalized_indices(frames: Sequence[np.ndarray], original_indices: Sequence[int] | None) -> list[int]:
    n = len(frames)
    if original_indices is None:
        return list(range(1, n + 1))
    if len(original_indices) != n:
        raise ValueError("original_indices 长度必须与 frames 相同")
    return [int(v) for v in original_indices]


def _frame_dimensions(frames: Sequence[np.ndarray]) -> tuple[int, int]:
    if not frames:
        raise ValueError("没有可叠的帧")
    shape = frames[0].shape
    if len(shape) != 3 or shape[2] != 3:
        raise ValueError("帧必须是 H×W×3 RGB 数组")
    h, w = shape[:2]
    for i, frame in enumerate(frames):
        if frame.shape[:2] != (h, w):
            raise ValueError(f"第 {i + 1} 帧尺寸 {frame.shape[:2]} 与首帧 {(h, w)} 不同")
    return h, w


def _rasterize_locks(locks: Sequence[LockRegion] | None, h: int, w: int) -> np.ndarray:
    mask = np.zeros((h, w), dtype=bool)
    for lock in locks or []:
        region = lock.clipped(w, h)
        if region.width <= 0 or region.height <= 0:
            continue
        x, y, rw, rh = region.as_rect()
        mask[y : y + rh, x : x + rw] = True
    return mask


def _active_positions(original_indices: Sequence[int], params: StackParams) -> list[int]:
    end = params.end if params.end is not None else max(original_indices, default=params.start)
    active: list[int] = []
    for pos, original in enumerate(original_indices):
        if params.start <= original <= end and original not in params.excluded:
            active.append(pos)
    return active


def _baseline(frames: Sequence[np.ndarray], active_positions: Sequence[int], mode: str) -> np.ndarray:
    active_frames = [np.asarray(frames[p], dtype=np.uint8) for p in active_positions]
    if not active_frames:
        raise ValueError("帧范围/排除设置后没有参与帧")
    if mode == "median":
        stacked = np.stack(active_frames, axis=0)
        return np.median(stacked, axis=0).astype(np.uint8)
    if mode != "minimum":
        raise ValueError(f"未知基底模式: {mode}")
    baseline = active_frames[0].copy()
    for frame in active_frames[1:]:
        np.minimum(baseline, frame, out=baseline)
    return baseline


@dataclass
class _Analysis:
    baseline: np.ndarray
    base_lum: np.ndarray
    lock_mask: np.ndarray
    active_positions: list[int]
    candidate_masks: list[np.ndarray]
    keep_masks: list[np.ndarray]
    retained_mask: np.ndarray
    count_map: np.ndarray
    flash_by_position: dict[int, bool]
    score_by_position: dict[int, float]
    stats: list[FrameStat]
    h: int
    w: int


def _analyze(
    frames: Sequence[np.ndarray],
    params: StackParams,
    original_indices: Sequence[int] | None = None,
    locks: Sequence[LockRegion] | None = None,
) -> _Analysis:
    h, w = _frame_dimensions(frames)
    orig = _normalized_indices(frames, original_indices)
    active_positions = _active_positions(orig, params)
    if not active_positions:
        raise ValueError("帧范围/排除设置后没有参与帧")

    baseline = _baseline(frames, active_positions, params.baseline_mode)
    base_lum = luminance(baseline)
    lock_mask = _rasterize_locks(locks, h, w)

    stats = [
        FrameStat(
            original_index=original,
            included=False,
            in_range=params.start <= original <= (params.end if params.end is not None else original),
            excluded=original in params.excluded,
        )
        for original in orig
    ]
    for stat, original in zip(stats, orig):
        end = params.end if params.end is not None else max(orig)
        stat.in_range = params.start <= original <= end
        if stat.excluded:
            stat.reason = "手工排除"
        elif not stat.in_range:
            stat.reason = "不在帧范围内"

    # First pass: thresholds and frame-level flash scores.
    raw_masks: dict[int, np.ndarray] = {}
    scores: dict[int, float] = {}
    excess_maps: dict[int, np.ndarray] = {}
    for pos in active_positions:
        frame = np.asarray(frames[pos], dtype=np.uint8)
        lum = luminance(frame)
        excess = np.maximum(0.0, lum - base_lum)
        raw = (lum >= float(params.lum_threshold)) & (excess >= float(params.excess_threshold))
        # A locked region gets a gentler threshold so a faint but wanted trail
        # can be protected without forcing pixels that are simply not there.
        locked_weak = (
            lock_mask
            & (lum >= max(10.0, params.lum_threshold * 0.45))
            & (excess >= max(5.0, params.excess_threshold * 0.30))
        )
        mask = raw | locked_weak
        raw_masks[pos] = mask
        excess_maps[pos] = excess
        scores[pos] = float(np.percentile(excess, 99.0))
        stat = stats[pos]
        stat.candidate_pixels = int(mask.sum())
        stat.included = True

    # Robust one-frame reflection detection.  A single outlier score is enough
    # to break MAD; the hard score catches it even for very short sequences.
    values = np.array([scores[p] for p in active_positions], dtype=np.float32)
    median_score = float(np.median(values))
    mad = float(np.median(np.abs(values - median_score))) if values.size else 0.0
    z_limit = max(0.1, float(params.flash_sensitivity))
    flash_by_position: dict[int, bool] = {}
    for pos in active_positions:
        score = scores[pos]
        # A fixed noise floor prevents a near-zero MAD from treating every
        # tiny score difference as an arbitrarily large robust z-score.
        robust_scale = 1.4826 * mad + 4.0
        z = 0.6745 * (score - median_score) / robust_scale
        is_flash = bool(
            params.anti_flash
            and (
                score >= params.flash_hard_score
                or (z >= z_limit and score >= params.flash_min_score)
            )
        )
        flash_by_position[pos] = is_flash
        stat = stats[pos]
        stat.flash_score = score
        stat.flash_detected = is_flash
        if is_flash:
            stat.reason = "疑似单帧强反光，已抑制其亮部"
            # Explicit locks still win inside the locked rectangle.
            raw_masks[pos] = raw_masks[pos] & lock_mask if lock_mask.any() else np.zeros((h, w), dtype=bool)
            stat.candidate_pixels = int(raw_masks[pos].sum())

    active_masks = [raw_masks[p] for p in active_positions]
    count_map = np.zeros((h, w), dtype=np.uint16)
    for mask in active_masks:
        count_map += mask.astype(np.uint16)

    # Temporal continuity: a moving point has a bright neighbour in an adjacent
    # frame even when exact pixels do not overlap.  A one-frame isolated spot
    # has neither previous nor next support.  Dilate each mask once and spread
    # it into the support masks of its adjacent active frames.
    support_masks: dict[int, np.ndarray] = {}
    if params.temporal_support and params.motion_radius > 0:
        active_support = [np.zeros((h, w), dtype=bool) for _ in active_positions]
        for k, pos in enumerate(active_positions):
            dilated = _dilate_bool(raw_masks[pos], params.motion_radius)
            if k > 0:
                active_support[k - 1] |= dilated
            if k + 1 < len(active_positions):
                active_support[k + 1] |= dilated
        for pos, supported in zip(active_positions, active_support):
            support_masks[pos] = supported
    else:
        for pos in active_positions:
            support_masks[pos] = np.ones((h, w), dtype=bool)

    if params.method == METHOD_COUNT:
        qualified = count_map >= max(1, int(params.min_occurrences))
        if int(params.max_occurrences) > 0:
            qualified &= count_map <= int(params.max_occurrences)
    else:
        qualified = np.ones((h, w), dtype=bool)

    keep_masks_full: dict[int, np.ndarray] = {}
    union = np.zeros((h, w), dtype=bool)
    for pos in active_positions:
        mask = raw_masks[pos]
        keep = mask & qualified
        if params.temporal_support:
            keep &= support_masks[pos] | lock_mask
        else:
            keep &= np.ones_like(mask)
        # Locks bypass count/qualified too.
        keep |= mask & lock_mask
        keep_masks_full[pos] = keep
        union |= keep

    if params.suppress_isolated and int(params.min_component_area) > 1:
        cleaned = remove_isolated_components(
            union,
            min_area=int(params.min_component_area),
            min_span=int(params.min_component_span),
            protect=lock_mask,
        )
    else:
        cleaned = union

    keep_masks: list[np.ndarray] = []
    for pos in range(len(frames)):
        if pos in keep_masks_full:
            kept = keep_masks_full[pos] & cleaned
            keep_masks_full[pos] = kept
            stats[pos].contributed_pixels = int(kept.sum())
            keep_masks.append(kept)
        else:
            keep_masks.append(np.zeros((h, w), dtype=bool))

    return _Analysis(
        baseline=baseline,
        base_lum=base_lum,
        lock_mask=lock_mask,
        active_positions=active_positions,
        candidate_masks=[raw_masks.get(p, np.zeros((h, w), dtype=bool)) for p in range(len(frames))],
        keep_masks=keep_masks,
        retained_mask=cleaned,
        count_map=count_map,
        flash_by_position=flash_by_position,
        score_by_position=scores,
        stats=stats,
        h=h,
        w=w,
    )


def stack_sequence(
    frames: Sequence[np.ndarray],
    params: StackParams,
    original_indices: Sequence[int] | None = None,
    locks: Sequence[LockRegion] | None = None,
) -> StackResult:
    """Stack same-size RGB arrays without resampling or changing coordinates."""
    analysis = _analyze(frames, params, original_indices, locks)
    h, w = analysis.h, analysis.w
    orig = _normalized_indices(frames, original_indices)

    image = analysis.baseline.copy()
    source_map = np.full((h, w), -1, dtype=np.int32)
    best_lum = analysis.base_lum.copy()

    for pos in analysis.active_positions:
        keep = analysis.keep_masks[pos]
        if not keep.any():
            continue
        frame = np.asarray(frames[pos], dtype=np.uint8)
        image[keep] = np.maximum(image[keep], frame[keep])
        lum = luminance(frame)
        update = keep & (lum > best_lum)
        source_map[update] = orig[pos]
        best_lum[update] = lum[update]

    retained_mask = analysis.retained_mask

    flash_indices = [orig[p] for p, flag in analysis.flash_by_position.items() if flag]
    warnings: list[str] = []
    if flash_indices:
        warnings.append("已抑制疑似强反光帧: " + ", ".join(map(str, flash_indices)))
    if not retained_mask.any():
        warnings.append("当前参数没有保留任何亮迹，可降低阈值或最小出现次数")

    return StackResult(
        image=image,
        baseline=analysis.baseline,
        count_map=analysis.count_map,
        retained_mask=analysis.retained_mask,
        source_map=source_map,
        lock_mask=analysis.lock_mask,
        params=params,
        width=w,
        height=h,
        original_indices=list(orig),
        active_indices=[orig[p] for p in analysis.active_positions],
        frame_stats=analysis.stats,
        flash_indices=flash_indices,
        warnings=warnings,
    )


def roi_contributors(
    frames: Sequence[np.ndarray],
    params: StackParams,
    roi: tuple[int, int, int, int],
    original_indices: Sequence[int] | None = None,
    locks: Sequence[LockRegion] | None = None,
    source_numbers: dict[int, int] | None = None,
    file_names: dict[int, str] | None = None,
) -> list[RoiContribution]:
    """Return frames whose bright observations contribute inside an image ROI.

    ``roi`` is ``(x, y, width, height)`` in full-resolution source pixels.
    """
    analysis = _analyze(frames, params, original_indices, locks)
    orig = _normalized_indices(frames, original_indices)
    x, y, rw, rh = roi
    x = max(0, int(x))
    y = max(0, int(y))
    rw = max(0, int(rw))
    rh = max(0, int(rh))
    x1 = min(analysis.w, x + rw)
    y1 = min(analysis.h, y + rh)
    if rw <= 0 or rh <= 0 or x >= analysis.w or y >= analysis.h:
        return []

    result: list[RoiContribution] = []
    for pos, original in enumerate(orig):
        stat = analysis.stats[pos]
        candidate = int(analysis.candidate_masks[pos][y:y1, x:x1].sum())
        retained = int(analysis.keep_masks[pos][y:y1, x:x1].sum())
        max_excess = 0.0
        if stat.included:
            lum = luminance(np.asarray(frames[pos], dtype=np.uint8))
            excess = np.maximum(0.0, lum - analysis.base_lum)
            max_excess = float(excess[y:y1, x:x1].max(initial=0.0))
        result.append(
            RoiContribution(
                original_index=original,
                included=stat.included,
                candidate_pixels=candidate,
                retained_pixels=retained,
                max_excess=max_excess,
                flash_detected=stat.flash_detected,
                source_number=(source_numbers or {}).get(original),
                file_name=(file_names or {}).get(original, ""),
            )
        )
    return result


def _hsv_to_rgb_array(h: np.ndarray, s: float, v: float) -> np.ndarray:
    h6 = (np.asarray(h, dtype=np.float32) % 1.0) * 6.0
    i = np.floor(h6).astype(np.int32)
    f = h6 - np.floor(h6)
    p = v * (1.0 - s)
    q = v * (1.0 - f * s)
    t = v * (1.0 - (1.0 - f) * s)
    i_mod = i % 6
    r = np.choose(i_mod, [v, q, p, p, t, v])
    g = np.choose(i_mod, [t, v, v, q, p, p])
    b = np.choose(i_mod, [p, p, t, v, v, q])
    return (np.stack([r, g, b], axis=-1) * 255.0).astype(np.uint8)


def source_overlay(result: StackResult, alpha: float = 0.58) -> np.ndarray:
    """Pseudo-color retained pixels by the original frame that sourced them."""
    overlay = result.image.astype(np.float32).copy()
    source = result.source_map
    valid = source >= 0
    if valid.any():
        # Golden-angle hue spacing makes adjacent original indices easy to tell.
        hues = (source.astype(np.float32) * 0.618033988749895) % 1.0
        colors = _hsv_to_rgb_array(hues, 0.72, 1.0).astype(np.float32)
        overlay[valid] = overlay[valid] * (1.0 - alpha) + colors[valid] * alpha
    return np.clip(overlay, 0, 255).astype(np.uint8)
