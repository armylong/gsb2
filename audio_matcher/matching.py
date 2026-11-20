"""Per-clip gain solver, renderer, and output verification.

The level model is deliberately small and inspectable:

``match_gain_db = target_active_rms_db - clip_active_rms_db``

Two peak strategies are supported, because they answer different questions:

``headroom`` (default)
    The clip's whole gain is lowered so its peak stays under the ceiling.
    If that prevents reaching the target, the shortfall is reported with its
    exact dB delta and the app offers a lower common target.

``limiter``
    The level target is reached, and only the loud samples are pulled down.
    Every contiguous range where that happens is returned, and the rendered
    file is re-measured so the app can say whether it still hits the target.

Nothing in this module predicts the final loudness: :func:`verify_render`
measures the samples actually written to disk with the same selection logic
used for the source.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from .levels import FULL_SCALE_MARGIN_DB, Interval, measure_selection

# A disagreement under this is below the report resolution and inaudible.
MATCH_TOLERANCE_DB = 0.15
# Never attenuate a clip further than this even if the numbers ask for it.
MIN_GAIN_DB = -60.0

PEAK_MODE_HEADROOM = "headroom"
PEAK_MODE_LIMITER = "limiter"
PEAK_MODES = (PEAK_MODE_HEADROOM, PEAK_MODE_LIMITER)


@dataclass(frozen=True)
class GainPlan:
    """One clip's evaluated gain, with the reason for the final number."""

    mode: str
    match_gain_db: float
    applied_gain_db: float
    predicted_rms_db: float | None
    predicted_peak_db: float | None
    limited: bool
    shortfall_db: float
    headroom_db: float | None

    @property
    def reaches_target(self) -> bool:
        return self.shortfall_db <= MATCH_TOLERANCE_DB

    @property
    def missing_db(self) -> float:
        return max(0.0, self.shortfall_db)

    @property
    def applied_linear(self) -> float:
        return 10.0 ** (self.applied_gain_db / 20.0)

    def to_dict(self) -> dict:
        return {
            "mode": self.mode,
            "match_gain_db": _round(self.match_gain_db),
            "applied_gain_db": _round(self.applied_gain_db),
            "predicted_rms_db": _round(self.predicted_rms_db),
            "predicted_peak_db": _round(self.predicted_peak_db),
            "limited": self.limited,
            "shortfall_db": _round(self.shortfall_db),
            "headroom_db": _round(self.headroom_db),
        }


def _round(value: float | None) -> float | None:
    if value is None:
        return None
    return round(float(value), 3)


def peak_allowance(
    measured_peak_db: float | None, ceiling_db: float | None
) -> float | None:
    """Largest gain the clip's own peak permits; ``None`` means unlimited.

    Even with no user ceiling, raising a clip whose peak is already at full
    scale would clip, so the digital limit still applies.  This is the
    "headroom" strategy's ceiling; the limiter strategy uses the ceiling at
    render time instead.
    """
    if measured_peak_db is None:
        return None
    hard_ceiling = 0.0 - FULL_SCALE_MARGIN_DB
    ceiling = hard_ceiling if ceiling_db is None else min(ceiling_db, hard_ceiling)
    return ceiling - measured_peak_db


