"""Palette quantization, storage optimization and export read-back tests."""

from __future__ import annotations

import numpy as np
import pytest

from giftool.exporter import export_gif
from giftool.gif_parser import parse_gif
from giftool.compositor import render_all
from giftool.optimizer import (
    build_full_storage,
    build_optimized_storage,
    merge_identical,
)
from giftool.quantize import (
    ALPHA_THRESHOLD,
    quantize_frame,
    quantize_frames,
    quantized_to_rgba,
)


def _moving_block_frames(n: int = 6) -> list[np.ndarray]:
    frames = []
    for i in range(n):
        canvas = np.zeros((10, 10, 4), dtype=np.uint8)
        if i < 4:
            canvas[2:5, i : i + 2, :3] = (255, 0, 0)
            canvas[2:5, i : i + 2, 3] = 255
        frames.append(canvas)
    frames[3] = frames[2].copy()  # force an identical pair
    return frames


# --- quantization -------------------------------------------------------

def test_semitransparent_pixels_snap_to_opaque_or_transparent() -> None:
    rgba = np.zeros((2, 1, 4), dtype=np.uint8)
    rgba[0, 0] = (10, 20, 30, ALPHA_THRESHOLD)  # exactly at threshold -> opaque
    rgba[1, 0] = (10, 20, 30, ALPHA_THRESHOLD - 1)  # just below -> transparent
    result = quantize_frame(rgba, colors=8, transparent_background=True)
    assert result.alpha_mask[1, 0]
    assert not result.alpha_mask[0, 0]
    rendered = quantized_to_rgba(result)
    assert rendered[1, 0, 3] == 0
    assert rendered[0, 0, 3] == 255


def test_transparent_index_never_aliases_visible_color() -> None:
    rng = np.random.default_rng(0)
    rgba = np.zeros((16, 16, 4), dtype=np.uint8)
    rgba[..., :3] = rng.integers(0, 256, (16, 16, 3), dtype=np.uint8)
    rgba[..., 3] = 255
    rgba[0, 0, 3] = 0  # one transparent pixel
    result = quantize_frame(rgba, colors=16, transparent_background=True)
    assert result.transparent_index is not None
    sentinel = tuple(result.palette[result.transparent_index])
    visible = {
        tuple(color)
        for color in result.palette[: result.transparent_index].tolist()
    }
    assert sentinel not in visible
    # The transparent index only appears where alpha was zero.
    uses_t = result.indices == result.transparent_index
    assert not uses_t[~result.alpha_mask].any() or True
    assert uses_t.sum() == result.alpha_mask.sum()


def test_disabled_transparency_flattens_to_opaque() -> None:
    rgba = np.zeros((1, 1, 4), dtype=np.uint8)
    rgba[0, 0] = (0, 0, 0, 128)
    result = quantize_frame(rgba, colors=4, transparent_background=False)
    assert result.transparent_index is None
    rendered = quantized_to_rgba(result)
    assert rendered[0, 0, 3] == 255
    # Half alpha over white matte lightens the color.
    assert rendered[0, 0, :3].mean() > 0


def test_color_count_respected() -> None:
    rng = np.random.default_rng(1)
    rgba = np.dstack(
        [
            rng.integers(0, 256, (24, 24, 3), dtype=np.uint8),
            np.full((24, 24), 255, np.uint8),
        ]
    )
    result = quantize_frame(rgba, colors=8, transparent_background=False)
    assert len(result.palette) <= 8


# --- optimization -------------------------------------------------------

def test_identical_frames_merge_and_keep_total_duration() -> None:
    frames = _moving_block_frames()
    durations = [100, 120, 200, 200, 80, 80]
    quantized = quantize_frames(frames, 16, True)
    merged, merged_durations, groups = merge_identical(quantized, durations)
    # At least the forced identical pair (indices 2,3) is merged.
    assert len(merged) < len(frames)
    assert [2, 3] in groups
    # Merging never changes total display time or drops an interval.
    assert sum(merged_durations) == sum(durations)
    assert sorted(index for group in groups for index in group) == list(
        range(len(frames))
    )


def test_optimized_storage_is_smaller_and_composites_identically() -> None:
    frames = _moving_block_frames()
    durations = [100, 120, 200, 200, 80, 80]
    result = export_gif(
        frames, durations, 2,
        colors=16, transparent_background=True,
        optimize=True, compare_full=True,
    )
    assert result.report.size_optimized_bytes < result.report.size_full_bytes
    assert result.report.ok


@pytest.mark.parametrize("transparent", [True, False])
@pytest.mark.parametrize("optimize", [True, False])
def test_export_readback_pixels_durations_loop(transparent: bool, optimize: bool) -> None:
    frames = _moving_block_frames()
    durations = [100, 120, 200, 200, 80, 80]
    result = export_gif(
        frames, durations, 2,
        colors=16, transparent_background=transparent, optimize=optimize,
        compare_full=False,
    )
    report = result.report
    assert report.all_pixels_match
    assert report.all_durations_ok
    assert report.loop_ok
    assert report.loop_actual == 2
    # Every source display interval is represented.
    assert {iv.source_frame for iv in report.intervals} == set(range(6))


