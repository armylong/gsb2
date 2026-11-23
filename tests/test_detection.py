"""Tests for detection, thresholds, pinning and square-wave hints."""

from __future__ import annotations

import numpy as np

from clipmend import analysis as an
from clipmend.samples import ensure_samples
from clipmend.wavio import load_wav


def test_detects_both_polarities_separately():
    sr = 44100
    x = np.zeros((2000, 2))
    x[100:140, 0] = 1.0
    x[500:530, 0] = -1.0
    x[800:820, 1] = 0.999
    segs = an.detect_segments(x, sr, an.DetectionConfig())
    pos = [s for s in segs if s.polarity > 0 and s.channel == 0]
    neg = [s for s in segs if s.polarity < 0 and s.channel == 0]
    assert len(pos) == 1 and (pos[0].start, pos[0].end) == (100, 140)
    assert len(neg) == 1 and (neg[0].start, neg[0].end) == (500, 530)
    assert any(s.channel == 1 and s.polarity > 0 for s in segs)


def test_short_plateau_below_min_run_is_ignored():
    x = np.zeros((100, 1))
    x[10:11, 0] = 1.0  # one sample only
    segs = an.detect_segments(x, 44100, an.DetectionConfig(min_run=2))
    assert segs == []


def test_threshold_change_does_not_drop_confirmed_segment():
    sr = 44100
    x = np.zeros((4000, 1))
    x[1000:1030, 0] = 0.95  # clipped plateau below full scale
    cfg = an.DetectionConfig(pos_dbfs=-3.0, neg_dbfs=-3.0)
    first = an.detect_segments(x, sr, cfg)
    assert len(first) == 1
    first[0].status = an.STATUS_CONFIRMED

    # Raise the threshold so this plateau would no longer be detected.
    strict = an.DetectionConfig(pos_dbfs=-0.05, neg_dbfs=-0.05)
    second = an.detect_segments(x, sr, strict, first)
    assert len(second) == 1
    assert second[0].status == an.STATUS_CONFIRMED
    assert (second[0].start, second[0].end) == (1000, 1030)
    assert "已保留确认" in second[0].hint


def test_threshold_change_does_not_drop_excluded_segment():
    x = np.zeros((4000, 1))
    x[200:260, 0] = 0.90  # detected at -3 dBFS, not at -0.5 dBFS
    cfg = an.DetectionConfig(pos_dbfs=-3.0)
    first = an.detect_segments(x, 44100, cfg)
    assert len(first) == 1
    first[0].status = an.STATUS_EXCLUDED
    second = an.detect_segments(
        x, 44100, an.DetectionConfig(pos_dbfs=-0.5), first
    )
    assert len(second) == 1
    assert second[0].status == an.STATUS_EXCLUDED
    assert "已保留排除" in second[0].hint


def test_confirmed_interval_is_unioned_with_new_detection():
    x = np.zeros((4000, 1))
    x[500:560, 0] = 1.0
    first = an.detect_segments(x, 44100, an.DetectionConfig(pos_dbfs=-3.0))
    first[0].status = an.STATUS_CONFIRMED
    # Widen the plateau and lower min_run so detection finds more.
    x[480:600, 0] = 1.0
    second = an.detect_segments(
        x, 44100, an.DetectionConfig(pos_dbfs=-0.05, min_run=2), first
    )
    assert len(second) == 1
    assert second[0].start <= 480
    assert second[0].end >= 600


def test_polarity_thresholds_are_independent():
    x = np.zeros((1000, 1))
    x[100:120, 0] = 0.9
    x[300:320, 0] = -0.9
    cfg = an.DetectionConfig(pos_dbfs=-0.5, neg_dbfs=-6.0)
    segs = an.detect_segments(x, 44100, cfg)
    assert [s.polarity for s in segs] == [-1]


def test_join_gap_bridges_micro_dropout_only():
    # A one-sample dip just under the threshold is a measurement wobble, not
    # the end of the clipping event.  A clearly quiet gap must not be bridged.
    x = np.zeros((1000, 1))
    x[100:150, 0] = 1.0
    x[150, 0] = 0.98  # one-sample wobble under a -0.1 dBFS threshold
    x[151:200, 0] = 1.0
    x[300:340, 0] = 1.0
    x[340:345, 0] = 0.0  # real silence, five samples
    x[345:400, 0] = 1.0
    cfg = an.DetectionConfig(join_gap=1)
    segs = an.detect_segments(x, 44100, cfg)
    assert [(s.start, s.end) for s in segs] == [
        (100, 200),
        (300, 340),
        (345, 400),
    ]
    cfg2 = an.DetectionConfig(join_gap=8)
    segs2 = an.detect_segments(x, 44100, cfg2)
    assert [(s.start, s.end) for s in segs2] == [(100, 200), (300, 340), (345, 400)]


def test_square_beep_in_demo_is_flagged_not_auto_excluded(samples_dir):
    wav = load_wav(ensure_samples(samples_dir)["short_peak"])
    segs = an.detect_segments(wav.samples, wav.sample_rate, an.DetectionConfig())
    flagged = [s for s in segs if "方波" in s.hint]
    assert flagged, "the demo must contain square-like flat content"
    assert all(s.status == an.STATUS_SUSPECTED for s in flagged)
    # The genuine isolated clips exist and are not flagged.
    genuine = [s for s in segs if s.length < 40 and not s.hint]
    assert genuine


def test_demo_clips_are_isolated(samples_dir):
    wav = load_wav(ensure_samples(samples_dir)["short_peak"])
    segs = an.detect_segments(wav.samples, wav.sample_rate, an.DetectionConfig())
    short = [s for s in segs if 5 <= s.length <= 40 and not s.hint]
    assert any(s.channel == 0 and s.polarity > 0 for s in short)
    assert any(s.channel == 0 and s.polarity < 0 for s in short)
    # Everything detected on the right channel must be the square beep region
    # (the demo has no right-channel clipping in the short sample).
    assert not [s for s in segs if s.channel == 1]


def test_segments_to_mask_skips_excluded_by_default():
    segs = [
        an.Segment(0, 1, 10, 20, status=an.STATUS_CONFIRMED),
        an.Segment(0, 1, 30, 40, status=an.STATUS_EXCLUDED),
    ]
    mask = an.segments_to_mask(segs, 0, 100)
    assert mask[10:20].all()
    assert not mask[30:40].any()
    mask_all = an.segments_to_mask(segs, 0, 100, include_excluded=True)
    assert mask_all[30:40].all()
