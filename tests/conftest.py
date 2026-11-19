from __future__ import annotations

import os
from pathlib import Path

import pytest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")


@pytest.fixture(scope="session")
def sample_dir(tmp_path_factory) -> Path:
    """一次生成全部样例，供多个测试共享。"""
    from reverb_tool.samples import write_all

    directory = tmp_path_factory.mktemp("samples")
    write_all(directory)
    return directory


@pytest.fixture()
def dry_impulse(tmp_path: Path):
    """长度可预测的单声道干声：单点脉冲。"""
    from reverb_tool.audio_io import write_wav

    path = tmp_path / "dry_impulse.wav"
    samples = [0.0] * 64
    samples[10] = 0.8
    write_wav(path, samples, 8000)
    return path


@pytest.fixture()
def echo_ir(tmp_path: Path):
    from reverb_tool.audio_io import write_wav

    path = tmp_path / "echo_ir.wav"
    samples = [0.0] * 400
    samples[0] = 1.0
    samples[400] = 0.0
    samples[200] = 0.5   # 25 ms @ 8 kHz
    write_wav(path, samples, 8000)
    return path
