"""Shared test helpers: in-memory source material with known content."""

from __future__ import annotations

import numpy as np

from drumchopper.audio import SourceAudio


def impulse_source(frames: int = 4000, samplerate: int = 1000) -> SourceAudio:
    """Mono material with identifiable one-sample markers."""
    data = np.zeros(frames, dtype=np.float32)
    data[100] = 0.9
    data[1100] = 0.6
    data[2100] = 0.4
    data[3100] = 0.3
    return SourceAudio(samples=data, samplerate=samplerate, name="impulse")


def ramp_source(frames: int = 8000, samplerate: int = 1000,
                channels: int = 2) -> SourceAudio:
    """Stereo material whose channels differ, for stereo-integrity tests."""
    left = np.zeros(frames, dtype=np.float32)
    right = np.zeros(frames, dtype=np.float32)
    left[500:5500] = 0.25
    right[500:5500] = -0.5
    for ch, arr in enumerate((left, right)):
        del ch
        arr[2000:2200] *= 0.3
    if channels == 1:
        data = left
    else:
        data = np.stack([left, right], axis=1)
    return SourceAudio(samples=data, samplerate=samplerate, name="ramp")


def rms(x: np.ndarray) -> float:
    if x.size == 0:
        return 0.0
    return float(np.sqrt(np.mean(np.square(np.asarray(x, dtype=np.float64)))))
