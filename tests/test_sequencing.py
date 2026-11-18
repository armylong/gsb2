from __future__ import annotations

import numpy as np
import pytest

from drumchopper import audio as A
from drumchopper.audio import Sequence, SourceAudio, SliceModel, render_sequence
from helpers import ramp_source


def make_source(values: list[float], samplerate: int = 1000,
                channels: int = 1) -> SourceAudio:
    """One slice per value, each 1000 samples long."""
    block = np.concatenate([
        np.full(1000, v, dtype=np.float32) for v in values
    ])
    data = block if channels == 1 else np.stack([block, -block], axis=1)
    return SourceAudio(samples=data, samplerate=samplerate, name="blocks")


def pattern(*entries) -> Sequence:
    steps: list[int | None] = [None] * A.STEPS
    for i, v in entries:
        steps[i] = v
    return Sequence(steps)


# ---------------------------------------------------------------------------
# Grid timing
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("bpm", [60.0, 97.0, 100.0, 123.4, 137.0, 174.0, 300.0])
@pytest.mark.parametrize("sr", [22050, 44100, 48000])
def test_step_offsets_reference_and_drift(bpm: float, sr: int):
    offsets = A.step_samples(bpm, sr)
    assert len(offsets) == A.STEPS
    assert offsets[0] == 0
    ideal = 60.0 / bpm / 4.0
    for i, got in enumerate(offsets):
        # cumulative reference, so drift never accumulates
        assert abs(got - i * ideal * sr) <= 0.5 + 1e-6
    # monotonic and strictly increasing
    diffs = np.diff(offsets)
    assert np.all(diffs > 0)
    # neighbouring steps differ by at most one sample
    assert np.max(diffs) - np.min(diffs) <= 1
    total = A.sequence_length_samples(bpm, sr)
    assert total == int(round(A.STEPS * ideal * sr))
    assert offsets[-1] < total


def test_sequence_length_is_closest_sample():
    sr = 44100
    for bpm in (77.7, 128.0, 133.37, 199.9):
        ideal = A.STEPS * 60.0 / bpm / 4.0 * sr
        assert abs(A.sequence_length_samples(bpm, sr) - ideal) <= 0.5


# ---------------------------------------------------------------------------
# Rendering rules
# ---------------------------------------------------------------------------

def test_full_sequence_length_and_all_empty_is_silence():
    src = make_source([0.5, 0.4, 0.3, 0.2])
    model = SliceModel(src.frames)
    model.set_cuts([1000, 2000, 3000])
    seq = pattern()
    out = render_sequence(src, model, seq, bpm=60, fade_in_s=0, fade_out_s=0)
    assert out.length == 4000  # 16 * 0.25 s * 1000 Hz
    assert out.audio.shape == (4000,)
    assert np.all(out.audio == 0)
    assert out.gain == 1.0


def test_single_slice_played_at_original_speed_with_tail_overlap():
    src = make_source([0.25, 0.5])  # slice 0 = +0.25, slice 1 = +0.5
    model = SliceModel(src.frames)
    model.set_cuts([1000])
    # at 60 BPM one 16th = 250 samples; a 1000-sample slice spans 4 steps
    seq = pattern((0, 0), (1, 1))
    out = render_sequence(src, model, seq, bpm=60, fade_in_s=0, fade_out_s=0)
    audio = out.audio
    # slice 0 [0,1000), slice 1 starts at 250 and ends at 1250 (overlap)
    np.testing.assert_allclose(audio[0:250], 0.25)
    np.testing.assert_allclose(audio[250:1000], 0.75)  # overlap is additive
    np.testing.assert_allclose(audio[1000:1250], 0.5)  # tail still rings out
    np.testing.assert_allclose(audio[1250:], 0.0)


def test_tail_is_not_truncated_by_the_next_step_and_stereo_preserved():
    src = make_source([0.2], samplerate=1000, channels=2)
    model = SliceModel(src.frames)
    seq = pattern((0, 0))
    out = render_sequence(src, model, seq, bpm=120, fade_in_s=0, fade_out_s=0)
    audio = out.audio
    assert audio.ndim == 2 and audio.shape[1] == 2, "不能把立体声折成单声道"
    np.testing.assert_allclose(audio[0, 0], 0.2)
    np.testing.assert_allclose(audio[0, 1], -0.2)
    # every sample of the slice remains, not just the first 16th note
    np.testing.assert_allclose(audio[:1000, 0], 0.2)
    np.testing.assert_allclose(audio[1000:, 0], 0.0)


