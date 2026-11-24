import numpy as np

from audio_integrity.audio_io import AudioData, load_wav, write_wav


def test_write_and_read_mono_stereo_wav(tmp_path):
    sr = 16000
    t = np.arange(sr // 4) / sr
    mono = (0.4 * np.sin(2 * np.pi * 440 * t)).astype(np.float32)
    mono_path = tmp_path / "mono.wav"
    write_wav(mono_path, mono, sr)
    loaded = load_wav(mono_path)
    assert loaded.n_channels == 1
    assert loaded.sample_rate == sr
    assert loaded.duration == 0.25
    assert np.allclose(loaded.samples[:, 0], mono, atol=2 / 32768)

    stereo = np.column_stack([mono, -mono])
    stereo_path = tmp_path / "stereo.wav"
    write_wav(stereo_path, AudioData(stereo, sr))
    loaded_st = load_wav(stereo_path)
    assert loaded_st.n_channels == 2
    assert loaded_st.samples.shape == (mono.size, 2)
    assert np.allclose(loaded_st.samples[:, 1], -mono, atol=2 / 32768)
