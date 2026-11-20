"""Tests for the measurement and overlap arithmetic (no Qt, no GUI)."""

from __future__ import annotations

import math

import numpy as np
import pytest

from audio_matcher.levels import (
    Interval,
    Region,
    active_mask,
    clip_intervals,
    merge_intervals,
    measure_selection,
    normalize_intervals,
    subtract_intervals,
)

RATE = 48000


def _speech(seconds: float, level_dbfs: float = -20.0, rate: int = RATE) -> np.ndarray:
    """Deterministic noise-ish speech: RMS at the requested level."""
    count = int(round(seconds * rate))
    t = np.arange(count, dtype=np.float64) / rate
    signal = np.sin(2 * math.pi * 180 * t) * (0.6 + 0.4 * np.sin(2 * math.pi * 3 * t))
    rms = float(np.sqrt(np.mean(signal**2)))
    return signal * (10 ** (level_dbfs / 20) / rms)


def _build(spec: list[tuple[float, float, float]], total: float = 6.0) -> np.ndarray:
    """Build a clip from (start_s, end_s, level_dbfs) speech blocks."""
    data = np.random.default_rng(3).normal(scale=1e-4, size=int(total * RATE))
    for start_s, end_s, level in spec:
        start = int(start_s * RATE)
        end = int(end_s * RATE)
        data[start:end] += _speech((end - start) / RATE, level, RATE)
    return data


# ---------------------------------------------------------------------------
# Interval arithmetic
# ---------------------------------------------------------------------------


def test_overlapping_speech_unions_once() -> None:
    merged = merge_intervals([Interval(0, 100), Interval(50, 150), Interval(400, 500)])
    assert merged == [Interval(0, 150), Interval(400, 500)]
    assert sum(item.length for item in merged) == 250


def test_touching_intervals_merge() -> None:
    assert merge_intervals([Interval(0, 10), Interval(10, 20)]) == [Interval(0, 20)]


def test_subtract_uses_actual_coverage() -> None:
    kept = subtract_intervals(
        [Interval(0, 100), Interval(50, 150)],  # union: 0..150
        [Interval(80, 90), Interval(140, 200)],  # union: 80..90, 140..200
    )
    assert kept == [Interval(0, 80), Interval(90, 140)]
    assert sum(item.length for item in kept) == 130


def test_subtract_whole_region() -> None:
    assert subtract_intervals([Interval(10, 20)], [Interval(0, 100)]) == []


def test_normalize_drops_empty_and_sorts() -> None:
    assert normalize_intervals([[5, 5], [30, 10], [0, 3]]) == [
        Interval(0, 3),
        Interval(10, 30),
    ]


def test_clip_intervals_bounds() -> None:
    assert clip_intervals([Interval(-10, 10), Interval(90, 200)], 100) == [
        Interval(0, 10),
        Interval(90, 100),
    ]


# ---------------------------------------------------------------------------
# Measurement
# ---------------------------------------------------------------------------


def test_active_mask_ignores_pauses() -> None:
    levels = np.array([-20.0, -21.0, -70.0, -90.0])
    mask = active_mask(levels)
    assert mask.tolist() == [True, True, False, False]


def test_measure_selection_overlap_no_double_count() -> None:
    data = _build([(1.0, 3.0, -20.0), (4.0, 5.0, -20.0)])
    single = measure_selection(data, RATE, [Interval(RATE, 3 * RATE)])
    overlapped = measure_selection(
        data,
        RATE,
        [Interval(RATE, 3 * RATE), Interval(2 * RATE, 3 * RATE)],
    )
    assert overlapped.total_duration_s == pytest.approx(single.total_duration_s, abs=1e-6)
    assert overlapped.rms_db == pytest.approx(single.rms_db, abs=1e-6)
    assert len(overlapped.fragments) == 1


def test_measure_selection_exclusion_removes_coverage() -> None:
    data = _build([(1.0, 3.0, -20.0)])
    cut = measure_selection(
        data,
        RATE,
        [Interval(RATE, 3 * RATE)],
        [Interval(int(1.5 * RATE), int(2.5 * RATE))],
    )
    assert cut.total_duration_s == pytest.approx(1.0, abs=1e-6)
    assert len(cut.fragments) == 2
    assert sum(item.share_of_selection for item in cut.fragments) == pytest.approx(1.0)


def test_measure_selection_level_uses_shared_gate() -> None:
    data = _build([(0.5, 1.5, -20.0), (3.0, 4.0, -70.0)])
    measurement = measure_selection(
        data,
        RATE,
        [Interval(int(0.5 * RATE), int(1.5 * RATE)), Interval(3 * RATE, 4 * RATE)],
    )
    # A quiet fragment far below the loudest one is pause for the gate.
    assert measurement.rms_db == pytest.approx(-20.0, abs=1.5)


def test_empty_selection_flags() -> None:
    data = _build([(1.0, 2.0, -20.0)])
    empty = measure_selection(data, RATE, [])
    assert "no_speech_selection" in empty.warning_codes
    excluded = measure_selection(
        data, RATE, [Interval(RATE, 2 * RATE)], [Interval(0, data.size)]
    )
    assert "all_excluded" in excluded.warning_codes
    assert excluded.effective_intervals == []


def test_too_short_and_silent_flags() -> None:
    silent = np.zeros(int(1.0 * RATE))
    measurement = measure_selection(silent, RATE, [Interval(0, int(0.05 * RATE))])
    assert "too_short" in measurement.warning_codes
    assert "silent" in measurement.warning_codes
    assert measurement.rms_db is None
    assert measurement.silent


def test_provenance_reports_effective_fragments() -> None:
    data = _build([(1.0, 2.0, -20.0), (3.0, 4.0, -20.0)])
    measurement = measure_selection(
        data,
        RATE,
        [Interval(RATE, 2 * RATE), Interval(3 * RATE, 4 * RATE)],
    )
    assert len(measurement.provenance) == 2
    assert measurement.provenance[0]["start_s"] == pytest.approx(1.0, abs=1e-6)
    assert measurement.provenance[1]["end_s"] == pytest.approx(4.0, abs=1e-6)


def test_region_roundtrip() -> None:
    region = Region("exclude", 10, 20)
    assert Region.from_dict(region.to_dict()) == region
