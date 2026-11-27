"""Suggest small symmetry-line adjustments from an intact reference region.

The user draws a rectangle over a small area that is complete on *both* sides
of the axis.  We score candidates by how well the image matches its own
reflection inside that rectangle, searching angle and normal-offset around
the current line.  The result is only a suggestion: the GUI keeps the manual
drag handles and can always override it.
"""

from __future__ import annotations

from dataclasses import dataclass
from math import cos, sin

import cv2
import numpy as np

from .geometry import SymLine, reflection_rt


@dataclass
class Suggestion:
    line: SymLine
    angle_delta_deg: float
    offset_delta_px: float
    score: float                 # trimmed mean abs difference, 8-bit units
    baseline_score: float        # score of the input line
    pixel_count: int


def _candidate_line(base: SymLine, d_angle: float, d_offset: float) -> SymLine:
    angle = base.angle + d_angle
    anchor = base.p1 + base.normal * d_offset
    u = np.array([cos(angle), sin(angle)], np.float64)
    half = base.length / 2.0
    return SymLine.from_points(
        (anchor[0] - u[0] * half, anchor[1] - u[1] * half),
        (anchor[0] + u[0] * half, anchor[1] + u[1] * half),
    )


def _score(
    image: np.ndarray, roi: tuple[int, int, int, int], line: SymLine, trim: float
) -> tuple[float, int]:
    """Symmetric mismatch score.

    Every reflected pixel pair inside the ROI contributes once, with both
    interpolation directions averaged — otherwise an oblique axis makes one
    sampling direction systematically smoother and biases the minimum toward
    a wrong angle/offset.
    """
    x0, y0, x1, y1 = roi
    if x1 <= x0 or y1 <= y0:
        return np.inf, 0
    work = image if image.ndim == 3 else image[:, :, None]
    h, w = work.shape[:2]

    gx, gy = np.meshgrid(
        np.arange(x0, x1, dtype=np.float64), np.arange(y0, y1, dtype=np.float64)
    )
    pts = np.stack([gx.ravel(), gy.ravel()], axis=1)
    r, t = reflection_rt(line)
    ref = pts @ r.T + t

    inside = (
        (ref[:, 0] >= x0) & (ref[:, 0] < x1) &
        (ref[:, 1] >= y0) & (ref[:, 1] < y1)
    )
    if inside.sum() < 128:
        return np.inf, int(inside.sum())

    map_x = ref[:, 0].reshape(gy.shape).astype(np.float32)
    map_y = ref[:, 1].reshape(gy.shape).astype(np.float32)
    local = work[y0:y1, x0:x1].astype(np.float32)
    sampled = cv2.remap(
        work, map_x, map_y, cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT, borderValue=0,
    ).astype(np.float32)

    # reverse direction: value at the reflected point looking back
    back = cv2.remap(
        local, map_x - x0, map_y - y0, cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT, borderValue=0,
    ).astype(np.float32)

    pair_fwd = np.abs(sampled - local).mean(axis=2)
    pair_rev = np.abs(back - sampled).mean(axis=2)
    diff = (0.5 * (pair_fwd + pair_rev)).ravel()
    valid = inside.ravel()
    d = diff[valid]
    cut = np.quantile(d, 1.0 - trim)
    return float(d[d <= cut].mean()), int(valid.sum())


def suggest_line(
    image: np.ndarray,
    roi: tuple[int, int, int, int],
    base: SymLine,
    angle_range_deg: float = 2.0,
    angle_step_deg: float = 0.1,
    offset_range_px: float = 4.0,
    offset_step_px: float = 0.5,
    trim: float = 0.2,
) -> Suggestion:
    """Coarse grid search followed by a half-step local refinement."""
    base_score, n = _score(image, roi, base, trim)
    if not np.isfinite(base_score):
        raise ValueError("参考区域内有效像素不足, 请把框画在轴线两侧都完整的位置")

    best_line, best_score = base, base_score
    best_da = best_do = 0.0

    def search(da_span: float, da_step: float, do_span: float, do_step: float):
        """All angle arguments are in degrees."""
        nonlocal best_line, best_score, best_da, best_do
        angles = np.arange(-da_span, da_span + 1e-9, da_step)
        offsets = np.arange(-do_span, do_span + 1e-9, do_step)
        for da in angles:
            for do in offsets:
                cand = _candidate_line(base, float(np.radians(da)), float(do))
                s, _ = _score(image, roi, cand, trim)
                if s < best_score - 1e-6:
                    best_score, best_line = s, cand
                    best_da, best_do = float(da), float(do)

    search(angle_range_deg, angle_step_deg, offset_range_px, offset_step_px)
    # local refinement at half resolution around the current best
    search(angle_step_deg, angle_step_deg / 2,
           offset_step_px, offset_step_px / 2)

    # report the actual geometric change from the input line
    delta_angle = best_line.angle - base.angle
    base_mid = (base.p1 + base.p2) / 2.0
    best_mid = (best_line.p1 + best_line.p2) / 2.0
    delta_offset = float(np.dot(best_mid - base_mid, base.normal))

    return Suggestion(
        line=best_line,
        angle_delta_deg=float(np.degrees(delta_angle)),
        offset_delta_px=delta_offset,
        score=best_score,
        baseline_score=base_score,
        pixel_count=n,
    )
