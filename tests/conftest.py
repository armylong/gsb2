"""Pytest fixtures shared across the test suite."""
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from slitscan import synth  # noqa: E402
from slitscan.video import decode_frames, probe  # noqa: E402


def _make_frames(n: int, h: int = 24, w: int = 48) -> np.ndarray:
    """Synthetic RGB frames: gradient background + moving bright bar."""
    frames = np.zeros((n, h, w, 3), dtype=np.uint8)
    rng = np.random.default_rng(42)
    for i in range(n):
        frames[i, :, :, 2] = np.linspace(0, 50, w, dtype=np.uint8)[None, :]
        x = (i * 3) % (w - 4)
        frames[i, :, x:x + 4] = (200, 200, 200)
        frames[i] += rng.integers(0, 3, frames[i].shape, dtype=np.uint8)
    return frames


@pytest.fixture
def frames_and_ts():
    frames = _make_frames(30)
    ts = np.round(np.arange(30) * 0.1, 3)  # 10 fps CFR
    return frames, ts


@pytest.fixture
def vfr_frames_and_ts():
    frames = _make_frames(20)
    # uneven presentation times, monotonic
    gaps = np.array([0.2, 0.05, 0.15, 0.1] * 5)
    ts = np.concatenate([[0.0], np.cumsum(gaps)[:19]])
    return frames, ts.astype(float)


@pytest.fixture(scope="session")
def sample_clips(tmp_path_factory):
    """Generate the three built-in clips once per session."""
    base = tmp_path_factory.mktemp("clips")
    paths = {}
    for pattern in synth.PATTERNS:
        paths[pattern] = synth.generate(
            pattern, str(base / f"{pattern}.mp4"), n_frames=30, fps=10)
    return paths


@pytest.fixture(scope="session")
def decoded_constant(sample_clips):
    info = probe(str(sample_clips["constant"]))
    frames, ts = decode_frames(str(sample_clips["constant"]), info)
    return info, frames, ts