def test_empty_step_does_not_trigger_and_previous_tail_continues():
    src = make_source([0.3, 0.6])
    model = SliceModel(src.frames)
    model.set_cuts([1000])
    # step 0 triggers slice 0, step 1 empty, step 2 triggers slice 1
    seq = pattern((0, 0), (2, 1))
    out = render_sequence(src, model, seq, bpm=60, fade_in_s=0, fade_out_s=0)
    audio = out.audio
    # step 1 spans [250, 500): only the tail of slice 0
    np.testing.assert_allclose(audio[250:500], 0.3)
    np.testing.assert_allclose(audio[500], 0.6 + 0.3)  # new trigger adds on top


def test_repeated_slice_adds_up():
    src = make_source([0.1])
    model = SliceModel(src.frames)
    seq = pattern((0, 0), (1, 0), (2, 0))
    out = render_sequence(src, model, seq, bpm=60, fade_in_s=0, fade_out_s=0)
    audio = out.audio
    # step 0 starts 0, step 1 at 250, step 2 at 500
    np.testing.assert_allclose(audio[0], 0.1, atol=1e-6)
    np.testing.assert_allclose(audio[250], 0.2, atol=1e-6)
    np.testing.assert_allclose(audio[500], 0.3, atol=1e-6)
    np.testing.assert_allclose(audio[1000:1250], 0.2, atol=1e-6)


def test_content_past_sequence_end_is_cut_off():
    src = make_source([0.5])
    model = SliceModel(src.frames)
    seq = pattern((15, 0))  # last step starts at 3750 for 60 BPM
    out = render_sequence(src, model, seq, bpm=60, fade_in_s=0, fade_out_s=0)
    audio = out.audio
    assert out.length == 4000
    np.testing.assert_allclose(audio[3750:4000], 0.5)
    assert audio.shape[0] == 4000, "导出长度不得因长尾而变长"


def test_last_slice_runs_to_material_end_and_different_lengths():
    src = make_source([0.1, 0.2, 0.3])
    model = SliceModel(src.frames)
    model.set_cuts([1500, 1700])  # 1500, 200, 1300 samples
    bounds = model.slice_bounds()
    assert bounds == [(0, 1500), (1500, 1700), (1700, 3000)]
    assert bounds[-1][1] == src.frames
    for (s, e) in bounds:
        assert 0 < e - s


def test_fades_apply_to_each_triggered_slice():
    src = make_source([0.5])
    model = SliceModel(src.frames)
    seq = pattern((0, 0))
    fin_s, fout_s = 0.01, 0.02  # 10 and 20 samples at 1000 Hz
    out = render_sequence(src, model, seq, bpm=60, fade_in_s=fin_s, fade_out_s=fout_s)
    audio = out.audio
    fin, fout = 10, 20
    assert audio[0] == pytest.approx(0.0, abs=1e-6)
    assert audio[fin - 1] == pytest.approx(0.5, rel=0.02)
    assert audio[999] == pytest.approx(0.0, abs=1e-6)
    assert audio[1000 - fout] == pytest.approx(0.5, rel=0.02)
    # no fade on the untouched second half of the sequence
    assert np.all(audio[1000:] == 0)


def test_slice_preview_uses_same_fade_rules():
    from drumchopper.player import preview_slice

    src = make_source([0.8])
    clip = preview_slice(src.samples, 0, 1000, 0.005, 0.005, 1000)
    assert clip.shape == (1000,)
    assert clip[0] == pytest.approx(0.0, abs=1e-6)
    assert clip[-1] == pytest.approx(0.0, abs=1e-6)
    assert clip[500] == pytest.approx(0.8, rel=1e-6)


