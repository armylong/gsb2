"""核心 DSP 验证：所有数值都取自实际渲染输出。"""

from __future__ import annotations

import numpy as np
import pytest

from reverb_tool.audio_io import load_dry, load_impulse, write_wav
from reverb_tool.dsp import ReverbParams, render, resample_impulse


def _stereo_dry(tmp_path, frames=200, sr=8000):
    path = tmp_path / "dry.wav"
    samples = np.zeros((frames, 2))
    samples[5, 0] = 0.6
    samples[50, 1] = 0.3
    write_wav(path, samples, sr)
    return load_dry(path)


def test_full_tail_length_and_predelay(sample_dir):
    """完整尾音长度 = 干声点数 + 实际响应点数 - 1 + 预延迟点数。"""
    dry = load_dry(sample_dir / "dry_note_48k.wav")
    ir = load_impulse(sample_dir / "ir_echoes_48k.wav")
    for predelay_ms in (0.0, 5.0, 37.0):
        result = render(
            dry, ir, ReverbParams(mix=0.4, predelay_ms=predelay_ms, protection=False)
        )
        predelay = round(predelay_ms / 1000.0 * dry.sample_rate)
        expected = dry.frames + ir.frames - 1 + predelay
        assert result.frames == expected, (predelay_ms, result.frames, expected)
        assert result.samples.shape == (expected, 2)
        assert result.dry_end_frame == predelay + dry.frames
        assert result.tail_frames == ir.frames - 1
        # 尾音段确实保留在输出里（这是完整卷积的最后一个采样点之后）
        assert result.samples.shape[0] == expected
        assert result.crop_frames(result.dry_end_frame, result.frames).shape[0] == (
            ir.frames - 1
        )


def test_mix_extremes_and_endpoint_frames(tmp_path):
    """纯干声 / 纯混响两端：数值来自实际输出。"""
    dry = _stereo_dry(tmp_path)
    ir_path = tmp_path / "ir.wav"
    taps = np.zeros(16)
    taps[0] = 0.7
    taps[8] = 0.35  # 1 ms @ 8 kHz
    write_wav(ir_path, taps, 8000)
    ir = load_impulse(ir_path)

    pure_dry = render(dry, ir, ReverbParams(mix=0.0, predelay_ms=0.0))
    # 纯干声：输出前 dry.frames 点与原声逐样本相同，后面全零
    assert np.allclose(
        pure_dry.samples[: dry.frames], dry.samples, atol=1e-12
    )
    assert np.max(np.abs(pure_dry.samples[dry.frames :])) == 0.0

    pure_wet = render(dry, ir, ReverbParams(mix=1.0, predelay_ms=0.0))
    # 纯混响在干声样本位置上不包含干声；直接声位置应只剩卷积
    expected_l = np.convolve(dry.samples[:, 0], taps)
    assert np.allclose(pure_wet.samples[:, 0], expected_l, atol=1e-12)
    assert not np.allclose(pure_wet.samples[: dry.frames], dry.samples)


def test_predelay_shifts_everything_without_changing_shape(tmp_path):
    dry = _stereo_dry(tmp_path)
    ir_path = tmp_path / "ir.wav"
    write_wav(ir_path, [1.0, 0.0, 0.5], 8000)
    ir = load_impulse(ir_path)

    base = render(dry, ir, ReverbParams(mix=1.0, predelay_ms=0.0))
    shift_frames = 12
    delayed = render(
        dry, ir, ReverbParams(mix=1.0, predelay_ms=shift_frames / 8000 * 1000)
    )
    assert delayed.predelay_frames == shift_frames
    assert delayed.frames == base.frames + shift_frames
    assert np.max(np.abs(delayed.samples[:shift_frames])) == 0.0
    assert np.allclose(delayed.samples[shift_frames:], base.samples, atol=1e-12)


def test_channels_do_not_bleed(tmp_path):
    """只出现在左声道的脉冲，右声道必须保持零。"""
    dry = _stereo_dry(tmp_path)
    ir_path = tmp_path / "ir.wav"
    taps = np.zeros(40)
    taps[0] = 1.0
    taps[17] = 0.4
    write_wav(ir_path, taps, 8000)
    ir = load_impulse(ir_path)

    result = render(
        dry, ir, ReverbParams(mix=1.0, predelay_ms=3.0, protection=False)
    )
    left_only_frame = 5 + result.predelay_frames
    # 左声道原始脉冲的能量不应出现在右声道
    # fftconvolve 有 ~1e-17 的浮点底噪，用 -240 dBFS 作为"无声"判据。
    right_after_left = result.samples[left_only_frame : left_only_frame + 40, 1]
    assert np.max(np.abs(right_after_left)) < 1e-12
    left_after_left = result.samples[left_only_frame : left_only_frame + 40, 0]
    assert np.max(np.abs(left_after_left)) > 0.1
    # 右声道自己的脉冲只影响右声道
    right_frame = 50 + result.predelay_frames
    right_after_right = result.samples[right_frame : right_frame + 80, 1]
    assert np.max(np.abs(right_after_right)) > 0.1
    assert np.max(np.abs(result.samples[right_frame : right_frame + 40, 0])) < 1e-12


