"""Tests for headroom warnings, export verification and audition buffers."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from clipmend import analysis as an


def test_export_round_trip_is_verified_and_isolation_holds(doc_short, tmp_path):
    out = tmp_path / "export.wav"
    report = doc_short.export(out, 16)
    assert out.exists()
    assert report.ok
    assert report.total_outside == 0
    assert report.mismatch_frames == 0
    assert report.max_quant_error_lsb <= 1.0
    assert report.changed_frames[1] == 0  # right channel untouched


def test_verification_detects_change_outside_intended_range(doc_short, tmp_path):
    doc = doc_short
    # Sabotage: modify one clean sample far from any repair region.
    tampered = doc.repaired.copy()
    tampered[100, 0] = np.clip(tampered[100, 0] + 0.25, -1.0, 1.0)
    path = tmp_path / "tampered.wav"
    an.export_wav(path, tampered, doc.wav.sample_rate, 16)
    report = an.verify_export(
        path,
        doc.wav.samples,
        tampered,
        16,
        doc.intended_ranges(),
        doc.wav.sample_rate,
    )
    assert not report.ok
    assert report.outside_frames[0] >= 1
    assert any(s <= 100 < e for s, e in report.outside_runs[0])


def test_verification_flags_wrong_channel_edit(doc_short, tmp_path):
    doc = doc_short
    tampered = doc.repaired.copy()
    seg = doc.segments[0]
    tampered[seg.start : seg.end, 1] += 0.1  # change the *other* channel
    path = tmp_path / "wrong_channel.wav"
    an.export_wav(path, tampered, doc.wav.sample_rate, 16)
    report = an.verify_export(
        path,
        doc.wav.samples,
        tampered,
        16,
        doc.intended_ranges(),
        doc.wav.sample_rate,
    )
    assert not report.ok
    assert report.outside_frames[1] > 0


def test_bit_depth_change_alone_does_not_count_as_modification(doc_short, tmp_path):
    doc = doc_short
    path = tmp_path / "depth24.wav"
    report = doc.export(path, 24)
    assert report.bits == 24
    assert report.ok
    # Only the repaired samples differ, all inside intended ranges.
    assert report.total_outside == 0
    assert report.total_changed <= doc.total_changed_samples()


def test_headroom_reports_new_peak(doc_short):
    rep = doc_short.headroom(16)
    assert rep.repaired_peak >= rep.original_peak
    assert rep.new_peak >= 0.0
    assert rep.headroom_db <= 0.0
    # With the deliberately square content excluded, the bundled short demo is
    # tuned to export cleanly by default.
    for seg in list(doc_short.segments):
        if "方波" in seg.hint:
            doc_short.set_status(seg.uid, an.STATUS_EXCLUDED)
    assert doc_short.headroom(16).fits


def test_demo_samples_import_cleanly_after_excluding_square_content(doc_short, doc_long):
    for doc in (doc_short, doc_long):
        for seg in list(doc.segments):
            if "方波" in seg.hint:
                doc.set_status(seg.uid, an.STATUS_EXCLUDED)
    assert doc_short.headroom(16).fits
    assert doc_long.headroom(16).fits
    # The long sample must still be marked as a low-confidence connection.
    assert doc_long.low_confidence_records()


def test_headroom_flags_overflow_when_repaired_peak_exceeds_full_scale():
    original = np.zeros((100, 1))
    repaired = original.copy()
    repaired[50, 0] = 1.4
    rep = an.headroom_report(original, repaired, 16)
    assert not rep.fits
    assert rep.overflow_count == 1
    assert rep.peak_dbfs > 0.0


def test_audit_contains_sample_ranges(doc_short, tmp_path):
    doc = doc_short
    out = tmp_path / "a.wav"
    verification = doc.export(out, 16)
    audit = doc.audit(verification)
    assert audit["segments"]
    # A record whose bridge happens to equal the input reports zero changes;
    # that is honest and must not be invented.  Every reported run, though,
    # must be in range and the total must match the document's own count.
    changed_total = 0
    for rec in audit["repairs"]:
        assert rec["changed_sample_count"] == sum(
            e - s for s, e in rec["changed_sample_runs"]
        )
        changed_total += rec["changed_sample_count"]
        for s, e in rec["changed_sample_runs"]:
            assert 0 <= s < e <= doc.wav.frames
    assert changed_total == doc.total_changed_samples()
    assert changed_total > 0
    assert audit["verification"]["ok"] is True
    path = tmp_path / "audit.json"
    doc.write_audit(path, verification)
    loaded = json.loads(path.read_text(encoding="utf-8"))
    assert loaded["frames"] == doc.wav.frames
    csv = doc.audit_csv()
    assert "changed_runs" in csv.splitlines()[0]
    assert str(doc.records[0].start) in csv


def test_excluding_a_segment_removes_its_changes(doc_short):
    doc = doc_short
    before = doc.total_changed_samples()
    seg = doc.segments[0]
    doc.set_status(seg.uid, an.STATUS_EXCLUDED)
    after = doc.total_changed_samples()
    assert after < before
    assert all(r.segment_uid != seg.uid for r in doc.records)
    # Excluded region is bit-identical to the input now.
    out = doc.repaired
    assert np.array_equal(
        out[seg.start : seg.end, seg.channel],
        doc.wav.samples[seg.start : seg.end, seg.channel],
    )


def test_long_sample_marks_low_confidence(doc_long):
    low = doc_long.low_confidence_records()
    assert low, "long flat-top demo must produce a low-confidence repair"
    assert any("长段缺失" in f for r in low for f in r.flags)


def test_verification_reports_flattened_frames():
    original = np.zeros((100, 2))
    repaired = original.copy()
    repaired[40:45, 0] = 1.3  # would be flattened on write
    import tempfile

    path = Path(tempfile.mkdtemp()) / "clipped.wav"
    an.export_wav(path, repaired, 22050, 16)
    report = an.verify_export(
        path,
        original,
        repaired,
        16,
        {0: [(40, 45)]},
        22050,
    )
    assert report.has_clipping
    assert report.clipped_frames == 5
    # Flattening is inside the intended range, so it is not a scope violation.
    assert report.total_outside == 0
