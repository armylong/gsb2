"""End-to-end checks driven by the exported wav's actual sample values.

These load material from disk, build a pattern, export, read the file back
and compare measured samples/energy against the source material.  Nothing
here trusts the pattern configuration alone.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

from drumchopper import audio as A
from drumchopper.audio import Sequence, SliceModel, read_wav, render_sequence, write_wav
from drumchopper.samples import generate_demo


def energy(samples: np.ndarray, start: int, end: int) -> float:
    block = samples[start:end]
    if block.size == 0:
        return 0.0
    return float(np.sqrt(np.mean(np.square(block.astype(np.float64)))))


def make_pattern(mapping: dict[int, int]) -> Sequence:
    steps: list[int | None] = [None] * A.STEPS
    for k, v in mapping.items():
        steps[k] = v
    return Sequence(steps)


def export(tmp_path: Path, samples, source, model, seq, bpm, fade=0.0):
    render = render_sequence(source, model, seq, bpm, fade_in_s=fade, fade_out_s=fade)
    path = tmp_path / f"export_{bpm}_{fade}.wav"
    write_wav(path, render.audio, source.samplerate)
    back = read_wav(path)
    return back.samples, back.frames, render


@pytest.fixture(scope="module")
def demo():
    samples, hits = generate_demo(seconds=3.2)
    return samples, hits


def source_of(samples) -> A.SourceAudio:
    return A.SourceAudio(samples=samples, samplerate=44100)


def test_exported_length_and_trigger_content_match_source(tmp_path, demo):
    """Export, then verify the file actually contains the slice at the grid."""
    samples, hits = demo
    source = source_of(samples)
    sr = source.samplerate
    known = sorted({h.start for h in hits if 0 < h.start < source.frames})
    model = SliceModel(source.frames)
    model.set_cuts(known[: A.MAX_SLICES - 1])
    bounds = model.slice_bounds()

    bpm = 137.0
    for step, slice_idx in ((0, 0), (5, 3), (13, 7), (15, 1)):
        seq = make_pattern({step: slice_idx})
        audio, frames, render = export(tmp_path, samples, source, model, seq, bpm)
        assert frames == A.sequence_length_samples(bpm, sr)
        assert audio.shape == (frames, 2)

        offset = render.step_offsets[step]
        start, end = bounds[slice_idx]
        n = min(end - start, frames - offset)
        # exact sample-for-sample match: proves placement, source speed and
        # channel integrity straight from the exported file
        np.testing.assert_allclose(audio[offset:offset + n], samples[start:start + n],
                                   atol=1e-6)
        if offset > 0:
            assert np.all(audio[max(0, offset - 100):offset] == 0), "拍位前不应有声音"
        # the material's own attack is present where the grid says it is
        assert energy(audio, offset, offset + int(0.005 * sr)) > 1e-4


def test_step_offsets_from_file_stay_within_one_sample(tmp_path, demo):
    samples, hits = demo
    source = source_of(samples)
    sr = source.samplerate
    model = SliceModel(source.frames)
    model.set_cuts(sorted({h.start for h in hits if 0 < h.start < source.frames})[:5])
    seq = make_pattern({i: i % model.count for i in range(A.STEPS)})
    for bpm in (77.7, 100.0, 137.0, 174.0, 299.3):
        audio, frames, render = export(tmp_path, samples, source, model, seq, bpm)
        assert frames == A.sequence_length_samples(bpm, sr)
        for i, off in enumerate(render.step_offsets):
            ideal = i * (60.0 / bpm / 4.0) * sr
            assert abs(off - ideal) <= 0.5, f"{bpm} BPM step {i} 漂移"


def test_overlap_sum_reproduces_exported_samples(tmp_path, demo):
    """Two overlapping triggers must add; verify against the file data."""
    samples, hits = demo
    source = source_of(samples)
    sr = source.samplerate
    model = SliceModel(source.frames)
    # one short, one long slice with a ringing tail
    model.set_cuts([int(0.25 * sr), int(1.0 * sr)])
    long_slice = 2  # [1.0 s, end) contains the crash-like long tail
    short_slice = 0
    seq = make_pattern({0: long_slice, 2: short_slice})
    audio, frames, render = export(tmp_path, samples, source, model, seq, 120)

    a0 = render.step_offsets[0]
    a2 = render.step_offsets[2]
    s_start, s_end = model.slice_bounds()[short_slice]
    l_start, l_end = model.slice_bounds()[long_slice]
    n_short = min(s_end - s_start, frames - a2)
    n_long_tail = min(l_end - l_start, frames - a0)

    # region after the second trigger: long tail + short slice, sample exact
    lo = max(a2, a0)
    hi = min(frames, a0 + n_long_tail, a2 + n_short)
    expected = (samples[l_start + (lo - a0):l_start + (hi - a0)]
                + samples[s_start + (lo - a2):s_start + (hi - a2)])
    np.testing.assert_allclose(audio[lo:hi], expected, atol=1e-6)
    # and the tail really is audible before the second trigger, i.e. the long
    # slice was not truncated at one grid step
    assert energy(audio, a0 + int(0.1 * sr), a2) > 1e-4


def test_repeated_slice_and_empty_step_measured_from_wav(tmp_path, demo):
    samples, hits = demo
    source = source_of(samples)
    sr = source.samplerate
    model = SliceModel(source.frames)
    model.set_cuts([int(0.5 * sr), int(1.0 * sr)])
    slice_idx = 2  # long, loud tail
    seq = make_pattern({0: slice_idx, 2: slice_idx})
    audio, frames, render = export(tmp_path, samples, source, model, seq, 120)
    start, end = model.slice_bounds()[slice_idx]

    s0, s1, s2 = render.step_offsets[0], render.step_offsets[1], render.step_offsets[2]
    # from step 0 alone until step 2 re-triggers, the output is the slice
    # waveform untouched at source speed
    n0 = min(end - start, s2 - s0)
    np.testing.assert_allclose(audio[s0:s0 + n0], samples[start:start + n0], atol=1e-6)
    # step 1 is empty: its region is exactly the step-0 tail, nothing new
    n1 = min(s1 - s0, frames - s1)
    np.testing.assert_allclose(audio[s1:s1 + n1],
                               samples[start + (s1 - s0):start + (s1 - s0) + n1],
                               atol=1e-6)
    # step 2 re-triggers the same slice: the region is the new copy plus the
    # still-ringing tail of the step-0 instance (proves additive overlap)
    n_tail = min(s2 - s0, frames - s2, end - start)
    expected = samples[start:start + n_tail] + samples[start + (s2 - s0):start + (s2 - s0) + n_tail]
    n_check = min(n_tail, s1 - s0)  # keep inside the region before the next trigger
    np.testing.assert_allclose(audio[s2:s2 + n_check], expected[:n_check], atol=1e-6)
    assert energy(audio, s2, s2 + int(0.02 * sr)) > energy(audio, s1, s1 + int(0.02 * sr))


def test_moved_cut_changes_exported_content(tmp_path, demo):
    samples, hits = demo
    source = source_of(samples)
    sr = source.samplerate
    model_a = SliceModel(source.frames)
    model_a.set_cuts([int(1.0 * sr), int(1.5 * sr)])
    model_b = SliceModel(source.frames)
    model_b.set_cuts([int(1.1 * sr), int(1.5 * sr)])
    seq = make_pattern({0: 1})
    a_audio, _, ra = export(tmp_path, samples, source, model_a, seq, 120)
    b_audio, _, rb = export(tmp_path, samples, source, model_b, seq, 120)
    assert a_audio.shape == b_audio.shape
    assert not np.allclose(a_audio, b_audio)
    # each export equals its own slice content, and the moved boundary makes
    # the two files start on different material at sample 0 of the trigger
    sa, ea = model_a.slice_bounds()[1]
    sb, eb = model_b.slice_bounds()[1]
    n = min(ea - sa, eb - sb)
    np.testing.assert_allclose(a_audio[:n], samples[sa:sa + n], atol=1e-6)
    np.testing.assert_allclose(b_audio[:n], samples[sb:sb + n], atol=1e-6)
    assert not np.allclose(samples[sa:sa + n], samples[sb:sb + n])


def test_truncation_at_sequence_end_from_file_data(tmp_path, demo):
    samples, hits = demo
    source = source_of(samples)
    sr = source.samplerate
    model = SliceModel(source.frames)
    model.set_cuts([int(0.5 * sr), int(1.0 * sr)])
    seq = make_pattern({15: 1})  # last step, long slice
    audio, frames, render = export(tmp_path, samples, source, model, seq, 90)
    assert frames == A.sequence_length_samples(90, sr)
    assert audio.shape[0] == frames
    start, end = model.slice_bounds()[1]
    offset = render.step_offsets[15]
    take = frames - offset
    assert 0 < take < (end - start), "本用例必须有内容被末尾截断"
    np.testing.assert_allclose(audio[offset:frames], samples[start:start + take],
                               atol=1e-6)


def test_stereo_is_not_collapsed_in_export(tmp_path, demo):
    samples, hits = demo
    source = source_of(samples)
    model = SliceModel(source.frames)
    model.set_cuts([11025, 22050])
    seq = make_pattern({0: 0, 1: 1})
    audio, frames, render = export(tmp_path, samples, source, model, seq, 120)
    assert audio.ndim == 2 and audio.shape[1] == 2
    assert not np.allclose(audio[:, 0], audio[:, 1])
    # channel content equals the corresponding source channels, checked in the
    # region before the second trigger so no overlap is involved
    s, e = model.slice_bounds()[0]
    second = render.step_offsets[1]
    n = min(e - s, second)
    np.testing.assert_allclose(audio[:n], samples[s:s + n], atol=1e-6)
    assert not np.allclose(audio[:n, 0], audio[:n, 1])


def test_protection_gain_applies_uniformly_to_export(tmp_path, demo):
    samples, hits = demo
    source = source_of(samples)
    sr = source.samplerate
    model = SliceModel(source.frames)
    model.set_cuts([int(0.5 * sr), int(1.0 * sr)])
    # slice 2 is long and loud; retrigger it on every step so tails pile up
    seq = make_pattern({i: 2 for i in range(A.STEPS)})
    # render the same buffer without protection and without clipping so the
    # gain can be checked as a uniform scalar
    plain = render_sequence(source, model, seq, 120, 0.002, 0.002,
                            apply_protection=False)
    assert plain.peak_before > 0.98, "本用例的素材应超过满幅"

    protected = render_sequence(source, model, seq, 120, 0.002, 0.002,
                                target_peak=0.9)
    assert protected.gain < 1.0
    path = tmp_path / "loud.wav"
    write_wav(path, protected.audio, sr)
    back = read_wav(path)
    assert np.max(np.abs(back.samples)) <= 0.9 + 1e-5
    # uniform scalar: every sample is the pre-clip mix times gain.  The
    # unprotected audio is clipped at ±1, so re-apply the same scalar to the
    # *unclipped* mix by comparing only the samples below the clip point.
    unclipped = plain.audio
    mask = np.abs(unclipped) < 1.0
    assert np.any(mask)
    np.testing.assert_allclose(protected.audio[mask], unclipped[mask] * protected.gain,
                               atol=1e-6)
    # the same buffer is what playback receives, so preview == export
    np.testing.assert_allclose(protected.audio, back.samples, atol=1e-6)
