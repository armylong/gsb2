"""Acceptance tests for the five stated requirements, end to end."""

from __future__ import annotations

import json

import numpy as np
import pytest

from clipmend import analysis as an
from clipmend.document import Document
from clipmend.ui.audio import build_playback_buffer


def test_req1_per_channel_and_polarity_separately(doc_short):
    ch0 = [s for s in doc_short.segments if s.channel == 0]
    pos = [s for s in ch0 if s.polarity > 0]
    neg = [s for s in ch0 if s.polarity < 0]
    assert pos and neg, "positive and negative clipping must be listed separately"
    true_pos = [s for s in pos if not s.hint]
    true_neg = [s for s in neg if not s.hint]
    assert true_pos and true_neg


def test_req1_threshold_change_keeps_confirmed_region(doc_short):
    seg = doc_short.segments[0]
    doc_short.set_status(seg.uid, an.STATUS_CONFIRMED)
    span = (seg.start, seg.end)
    doc_short.set_thresholds(-0.02, -0.02, 2, 1)
    kept = [s for s in doc_short.segments if s.uid == seg.uid]
    assert kept and kept[0].status == an.STATUS_CONFIRMED
    assert kept[0].start <= span[0] and kept[0].end >= span[1]


def test_req2_user_can_exclude_square_content_and_audit_regions(doc_short):
    square = [s for s in doc_short.segments if "方波" in s.hint]
    assert square, "demo must include square-like flat content to exclude"
    for seg in square:
        doc_short.set_status(seg.uid, an.STATUS_EXCLUDED)
    assert doc_short.records
    audit = doc_short.audit()
    assert all("changed_sample_runs" in rec for rec in audit["repairs"])
    for rec in audit["repairs"]:
        assert rec["changed_sample_count"] == sum(
            e - s for s, e in rec["changed_sample_runs"]
        )


def test_req2_manual_region_is_a_repair(doc_short):
    doc_short.add_user_region(0, 300, 400)
    added = [r for r in doc_short.records if (r.start, r.end) == (300, 400)]
    assert added
    assert added[0].changed_runs == [(300, 400)]


def test_req3_short_gap_joins_ends_and_long_gap_is_flagged(doc_short, doc_long):
    short_rec = doc_short.records[0]
    assert short_rec.confidence != an.CONFIDENCE_LOW
    long_low = doc_long.low_confidence_records()
    assert long_low
    assert any("长段缺失" in flag for r in long_low for flag in r.flags)
    # Label says it is reference-only, not a confident restoration.
    assert an.CONFIDENCE_LABELS[long_low[0].confidence] != "高"


def test_req4_same_range_all_three_versions_and_isolation(doc_short):
    wav = doc_short.wav
    seg = doc_short.segments[0]
    start, end = seg.start - 200, seg.end + 200
    original = build_playback_buffer(wav.samples, wav.sample_rate, start, end)
    repaired = build_playback_buffer(doc_short.repaired, wav.sample_rate, start, end)
    difference = build_playback_buffer(doc_short.diff, wav.sample_rate, start, end)
    assert original.frames == repaired.frames == difference.frames
    # A soloed left channel leaves the right side silent in all three.
    solo = build_playback_buffer(
        doc_short.repaired, wav.sample_rate, start, end, channel_gain=(1.0, 0.0)
    )
    data = np.frombuffer(solo.data, dtype="<f4").reshape(-1, 2)
    assert np.allclose(data[:, 1], 0.0)
    # And the right channel of the document really is untouched.
    assert np.array_equal(doc_short.repaired[:, 1], wav.samples[:, 1])


def test_req5_headroom_export_and_readback(doc_short, tmp_path):
    headroom = doc_short.headroom(16)
    assert headroom.original_peak > 0
    assert headroom.repaired_peak > 0
    out = tmp_path / "out.wav"
    report = doc_short.export(out, 16)
    assert out.exists()
    assert report.ok
    assert report.total_outside == 0
    assert report.changed_frames[1] == 0
    audit_path = tmp_path / "audit.json"
    doc_short.write_audit(audit_path, report)
    payload = json.loads(audit_path.read_text(encoding="utf-8"))
    assert payload["verification"]["ok"] is True
    assert payload["segments"]


def test_req5_builtin_samples_are_listed_and_load():
    from clipmend.samples import SAMPLES

    keys = {s.key for s in SAMPLES}
    assert keys == {"short_peak", "long_flat"}
    assert all(s.description for s in SAMPLES)


def test_long_sample_has_isolated_right_channel_event(doc_long):
    right = [s for s in doc_long.segments if s.channel == 1]
    assert right, "long demo deliberately has a separate right-channel clip"
    # Disable every left-channel decision, keep only the right event.
    for seg in doc_long.segments:
        if seg.channel == 0:
            doc_long.set_status(seg.uid, an.STATUS_EXCLUDED)
    seg = right[0]
    doc_long.set_status(seg.uid, an.STATUS_CONFIRMED)
    doc_long.rebuild()
    # Repairing the isolated right event must not alter the left channel.
    assert np.array_equal(doc_long.repaired[:, 0], doc_long.wav.samples[:, 0])
    assert not np.array_equal(
        doc_long.repaired[seg.start : seg.end, 1],
        doc_long.wav.samples[seg.start : seg.end, 1],
    )
