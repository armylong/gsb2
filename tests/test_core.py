"""Tests for cue parsing, validation, planning, export and audition stability."""

from __future__ import annotations

import os
import tempfile
from fractions import Fraction

import numpy as np
import pytest
import soundfile as sf

from cuecut.cue import parse_cue, validate_against_audio
from cuecut.demo import generate_demo
from cuecut.exporter import (
    export_plan,
    verify_exported_head_tail,
    verify_junction,
)
from cuecut.model import AudioInfo
from cuecut.plan import (
    SplitMode,
    build_plan,
    in_track_offset,
    is_in_lead,
    junctions,
    member_track_index,
)
from cuecut.timeutil import sample_at


def _write(tmp_path, text, sr=44100, samples=44100 * 30):
    wav = tmp_path / "a.wav"
    sf.write(str(wav), np.zeros((samples, 2)), sr, subtype="PCM_24", format="WAV")
    cue = tmp_path / "a.cue"
    cue.write_text(text, encoding="utf-8")
    info = AudioInfo(str(wav), sr, 2, samples, "PCM_24")
    return str(cue), info, str(wav)


def _sheet(tmp_path, text, **kw):
    cue, info, wav = _write(tmp_path, text, **kw)
    sheet = parse_cue(cue)
    validate_against_audio(sheet, info)
    return sheet, info, wav


def test_good_sheet_parses():
    text = """TITLE "Album"
FILE "a.wav" WAVE
  TRACK 01 AUDIO
    INDEX 01 00:00:00
  TRACK 02 AUDIO
    INDEX 00 00:10:00
    INDEX 01 00:15:00
"""
    with tempfile.TemporaryDirectory() as d:
        from pathlib import Path

        cue, info, wav = _write(Path(d), text)
        sheet = parse_cue(cue)
        validate_against_audio(sheet, info)
        assert not sheet.errors
        assert len(sheet.tracks) == 2
        assert sheet.tracks[1].lead == Fraction(10)
        assert sheet.tracks[1].start == Fraction(15)


def test_missing_index01_reports_line():
    with tempfile.TemporaryDirectory() as d:
        from pathlib import Path

        text = 'FILE "a.wav" WAVE\n  TRACK 01 AUDIO\n    TITLE "x"\n'
        cue, info, wav = _write(Path(d), text)
        sheet = parse_cue(cue)
        assert sheet.errors
        assert sheet.errors[0].line == 2
        assert "INDEX 01" in sheet.errors[0].message


def test_point_outside_file_reports_track_and_line():
    with tempfile.TemporaryDirectory() as d:
        from pathlib import Path

        # 30 s file; INDEX 01 at 40 s is off the end.
        text = 'FILE "a.wav" WAVE\n  TRACK 01 AUDIO\n    INDEX 01 00:00:00\n  TRACK 02 AUDIO\n    INDEX 01 00:40:00\n'
        cue, info, wav = _write(Path(d), text, samples=44100 * 30)
        sheet = parse_cue(cue)
        validate_against_audio(sheet, info)
        assert any(e.code == "point_outside_file" and e.track_number == 2 for e in sheet.errors)
        assert any(e.line == 5 for e in sheet.errors)


def test_out_of_order_times_reports_both_positions():
    with tempfile.TemporaryDirectory() as d:
        from pathlib import Path

        text = (
            'FILE "a.wav" WAVE\n'
            "  TRACK 01 AUDIO\n    INDEX 01 00:20:00\n"
            "  TRACK 02 AUDIO\n    INDEX 01 00:10:00\n"
        )
        cue, info, wav = _write(Path(d), text, samples=44100 * 30)
        sheet = parse_cue(cue)
        validate_against_audio(sheet, info)
        err = next(e for e in sheet.errors if e.code == "time_out_of_order")
        assert err.line == 5
        assert err.track_number == 2
        assert "第 3 行" in err.message


