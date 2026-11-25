from __future__ import annotations

import json
import os
import stat
from dataclasses import replace
from pathlib import Path

import pytest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from mkv_tool.audio import dominant_frequency, extract_mono_pcm_wav
from mkv_tool.edits import TrackEditSession
from mkv_tool.errors import MuxError, SourceNotFoundError, UnsupportedScopeError
from mkv_tool.exporter import export_mkv
from mkv_tool.media import SourceInfo, StreamInfo, probe_file
from mkv_tool.subtitles import cues_at, extract_subtitle_srt, parse_srt
from mkv_tool.verification import verify_output


def test_probe_distinguishes_duplicate_language_and_missing_language(sample_path: Path) -> None:
    info = probe_file(sample_path)
    assert [s.index for s in info.streams] == [0, 1, 2, 3, 4, 5, 6]

    audios = info.audios
    assert [s.language for s in audios] == ["eng", "eng"]
    assert audios[0].index != audios[1].index
    assert "440" in audios[0].title
    assert "880" in audios[1].title

    untagged = info.get(6)
    assert untagged.codec_type == "subtitle"
    assert untagged.language == ""
    assert untagged.index == 6

    forced = info.get(3)
    assert forced.default is True
    assert forced.forced is True


def test_subtitle_text_at_specified_time(sample_path: Path) -> None:
    srt = extract_subtitle_srt(sample_path, 5)
    cues = parse_srt(srt)
    assert len(cues) == 2
    hit = cues_at(cues, 0.5)
    assert hit and "中文字幕第一条" in hit[0].text
    assert cues_at(cues, 9.0) == []


def test_remove_first_audio_keeps_880_track_not_subtitle(
    sample_path: Path, tmp_path: Path
) -> None:
    session = TrackEditSession(probe_file(sample_path))
    session.set_included(1, False)
    session.set_default(2, True)
    output = tmp_path / "remove-first-audio.mkv"
    plan = session.build_plan(output, overwrite=True)

    report = export_mkv(plan)
    assert report.ok, "\n".join(report.summary_lines())

    reopened = probe_file(output)
    assert len(reopened.audios) == 1
    assert len(reopened.streams) == 6
    retained_audio = reopened.audios[0]
    assert retained_audio.index == 1  # output stream index after one video
    assert retained_audio.codec_type == "audio"
    assert retained_audio.codec_name == "aac"
    assert retained_audio.default is True

    # Output #1 must be audio; this explicitly catches an off-by-one map that
    # would land on source stream #3/the first subtitle.
    assert reopened.streams[1].codec_type == "audio"
    assert reopened.streams[2].codec_type == "subtitle"

    matching_check = next(c for c in report.checks if c.output_index == 1)
    assert matching_check.expected.source_index == 2
    assert matching_check.packet_hash
    assert matching_check.errors == []

    wav = tmp_path / "retained.wav"
    extract_mono_pcm_wav(output, retained_audio.index, wav)
    frequency = dominant_frequency(wav)
    assert abs(frequency - 880.0) < 25.0
    assert abs(frequency - 440.0) > 100.0


def test_reorder_metadata_default_and_forced_are_written_and_reopened(
    sample_path: Path, tmp_path: Path
) -> None:
    session = TrackEditSession(probe_file(sample_path))

    # Audio order becomes source #2 then #1.
    session.move(2, -1)
    # Move Chinese subtitle #5 to the top of the subtitle group.
    session.move(5, -1)
    session.move(5, -1)

    session.set_language(2, "jpn")
    session.set_title(2, "Japanese 880 edited")
    session.set_default(2, True)

    # Default and forced intentionally live on different subtitle tracks.
    session.set_default(4, True)
    session.set_forced(3, True)
    session.set_forced(5, True)

    output = tmp_path / "reordered.mkv"
    report = export_mkv(session.build_plan(output, overwrite=True))
    assert report.ok, "\n".join(report.summary_lines())

    reopened = probe_file(output)
    assert [s.index for s in reopened.streams] == [0, 1, 2, 3, 4, 5, 6]

    expected_identity = [
        (0, "video", 0),
        (1, "audio", 2),
        (2, "audio", 1),
        (3, "subtitle", 5),
        (4, "subtitle", 3),
        (5, "subtitle", 4),
        (6, "subtitle", 6),
    ]
    for output_index, codec_type, source_index in expected_identity:
        check = report.checks[output_index]
        assert check.expected.source_index == source_index
        assert check.expected.codec_type == codec_type
        assert check.ok

    japanese = reopened.streams[1]
    assert japanese.language == "jpn"
    assert japanese.title == "Japanese 880 edited"
    assert japanese.default is True

    # Output #4 is source #3: not default after choosing #4, but still forced.
    old_forced = reopened.streams[4]
    assert old_forced.forced is True
    assert old_forced.default is False

    # Output #5 is source #4: default, not forced.
    new_default = reopened.streams[5]
    assert new_default.default is True
    assert new_default.forced is False

    # Source #5 was moved first and forced; it is output #3.
    moved_forced = reopened.streams[3]
    assert moved_forced.forced is True


