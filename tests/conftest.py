from __future__ import annotations

import shutil
from pathlib import Path

import pytest

from mkv_tool.sample import generate_sample


@pytest.fixture(scope="session")
def ffmpeg_available() -> bool:
    return shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None


@pytest.fixture()
def sample_path(tmp_path: Path, ffmpeg_available: bool) -> Path:
    if not ffmpeg_available:
        pytest.skip("ffmpeg/ffprobe not installed")
    return generate_sample(tmp_path / "multitrack.mkv")


@pytest.fixture()
def offset_sample_path(tmp_path: Path, ffmpeg_available: bool) -> Path:
    if not ffmpeg_available:
        pytest.skip("ffmpeg/ffprobe not installed")
    return generate_sample(tmp_path / "offsets.mkv", offset_demo=True)