def test_lead_after_start_is_parse_error():
    with tempfile.TemporaryDirectory() as d:
        from pathlib import Path

        text = (
            'FILE "a.wav" WAVE\n'
            "  TRACK 01 AUDIO\n    INDEX 00 00:10:00\n    INDEX 01 00:05:00\n"
        )
        cue, info, wav = _write(Path(d), text)
        sheet = parse_cue(cue)
        assert any(e.code == "lead_after_start" for e in sheet.errors)


def test_multiple_file_lines_rejected():
    with tempfile.TemporaryDirectory() as d:
        from pathlib import Path

        text = 'FILE "a.wav" WAVE\nFILE "b.wav" WAVE\n  TRACK 01 AUDIO\n    INDEX 01 00:00:00\n'
        cue, info, wav = _write(Path(d), text)
        sheet = parse_cue(cue)
        assert any(e.code == "multiple_files" for e in sheet.errors)


def test_bad_time_format_points_at_line():
    with tempfile.TemporaryDirectory() as d:
        from pathlib import Path

        text = 'FILE "a.wav" WAVE\n  TRACK 01 AUDIO\n    INDEX 01 00:99:00\n'
        cue, info, wav = _write(Path(d), text)
        sheet = parse_cue(cue)
        assert any(e.line == 3 and e.code == "bad_time" for e in sheet.errors)


def test_revalidation_clears_stale_audio_errors():
    with tempfile.TemporaryDirectory() as d:
        from pathlib import Path

        text = 'FILE "a.wav" WAVE\n  TRACK 01 AUDIO\n    INDEX 01 00:00:00\n  TRACK 02 AUDIO\n    INDEX 01 00:40:00\n'
        cue, info, wav = _write(Path(d), text, samples=44100 * 20)
        sheet = parse_cue(cue)
        validate_against_audio(sheet, info)
        assert sheet.errors
        bigger = AudioInfo(wav, 44100, 2, 44100 * 60, "PCM_24")
        validate_against_audio(sheet, bigger)
        assert not sheet.errors


@pytest.fixture(scope="module")
def demo(tmp_path_factory):
    d = tmp_path_factory.mktemp("demo")
    truth = generate_demo(str(d))
    info = AudioInfo(truth.path, truth.samplerate, truth.channels, truth.total_samples, "PCM_24")
    sheet = parse_cue(truth.cue_path)
    validate_against_audio(sheet, info)
    return truth, info, sheet, str(d)


def test_demo_sheet_valid(demo):
    truth, info, sheet, _ = demo
    assert not sheet.errors
    assert len(sheet.tracks) == 4
    assert all(t.lead is not None for t in sheet.tracks[1:])


def test_plans_tile_every_mode(demo):
    truth, info, sheet, _ = demo
    for mode in SplitMode:
        for sep in (False, True):
            plan = build_plan(sheet, info, mode, sep)
            assert plan.tiles_whole_file()
            assert not plan.ownership_problems()


def test_tail_vs_head_boundaries(demo):
    truth, info, sheet, _ = demo
    tail = build_plan(sheet, info, SplitMode.TAIL, False)
    head = build_plan(sheet, info, SplitMode.HEAD, False)
    sr = info.samplerate
    # TAIL: T2's file starts at INDEX 01; its lead belongs to T1's file.
    assert tail.segment_for_sheet_index(1).first_sample == sample_at(Fraction(40), sr)
    assert tail.segment_for_sheet_index(0).last_sample == sample_at(Fraction(40), sr) - 1
    # HEAD: T2's file starts at INDEX 00; T1's file ends one sample before.
    assert head.segment_for_sheet_index(1).first_sample == sample_at(Fraction(34), sr)
    assert head.segment_for_sheet_index(0).last_sample == sample_at(Fraction(34), sr) - 1


def test_head_lead_separate(demo):
    truth, info, sheet, _ = demo
    plan = build_plan(sheet, info, SplitMode.TAIL, True)
    head_seg = next(s for s in plan.segments if s.kind == "head_lead")
    assert head_seg.first_sample == 0
    assert head_seg.last_sample == sample_at(sheet.tracks[0].start, info.samplerate) - 1
    assert plan.segments[1].first_sample == head_seg.last_sample + 1