def test_protection_is_shared_scalar(sample_dir):
    """保护后左右比例不变，且峰值不超过上限。"""
    dry = load_dry(sample_dir / "dry_stereo_48k.wav")
    ir = load_impulse(sample_dir / "ir_echoes_48k.wav")
    params = ReverbParams(mix=1.0, output_gain_db=12.0, protection=False)
    unprotected = render(dry, ir, params)
    assert unprotected.raw_peak > 1.0

    protected = render(
        dry, ir, ReverbParams(mix=1.0, output_gain_db=12.0, protection=True)
    )
    ratio_before = np.divide(
        unprotected.samples,
        protected.samples,
        out=np.zeros_like(protected.samples),
        where=np.abs(protected.samples) > 1e-12,
    )
    used = np.abs(protected.samples) > 1e-9
    assert np.allclose(ratio_before[used], ratio_before[used][0], rtol=1e-9)
    assert protected.output_peak <= 10 ** (-0.1 / 20) + 1e-12
    assert unprotected.raw_peak == pytest.approx(protected.raw_peak, rel=1e-12)
    assert protected.protection_gain_db < 0


def test_no_implicit_ir_normalization(tmp_path):
    """响应整体放大 6 dB，输出也应整体放大 6 dB（不做自动归一化）。"""
    dry = _stereo_dry(tmp_path)
    ir_path = tmp_path / "ir.wav"
    write_wav(ir_path, [0.2, 0.1, 0.05], 8000)
    ir = load_impulse(ir_path)
    doubled_path = tmp_path / "ir2.wav"
    write_wav(doubled_path, [0.4, 0.2, 0.1], 8000)
    ir2 = load_impulse(doubled_path)

    a = render(dry, ir, ReverbParams(mix=1.0, protection=False))
    b = render(dry, ir2, ReverbParams(mix=1.0, protection=False))
    assert np.allclose(b.samples, a.samples * 2.0, rtol=1e-9, atol=1e-15)


def test_sample_rate_mismatch_uses_dry_rate(sample_dir):
    """两份采样率不同时以干声采样率处理，界面长度按重采样后的实际点数。"""
    dry = load_dry(sample_dir / "dry_stereo_48k.wav")
    ir = load_impulse(sample_dir / "ir_echoes_44k1.wav")
    assert ir.sample_rate == 44100
    resampled = resample_impulse(dry, ir)
    result = render(dry, ir, ReverbParams(mix=0.5, predelay_ms=0.0))
    assert result.dry_sample_rate == 48000
    assert result.ir_sample_rate == 44100
    assert result.ir_frames_used == len(resampled)
    assert result.frames == dry.frames + len(resampled) - 1
    # 使用长度接近原始时长（0.5 s）
    assert result.ir_used_duration_s == pytest.approx(0.5, abs=0.01)


def test_echo_position_and_amplitude(sample_dir):
    """已知回声位置/幅度：脉冲干声 + 离散响应，直接读输出采样。"""
    from reverb_tool.samples import impulse_response

    tmp = sample_dir
    spec = impulse_response(tmp / "check_ir.wav", sample_rate=8000, length_s=0.5)
    ir = load_impulse(spec.path)
    dry_path = tmp / "check_dry.wav"
    samples = np.zeros(32)
    samples[0] = 1.0
    write_wav(dry_path, samples, 8000)
    dry = load_dry(dry_path)

    result = render(
        dry, ir, ReverbParams(mix=1.0, predelay_ms=0.0, protection=False)
    )
    taps = spec.expected["taps"]
    for delay_s, gain in taps:
        index = round(delay_s * 8000)
        assert result.samples[index, 0] == pytest.approx(gain, abs=1e-12)
        assert result.samples[index, 1] == pytest.approx(gain, abs=1e-12)


def test_output_time_axis_matches_dry_timeline(sample_dir):
    """干声终点、尾音终点都落在输出时间轴上，且可据此截取尾音。"""
    dry = load_dry(sample_dir / "dry_note_48k.wav")
    ir = load_impulse(sample_dir / "ir_echoes_48k.wav")
    result = render(dry, ir, ReverbParams(mix=1.0, predelay_ms=20.0))
    assert result.dry_end_s == pytest.approx(
        result.predelay_frames / result.dry_sample_rate + result.dry_duration_s
    )
    tail = result.crop_frames(result.dry_end_frame, result.frames)
    assert tail.shape[0] == result.tail_frames
    assert np.array_equal(tail, result.samples[result.dry_end_frame :])
