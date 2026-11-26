import numpy as np
import pytest

from ambi_rotate.wavio import read_wav, write_wav


@pytest.mark.parametrize("subtype", ["pcm16", "pcm24", "float32"])
def test_wav_roundtrip(tmp_path, subtype):
    rng = np.random.default_rng(5)
    x = rng.uniform(-0.9, 0.9, (1000, 4))
    path = str(tmp_path / f"x_{subtype}.wav")
    write_wav(path, x, 32000, subtype=subtype)
    w = read_wav(path)
    assert w.sample_rate == 32000
    assert w.data.shape == (1000, 4)
    tol = {"pcm16": 2e-4, "pcm24": 2e-7, "float32": 1e-7}[subtype]
    assert np.max(np.abs(w.data - x)) < tol


def test_stereo_export_layout(tmp_path):
    x = np.linspace(-0.5, 0.5, 200).reshape(-1, 1)
    stereo = np.repeat(x, 2, axis=1)
    path = str(tmp_path / "s.wav")
    write_wav(path, stereo, 24000, subtype="pcm16")
    w = read_wav(path)
    assert w.channels == 2
    assert np.allclose(w.data[:, 0], w.data[:, 1], atol=2e-4)
