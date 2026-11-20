"""Per-frame quality metrics against the clean reference, with caching.

Metrics are computed at the preview scale so the charts can be refreshed while
the user drags the radius slider.  ``raw`` is the unprocessed frame, ``mean``
and ``atten`` are the two filters; the split between static background and
moving subject is what makes the trade-off legible: both filters clean static
grain, only ``atten`` keeps the moving subject intact.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

import analysis


@dataclass
class FrameMetrics:
    frame: int
    window: list[int]
    degraded: bool
    # RMSE against the clean reference
    raw_static: float = 0.0
    mean_static: float = 0.0
    atten_static: float = 0.0
    raw_moving: float = 0.0
    mean_moving: float = 0.0
    atten_moving: float = 0.0


@dataclass
class ClipMetrics:
    params: analysis.Params
    frames: list[FrameMetrics] = field(default_factory=list)
    shots: list[analysis.Shot] = field(default_factory=list)
    cuts: list[int] = field(default_factory=list)

    def at(self, frame: int) -> FrameMetrics | None:
        if 0 <= frame < len(self.frames):
            return self.frames[frame]
        return None

    def mean_of(self, attr: str) -> float:
        vals = [getattr(m, attr) for m in self.frames]
        return float(np.mean(vals)) if vals else 0.0

    def series(self, attr: str) -> np.ndarray:
        return np.array([getattr(m, attr) for m in self.frames], dtype=np.float32)

    def smooth(self, attr: str, half: int = 2) -> np.ndarray:
        """Moving average of a metric, computed inside each shot only.

        Per-frame RMSE on grain is naturally jittery; the average makes the
        level of each branch readable.  The split at cuts keeps a cut from
        bleeding into either side.  Exact per-frame numbers stay available in
        the hover readout and in the verification table.
        """
        vals = self.series(attr)
        out = np.empty_like(vals)
        for shot in self.shots:
            lo, hi = shot.start, shot.end + 1
            for i in range(lo, hi):
                a, b = max(lo, i - half), min(hi, i + half + 1)
                out[i] = float(vals[a:b].mean())
        return out


class MetricsCache:
    """Computes :class:`ClipMetrics` once per (radius, threshold)."""

    def __init__(self, bundle: dict, cuts: list[int] | None = None):
        self.bundle = bundle
        self.original = bundle["original"]
        self.clean = bundle["clean"]
        self.mask = bundle.get("mask")
        frames = [self.original.read(i) for i in range(len(self.original))]
        self.cuts = cuts if cuts is not None else analysis.detect_cuts(frames)
        self.shots = analysis.build_shots(self.cuts, len(self.original))
        self._cache: dict[tuple[int, float], ClipMetrics] = {}

    def get(self, params: analysis.Params, progress=None) -> ClipMetrics:
        key = (int(params.radius), float(params.motion_threshold))
        if key in self._cache:
            return self._cache[key]
        out = ClipMetrics(params=params, shots=self.shots, cuts=self.cuts)
        total = len(self.original)
        # Pass-through frames (window too short) have identical raw/mean/atten
        # numbers by definition; pretending otherwise in the chart would imply
        # a filter ran when it did not.
        for i in range(total):
            result = analysis.analyze(self.original, i, self.shots, params)
            gt = self.clean.read(i)
            mask_frame = self.mask.read(i) if self.mask is not None else None
            static, moving = analysis.region_masks(
                mask_frame, self.original.shape()[:2], result.motion_mask)
            raw = self.original.read(i)
            m = FrameMetrics(i, result.window.frames, result.window.degraded)
            if result.window.degraded:
                m.mean_static = m.raw_static = analysis.rmse(raw, gt, static)
                m.atten_static = m.raw_static
                m.mean_moving = m.raw_moving = analysis.rmse(raw, gt, moving)
                m.atten_moving = m.raw_moving
            else:
                m.raw_static = analysis.rmse(raw, gt, static)
                m.mean_static = analysis.rmse(result.mean, gt, static)
                m.atten_static = analysis.rmse(result.atten, gt, static)
                m.raw_moving = analysis.rmse(raw, gt, moving)
                m.mean_moving = analysis.rmse(result.mean, gt, moving)
                m.atten_moving = analysis.rmse(result.atten, gt, moving)
            out.frames.append(m)
            if progress and i % 10 == 0:
                progress(i / total)
        if progress:
            progress(1.0)
        self._cache[key] = out
        return out
