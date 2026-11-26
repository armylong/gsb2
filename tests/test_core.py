"""Tests for slit geometry, padding modes and the interpolation math."""
import numpy as np
import pytest

from slitscan.core import (SlitConfig, block_has_real_pixels, build_strip,
                           frame_to_block, resolve_slit, select_moments,
                           slit_center_at, slit_left_for_center, x_to_block)


def test_center_interpolation_endpoints():
    assert slit_center_at(0.0, 0, 1, 10, 30) == pytest.approx(10)
    assert slit_center_at(1.0, 0, 1, 10, 30) == pytest.approx(30)
    assert slit_center_at(0.25, 0, 1, 10, 30) == pytest.approx(15)
    # degenerate time span -> static center
    assert slit_center_at(0.5, 1, 1, 7, 9) == pytest.approx(7)


def test_slit_left_centers_on_value():
    left = slit_left_for_center(center=10.0, width=4)
    assert left == 8  # [8,12) centered on 10
    left = slit_left_for_center(center=10.0, width=5)
    assert left + 5 / 2 == pytest.approx(10.0, abs=0.5)


def test_resolve_slit_inside_frame_needs_no_padding():
    left, cols, pad = resolve_slit(5, 4, 40, "edge")
    assert left == 5 and cols == [5, 6, 7, 8] and pad is False


def test_padding_edge_replicates_boundary():
    left, cols, pad = resolve_slit(-2, 4, 40, "edge")
    assert pad is True
    assert cols == [0, 0, 0, 1]
    left, cols, pad = resolve_slit(38, 4, 40, "edge")
    assert cols == [38, 39, 39, 39]


def test_padding_reflect_mirrors_columns():
    left, cols, pad = resolve_slit(-2, 4, 40, "reflect")
    assert pad is True
    assert cols == [2, 1, 0, 1]
    left, cols, pad = resolve_slit(39, 3, 40, "reflect")
    assert cols == [39, 39, 38]


def test_padding_zero_marks_unrecoverable_columns():
    left, cols, pad = resolve_slit(-2, 4, 40, "zero")
    assert cols == [-1, -1, 0, 1]
    assert not block_has_real_pixels(type("B", (), {"source_cols": [-1, -1]})())


def test_padding_limit_shifts_slit_instead_of_padding():
    left, cols, pad = resolve_slit(-5, 4, 40, "limit")
    assert (left, cols, pad) == (0, [0, 1, 2, 3], False)
    left, cols, pad = resolve_slit(39, 4, 40, "limit")
    assert (left, cols, pad) == (36, [36, 37, 38, 39], False)


def test_select_moments_frame_layout_respects_trim_and_skip(frames_and_ts):
    _, ts = frames_and_ts
    cfg = SlitConfig(trim_start=0.5, trim_end=2.0,
                     skip_intervals=[(1.0, 1.3)])
    moments = select_moments(ts, cfg)
    times = [m[1] for m in moments]
    assert times[0] == pytest.approx(0.5)
    assert times[-1] == pytest.approx(2.0)
    assert all(not (1.0 <= t < 1.3) for t in times)
    assert all(not m[2] for m in moments)  # no synthetic flags in frame layout


def test_select_moments_interval_layout_flags_duplicates(frames_and_ts):
    _, ts = frames_and_ts
    cfg = SlitConfig(layout="interval", interval=0.05)  # denser than 0.1 fps
    moments = select_moments(ts, cfg)
    # frames must be reused -> at least one duplicate flagged synthetic
    assert any(m[2] for m in moments)
    grid = [m[1] for m in moments]
    assert np.allclose(np.diff(grid), 0.05, atol=1e-9)


def test_select_moments_interval_layout_marks_missing(vfr_frames_and_ts):
    _, ts = vfr_frames_and_ts
    cfg = SlitConfig(layout="interval", interval=0.01)
    moments = select_moments(ts, cfg)
    # gap larger than the grid spacing -> missing-frame records appear
    assert any(m[0] == -1 and m[2] for m in moments)