def solve_gain(
    measured_rms_db: float | None,
    measured_peak_db: float | None,
    target_rms_db: float | None,
    ceiling_db: float | None,
    mode: str = PEAK_MODE_HEADROOM,
) -> GainPlan | None:
    """Compute one clip's gain.

    Returns ``None`` when the clip has no usable speech level or target, which
    is how the UI separates "not measurable" from "measured, gain 0 dB".
    """
    if measured_rms_db is None or target_rms_db is None:
        return None
    if mode not in PEAK_MODES:
        raise ValueError(f"unknown peak mode: {mode!r}")
    match_gain = float(target_rms_db - measured_rms_db)
    if mode == PEAK_MODE_HEADROOM:
        allowance = peak_allowance(measured_peak_db, ceiling_db)
        applied = match_gain if allowance is None else min(match_gain, allowance)
        applied = max(applied, MIN_GAIN_DB)
        shortfall = max(0.0, match_gain - applied)
        limited = allowance is not None and allowance < match_gain - 1e-9
        headroom = allowance
    else:
        # The limiter handles peaks at render time; the whole-clip gain is not
        # capped.  ``limited`` here means "the limiter will have work to do".
        applied = max(match_gain, MIN_GAIN_DB)
        shortfall = 0.0
        allowance = peak_allowance(measured_peak_db, ceiling_db)
        limited = allowance is not None and allowance < match_gain - 1e-9
        headroom = allowance
    predicted_rms = measured_rms_db + applied
    predicted_peak = None if measured_peak_db is None else measured_peak_db + applied
    return GainPlan(
        mode=mode,
        match_gain_db=match_gain,
        applied_gain_db=applied,
        predicted_rms_db=predicted_rms,
        predicted_peak_db=predicted_peak,
        limited=limited,
        shortfall_db=shortfall,
        headroom_db=headroom,
    )


def reachable_target(
    match_gain_db: float, applied_gain_db: float, current_target_db: float
) -> float:
    """Highest target a headroom-limited clip can reach under its ceiling."""
    return current_target_db - max(0.0, match_gain_db - applied_gain_db)


def suggested_target(
    plans: dict[str, GainPlan | None], current_target_db: float | None
) -> float | None:
    """Lowest common target that every capped clip can actually reach.

    ``None`` when no headroom-limited clip exists, i.e. the target is fine.
    Limiter-mode clips are excluded: they reach the target and the limiter
    reports its changes separately.
    """
    if current_target_db is None:
        return None
    capped = [
        plan
        for plan in plans.values()
        if plan is not None and plan.limited and plan.mode == PEAK_MODE_HEADROOM
    ]
    if not capped:
        return None
    return min(
        reachable_target(plan.match_gain_db, plan.applied_gain_db, current_target_db)
        for plan in capped
    )


def db_to_linear(db: float) -> float:
    return 10.0 ** (db / 20.0)


def linear_to_db(value: float) -> float | None:
    if value <= 0:
        return None
    return 20.0 * math.log10(value)


# ---------------------------------------------------------------------------
# Render
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class LimitedRun:
    """A contiguous range (seconds) where the peak limiter altered samples."""

    start_s: float
    end_s: float
    peak_db: float
    reduction_db: float
    samples_changed: int

    def to_dict(self) -> dict:
        return {
            "start_s": round(self.start_s, 4),
            "end_s": round(self.end_s, 4),
            "peak_db": round(self.peak_db, 2),
            "reduction_db": round(self.reduction_db, 2),
            "samples_changed": self.samples_changed,
        }


@dataclass(frozen=True)
class RenderResult:
    """What was written, and what a fresh measurement of it says."""

    gain_db: float
    mode: str
    peak_before_limit_db: float | None
    peak_after_db: float | None
    limited_runs: tuple[LimitedRun, ...]
    measured_rms_db: float | None = None
    measured_peak_db: float | None = None
    target_rms_db: float | None = None
    deviation_db: float | None = None
    deviates_from_target: bool = False

    @property
    def limit_changed_anything(self) -> bool:
        return bool(self.limited_runs)

    def to_dict(self) -> dict:
        return {
            "gain_db": round(self.gain_db, 3),
            "mode": self.mode,
            "peak_before_limit_db": _round(self.peak_before_limit_db),
            "peak_after_db": _round(self.peak_after_db),
            "limited_runs": [run.to_dict() for run in self.limited_runs],
            "measured_rms_db": _round(self.measured_rms_db),
            "measured_peak_db": _round(self.measured_peak_db),
            "target_rms_db": _round(self.target_rms_db),
            "deviation_db": _round(self.deviation_db),
            "deviates_from_target": self.deviates_from_target,
        }


@dataclass(frozen=True)
class RenderedSamples:
    samples: object  # numpy.ndarray, typed loosely to keep import-time light
    peak_before_limit_db: float | None
    peak_after_db: float | None
    limited_runs: tuple[LimitedRun, ...]


