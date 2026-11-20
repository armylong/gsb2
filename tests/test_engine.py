"""End-to-end engine test: demo samples, matching, export, re-measure."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from audio_matcher import samples
from audio_matcher.audio_io import load_audio
from audio_matcher.engine import evaluate, export_all
from audio_matcher.levels import Region
from audio_matcher.matching import PEAK_MODE_HEADROOM, PEAK_MODE_LIMITER
from audio_matcher.project import Project


@pytest.fixture(scope="module")
def demo(tmp_path_factory) -> dict:
    root = tmp_path_factory.mktemp("demo")
    source = root / "src"
    paths = samples.write_samples(source)
    project = Project()
    project.import_paths([str(p) for p in paths])
    for clip in project.clips:
        rate = clip.sample_rate
        clip.regions = [
            Region("speech", int(a * rate), int(b * rate))
            for a, b in samples.demo_regions(clip.name)
        ] + [
            Region("exclude", int(a * rate), int(b * rate))
            for a, b in samples.demo_exclusions(clip.name)
        ]
        if clip.name == "speaker_c_peak_clap.wav":
            clip.peak_limit_enabled = True
            clip.peak_limit_db = -1.0
            clip.peak_mode = PEAK_MODE_LIMITER
        elif clip.name == "speaker_e_peak_knock.wav":
            clip.peak_limit_enabled = True
            clip.peak_limit_db = -1.0
            clip.peak_mode = PEAK_MODE_HEADROOM
    reference = next(c for c in project.clips if c.name == "speaker_a_reference.wav")
    project.set_reference(reference.id)
    audio = {clip.id: load_audio(clip.path).samples for clip in project.clips}
    outcome = evaluate(project, audio)
    return {
        "root": root,
        "project": project,
        "audio": audio,
        "outcome": outcome,
        "output": root / "out",
    }


def test_all_clips_measured(demo) -> None:
    outcome = demo["outcome"]
    assert len(outcome.evaluations) == len(samples.SAMPLES)
    for evaluation in outcome.evaluations:
        assert evaluation.measurement is not None
        assert evaluation.measurement.rms_db is not None


def test_reference_is_loudest_and_quiet_clip_needs_positive_gain(demo) -> None:
    evaluations = {e.clip.name: e for e in demo["outcome"].evaluations}
    quiet = evaluations["speaker_b_quiet.wav"]
    assert quiet.plan is not None
    assert quiet.plan.applied_gain_db > 5.0
    loud = evaluations["speaker_d_loud.wav"]
    assert loud.plan is not None
    assert loud.plan.applied_gain_db < 0.0


def test_headroom_clip_reports_shortfall(demo) -> None:
    evaluations = {e.clip.name: e for e in demo["outcome"].evaluations}
    clip = evaluations["speaker_e_peak_knock.wav"]
    assert clip.plan is not None
    assert clip.plan.mode == PEAK_MODE_HEADROOM
    assert clip.plan.limited
    assert clip.plan.shortfall_db > 5.0
    assert demo["outcome"].suggested_target_db is not None


def test_export_and_remeasure(demo) -> None:
    result = export_all(
        demo["project"],
        demo["outcome"],
        demo["audio"],
        output_dir=demo["output"],
    )
    records = {record.clip_name: record for record in result["records"]}
    assert (demo["output"] / "match_report.json").is_file()
    assert (demo["output"] / "match_report.csv").is_file()
    for name, record in records.items():
        assert Path(record.output_path).is_file(), name
    # Measured-from-the-file levels land on the target for clips that fit.
    for name in ("speaker_a_reference.wav", "speaker_b_quiet.wav", "speaker_d_loud.wav"):
        record = records[name]
        assert record.deviation_db is not None
        assert abs(record.deviation_db) < 0.5
    # The held-back clip says so, with a measured deviation and no silence.
    held = records["speaker_e_peak_knock.wav"]
    assert held.status == "below_target"
    assert held.deviation_db is not None and held.deviation_db < -5.0
    assert "dB" in held.note


def test_limiter_export_lists_changed_ranges(demo) -> None:
    result = export_all(
        demo["project"],
        demo["outcome"],
        demo["audio"],
        output_dir=demo["output"],
    )
    record = next(
        r for r in result["records"] if r.clip_name == "speaker_c_peak_clap.wav"
    )
    assert record.limited_runs
    run = record.limited_runs[0]
    assert 3.5 < run["start_s"] < 3.7
    assert run["end_s"] > run["start_s"]
    assert run["reduction_db"] < 0
    assert record.status == "ok"


def test_report_json_has_provenance_and_crest(demo) -> None:
    result = export_all(
        demo["project"],
        demo["outcome"],
        demo["audio"],
        output_dir=demo["output"],
    )
    payload = json.loads(Path(result["report_json"]).read_text(encoding="utf-8"))
    assert payload["target_rms_db"] is not None
    for record in payload["clips"]:
        assert record["provenance"], record["clip_name"]
        crest = record["source_peak_db"] - record["source_rms_db"]
        assert crest > 0
        assert record["measured_rms_db"] is not None


def test_export_is_idempotent(demo) -> None:
    first = export_all(
        demo["project"], demo["outcome"], demo["audio"], output_dir=demo["output"]
    )
    second = export_all(
        demo["project"], demo["outcome"], demo["audio"], output_dir=demo["output"]
    )
    for a, b in zip(first["records"], second["records"], strict=True):
        assert a.measured_rms_db == pytest.approx(b.measured_rms_db)