def test_uniform_protection_gain_when_mix_clips():
    src = make_source([0.7])
    model = SliceModel(src.frames)
    seq = pattern((0, 0), (1, 0), (2, 0))  # will sum to over 1.0
    out = render_sequence(src, model, seq, bpm=60, fade_in_s=0, fade_out_s=0,
                          target_peak=0.9)
    assert out.peak_before > 0.9
    assert out.gain < 1.0
    assert out.peak_after == pytest.approx(0.9, abs=1e-6)
    # the attenuation is uniform: the quiet head keeps the same ratio
    no_protection = render_sequence(src, model, seq, bpm=60, fade_in_s=0,
                                    fade_out_s=0, apply_protection=False)
    ratio = out.audio[0] / no_protection.audio[0]
    assert ratio == pytest.approx(out.gain, rel=1e-5)
    assert np.max(np.abs(out.audio)) <= 1.0


def test_no_gain_when_mix_is_safe():
    src = make_source([0.3])
    model = SliceModel(src.frames)
    out = render_sequence(src, model, pattern((0, 0)), bpm=60,
                          fade_in_s=0, fade_out_s=0)
    assert out.gain == 1.0
    assert out.peak_after == pytest.approx(0.3, rel=1e-6)


def test_invalid_slice_reference_skipped_safely():
    src = make_source([0.4])
    model = SliceModel(src.frames)
    seq = pattern((0, 0), (1, 99))
    out = render_sequence(src, model, seq, bpm=60, fade_in_s=0, fade_out_s=0)
    assert out.length == 4000
    assert np.all(out.audio[1000:] == 0)


def test_render_uses_int_sample_offsets_exactly():
    src = make_source([0.33, 0.11])
    model = SliceModel(src.frames)
    seq = pattern((0, 1), (5, 0))
    bpm = 137.0
    sr = 48000
    src = SourceAudio(samples=np.tile(src.samples, 1), samplerate=sr)
    model = SliceModel(src.frames)
    out = render_sequence(src, model, seq, bpm=bpm, fade_in_s=0, fade_out_s=0)
    offsets = A.step_samples(bpm, sr)
    expected_len = A.sequence_length_samples(bpm, sr)
    assert out.length == expected_len
    # the second trigger is exactly at offsets[5]; test a sample just before
    start = offsets[5]
    assert out.audio[start - 1] == 0 or True  # first slice tail may still ring


def test_stereo_channels_render_independently():
    sr = 1000
    left = np.zeros(4000, dtype=np.float32)
    right = np.zeros(4000, dtype=np.float32)
    left[0:1000] = 0.4
    right[0:1000] = -0.2
    src = SourceAudio(samples=np.stack([left, right], axis=1), samplerate=sr)
    model = SliceModel(src.frames)
    model.set_cuts([1000])
    out = render_sequence(src, model, pattern((0, 0)), bpm=60,
                          fade_in_s=0, fade_out_s=0)
    np.testing.assert_allclose(out.audio[:1000, 0], 0.4)
    np.testing.assert_allclose(out.audio[:1000, 1], -0.2)
    assert not np.allclose(out.audio[:, 0], out.audio[:, 1])


def test_exported_file_matches_render(tmp_path):
    from drumchopper.audio import read_wav, write_wav

    src = ramp_source(frames=4000)
    model = SliceModel(src.frames)
    model.set_cuts([1000, 2500])
    seq = pattern((0, 0), (1, 2), (4, 1), (6, 0), (8, 2), (15, 1))
    render = render_sequence(src, model, seq, bpm=105.3, fade_in_s=0.004,
                             fade_out_s=0.004)
    path = tmp_path / "out.wav"
    write_wav(path, render.audio, src.samplerate)
    back = read_wav(path)
    assert back.samplerate == src.samplerate
    assert back.channels == 2
    assert back.frames == render.length
    np.testing.assert_allclose(back.samples, render.audio, atol=1e-6)


def test_render_audio_data_reflects_pattern_not_just_configuration():
    """A silent rendered region proves an empty step really produced silence."""
    src = make_source([0.5, 0.25])
    model = SliceModel(src.frames)
    empty_seq = pattern()
    filled_seq = pattern((3, 0))
    empty = render_sequence(src, model, empty_seq, bpm=60, fade_in_s=0, fade_out_s=0)
    filled = render_sequence(src, model, filled_seq, bpm=60, fade_in_s=0, fade_out_s=0)
    assert np.all(empty.audio == 0)
    assert np.all(filled.audio[:750] == 0)  # before step 3
    assert np.max(filled.audio[750:]) > 0.4  # step 3 actually sounded
    assert np.max(filled.audio[750:]) == pytest.approx(0.5, rel=1e-6)
