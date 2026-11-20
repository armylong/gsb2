"""Tests for the gain solver, limiter reporting and render verification."""

from __future__ import annotations

import numpy as np
import pytest

from audio_matcher.levels import Interval, measure_selection
from audio_matcher.matching import (
    MATCH_TOLERANCE_DB,
    PEAK_MODE_HEADROOM,
    PEAK_MODE_LIMITER,
    peak_allowance,
    reachable_target,
    render_samples,
    solve_gain,
    suggested_target,
    verify_render,
)

RATE = 48000


def test_unlimited_gain_matches_target() -> None:
    plan = solve_gain(-30.0, -20.0, -20.0, None)
    assert plan is not None
    assert plan.applied_gain_db == pytest.approx(10.0)
    assert not plan.limited
    assert plan.predicted_rms_db == pytest.approx(-20.0)


def test_headroom_lowers_gain_and_reports_shortfall() -> None:
    # Needs +14 dB, but a -0.5 dBFS peak under a -1 dBFS ceiling allows -0.5.
    plan = solve_gain(-30.0, -0.5, -16.0, -1.0, mode=PEAK_MODE_HEADROOM)
    assert plan is not None
    assert plan.applied_gain_db == pytest.approx(-0.5)
    assert plan.limited
    assert plan.shortfall_db == pytest.approx(14.5)
    assert not plan.reaches_target
    assert plan.predicted_peak_db == pytest.approx(-1.0, abs=1e-6)


def test_hard_full_scale_applies_without_user_ceiling() -> None:
    plan = solve_gain(-20.0, -0.5, -6.0, None, mode=PEAK_MODE_HEADROOM)
    assert plan is not None
    assert plan.applied_gain_db < 1.0
    assert plan.limited


def test_limiter_mode_keeps_target_and_flags_peak_work() -> None:
    plan = solve_gain(-30.0, -0.5, -16.0, -1.0, mode=PEAK_MODE_LIMITER)
    assert plan is not None
    assert plan.applied_gain_db == pytest.approx(14.0)
    assert plan.shortfall_db == 0.0
    assert plan.reaches_target
    # "limited" here means the limiter will have work to do.
    assert plan.limited


def test_no_measurement_or_target_returns_none() -> None:
    assert solve_gain(None, -3.0, -20.0, None) is None
    assert solve_gain(-20.0, -3.0, None, None) is None


def test_suggested_target_is_lowest_reachable() -> None:
    limited = solve_gain(-30.0, -0.5, -16.0, -1.0, mode=PEAK_MODE_HEADROOM)
    fine = solve_gain(-20.0, -10.0, -16.0, -1.0, mode=PEAK_MODE_HEADROOM)
    assert limited is not None and fine is not None
    suggestion = suggested_target({"a": limited, "b": fine}, -16.0)
    assert suggestion == pytest.approx(reachable_target(limited.match_gain_db, limited.applied_gain_db, -16.0))
    assert suggestion == pytest.approx(-16.0 - limited.shortfall_db)
    assert suggested_target({"b": fine}, -16.0) is None


def test_peak_allowance_never_exceeds_full_scale() -> None:
    assert peak_allowance(-6.0, None) == pytest.approx(5.99)
    assert peak_allowance(-6.0, -3.0) == pytest.approx(3.0)


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------


def _quiet_with_clap() -> np.ndarray:
    data = np.random.default_rng(1).normal(scale=10 ** (-40 / 20), size=RATE)
    data[int(0.4 * RATE) : int(0.4 * RATE) + 200] = 0.95
    return data


def test_limiter_reports_time_ranges_it_changed() -> None:
    data = _quiet_with_clap()
    rendered = render_samples(data, RATE, 20.0, -1.0, mode=PEAK_MODE_LIMITER)
    assert rendered.limited_runs
    start, end = rendered.limited_runs[0].start_s, rendered.limited_runs[0].end_s
    assert start == pytest.approx(0.4, abs=0.002)
    assert 0.0 < end - start < 0.02
    assert rendered.peak_after_db == pytest.approx(-1.0, abs=0.01)


def test_headroom_render_does_not_report_changes() -> None:
    data = _quiet_with_clap()
    plan = solve_gain(-40.0, -0.45, -20.0, -1.0, mode=PEAK_MODE_HEADROOM)
    assert plan is not None
    rendered = render_samples(data, RATE, plan.applied_gain_db, -1.0, mode=PEAK_MODE_HEADROOM)
    assert rendered.limited_runs == ()
    assert rendered.peak_after_db is not None and rendered.peak_after_db <= -0.9


def test_verify_render_measures_written_samples() -> None:
    data = _quiet_with_clap()
    rendered = render_samples(data, RATE, 0.0, None, mode=PEAK_MODE_HEADROOM)
    intervals = [Interval(0, data.size)]
    check = verify_render(
        rendered.samples,
        RATE,
        intervals,
        [],
        target_rms_db=None,
    )
    direct = measure_selection(rendered.samples, RATE, intervals)
    assert check.measured_rms_db == pytest.approx(direct.rms_db)


def test_verify_render_flags_target_deviation() -> None:
    data = np.random.default_rng(2).normal(scale=0.1, size=RATE)
    check = verify_render(data, RATE, [Interval(0, data.size)], [], target_rms_db=-6.0)
    assert check.deviation_db is not None
    assert check.deviates_from_target
    assert abs(check.deviation_db) > MATCH_TOLERANCE_DB