def test_positive_and_negative_relative_offsets_survive_export(
    offset_sample_path: Path, tmp_path: Path
) -> None:
    info = probe_file(offset_sample_path)
    assert info.relative_offset(info.get(1)) == pytest.approx(0.35, abs=0.06)
    assert info.relative_offset(info.get(2)) == pytest.approx(-0.15, abs=0.06)

    session = TrackEditSession(info)
    # Put early track before late track in output order.
    session.move(2, -1)
    output = tmp_path / "offsets-edited.mkv"
    report = export_mkv(session.build_plan(output, overwrite=True))
    assert report.ok, "\n".join(report.summary_lines())

    reopened = probe_file(output)
    assert reopened.relative_offset(reopened.streams[1]) == pytest.approx(-0.15, abs=0.08)
    assert reopened.relative_offset(reopened.streams[2]) == pytest.approx(0.35, abs=0.08)

    # Remove the early track; the late track must remain late relative video.
    session2 = TrackEditSession(probe_file(offset_sample_path))
    session2.set_included(2, False)
    output2 = tmp_path / "offsets-remove-early.mkv"
    report2 = export_mkv(session2.build_plan(output2, overwrite=True))
    assert report2.ok
    reopened2 = probe_file(output2)
    assert reopened2.relative_offset(reopened2.audios[0]) == pytest.approx(0.35, abs=0.08)


def test_missing_source_does_not_publish_output(sample_path: Path, tmp_path: Path) -> None:
    session = TrackEditSession(probe_file(sample_path))
    output = tmp_path / "missing-source-output.mkv"
    plan = session.build_plan(output)
    sample_path.unlink()

    with pytest.raises(SourceNotFoundError):
        export_mkv(plan)
    assert not output.exists()
    assert list(tmp_path.glob(".*.tmp.mkv")) == []


def test_mux_failure_cleans_temp_and_raises(
    sample_path: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    fake_ffmpeg = tmp_path / "fake-ffmpeg"
    fake_ffmpeg.write_text("#!/bin/sh\necho simulated mux failure >&2\nexit 17\n", encoding="utf-8")
    fake_ffmpeg.chmod(fake_ffmpeg.stat().st_mode | stat.S_IXUSR)

    session = TrackEditSession(probe_file(sample_path))
    output = tmp_path / "mux-failed.mkv"
    plan = session.build_plan(output, ffmpeg=fake_ffmpeg)

    # Avoid invoking the failing fake for pre-export content hashes; this test
    # is specifically about mux failure cleanup.
    monkeypatch.setattr("mkv_tool.exporter.packet_stream_hash", lambda *a, **k: "0" * 64)

    with pytest.raises(MuxError):
        export_mkv(plan)
    assert not output.exists()
    assert list(tmp_path.glob(".*.tmp.mkv")) == []


def test_verifier_flags_missing_intended_target(sample_path: Path, tmp_path: Path) -> None:
    session = TrackEditSession(probe_file(sample_path))
    output = tmp_path / "good.mkv"
    plan = session.build_plan(output, overwrite=True)
    assert export_mkv(plan).ok

    # Now demand one additional target that the existing output does not have.
    missing = replace(plan.expected[-1], output_index=99, source_index=99)
    wrong_plan = replace(plan, expected=[*plan.expected, missing])
    report = verify_output(output, wrong_plan)
    assert report.ok is False
    assert any("数量" in error for error in report.errors)
    assert any("不存在" in error for error in report.errors)


def test_attached_cover_is_not_silently_labelled_fixed_or_dropped(tmp_path: Path) -> None:
    main_video = StreamInfo(index=0, codec_type="video", codec_name="h264")
    cover = StreamInfo(
        index=1,
        codec_type="video",
        codec_name="png",
        disposition={"attached_pic": True, "default": False},
    )
    audio = StreamInfo(index=2, codec_type="audio", codec_name="aac", language="eng")
    source = SourceInfo(path=tmp_path / "with-cover.mkv", streams=[main_video, cover, audio])

    assert cover in source.unsupported_streams
    session = TrackEditSession(source)
    with pytest.raises(UnsupportedScopeError):
        session.build_plan(tmp_path / "out.mkv")

    plan = session.build_plan(tmp_path / "out.mkv", acknowledge_unsupported=True)
    assert [stream.source_index for stream in plan.expected] == [0, 2]


def test_default_false_on_other_row_does_not_clear_current_default(
    sample_path: Path,
) -> None:
    session = TrackEditSession(probe_file(sample_path))
    session.set_default(2, True)
    session.set_default(1, False)
    assert session.default_track("audio") is not None
    assert session.default_track("audio").source_index == 2

    session.set_default(2, False)
    assert session.default_track("audio") is None


def test_sample_cli_command(tmp_path: Path) -> None:
    from mkv_tool.sample import main

    target = tmp_path / "cli-sample.mkv"
    code = main(["--out", str(target), "--duration", "1"])
    assert code == 0
    info = probe_file(target)
    assert len(info.audios) == 2
    assert len(info.subtitles) == 4
