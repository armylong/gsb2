import numpy as np
import pytest

from pitchshift_tool.pipeline import (
    CancelToken,
    CancelledError,
    pitch_shift,
    pitch_shift_channel,
    time_stretch,
)

SR = 44100


def tone(freq, seconds=1.0, sr=SR, phase=0.0):
    t = np.arange(int(sr * seconds)) / sr
    return (0.6 * np.sin(2 * np.pi * freq * t + phase)).astype(np.float32)


def test_zero_shift_is_exact_identity_mono_and_stereo():
    mono = tone(440, 0.5)
    stereo = np.stack([mono, tone(330, 0.5)], axis=1)
    assert np.array_equal(pitch_shift(mono, SR, 0.0), mono)
    out_st = pitch_shift(stereo, SR, 0.0)
    assert np.array_equal(out_st, stereo)
    assert out_st.dtype == np.float32


@pytest.mark.parametrize("semi", [-5.0, -0.5, 2.0, 3.0, 7.0])
def test_shape_and_length_preserved(semi):
    stereo = np.stack([tone(440, 1.0), tone(330, 1.0)], axis=1)
    out = pitch_shift(stereo, SR, semi)
    assert out.shape == stereo.shape
    assert out.dtype == np.float32
    mono = tone(440, 0.8)
    assert pitch_shift(mono, SR, semi).shape == mono.shape


def test_sustained_frequency_follows_semitones():
    from pitchshift_tool.analysis import dominant_frequency

    f0 = 440.0
    x = tone(f0, 1.5)
    # 避开首尾边界, 在中段测量
    for semi in (-3.0, 2.0, 5.0):
        shifted = pitch_shift_channel(x, SR, semi)
        measured = dominant_frequency(shifted, SR, 0.4, 1.2)
        expected = f0 * 2 ** (semi / 12.0)
        assert measured == pytest.approx(expected, rel=0.012), (
            f"semi={semi}: {measured:.2f} vs {expected:.2f}"
        )


def test_onset_time_stays_in_place():
    from pitchshift_tool.analysis import onset_times

    sr = SR
    n = sr  # 1 秒
    x = tone(220, 1.0) * 0.2
    center = int(0.5 * sr)
    # 宽频短脉冲模拟鼓点
    decay = np.exp(-np.arange(400) / (0.02 * sr))
    rng = np.random.default_rng(0)
    x[center : center + 400] += 0.9 * decay * rng.standard_normal(400)

    for semi in (-4.0, 4.0):
        out = pitch_shift_channel(x.astype(np.float32), sr, semi)
        t_before = onset_times(x, sr, 0.3, 0.7)
        t_after = onset_times(out, sr, 0.3, 0.7)
        assert t_before and t_after
        # 音头漂移应远小于一个窗长 (约 46ms)
        assert abs(t_after[0] - t_before[0]) < 0.03


def test_identical_stereo_channels_remain_identical():
    # 两声道完全相同 (居中声像) -> 处理后仍逐采样相同, 不会偏到一侧
    mono = tone(440, 1.0)
    stereo = np.repeat(mono[:, None], 2, axis=1)
    out = pitch_shift(stereo, SR, 3.0)
    assert np.array_equal(out[:, 0], out[:, 1])

    # 左右内容不同时, 差异应保留 (不会被混成相同)
    diff = np.stack([tone(440, 1.0), tone(660, 1.0)], axis=1)
    out2 = pitch_shift(diff, SR, 3.0)
    assert not np.allclose(out2[:, 0], out2[:, 1])


def test_time_stretch_length_relation():
    x = tone(440, 1.0)
    rate = 2.0 ** (-2 / 12.0)  # +2 半音 -> 拉长
    stretched = time_stretch(x, rate, 2048, 512)
    assert abs(len(stretched) - round(len(x) / rate)) <= 512
    assert len(stretched) > len(x)


def test_cancel_token_aborts_processing():
    token = CancelToken()
    token.cancel()
    with pytest.raises(CancelledError):
        pitch_shift_channel(tone(440, 2.0), SR, 2.0, token=token)


def test_progress_reaches_one():
    seen = []
    pitch_shift_channel(tone(440, 0.5), SR, 2.0, progress_cb=seen.append)
    assert seen and seen[-1] == 1.0


def test_stereo_progress_aggregates_channels():
    stereo = np.stack([tone(440, 0.5), tone(330, 0.5)], axis=1)
    seen = []
    pitch_shift(stereo, SR, 2.0, progress_cb=seen.append)
    assert seen[-1] == 1.0
    assert max(seen) <= 1.0