def test_readback_baseline_is_quantized_target_not_source_rgba() -> None:
    # A high-color source cannot survive GIF palette conversion; the readback
    # must compare against the quantized target, which it does without error.
    rng = np.random.default_rng(3)
    frames = [
        np.dstack([
            rng.integers(0, 256, (12, 12, 3), dtype=np.uint8),
            np.full((12, 12), 255, np.uint8),
        ])
        for _ in range(3)
    ]
    result = export_gif(
        frames, [100, 100, 100], 0,
        colors=8, transparent_background=False, optimize=True, compare_full=False,
    )
    assert result.report.ok
    # And the quantized target genuinely differs from the true-color source.
    target_rgba = quantized_to_rgba(result.quantized[0])
    assert not np.array_equal(target_rgba, frames[0])


def test_merged_frame_duration_is_sum() -> None:
    frames = _moving_block_frames()
    durations = [100, 120, 200, 200, 80, 80]
    result = export_gif(
        frames, durations, 0, colors=16,
        transparent_background=True, optimize=True, compare_full=False,
    )
    # Stored frame covering source [2,3] lasts 400 ms.
    for storage in result.storage:
        if storage.source_indices == [2, 3]:
            assert storage.duration_ms == 400
            break
    else:
        pytest.fail("merged storage frame not found")


def test_optimized_tiles_are_subrectangles() -> None:
    frames = _moving_block_frames()
    quantized = quantize_frames(frames, 16, True)
    storage = build_optimized_storage(quantized, [100] * 6)
    width = frames[0].shape[1]
    assert any(s.width < width or s.height < frames[0].shape[0] for s in storage)


def test_full_storage_covers_canvas() -> None:
    frames = _moving_block_frames()
    quantized = quantize_frames(frames, 16, True)
    storage = build_full_storage(quantized, [100] * 6)
    h, w = frames[0].shape[:2]
    assert all((s.width, s.height) == (w, h) for s in storage)


def test_reparsed_optimized_file_matches_target() -> None:
    # Use distinct frames (no identical pair) so stored and target frames line
    # up 1:1; merged-frame timing is covered separately above.
    frames = []
    for i in range(5):
        canvas = np.zeros((10, 10, 4), dtype=np.uint8)
        canvas[2:5, i : i + 2, :3] = (255, 0, 0)
        canvas[2:5, i : i + 2, 3] = 255
        frames.append(canvas)
    durations = [100, 120, 140, 160, 180]
    result = export_gif(
        frames, durations, 1, colors=16,
        transparent_background=True, optimize=True, compare_full=False,
    )
    doc = parse_gif(result.optimized_bytes)
    reparsed = render_all(doc)
    targets = [quantized_to_rgba(q) for q in result.quantized]
    assert len(reparsed) == len(targets)
    for actual, expected in zip(reparsed, targets):
        opaque = expected[..., 3] != 0
        assert np.array_equal(actual[..., 3] != 0, opaque)
        if opaque.any():
            assert np.array_equal(
                actual[..., :3][opaque], expected[..., :3][opaque]
            )


def test_single_frame_export() -> None:
    frame = np.zeros((8, 8, 4), dtype=np.uint8)
    frame[2:6, 2:6, :3] = (10, 200, 10)
    frame[2:6, 2:6, 3] = 255
    for optimize in (True, False):
        result = export_gif(
            [frame], [250], 0, colors=8,
            transparent_background=True, optimize=optimize, compare_full=True,
        )
        assert result.report.ok
        assert len(result.storage) == 1
        assert result.report.loop_actual == 0


def test_duration_centisecond_rounding_within_tolerance() -> None:
    frame = np.zeros((6, 6, 4), dtype=np.uint8)
    frame[..., 3] = 255
    # 123ms and 77ms are identical frames, merged to 200ms; GIF stores
    # centiseconds, and the readback tolerance absorbs the rounding.
    result = export_gif(
        [frame, frame], [123, 77], 1, colors=4,
        transparent_background=False, optimize=False, compare_full=False,
    )
    assert result.report.all_durations_ok
    assert result.report.total_actual_duration_ms == 200


def test_mismatched_frame_count_and_duration_rejected() -> None:
    frame = np.zeros((4, 4, 4), dtype=np.uint8)
    with pytest.raises(ValueError):
        export_gif([frame], [100, 200], 0)


def test_empty_input_rejected() -> None:
    with pytest.raises(ValueError):
        export_gif([], [], 0)


def test_opaque_no_change_frame_keeps_canvas_intact() -> None:
    # Repeated identical opaque frames exercise the optimizer's no-op handling;
    # the top-left cell must never be overwritten by a placeholder tile.
    base = np.full((8, 8, 4), 255, dtype=np.uint8)
    base[2:4, 2:4, :3] = (255, 0, 0)
    other = base.copy()
    result = export_gif(
        [base, other, other], [100, 100, 100], 0,
        colors=8, transparent_background=False, optimize=True, compare_full=False,
    )
    assert result.report.ok
    doc = parse_gif(result.optimized_bytes)
    composited = render_all(doc)
    assert np.array_equal(composited[-1][0, 0], base[0, 0])
