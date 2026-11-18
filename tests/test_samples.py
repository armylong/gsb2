from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import numpy as np

from drumchopper.audio import detect_onsets, read_wav
from drumchopper.samples import generate_demo, write_demo


def test_demo_is_stereo_with_distinct_channels():
    samples, hits = generate_demo()
    assert samples.ndim == 2 and samples.shape[1] == 2
    assert samples.dtype == np.float32
    assert not np.allclose(samples[:, 0], samples[:, 1])
    assert hits, "至少要有一次击打"
    # different attack lengths / long tail must both exist
    durations = sorted({h.name for h in hits})
    assert {"kick", "snare", "hat", "crash"} <= set(durations)
    assert max(h.duration for h in hits) > 40000  # crash tail > 0.9 s


def test_known_onsets_are_exact_sample_positions(tmp_path: Path):
    wav = tmp_path / "demo.wav"
    meta = write_demo(wav, tmp_path / "demo.json")
    assert {h["start"] for h in meta["hits"]} == set(meta["onsets"])
    # onsets are strictly increasing and inside the material
    assert meta["onsets"] == sorted(meta["onsets"])
    assert all(0 <= s < meta["frames"] for s in meta["onsets"])
    # the file on disk has the announced frame count
    source = read_wav(wav)
    assert source.frames == meta["frames"]
    assert source.channels == 2


def test_detector_finds_known_attacks_within_tolerance():
    samples, hits = generate_demo()
    known = sorted({h.start for h in hits if 0 < h.start < samples.shape[0]})
    detected = detect_onsets(samples, 44100)
    assert detected, "检测器应至少给出一个候选"
    tolerance = int(0.010 * 44100)  # 10 ms is plenty for initial suggestions
    for start in known[:8]:
        assert any(abs(d - start) <= tolerance for d in detected), f"漏检 {start}"
    for d in detected:
        assert min(abs(d - k) for k in known) <= tolerance, f"误检 {d}"
    # suggestions never exceed the slice budget and stay inside the material
    assert len(detected) <= 15
    assert all(0 < d < samples.shape[0] for d in detected)


def test_demo_cli(tmp_path: Path):
    wav = tmp_path / "cli.wav"
    result = subprocess.run(
        [sys.executable, "-m", "drumchopper.samples", str(wav), "--seconds", "2.0"],
        capture_output=True, text=True, check=True,
    )
    assert wav.exists()
    meta = json.loads((tmp_path / "cli_onsets.json").read_text())
    assert meta["frames"] == int(2.0 * 44100)
    assert "已知起音" in result.stdout
