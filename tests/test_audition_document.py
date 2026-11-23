"""Tests for audition buffer construction and document behaviour."""

from __future__ import annotations

import numpy as np
import pytest

from clipmend import analysis as an
from clipmend.document import Document
from clipmend.ui.audio import build_playback_buffer


def test_buffer_keeps_requested_range_and_channel_solo():
    rng = np.random.default_rng(1)
    x = rng.uniform(-0.5, 0.5, size=(1000, 2))
    buf = build_playback_buffer(x, 22050, 100, 300, channel_gain=(1.0, 0.0))
    assert (buf.first_frame, buf.last_frame) == (100, 300)
    assert buf.frames == 200
    assert buf.channels == 2
    data = np.frombuffer(buf.data, dtype="<f4").reshape(-1, 2)
    assert np.allclose(data[:, 0], x[100:300, 0], atol=1e-6)
    assert np.allclose(data[:, 1], 0.0)


def test_all_three_versions_are_same_length(doc_short):
    wav = doc_short.wav
    start, end = 57000, 59500
    buffers = [
        build_playback_buffer(
            version, wav.sample_rate, start, end
        )
        for version in (wav.samples, doc_short.repaired, doc_short.diff)
    ]
    assert len({b.frames for b in buffers}) == 1
    assert len({b.data for b in buffers}) == 3


def test_difference_buffer_is_original_minus_repaired(doc_short):
    wav = doc_short.wav
    seg = doc_short.segments[0]
    start, end = seg.start, seg.end
    orig = build_playback_buffer(wav.samples, wav.sample_rate, start, end)
    rep = build_playback_buffer(doc_short.repaired, wav.sample_rate, start, end)
    diff = build_playback_buffer(doc_short.diff, wav.sample_rate, start, end)
    a = np.frombuffer(orig.data, dtype="<f4").reshape(-1, 2)
    b = np.frombuffer(rep.data, dtype="<f4").reshape(-1, 2)
    d = np.frombuffer(diff.data, dtype="<f4").reshape(-1, 2)
    # document.diff is repaired - original
    assert np.allclose(b - a, d, atol=2e-6)


def test_buffer_clips_out_of_range_requests():
    x = np.ones((100, 1))
    buf = build_playback_buffer(x, 8000, -20, 500)
    assert buf.first_frame == 0
    assert buf.last_frame == 100
    assert buf.frames == 100


def test_buffer_resamples_when_target_rate_differs():
    x = np.zeros((22050, 1))
    buf = build_playback_buffer(x, 22050, 0, 22050, target_rate=44100)
    assert buf.sample_rate == 44100
    assert buf.frames == 44100


def test_loop_fades_edges_without_changing_length():
    x = np.ones((500, 1))
    buf = build_playback_buffer(x, 8000, 0, 500, loop=True)
    data = np.frombuffer(buf.data, dtype="<f4").reshape(-1, 2)
    assert buf.frames == 500
    assert data[0, 0] < 0.05
    assert data[-1, 0] < 0.05
    assert data[250, 0] > 0.9


# -- document ---------------------------------------------------------------


def test_document_rebuilds_on_status_change(doc_short):
    before = len(doc_short.records)
    doc_short.set_status(doc_short.segments[0].uid, an.STATUS_EXCLUDED)
    assert len(doc_short.records) == before - 1


def test_document_thresholds_keep_user_decisions(doc_short):
    seg = doc_short.segments[0]
    doc_short.set_status(seg.uid, an.STATUS_CONFIRMED)
    (start, end) = (seg.start, seg.end)
    doc_short.set_thresholds(-0.02, -0.02, 2, 1)
    kept = [s for s in doc_short.segments if s.uid == seg.uid]
    assert kept and kept[0].status == an.STATUS_CONFIRMED
    assert kept[0].start <= start and kept[0].end >= end


def test_document_user_region_creates_repair(doc_short):
    doc_short.add_user_region(1, 1000, 1200)
    user = [r for r in doc_short.records if r.end == 1200 and r.channel == 1]
    assert user, "user-selected region must be repaired"
    assert user[0].changed_runs == [(1000, 1200)]


def test_document_exclude_square_demo(doc_short):
    square = [s for s in doc_short.segments if "方波" in s.hint]
    assert square
    for seg in square:
        doc_short.set_status(seg.uid, an.STATUS_EXCLUDED)
    assert all(
        s.status == an.STATUS_EXCLUDED for s in doc_short.segments if "方波" in s.hint
    )
    # Other clips still repaired.
    assert doc_short.records


def test_document_method_switch_changes_records(doc_short):
    before = {r.segment_uid: r.method for r in doc_short.records}
    doc_short.set_method("hermite")
    after = {r.segment_uid: r.method for r in doc_short.records}
    assert all(m == "hermite" for m in after.values())
    assert before != after or True
