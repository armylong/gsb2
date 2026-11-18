from __future__ import annotations

import numpy as np
import pytest

from drumchopper.audio import (
    MAX_SLICES,
    SliceModel,
    read_wav,
    write_wav,
)
from helpers import impulse_source, ramp_source


def test_slices_partition_material_without_gaps_or_overlap():
    model = SliceModel(1000)
    model.set_cuts([100, 400, 401, 999])
    bounds = model.slice_bounds()
    assert bounds == [(0, 100), (100, 400), (400, 401), (401, 999), (999, 1000)]
    # contiguous partition: each end equals the next start, covers everything
    assert bounds[0][0] == 0
    assert bounds[-1][1] == 1000
    for (s0, e0), (s1, _) in zip(bounds, bounds[1:]):
        assert e0 == s1
    assert all(e > s for s, e in bounds), "不允许空片"


def test_slice_bounds_cover_every_sample_exactly_once():
    model = SliceModel(1000)
    model.set_cuts([250, 500, 750])
    counts = np.zeros(1000, dtype=int)
    for start, end in model.slice_bounds():
        counts[start:end] += 1
    assert np.all(counts == 1), "每个采样必须恰好属于一个切片"


def test_set_cuts_sorts_dedupes_and_ignores_edges():
    model = SliceModel(1000)
    model.set_cuts([900, 100, 500, 100, 0, 1000, -5])
    assert model.cuts == [100, 500, 900]
    assert model.count == 4


def test_too_many_cuts_rejected():
    model = SliceModel(10_000)
    model.set_cuts(range(1, MAX_SLICES))  # 15 cuts => 16 slices, allowed
    assert model.count == MAX_SLICES
    with pytest.raises(ValueError):
        model.set_cuts(range(1, MAX_SLICES + 1))  # 16 cuts => 17 slices


def test_add_move_remove_and_order_constraints():
    model = SliceModel(1000)
    assert model.add_cut(500)
    assert not model.add_cut(500), "重复切点不添加"
    assert not model.add_cut(0) and not model.add_cut(1000)
    assert model.add_cut(200)
    assert model.cuts == [200, 500]

    # moving past a neighbour sorts instead of creating overlap
    assert model.move_cut(0, 800)
    assert model.cuts == [500, 800]
    assert model.slice_bounds() == [(0, 500), (500, 800), (800, 1000)]

    # clamp_move keeps the cut strictly between neighbours
    assert model.clamp_move(0, 10) == 10
    assert model.clamp_move(0, 9999) == 799
    assert model.clamp_move(1, 0) == 501
    assert model.clamp_move(1, 5000) == 999

    assert model.remove_cut(0)
    assert model.cuts == [800]
    assert not model.remove_cut(5)


def test_slice_of_position_boundaries():
    model = SliceModel(1000)
    model.set_cuts([100, 200])
    assert model.slice_of_position(0) == 0
    assert model.slice_of_position(99) == 0
    assert model.slice_of_position(100) == 1  # cut sample belongs to the next slice
    assert model.slice_of_position(200) == 2
    assert model.slice_of_position(999) == 2


def test_degenerate_material_clamped_to_one_frame():
    model = SliceModel(0)
    assert model.frames == 1
    assert model.slice_bounds() == [(0, 1)]


def test_move_cut_rejects_duplicate_and_edges():
    model = SliceModel(1000)
    model.set_cuts([300, 600])
    assert not model.move_cut(0, 600), "不能移到另一个切点同一位置"
    assert not model.move_cut(0, 0)
    assert not model.move_cut(0, 1000)
    assert model.cuts == [300, 600]


def test_wav_roundtrip_keeps_channels_and_samples(tmp_path):
    source = ramp_source(frames=1000)
    path = tmp_path / "stereo.wav"
    write_wav(path, source.samples, source.samplerate)
    back = read_wav(path)
    assert back.channels == 2
    assert back.frames == 1000
    np.testing.assert_allclose(back.samples, source.samples, atol=1e-6)


def test_read_rejects_over_8_seconds(tmp_path):
    source = impulse_source(frames=9000, samplerate=1000)
    path = tmp_path / "long.wav"
    write_wav(path, source.samples, source.samplerate)
    with pytest.raises(Exception):
        read_wav(path)