def test_owner_of_sample_uses_binary_search(demo):
    truth, info, sheet, _ = demo
    plan = build_plan(sheet, info, SplitMode.HEAD, False)
    for seg in plan.segments:
        for s in (seg.first_sample, seg.last_sample, (seg.first_sample + seg.last_sample) // 2):
            assert plan.owner_of_sample(s) is seg
    assert plan.owner_of_sample(-1) is None
    assert plan.owner_of_sample(info.total_samples) is None


def test_lead_membership_independent_of_mode(demo):
    truth, info, sheet, _ = demo
    # A sample 3 s before T2's INDEX 01 is in T2's lead region for *both* modes.
    s = sample_at(Fraction(37), info.samplerate)
    assert member_track_index(sheet, info, s) == 1
    assert is_in_lead(sheet, info, s)
    assert in_track_offset(sheet, info, s) == s - sample_at(Fraction(40), info.samplerate)
    assert in_track_offset(sheet, info, s) < 0
    # A sample in T2 proper is positive in-track time.
    t = sample_at(Fraction(50), info.samplerate)
    assert in_track_offset(sheet, info, t) > 0


def test_export_and_reconstruction(demo):
    truth, info, sheet, base = demo
    for mode in SplitMode:
        for sep in (False, True):
            out = os.path.join(base, f"out-{mode.value}-{int(sep)}")
            plan = build_plan(sheet, info, mode, sep)
            result = export_plan(plan, out)
            assert result.ok, result.errors
            assert not verify_junction(out, plan)


def test_exported_head_tail_recheck(demo):
    truth, info, sheet, base = demo
    out = os.path.join(base, "ht")
    plan = build_plan(sheet, info, SplitMode.HEAD, True)
    assert export_plan(plan, out).ok
    rows = verify_exported_head_tail(out, plan)
    assert all(r.ok for r in rows)
    assert all("✓" in r.head_text and "✓" in r.tail_text for r in rows)


def test_exported_head_tail_detects_tamper(demo):
    truth, info, sheet, base = demo
    out = os.path.join(base, "tamper")
    plan = build_plan(sheet, info, SplitMode.TAIL, False)
    assert export_plan(plan, out).ok
    path = os.path.join(out, plan.segments[0].file_name)
    data, sr = sf.read(path, dtype="float64", always_2d=True)
    data[-1, 0] += 0.5
    sf.write(path, data, sr, subtype="PCM_24", format="WAV")
    rows = verify_exported_head_tail(out, plan)
    assert not rows[0].ok
    assert "✗" in rows[0].tail_text


def test_demo_marker_samples_match_ground_truth(demo):
    truth, info, sheet, base = demo
    sr = info.samplerate
    for m in truth.markers:
        # Cue times are whole frames, so the demo uses whole seconds; exact.
        assert m.sample % sr == 0


def test_junction_true_split_follows_mode(demo):
    truth, info, sheet, _ = demo
    js = junctions(sheet, info)
    j = js[0]
    assert j.true_split(SplitMode.TAIL, info) == sample_at(Fraction(40), info.samplerate)
    assert j.true_split(SplitMode.HEAD, info) == sample_at(Fraction(34), info.samplerate)


def test_audition_region_survives_mode_switch(demo):
    from cuecut.audio import AudioSource, PreviewPlayer

    truth, info, sheet, _ = demo
    src = AudioSource(info.path)
    player = PreviewPlayer(src)
    first, last = 1_000_000, 1_200_000
    player.start(first, last)
    mode_region = player.region
    player.set_mode(SplitMode.TAIL)
    assert player.region == mode_region == (first, last + 1)
    player.set_mode(SplitMode.HEAD)
    assert player.region == mode_region
    player.shutdown()
    src.close()


def test_no_leads_plan_single_file_per_track():
    with tempfile.TemporaryDirectory() as d:
        from pathlib import Path

        text = ('FILE "a.wav" WAVE\n'
                "  TRACK 01 AUDIO\n    INDEX 01 00:00:00\n"
                "  TRACK 02 AUDIO\n    INDEX 01 00:10:00\n"
                "  TRACK 03 AUDIO\n    INDEX 01 00:20:00\n")
        cue, info, wav = _write(Path(d), text, samples=44100 * 30)
        sheet = parse_cue(cue)
        validate_against_audio(sheet, info)
        assert not sheet.errors
        for mode in SplitMode:
            for sep in (False, True):
                plan = build_plan(sheet, info, mode, sep)
                assert plan.tiles_whole_file()
                # No lead anywhere: modes cannot differ.
                assert plan.segments[-1].last_sample == info.total_samples - 1
                assert len(plan.segments) == 3


def test_fractional_frames_map_to_exact_samples():
    with tempfile.TemporaryDirectory() as d:
        from pathlib import Path

        # 00:00:01 at 75 fps = 1/75 s; at 44100 that is 588 samples.
        text = ('FILE "a.wav" WAVE\n  TRACK 01 AUDIO\n    INDEX 01 00:00:00\n'
                "  TRACK 02 AUDIO\n    INDEX 01 00:00:01\n")
        cue, info, wav = _write(Path(d), text, samples=44100 * 5)
        sheet = parse_cue(cue)
        validate_against_audio(sheet, info)
        assert not sheet.errors
        plan = build_plan(sheet, info, SplitMode.TAIL, False)
        assert plan.segments[0].last_sample == 587
        assert plan.segments[1].first_sample == 588


def test_head_lead_with_track1_own_lead():
    with tempfile.TemporaryDirectory() as d:
        from pathlib import Path

        text = ('FILE "a.wav" WAVE\n'
                "  TRACK 01 AUDIO\n    INDEX 00 00:02:00\n    INDEX 01 00:06:00\n"
                "  TRACK 02 AUDIO\n    INDEX 00 00:12:00\n    INDEX 01 00:16:00\n")
        cue, info, wav = _write(Path(d), text, samples=44100 * 25)
        sheet = parse_cue(cue)
        validate_against_audio(sheet, info)
        assert not sheet.errors
        sr = 44100
        for mode in SplitMode:
            plan = build_plan(sheet, info, mode, True)
            assert plan.tiles_whole_file()
            head = plan.segments[0]
            # head lead runs from 0 to one sample before T1's INDEX 00
            assert head.first_sample == 0
            assert head.last_sample == sample_at(Fraction(2), sr) - 1
            # T1's own lead always lives in T1's file in both modes
            assert plan.segments[1].first_sample == sample_at(Fraction(2), sr)


def test_lead_inside_previous_track_is_flagged():
    with tempfile.TemporaryDirectory() as d:
        from pathlib import Path

        text = ('FILE "a.wav" WAVE\n'
                "  TRACK 01 AUDIO\n    INDEX 01 00:00:00\n"
                "  TRACK 02 AUDIO\n    INDEX 00 00:10:00\n    INDEX 01 00:05:00\n")
        cue, info, wav = _write(Path(d), text, samples=44100 * 25)
        sheet = parse_cue(cue)
        validate_against_audio(sheet, info)
        assert any(e.code == "lead_after_start" for e in sheet.errors)


def test_file_name_mismatch_warns():
    with tempfile.TemporaryDirectory() as d:
        from pathlib import Path

        text = 'FILE "other.wav" WAVE\n  TRACK 01 AUDIO\n    INDEX 01 00:00:00\n'
        cue, info, wav = _write(Path(d), text, samples=44100 * 25)
        sheet = parse_cue(cue)
        validate_against_audio(sheet, info)
        assert not sheet.errors
        assert any("other.wav" in w.message for w in sheet.warnings)