def render_samples(
    mono_samples,
    sample_rate: int,
    gain_db: float,
    ceiling_db: float | None,
    mode: str = PEAK_MODE_HEADROOM,
) -> RenderedSamples:
    """Apply gain and, in limiter mode, a sample-wise peak ceiling.

    The limiter is a safety ceiling with no attack time: any sample over the
    ceiling is scaled to it.  That is intentionally blunt, but it is fully
    visible: every contiguous run where it engages becomes a reported time
    range, so the user can move the ceiling, change the target, or accept it.
    ``headroom`` mode should never need the limiter, and if rounding puts a
    sample a hair over, it is clamped without being reported as a run.
    """
    import numpy as np

    if mode not in PEAK_MODES:
        raise ValueError(f"unknown peak mode: {mode!r}")
    data = np.asarray(mono_samples, dtype=np.float64)
    gained = data * db_to_linear(gain_db)
    hard_ceiling = 0.0 - FULL_SCALE_MARGIN_DB
    ceiling = hard_ceiling if ceiling_db is None else min(ceiling_db, hard_ceiling)
    ceiling_linear = db_to_linear(ceiling)
    before_peak = float(np.max(np.abs(gained))) if gained.size else 0.0

    runs: list[LimitedRun] = []
    if mode == PEAK_MODE_LIMITER and gained.size:
        over = np.abs(gained) > ceiling_linear + 1e-12
        if np.any(over):
            # Group over-limit samples; a gap shorter than 10 ms is part of the
            # same event so one hand clap is one range, not hundreds.
            indices = np.flatnonzero(over)
            splits = (
                np.flatnonzero(np.diff(indices) > max(1, int(sample_rate * 0.010)))
                + 1
            )
            for group in np.split(indices, splits):
                if group.size == 0:
                    continue
                segment = gained[group[0] : group[-1] + 1]
                segment_peak = float(np.max(np.abs(segment)))
                if segment_peak <= 0:
                    continue
                runs.append(
                    LimitedRun(
                        start_s=group[0] / float(sample_rate),
                        end_s=(group[-1] + 1) / float(sample_rate),
                        peak_db=20.0 * math.log10(segment_peak),
                        reduction_db=20.0 * math.log10(ceiling_linear / segment_peak),
                        samples_changed=int(group.size),
                    )
                )
    # In headroom mode the gain solver already fits the peak under the
    # ceiling; clipping here only absorbs float rounding or a stale plan.
    clipped = np.clip(gained, -ceiling_linear, ceiling_linear)
    after_peak = float(np.max(np.abs(clipped))) if clipped.size else 0.0
    return RenderedSamples(
        samples=clipped,
        peak_before_limit_db=20.0 * math.log10(before_peak) if before_peak > 0 else None,
        peak_after_db=20.0 * math.log10(after_peak) if after_peak > 0 else None,
        limited_runs=tuple(runs),
    )


def verify_render(
    rendered_samples,
    sample_rate: int,
    speech_intervals: list[Interval],
    exclude_intervals: list[Interval] | None,
    target_rms_db: float | None,
) -> RenderResult:
    """Measure the written samples with the same selection as the source.

    This is the honest half of the workflow: the number reported for the
    deliverable comes from the deliverable, not from gain arithmetic.
    """
    measurement = measure_selection(
        rendered_samples,
        sample_rate,
        speech_intervals,
        exclude_intervals,
    )
    deviation = None
    if measurement.rms_db is not None and target_rms_db is not None:
        deviation = measurement.rms_db - target_rms_db
    deviates = deviation is not None and abs(deviation) > MATCH_TOLERANCE_DB
    return RenderResult(
        gain_db=0.0,
        mode=PEAK_MODE_HEADROOM,
        peak_before_limit_db=measurement.clip_peak_db,
        peak_after_db=measurement.clip_peak_db,
        limited_runs=(),
        measured_rms_db=measurement.rms_db,
        measured_peak_db=measurement.clip_peak_db,
        target_rms_db=target_rms_db,
        deviation_db=deviation,
        deviates_from_target=bool(deviates),
    )
