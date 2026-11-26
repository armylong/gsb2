"""Horizontal block matching and left/right consistency diagnostics.

Coordinate convention used throughout the project:

    disparity d = x_ref - x_target
    target_x   = x_ref - d

Thus a positive disparity means the matching point lies to the left in the
target image when the left image is the reference.  Swapping the image order
negates the signed disparity.  No camera calibration or rectification estimate
is performed; images are only assumed to be in the same row-aligned order.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import json
from pathlib import Path
from typing import Any

import cv2
import numpy as np


# ---------------------------------------------------------------------------
# Image IO and small array helpers
# ---------------------------------------------------------------------------


def load_image(path: str | Path) -> np.ndarray:
    """Load a grayscale or color image, including non-ASCII paths on macOS."""

    path = Path(path)
    data = np.fromfile(str(path), dtype=np.uint8)
    if data.size == 0:
        raise ValueError(f"图片为空或无法读取: {path}")
    img = cv2.imdecode(data, cv2.IMREAD_UNCHANGED)
    if img is None:
        raise ValueError(f"OpenCV 无法解码图片: {path}")
    if img.ndim == 2:
        return img
    if img.ndim == 3 and img.shape[2] == 1:
        return img[:, :, 0]
    if img.ndim == 3 and img.shape[2] == 4:
        # Flat white background is only used for display/matching convenience.
        bgr = img[:, :, :3]
        alpha = img[:, :, 3:4].astype(np.float32) / 255.0
        bgr_f = bgr.astype(np.float32) * alpha + 255.0 * (1.0 - alpha)
        return bgr_f.astype(np.uint8)
    return img[:, :, :3]


def load_image_pair(left_path: str | Path, right_path: str | Path) -> tuple[np.ndarray, np.ndarray]:
    left = load_image(left_path)
    right = load_image(right_path)
    if left.shape[:2] != right.shape[:2]:
        raise ValueError(
            f"左右图片尺寸必须相同: 左 {left.shape[1]}x{left.shape[0]}, "
            f"右 {right.shape[1]}x{right.shape[0]}"
        )
    return left, right


def to_gray(img: np.ndarray) -> np.ndarray:
    if img.ndim == 2:
        return img
    return cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)


def bgr_to_rgb(img: np.ndarray) -> np.ndarray:
    if img.ndim == 2:
        return cv2.cvtColor(img, cv2.COLOR_GRAY2RGB)
    return cv2.cvtColor(img, cv2.COLOR_BGR2RGB)


def _shift_target(target: np.ndarray, d: int) -> np.ndarray:
    """Place target value x-d into shifted coordinate x."""

    h, w = target.shape
    shifted = np.zeros_like(target, dtype=np.float32)
    if d >= 0:
        if d >= w:
            return shifted
        shifted[:, d:] = target[:, : w - d].astype(np.float32)
    else:
        a = -d
        if a >= w:
            return shifted
        shifted[:, : w - a] = target[:, a:].astype(np.float32)
    return shifted


def _sample_offset(a: np.ndarray, dy: int, dx: int, fill: float | bool) -> np.ndarray:
    """Return out[y, x] = a[y + dy, x + dx], filling out-of-range samples."""

    h, w = a.shape[:2]
    if a.dtype == bool:
        out = np.full((h, w), bool(fill), dtype=bool)
    else:
        out = np.full_like(a, fill)  # type: ignore[arg-type]

    y_dst0, y_dst1 = max(0, -dy), min(h, h - dy)
    x_dst0, x_dst1 = max(0, -dx), min(w, w - dx)
    y_src0, y_src1 = max(0, dy), min(h, h + dy)
    x_src0, x_src1 = max(0, dx), min(w, w + dx)
    if y_dst1 > y_dst0 and x_dst1 > x_dst0:
        out[y_dst0:y_dst1, x_dst0:x_dst1] = a[y_src0:y_src1, x_src0:x_src1]
    return out


# ---------------------------------------------------------------------------
# Result container
# ---------------------------------------------------------------------------


@dataclass
class SingleMatch:
    ref_side: str
    disparities: np.ndarray
    cost_volume: np.ndarray
    support_volume: np.ndarray
    offset_volume: np.ndarray
    disparity: np.ndarray
    disparity_integer: np.ndarray
    geometry_mask: np.ndarray
    border_mask: np.ndarray
    edge_guard_mask: np.ndarray
    confidence: np.ndarray
    best_cost: np.ndarray
    second_cost: np.ndarray
    texture_score: np.ndarray
    textureless_mask: np.ndarray
    repetitive_mask: np.ndarray
    range_edge_mask: np.ndarray
    params: dict[str, Any]
    lr_diff: np.ndarray = field(default_factory=lambda: np.full((0, 0), np.nan, np.float32))
    lr_consistent: np.ndarray = field(default_factory=lambda: np.zeros((0, 0), bool))

    @property
    def shape(self) -> tuple[int, int]:
        return self.disparity.shape


@dataclass
class PairMatch:
    left: SingleMatch
    right: SingleMatch
    reference_side: str
    lr_threshold: float

    @property
    def reference(self) -> SingleMatch:
        return self.left if self.reference_side == "left" else self.right

    @property
    def other(self) -> SingleMatch:
        return self.right if self.reference_side == "left" else self.left


# ---------------------------------------------------------------------------
# Matching
# ---------------------------------------------------------------------------


def texture_map(gray: np.ndarray, radius: int) -> np.ndarray:
    k = 2 * int(radius) + 1
    g = gray.astype(np.float32)
    gx = cv2.Sobel(g, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(g, cv2.CV_32F, 0, 1, ksize=3)
    mag = cv2.magnitude(gx, gy)
    return cv2.boxFilter(mag, cv2.CV_32F, (k, k), normalize=True, borderType=cv2.BORDER_CONSTANT)


def match_single(
    ref_gray: np.ndarray,
    target_gray: np.ndarray,
    min_disp: int,
    max_disp: int,
    radius: int = 2,
    texture_threshold: float = 4.0,
    ambiguity_tolerance: float = 0.04,
    ref_side: str = "left",
) -> SingleMatch:
    """Match every reference pixel over signed integer horizontal offsets."""

    if min_disp > max_disp:
        min_disp, max_disp = max_disp, min_disp
    min_disp = int(min_disp)
    max_disp = int(max_disp)
    radius = max(1, int(radius))
    h, w = ref_gray.shape
    ds = np.arange(min_disp, max_disp + 1, dtype=np.int32)
    if ds.size == 0:
        raise ValueError("搜索范围为空")

    k = 2 * radius + 1
    area = float(k * k)
    ref_f = ref_gray.astype(np.float32)
    cost_volume = np.empty((ds.size, h, w), dtype=np.float32)
    support_volume = np.empty((ds.size, h, w), dtype=bool)
    # Centered plus inward/side windows.  At a depth edge this lets a
    # background pixel choose a window that does not cross into the foreground
    # (and vice versa), instead of borrowing the nearer layer's disparity.
    window_offsets: tuple[tuple[int, int], ...] = (
        (0, 0),
        (-radius, 0),
        (radius, 0),
        (0, -radius),
        (0, radius),
    )
    offset_volume = np.zeros((ds.size, h, w), dtype=np.uint8)

    for i, d in enumerate(ds):
        shifted = _shift_target(target_gray, int(d))
        # Pixels inserted by shifting are exactly zero only by construction;
        # use an explicit overlap mask rather than treating black as valid.
        overlap = np.zeros((h, w), dtype=np.uint8)
        if d >= 0:
            if d < w:
                overlap[:, d:] = 1
        else:
            a = -int(d)
            if a < w:
                overlap[:, : w - a] = 1

        diff = cv2.absdiff(ref_f, shifted)
        cost_sum = cv2.boxFilter(
            diff, cv2.CV_32F, (k, k), normalize=False, borderType=cv2.BORDER_CONSTANT
        )
        count = cv2.boxFilter(
            overlap.astype(np.float32),
            cv2.CV_32F,
            (k, k),
            normalize=False,
            borderType=cv2.BORDER_CONSTANT,
        )
        mean_cost = cost_sum / np.maximum(count, 1.0)
        full_window = count >= area - 0.01

        pixel_cost = np.full((h, w), np.inf, dtype=np.float32)
        pixel_support = np.zeros((h, w), dtype=bool)
        for oi, (oy, ox) in enumerate(window_offsets):
            shifted_cost = _sample_offset(mean_cost, oy, ox, np.inf)
            shifted_support = _sample_offset(full_window, oy, ox, False)
            use = shifted_support & (shifted_cost < pixel_cost)
            pixel_cost[use] = shifted_cost[use]
            offset_volume[i][use] = oi
            pixel_support |= shifted_support

        # Full support is required for each selected side/centred window.
        # Image-border pixels can still use an inward window, but are also
        # recorded separately in border_mask.
        cost_volume[i] = pixel_cost
        support_volume[i] = pixel_support
        offset_volume[i][~pixel_support] = 255

    masked_cost = np.where(support_volume, cost_volume, np.inf).astype(np.float32)
    best_idx = np.argmin(masked_cost, axis=0).astype(np.int32)
    geometry_mask = np.isfinite(np.take_along_axis(masked_cost, best_idx[None], axis=0)[0])

    yy, xx = np.indices((h, w), dtype=np.int32)
    best_cost = masked_cost[best_idx, yy, xx]
    border_mask = (
        (xx < radius) | (xx >= w - radius) | (yy < radius) | (yy >= h - radius)
    )

    # Best competitor away from the parabola/neighbourhood of the current
    # integer minimum.  This is what exposes repeated stripes.
    competitor_radius = max(1, radius)
    second_cost = np.full((h, w), np.inf, dtype=np.float32)
    for bi in range(ds.size):
        ys, xs = np.where(geometry_mask & (best_idx == bi))
        if ys.size == 0:
            continue
        candidates = masked_cost[:, ys, xs].copy()
        lo = max(0, bi - competitor_radius)
        hi = min(ds.size, bi + competitor_radius + 1)
        candidates[lo:hi, :] = np.inf
        second_cost[ys, xs] = np.min(candidates, axis=0)

    with np.errstate(divide="ignore", invalid="ignore"):
        confidence = (second_cost - best_cost) / np.maximum(second_cost, 1e-6)
    confidence = np.nan_to_num(confidence, nan=0.0, posinf=0.0, neginf=0.0).clip(0.0, 1.0).astype(np.float32)
    confidence[~geometry_mask] = 0.0

    with np.errstate(invalid="ignore"):
        repetitive_mask = (
            geometry_mask
            & np.isfinite(second_cost)
            & ((second_cost - best_cost) <= ambiguity_tolerance * np.maximum(best_cost, 2.0))
        )

    # Sub-pixel parabola fit. Keep the original integer result separately.
    subpixel = np.full((h, w), np.nan, dtype=np.float32)
    integer_disp = np.full((h, w), -32768, dtype=np.int16)
    integer_disp[geometry_mask] = ds[best_idx[geometry_mask]].astype(np.int16)

    safe_prev = np.maximum(best_idx - 1, 0)
    safe_next = np.minimum(best_idx + 1, ds.size - 1)
    cm = cost_volume[safe_prev, yy, xx]
    cp = cost_volume[safe_next, yy, xx]
    has_neighbours = (
        geometry_mask
        & (best_idx > 0)
        & (best_idx < ds.size - 1)
        & support_volume[safe_prev, yy, xx]
        & support_volume[safe_next, yy, xx]
    )
    denom = np.full((h, w), np.inf, dtype=np.float32)
    numer = np.zeros((h, w), dtype=np.float32)
    with np.errstate(invalid="ignore"):
        denom_candidate = cm - 2.0 * best_cost + cp
        numer_candidate = cm - cp
    denom[has_neighbours] = denom_candidate[has_neighbours]
    numer[has_neighbours] = numer_candidate[has_neighbours]
    delta = np.zeros((h, w), dtype=np.float32)
    fit = has_neighbours & (denom > 1e-6)
    delta[fit] = np.clip(0.5 * numer[fit] / denom[fit], -1.0, 1.0)
    subpixel[geometry_mask] = (ds[best_idx[geometry_mask]] + delta[geometry_mask]).astype(np.float32)

    texture_score = texture_map(ref_gray, radius)
    textureless_mask = texture_score < float(texture_threshold)

    # Conservative intensity-edge guard.  Mixed foreground/background blocks
    # at occlusion boundaries can pass LR by finding a self-consistent wrong
    # edge match; do not present those boundary pixels as reliable layer data.
    median = float(np.median(ref_gray))
    canny_lo = int(max(20.0, 0.55 * median))
    canny_hi = int(min(255.0, max(90.0, 1.35 * median)))
    edges = cv2.Canny(ref_gray, canny_lo, canny_hi)
    guard_r = radius + 1
    edge_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * guard_r + 1, 2 * guard_r + 1))
    edge_guard_mask = cv2.dilate(edges, edge_kernel).astype(bool)

    range_edge_mask = geometry_mask & ((best_idx == 0) | (best_idx == ds.size - 1))

    params = {
        "min_disp": min_disp,
        "max_disp": max_disp,
        "radius": radius,
        "window": k,
        "texture_threshold": float(texture_threshold),
        "ambiguity_tolerance": float(ambiguity_tolerance),
        "canny_low": canny_lo,
        "canny_high": canny_hi,
        "edge_guard_radius": guard_r,
        "metric": "multi-window mean-SAD + parabola",
        "window_offsets": [list(item) for item in window_offsets],
        "convention": "d=x_ref-x_target, target_x=x_ref-d",
    }

    return SingleMatch(
        ref_side=ref_side,
        disparities=ds,
        cost_volume=cost_volume,
        support_volume=support_volume,
        offset_volume=offset_volume,
        disparity=subpixel,
        disparity_integer=integer_disp,
        geometry_mask=geometry_mask,
        border_mask=border_mask,
        edge_guard_mask=edge_guard_mask,
        confidence=confidence,
        best_cost=best_cost.astype(np.float32),
        second_cost=second_cost.astype(np.float32),
        texture_score=texture_score.astype(np.float32),
        textureless_mask=textureless_mask,
        repetitive_mask=repetitive_mask,
        range_edge_mask=range_edge_mask,
        params=params,
    )


def _cross_check(from_match: SingleMatch, to_match: SingleMatch) -> np.ndarray:
    """Return |d_from + d_reverse_at_target| in from-match coordinates."""

    h, w = from_match.shape
    yy, xx = np.indices((h, w), dtype=np.int32)
    diff = np.full((h, w), np.nan, dtype=np.float32)

    d = from_match.disparity
    d_clean = np.where(np.isfinite(d), d, 0.0).astype(np.float32)
    target_x = np.rint(xx - d_clean).astype(np.int32)
    inside = from_match.geometry_mask & np.isfinite(d) & (target_x >= 0) & (target_x < w)
    target_x_clipped = np.clip(target_x, 0, w - 1)

    reverse_d = to_match.disparity[yy, target_x_clipped]
    reverse_ok = to_match.geometry_mask[yy, target_x_clipped] & np.isfinite(reverse_d)
    valid = inside & reverse_ok
    diff[valid] = np.abs(d[valid] + reverse_d[valid])
    return diff


def match_pair(
    left_gray: np.ndarray,
    right_gray: np.ndarray,
    min_disp: int = 0,
    max_disp: int = 32,
    radius: int = 2,
    lr_threshold: float = 1.5,
    texture_threshold: float = 4.0,
    ambiguity_tolerance: float = 0.04,
    reference_side: str = "left",
) -> PairMatch:
    """Run forward and signed reverse searches and cross-check them."""

    left = match_single(
        left_gray,
        right_gray,
        min_disp,
        max_disp,
        radius,
        texture_threshold,
        ambiguity_tolerance,
        ref_side="left",
    )
    # If d = x_L-x_R, then the right-reference signed disparity is
    # d_R = x_R-x_L = -d.  Search the negated interval, preserving sign.
    right = match_single(
        right_gray,
        left_gray,
        -max_disp,
        -min_disp,
        radius,
        texture_threshold,
        ambiguity_tolerance,
        ref_side="right",
    )
    left.lr_diff = _cross_check(left, right)
    right.lr_diff = _cross_check(right, left)
    left.lr_consistent = left.lr_diff <= float(lr_threshold)
    right.lr_consistent = right.lr_diff <= float(lr_threshold)
    return PairMatch(left=left, right=right, reference_side=reference_side, lr_threshold=lr_threshold)


def retention_mask(
    result: SingleMatch,
    confidence_threshold: float,
    lr_threshold: float | None = None,
    require_lr: bool = True,
    reject_textureless: bool = True,
    reject_repetitive: bool = False,
    reject_range_edge: bool = False,
    reject_border: bool = False,
    reject_edge_guard: bool = False,
    edge_trim: int = 2,
) -> np.ndarray:
    """Pixels retained by the current *interactive* reliability settings."""

    mask = result.geometry_mask.copy()
    mask &= result.confidence >= float(confidence_threshold)
    if require_lr:
        thr = result.params.get("lr_threshold", None) if lr_threshold is None else lr_threshold
        if lr_threshold is not None:
            lr_ok = result.lr_diff <= float(lr_threshold)
        else:
            lr_ok = result.lr_consistent
        mask &= np.isfinite(result.lr_diff) & lr_ok
    if reject_textureless:
        mask &= ~result.textureless_mask
    if reject_repetitive:
        mask &= ~result.repetitive_mask
    if reject_range_edge:
        mask &= ~result.range_edge_mask
    if reject_border:
        mask &= ~result.border_mask
    if reject_edge_guard:
        mask &= ~result.edge_guard_mask
    if edge_trim and edge_trim > 0:
        # Erode the retained components.  Mixed blocks on an occlusion contour
        # can otherwise form a 1-2 px foreground "fattening" into background.
        kernel = np.ones((3, 3), dtype=np.uint8)
        mask = cv2.erode(mask.astype(np.uint8), kernel, iterations=int(edge_trim)).astype(bool)
    return mask


def edge_trim_pixels(pre_trim_mask: np.ndarray, trim: int) -> np.ndarray:
    """Pixels that are removed solely by the contour erosion protection."""

    if trim <= 0:
        return np.zeros_like(pre_trim_mask, dtype=bool)
    kernel = np.ones((3, 3), dtype=np.uint8)
    eroded = cv2.erode(pre_trim_mask.astype(np.uint8), kernel, iterations=int(trim)).astype(bool)
    return pre_trim_mask & ~eroded


def segment_disparity_layers(
    disparity: np.ndarray,
    mask: np.ndarray,
    layer_count: int = 2,
) -> tuple[np.ndarray, np.ndarray]:
    """Cluster retained signed disparities into near-to-far layers.

    Label 0 is the nearest layer (largest disparity magnitude), labels increase
    toward farther layers.  Invalid/rejected pixels receive ``-1``.
    """

    labels = np.full(disparity.shape, -1, dtype=np.int16)
    valid = mask & np.isfinite(disparity)
    values = disparity[valid].reshape(-1, 1).astype(np.float32)
    k = int(max(2, min(layer_count, 8)))
    if values.shape[0] < k:
        return labels, np.empty((0,), dtype=np.float32)

    criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 30, 0.2)
    _compactness, cluster_ids, centers = cv2.kmeans(
        values,
        k,
        None,
        criteria,
        8,
        cv2.KMEANS_PP_CENTERS,
    )
    centers = centers.reshape(-1).astype(np.float32)
    # Near means larger |d| under either reference sign convention.
    near_to_far = np.argsort(np.abs(centers))[::-1]
    remap = np.empty(k, dtype=np.int16)
    for new_label, old_center_index in enumerate(near_to_far):
        remap[int(old_center_index)] = new_label
    labels[valid] = remap[cluster_ids.reshape(-1)].astype(np.int16)
    return labels, centers[near_to_far]


def depth_from_disparity(disparity: np.ndarray, depth_coefficient: float) -> np.ndarray:
    """Convert signed disparity magnitude to depth.

    ``depth = coefficient / |disparity|``.  ``coefficient`` may be understood
    as focal-length-in-pixels × baseline, or any empirically supplied
    proportional scale.  The signed/zero/NaN disparity array is never modified
    by this function.
    """

    d = np.asarray(disparity, dtype=np.float32)
    depth = np.full_like(d, np.nan, dtype=np.float32)
    if depth_coefficient <= 0:
        return depth
    finite = np.isfinite(d)
    zero = finite & (np.abs(d) <= 1e-6)
    valid = finite & (np.abs(d) > 1e-6)
    depth[zero] = np.inf
    depth[valid] = float(depth_coefficient) / np.abs(d[valid])
    return depth


def export_npz(
    path: str | Path,
    pair: PairMatch,
    retained: np.ndarray,
    depth_coefficient: float | None = None,
    source_paths: tuple[str, str] | None = None,
    trim_mask: np.ndarray | None = None,
    settings: dict[str, Any] | None = None,
    layer_labels: np.ndarray | None = None,
    layer_centers: np.ndarray | None = None,
) -> Path:
    """Lossless export: float disparities, masks, depth and orientation."""

    ref = pair.reference
    path = Path(path)
    if path.suffix.lower() != ".npz":
        path = path.with_suffix(".npz")
    depth = (
        depth_from_disparity(ref.disparity, float(depth_coefficient))
        if depth_coefficient
        else np.full(ref.shape, np.nan, np.float32)
    )
    metadata = {
        "reference_side": pair.reference_side,
        "other_side": "right" if pair.reference_side == "left" else "left",
        "convention": ref.params["convention"],
        "search_disparities_signed": ref.disparities.tolist(),
        "lr_threshold": pair.lr_threshold,
        "depth_formula": "depth_coefficient / abs(disparity)" if depth_coefficient else None,
        "depth_coefficient": float(depth_coefficient) if depth_coefficient else None,
        "source_paths": list(source_paths) if source_paths else None,
        "reliability_settings": settings,
        "layer_centers_signed": layer_centers.tolist() if layer_centers is not None else None,
        "layer_order": "label 0 = largest abs(disparity), nearest",
        "note": "NaN disparity means no geometrically supported estimate; zero is a valid disparity.",
    }
    if trim_mask is None:
        trim_mask = np.zeros(ref.shape, dtype=bool)
    if layer_labels is None:
        layer_labels = np.full(ref.shape, -1, dtype=np.int16)
    np.savez_compressed(
        path,
        disparity=ref.disparity.astype(np.float32),
        disparity_integer=ref.disparity_integer.astype(np.int16),
        depth=depth.astype(np.float32),
        geometry_mask=ref.geometry_mask.astype(np.uint8),
        reliable_mask=retained.astype(np.uint8),
        invalid_mask=(~retained).astype(np.uint8),
        lr_diff=ref.lr_diff.astype(np.float32),
        lr_consistent=ref.lr_consistent.astype(np.uint8),
        confidence=ref.confidence.astype(np.float32),
        textureless_mask=ref.textureless_mask.astype(np.uint8),
        repetitive_mask=ref.repetitive_mask.astype(np.uint8),
        range_edge_mask=ref.range_edge_mask.astype(np.uint8),
        image_border_mask=ref.border_mask.astype(np.uint8),
        border_mask=ref.border_mask.astype(np.uint8),
        no_geometry_mask=(~ref.geometry_mask).astype(np.uint8),
        edge_guard_mask=ref.edge_guard_mask.astype(np.uint8),
        edge_trim_mask=trim_mask.astype(np.uint8),
        layer_labels=layer_labels.astype(np.int16),
        metadata_json=np.array(json.dumps(metadata, ensure_ascii=False), dtype=np.str_),
    )
    return path
