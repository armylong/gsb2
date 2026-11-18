"""Headless GUI-level flow: load a wav, edit, export, verify the produced file."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

from drumchopper import audio as A


@pytest.fixture(scope="module")
def qapp():
    from PySide6.QtWidgets import QApplication

    return QApplication.instance() or QApplication([])


@pytest.fixture()
def window(qapp, tmp_path):
    from drumchopper.ui.main_window import MainWindow

    w = MainWindow()
    w.player._ensure_stream = lambda: False  # never touch a real audio device
    yield w
    w.close()


def prepare_demo(tmp_path: Path) -> tuple[Path, dict]:
    from drumchopper.samples import write_demo

    wav = tmp_path / "demo.wav"
    meta = write_demo(wav, tmp_path / "demo_onsets.json")
    return wav, meta


def test_load_limits_slices_and_populates_grid(window, tmp_path):
    wav, meta = prepare_demo(tmp_path)
    window._load_path(wav)
    assert window.model is not None and window.source is not None
    assert window.model.count <= A.MAX_SLICES
    assert len(window.sequence.steps) == A.STEPS
    assert window.export_btn.isEnabled()
    assert window.file_label.text().startswith("demo.wav")
    # first slice starts at 0, last ends at the material end
    bounds = window.model.slice_bounds()
    assert bounds[0][0] == 0 and bounds[-1][1] == window.source.frames
    assert all(e > s for s, e in bounds)


def test_seeded_onsets_are_deduplicated(window, tmp_path):
    wav, meta = prepare_demo(tmp_path)
    duplicated = meta["onsets"] + meta["onsets"] + [0, -3, 10 ** 9]
    window._load_path(wav, seed_onsets=duplicated)
    assert window.model.cuts == sorted(set(window.model.cuts))
    assert all(0 < c < window.source.frames for c in window.model.cuts)
    assert window.model.count <= A.MAX_SLICES


def test_export_from_window_matches_grid_and_length(window, tmp_path):
    wav, meta = prepare_demo(tmp_path)
    window._load_path(wav)
    window.transport.fade.setValue(0.0)  # pure content comparison
    window.transport.bpm.setValue(140.0)
    # a deliberately sparse pattern: one repeated slice and one empty run
    window.sequence.steps = [None] * A.STEPS
    window.sequence.steps[0] = 0
    window.sequence.steps[3] = 0
    window.sequence.steps[8] = min(2, window.model.count - 1)
    window.on_sequence_changed()

    out = tmp_path / "pattern.wav"
    info = window.export_to(out)
    assert info is not None and out.exists()
    sr = window.source.samplerate
    expected_frames = A.sequence_length_samples(140.0, sr)
    assert info["frames"] == expected_frames
    assert info["steps"] == window.sequence.steps
    assert info["step_samples"] == A.step_samples(140.0, sr)

    back = A.read_wav(out)
    assert back.frames == expected_frames
    assert back.channels == window.source.channels
    # the exported file contains the slice content at the stated trigger
    start, end = window.model.slice_bounds()[0]
    offset = info["step_samples"][0]
    n = min(end - start, info["step_samples"][3])  # until the repeat
    np.testing.assert_allclose(back.samples[offset:offset + n],
                               window.source.samples[start:start + n], atol=1e-6)
    # the empty step 1 region only carries the tail (no new attack)
    s1 = info["step_samples"][1]
    assert np.allclose(back.samples[s1:s1 + 32],
                       window.source.samples[start + (s1 - offset):start + (s1 - offset) + 32],
                       atol=1e-6)


def test_sidecar_json_roundtrip(window, tmp_path):
    wav, meta = prepare_demo(tmp_path)
    window._load_path(wav)
    out = tmp_path / "with_meta.wav"
    window.export_to(out)
    data = json.loads(out.with_suffix(".json").read_text())
    assert data["samplerate"] == window.source.samplerate
    assert data["channels"] == window.source.channels
    assert len(data["steps"]) == A.STEPS
    assert len(data["slices"]) == window.model.count
    assert data["frames"] == A.sequence_length_samples(data["bpm"], data["samplerate"])


def test_fade_setting_is_applied_on_export(window, tmp_path):
    wav, meta = prepare_demo(tmp_path)
    window._load_path(wav)
    window.transport.fade.setValue(10.0)
    window.sequence.steps = [None] * A.STEPS
    window.sequence.steps[0] = 0
    info = window.export_to(tmp_path / "faded.wav")
    assert info is not None
    audio = A.read_wav(tmp_path / "faded.wav").samples
    n = int(round(0.01 * window.source.samplerate))
    start = window.model.slice_bounds()[0][0]
    # first sample is faded to silence, the middle is untouched
    assert abs(float(audio[0, 0])) < 1e-4
    mid = n + 10
    np.testing.assert_allclose(audio[mid:mid + 50], window.source.samples[start + mid:start + mid + 50],
                               atol=1e-6)


def test_changing_cut_invalidates_render(window, tmp_path):
    wav, meta = prepare_demo(tmp_path)
    window._load_path(wav)
    out1 = tmp_path / "a.wav"
    info1 = window.export_to(out1)
    assert info1 is not None
    # move the first interior cut and export again
    window.model.move_cut(0, window.model.cuts[0] + 2000)
    window.on_cuts_changed()
    out2 = tmp_path / "b.wav"
    info2 = window.export_to(out2)
    assert info2 is not None
    assert info2["slices"] != info1["slices"]
    a = A.read_wav(out1).samples
    b = A.read_wav(out2).samples
    assert a.shape == b.shape
    assert not np.allclose(a, b)


def test_pattern_references_shrink_when_slices_are_removed(window, tmp_path):
    wav, meta = prepare_demo(tmp_path)
    window._load_path(wav)
    last = window.model.count - 1
    window.sequence.steps[5] = last
    # remove all interior cuts => one slice; stale references must be cleared
    window.model.set_cuts([])
    window.on_cuts_changed()
    assert window.model.count == 1
    assert all(s is None or s == 0 for s in window.sequence.steps)


def test_bpm_change_updates_displayed_step_times(window, tmp_path):
    wav, meta = prepare_demo(tmp_path)
    window._load_path(wav)
    window.transport.bpm.setValue(150.0)
    expected = A.step_samples(150.0, window.source.samplerate)
    assert window.grid._step_samples == expected
    assert window.grid._samplerate == window.source.samplerate


def test_audition_uses_slice_bounds_without_device(window, tmp_path):
    wav, meta = prepare_demo(tmp_path)
    window._load_path(wav)
    # no device is available; auditioning should report an error but not crash
    window.audition_selected()
    assert "无法播放" in window.status.currentMessage()
