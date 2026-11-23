"""Tests for WAV IO: round trips, bit depths, error handling."""

from __future__ import annotations

import struct

import numpy as np
import pytest

from clipmend.samples import ensure_samples
from clipmend.wavio import (
    WavError,
    encode_wav,
    load_wav,
    quantize,
    save_wav,
)


def test_demo_samples_exist_and_are_stereo(samples_dir):
    paths = ensure_samples(samples_dir)
    assert set(paths) == {"short_peak", "long_flat"}
    for key, path in paths.items():
        wav = load_wav(path)
        assert wav.channels == 2
        assert wav.sample_rate == 22050
        assert wav.duration <= 60.0
        assert np.abs(wav.samples).max() <= 1.0
        assert path.exists()


@pytest.mark.parametrize("bits", [16, 24, 32])
def test_round_trip_is_exact_for_quantized_values(tmp_path, bits):
    rng = np.random.default_rng(0)
    codes = rng.integers(-(2 ** (bits - 1)), 2 ** (bits - 1) - 1, size=(500, 2))
    scale = float(2 ** (bits - 1))
    samples = codes / scale
    path = tmp_path / f"round_{bits}.wav"
    save_wav(path, samples, 48000, bits)
    loaded = load_wav(path)
    assert loaded.bits_per_sample == bits
    assert loaded.sample_rate == 48000
    assert loaded.frames == 500
    assert np.allclose(loaded.samples, samples, atol=0.0, rtol=0.0)


def test_quantize_matches_decode_scale():
    x = np.array([0.0, 0.5, -0.5, 1.0, -1.0])
    q16 = quantize(x, 16)
    assert list(q16) == [0, 16384, -16384, 32767, -32768]
    # The decode scale is 2**15, so 1.0 maps to 32767/32768 on the way back.
    assert np.allclose(q16 / 32768.0, [0.0, 0.5, -0.5, 32767 / 32768.0, -1.0])


def test_eight_bit_round_trip(tmp_path):
    x = np.linspace(-1.0, 1.0, 257).reshape(-1, 1)
    path = tmp_path / "eight.wav"
    save_wav(path, x, 8000, 8)
    loaded = load_wav(path)
    assert loaded.bits_per_sample == 8
    assert np.max(np.abs(loaded.samples[:, 0] - x[:, 0])) <= 1.0 / 128.0


def test_mono_round_trip(tmp_path):
    x = np.sin(np.linspace(0, 20, 1000)) * 0.5
    path = tmp_path / "mono.wav"
    save_wav(path, x, 16000, 16)
    loaded = load_wav(path)
    assert loaded.channels == 1
    assert loaded.frames == 1000


def test_rejects_non_wav(tmp_path):
    path = tmp_path / "not.wav"
    path.write_bytes(b"this is not audio")
    with pytest.raises(WavError):
        load_wav(path)


def test_rejects_float_format(tmp_path):
    payload = np.zeros(100, dtype="<f4").tobytes()
    fmt = struct.pack("<HHIIHH", 3, 2, 44100, 44100 * 8, 8, 32)
    header = b"RIFF" + struct.pack("<I", 4 + 8 + len(fmt) + 8 + len(payload)) + b"WAVE"
    header += b"fmt " + struct.pack("<I", len(fmt)) + fmt
    header += b"data" + struct.pack("<I", len(payload))
    path = tmp_path / "float.wav"
    path.write_bytes(header + payload)
    with pytest.raises(WavError):
        load_wav(path)


def test_rejects_too_long(tmp_path):
    x = np.zeros((int(3 * 8000), 1))
    path = tmp_path / "long.wav"
    save_wav(path, x, 8000, 16)
    with pytest.raises(WavError):
        load_wav(path, max_seconds=2.0)


def test_rejects_more_than_two_channels(tmp_path):
    x = np.zeros((100, 4))
    path = tmp_path / "four.wav"
    save_wav(path, x, 44100, 16)
    with pytest.raises(WavError):
        load_wav(path)


def test_truncated_data_chunk_is_tolerated(tmp_path):
    x = np.sin(np.linspace(0, 30, 2000)) * 0.4
    raw = encode_wav(x, 16000, 16)
    truncated = raw[: len(raw) - 200]
    path = tmp_path / "truncated.wav"
    path.write_bytes(truncated)
    loaded = load_wav(path)
    assert loaded.frames < 2000
    assert loaded.frames > 0