def test_build_strip_dimensions_and_paging(frames_and_ts):
    frames, ts = frames_and_ts
    cfg = SlitConfig(width=5, max_page_width=37)  # 37 not multiple of 5
    result = build_strip(frames, ts, cfg)
    n = len(ts)
    assert result.total_width == n * 5
    # no slice straddles a page boundary; pages still cover every column
    assert sum(p.shape[1] for p in result.pages) == result.total_width
    for b in result.blocks:
        assert b.page_x0 + b.width <= result.pages[b.page].shape[1]
    assert all(len(b.source_cols) == b.width for b in result.blocks)


def test_page_joins_are_exact_no_lost_or_doubled_column(frames_and_ts):
    frames, ts = frames_and_ts
    cfg = SlitConfig(width=7, max_page_width=29)
    result = build_strip(frames, ts, cfg)
    prev_end = 0
    for b in result.blocks:
        assert b.global_x0 == prev_end
        prev_end = b.global_x0 + b.width
    assert prev_end == result.total_width


def test_build_pixels_match_source_columns(frames_and_ts):
    frames, ts = frames_and_ts
    cfg = SlitConfig(width=6, start_center=20, end_center=20)
    result = build_strip(frames, ts, cfg)
    for b in result.blocks:
        page = result.pages[b.page]
        for k, src_col in enumerate(b.source_cols):
            assert np.array_equal(page[:, b.page_x0 + k, :],
                                  frames[b.frame_index, :, src_col, :])


def test_padded_columns_are_black_and_flagged(frames_and_ts):
    frames, ts = frames_and_ts
    cfg = SlitConfig(width=8, start_center=-3, end_center=-3, padding="zero")
    result = build_strip(frames, ts, cfg)
    b0 = result.blocks[0]
    assert b0.synthetic and b0.source_cols[:2] == [-1, -1]
    page = result.pages[b0.page]
    assert page[:, b0.page_x0, :].sum() == 0
    assert page[:, b0.page_x0 + 1, :].sum() == 0
    # remaining columns still carry real pixels
    assert block_has_real_pixels(b0)


def test_panning_slit_moves_linearly(frames_and_ts):
    frames, ts = frames_and_ts
    cfg = SlitConfig(width=4, start_center=10, end_center=40)
    result = build_strip(frames, ts, cfg)
    lefts = [b.slit_left for b in result.blocks]
    diffs = np.diff(lefts)
    assert np.all(diffs >= 0)                      # monotonic pan
    assert np.std(diffs[diffs != 0]) < 1.5        # near-constant steps


def test_trim_and_skip_recompute_index(frames_and_ts):
    frames, ts = frames_and_ts
    cfg = SlitConfig(width=4, trim_start=0.3, trim_end=2.5,
                     skip_intervals=[(1.0, 1.5)])
    result = build_strip(frames, ts, cfg)
    times = [b.t for b in result.blocks]
    assert min(times) >= 0.3 - 1e-9 and max(times) <= 2.5 + 1e-9
    assert all(not (1.0 <= t < 1.5) for t in times)


def test_backlinks_both_directions(frames_and_ts):
    frames, ts = frames_and_ts
    cfg = SlitConfig(width=3)
    result = build_strip(frames, ts, cfg)
    # output column -> source frame
    b = x_to_block(result.blocks, page=0, x=result.blocks[7].page_x0 + 1)
    assert b is result.blocks[7]
    # source frame -> output block
    again = frame_to_block(result.blocks, b.frame_index)
    assert again is b
    # a column beyond the last block is not resolvable
    assert x_to_block(result.blocks, 0, result.pages[0].shape[1] + 5) is None


def test_empty_selection_raises(frames_and_ts):
    frames, ts = frames_and_ts
    cfg = SlitConfig(trim_start=99, trim_end=100)
    with pytest.raises(ValueError):
        build_strip(frames, ts, cfg)
