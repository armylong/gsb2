"""Tests for repair behaviour: continuity, honesty about long gaps, isolation."""

from __future__ import annotations

import numpy as np

from clipmend import analysis as an


def _sine(n=4000, sr=44100, freq=220.0, amp=0.6):
    t = np.arange(n) / sr
    return amp * np.sin(2 * np.pi * freq * t)


def test_short_gap_joins_both_ends():
    x = _sine()
    original = x.copy()
    x[2000:2012] = 1.0  # flat clipped run, 12 samples
    sig = np.stack([x, x.copy()], axis=1)
    mask = np.zeros(sig.shape[0], bool)
    mask[2000:2012] = True
    result = an.repair_region(
        sig, 44100, 0, 2000, 2012, 1, mask, method="hermite"
    )
    assert result.values.size == 12
    # The bridge must start and end close to the clean neighbours.
    assert abs(result.values[0] - sig[1999, 0]) < 0.05
    assert abs(result.values[-1] - sig[2012, 0]) < 0.05
    # And it must not introduce a discontinuity jump far from the signal.
    assert np.max(np.abs(result.values)) < 1.5 * np.max(np.abs(original))
    assert result.confidence == an.CONFIDENCE_HIGH


def test_repair_never_touches_outside_region():
    x = _sine()
    x[2000:2012] = 1.0
    sig = np.stack([x, x.copy()], axis=1)
    mask = np.zeros(sig.shape[0], bool)
    mask[2000:2012] = True
    result = an.repair_region(sig, 44100, 0, 2000, 2012, 1, mask)
    rec = an.RepairRecord(
        channel=0,
        start=2000,
        end=2012,
        polarity=1,
        method=result.method,
        confidence=result.confidence,
        flags=result.flags,
        values=result.values,
        changed_runs=[(2000, 2012)],
        changed_count=12,
        max_delta=1.0,
    )
    out = an.apply_repairs(sig, [rec])
    diff = np.abs(out - sig).sum(axis=1)
    assert diff[2000:2012].all()
    assert not diff[:2000].any()
    assert not diff[2012:].any()
    # The untouched channel is bit-identical.
    assert np.array_equal(out[:, 1], sig[:, 1])


def test_long_gap_is_low_confidence_and_marked():
    sr = 44100
    x = _sine(n=20000, sr=sr)
    x[5000:9000] = 1.0  # 4000 samples, ~90 ms
    sig = np.stack([x, x.copy()], axis=1)
    mask = np.zeros(sig.shape[0], bool)
    mask[5000:9000] = True
    result = an.repair_region(sig, sr, 0, 5000, 9000, 1, mask, method="auto")
    assert result.confidence == an.CONFIDENCE_LOW
    assert any("长段缺失" in f for f in result.flags)
    # It must not overshoot wildly: a long gap is a connection, not a restore.
    assert np.max(np.abs(result.values)) <= 1.5
    assert result.mode in ("line", "blend")


def test_auto_mode_uses_line_for_multi_period_gap():
    sr = 44100
    x = _sine(n=20000, sr=sr, freq=100.0)  # period 441
    x[5000:7000] = 1.0  # ~4.5 periods
    sig = np.stack([x, x.copy()], axis=1)
    mask = np.zeros(sig.shape[0], bool)
    mask[5000:7000] = True
    result = an.repair_region(sig, sr, 0, 5000, 7000, 1, mask, method="auto")
    assert result.confidence == an.CONFIDENCE_LOW
    assert result.mode == "line"
    assert result.method == "line"
    assert result.ratio is not None and result.ratio > 2.0


def test_records_only_cover_changed_samples():
    x = _sine()
    x[2000:2012] = 1.0
    sig = np.stack([x, x.copy()], axis=1)
    mask = np.zeros(sig.shape[0], bool)
    mask[2000:2012] = True
    seg = an.Segment(channel=0, polarity=1, start=2000, end=2012, uid=7)
    rec = an.make_repair_record(sig, 44100, seg, mask)
    assert rec.changed_count == 12
    assert rec.changed_runs == [(2000, 2012)]
    assert rec.max_delta > 0.0


def test_identical_region_produces_no_changed_runs():
    x = _sine()
    sig = np.stack([x, x.copy()], axis=1)
    mask = np.zeros(sig.shape[0], bool)
    mask[1000:1010] = True
    seg = an.Segment(channel=0, polarity=1, start=1000, end=1010, uid=1)
    # Context is continuous with the region, so a bridge can coincide; just
    # require that reported runs match the real differences.
    rec = an.make_repair_record(sig, 44100, seg, mask)
    real = np.flatnonzero(sig[1000:1010, 0] != rec.values)
    assert rec.changed_count == real.size


def test_repair_does_not_modify_other_channel_when_applied():
    x = _sine()
    right = _sine(freq=330.0)
    x[2000:2012] = 1.0
    sig = np.stack([x, right], axis=1)
    mask = np.zeros(sig.shape[0], bool)
    mask[2000:2012] = True
    seg = an.Segment(channel=0, polarity=1, start=2000, end=2012, uid=1)
    rec = an.make_repair_record(sig, 44100, seg, mask)
    out = an.apply_repairs(sig, [rec])
    assert np.array_equal(out[:, 1], right)


def test_clip_running_to_file_end_uses_one_sided_extrapolation():
    x = _sine(n=2000)
    x[1950:] = 1.0
    sig = np.stack([x, x.copy()], axis=1)
    mask = np.zeros(sig.shape[0], bool)
    mask[1950:] = True
    result = an.repair_region(sig, 44100, 0, 1950, 2000, 1, mask)
    assert any("右侧无上下文" in f for f in result.flags)
    assert result.confidence == an.CONFIDENCE_LOW


def test_confidence_labels_cover_all_levels():
    assert set(an.CONFIDENCE_LABELS) == {
        an.CONFIDENCE_HIGH,
        an.CONFIDENCE_MEDIUM,
        an.CONFIDENCE_LOW,
    }
