"""Tests for project persistence, locking, and source-change detection."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from audio_matcher.audio_io import SourceSnapshot, compare_source, load_audio
from audio_matcher.levels import Region
from audio_matcher.project import ClipState, Project

RATE = 48000


def _make_file(path: Path, level: float, seconds: float = 2.0) -> Path:
    rng = np.random.default_rng(int(level * 1000) & 0xFFFF)
    data = rng.normal(scale=level, size=int(seconds * RATE))
    sf.write(str(path), data, RATE, subtype="PCM_24")
    return path


def _project_with_two_clips(tmp_path: Path) -> Project:
    first = _make_file(tmp_path / "a.wav", 0.1)
    second = _make_file(tmp_path / "b.wav", 0.02)
    project = Project()
    project.import_paths([str(first), str(second)])
    for clip in project.clips:
        clip.regions = [Region("speech", 0, int(1.0 * RATE))]
    return project


def test_save_and_load_roundtrip(tmp_path: Path) -> None:
    project = _project_with_two_clips(tmp_path)
    project.target_override_db = -19.5
    path = project.save(tmp_path / "p.json")
    loaded = Project.load(path)
    assert len(loaded.clips) == 2
    assert loaded.target_override_db == pytest.approx(-19.5)
    assert loaded.clips[0].regions == project.clips[0].regions
    assert not loaded.dirty


def test_lock_survives_new_reference_and_reload(tmp_path: Path) -> None:
    project = _project_with_two_clips(tmp_path)
    locked = project.clips[1]
    project.set_locked(locked.id, True, gain_db=4.25, mode="headroom")
    project.set_reference(project.clips[0].id)
    project.save(tmp_path / "p.json")
    loaded = Project.load(tmp_path / "p.json")
    reloaded = loaded.find(locked.id)
    assert reloaded is not None
    assert reloaded.locked
    assert reloaded.locked_gain_db == pytest.approx(4.25)


def test_unlock_clears_captured_values(tmp_path: Path) -> None:
    project = _project_with_two_clips(tmp_path)
    clip = project.clips[0]
    project.set_locked(clip.id, True, gain_db=2.0)
    project.set_locked(clip.id, False)
    assert clip.locked_gain_db is None
    assert not clip.locked


def test_capture_lock_values_only_fills_once(tmp_path: Path) -> None:
    project = _project_with_two_clips(tmp_path)
    clip = project.clips[0]
    project.set_locked(clip.id, True, gain_db=None)
    project.capture_lock_values(clip.id, -3.0)
    project.capture_lock_values(clip.id, 9.0)
    assert clip.locked_gain_db == pytest.approx(-3.0)


def test_measurement_invalidated_by_selection_change(tmp_path: Path) -> None:
    project = _project_with_two_clips(tmp_path)
    clip = project.clips[0]
    audio = load_audio(clip.path)
    from audio_matcher.levels import measure_selection

    clip.mark_measurement(
        measure_selection(audio.samples, RATE, clip.speech_regions(), [])
    )
    assert clip.measurement is not None
    project.add_region(clip.id, "exclude", 0, RATE // 2)
    # add_region already drops the now-stale measurement; the signature check
    # is the safety net for edits made to the region list directly.
    assert clip.measurement is None
    clip.mark_measurement(
        measure_selection(audio.samples, RATE, clip.speech_regions(), [])
    )
    clip.regions.append(Region("speech", RATE, RATE * 2))
    assert clip.invalidate_if_stale()


def test_changed_source_clears_measurement_on_open(tmp_path: Path) -> None:
    project = _project_with_two_clips(tmp_path)
    clip = project.clips[0]
    audio = load_audio(clip.path)
    from audio_matcher.levels import measure_selection

    clip.mark_measurement(
        measure_selection(audio.samples, RATE, clip.speech_regions(), [])
    )
    clip.last_render_check = {"output_path": "x.wav"}
    path = project.save(tmp_path / "p.json")

    # Overwrite the source with different content, keeping the file name.
    replacement = np.random.default_rng(7).normal(scale=0.2, size=RATE * 2)
    sf.write(clip.path, replacement, RATE, subtype="PCM_24")

    loaded = Project.load(path)
    changes = loaded.check_sources()
    changed = loaded.find(clip.id)
    assert changed is not None
    assert clip.id in changes
    assert changed.measurement is None
    assert changed.last_render_check is None
    assert changed.needs_rematch


def test_unchanged_source_keeps_measurement(tmp_path: Path) -> None:
    project = _project_with_two_clips(tmp_path)
    path = project.save(tmp_path / "p.json")
    loaded = Project.load(path)
    assert loaded.check_sources() == {}


def test_compare_source_detects_same_size_edit(tmp_path: Path) -> None:
    path = _make_file(tmp_path / "c.wav", 0.1)
    stat = path.stat()
    snapshot = SourceSnapshot(
        path=str(path),
        fingerprint="not-the-real-hash",
        file_size=stat.st_size,
        file_mtime_ns=stat.st_mtime_ns,
    )
    change = compare_source(snapshot)
    assert change is not None and change.reason == "changed"


def test_compare_source_missing(tmp_path: Path) -> None:
    snapshot = SourceSnapshot(
        path=str(tmp_path / "gone.wav"),
        fingerprint="x",
        file_size=1,
        file_mtime_ns=1,
    )
    change = compare_source(snapshot)
    assert change is not None and change.reason == "missing"


def test_import_duplicate_path_reuses_clip(tmp_path: Path) -> None:
    project = _project_with_two_clips(tmp_path)
    first_path = project.clips[0].path
    added, errors = project.import_paths([first_path])
    assert not errors
    assert len(project.clips) == 2
    assert added[0].id == project.clips[0].id


def test_project_rejects_newer_version() -> None:
    with pytest.raises(ValueError):
        Project.from_dict({"version": 999, "clips": []})


def test_clip_state_serializes_render_check(tmp_path: Path) -> None:
    project = _project_with_two_clips(tmp_path)
    clip = project.clips[0]
    clip.last_render_check = {"status": "ok", "limited_runs": [{"start_s": 1.0}]}
    data = clip.to_dict()
    restored = ClipState.from_dict(data)
    assert restored.last_render_check == clip.last_render_check
