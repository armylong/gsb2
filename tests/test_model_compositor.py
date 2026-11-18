"""Compositor behaviour: seek independence, disposal, blend, validation."""

from __future__ import annotations

import numpy as np
import pytest

from apng_editor.model import (
    BLEND_OVER,
    BLEND_REPLACE,
    DISPOSE_CLEAR,
    DISPOSE_KEEP,
    DISPOSE_PREVIOUS,
    Frame,
    Project,
    ValidationError,
    alpha_over,
    compose_project,
    composite_at,
)
from apng_editor.samples import (
    GREEN,
    RED,
    SEMI_BLUE,
    SEMI_YELLOW,
    expected_alpha_overlap_inside,
    expected_alpha_overlap_outside,
    expected_blend_over,
    expected_move_clear_overlap,
    expected_restore_overlap,
    sample_alpha_overlap,
    sample_move_and_clear,
    sample_restore_previous,
    solid_tile,
)


def pixel(array: np.ndarray, x: int, y: int) -> tuple[int, int, int, int]:
    return tuple(int(v) for v in array[y, x])


# --------------------------------------------------------------- samples
def test_alpha_overlap_sample_matches_independent_pixels() -> None:
    frames = compose_project(sample_alpha_overlap())
    # Outside the red square the half-transparent blue must keep its alpha.
    assert pixel(frames[1], 65, 65) == expected_alpha_overlap_outside()
    assert pixel(frames[1], 65, 65) == SEMI_BLUE
    # Inside the overlap: independent float formula.
    assert pixel(frames[1], 40, 40) == expected_alpha_overlap_inside()
    assert pixel(frames[1], 40, 40) == (100, 15, 120, 255)
    # The opaque red frame is untouched.
    assert pixel(frames[0], 12, 20) == RED
    assert pixel(frames[0], 0, 0) == (0, 0, 0, 0)


def test_move_and_clear_sample_matches_independent_pixels() -> None:
    frames = compose_project(sample_move_and_clear())
    assert pixel(frames[0], 5, 5) == GREEN
    # While frame 2 runs, the new tile is shown and the old green survives.
    assert pixel(frames[1], 41, 41) == (200, 40, 170, 255)
    assert pixel(frames[1], 5, 5) == GREEN
    # Frame 3: clear applied only to frame 2's rectangle, so the green is
    # still there and the magenta rectangle is transparent.
    assert pixel(frames[2], 5, 5) == GREEN
    assert pixel(frames[2], 45, 45) == (0, 0, 0, 0)
    assert pixel(frames[2], 12, 12) == expected_move_clear_overlap()
    assert pixel(frames[2], 12, 12) == expected_blend_over(GREEN, SEMI_YELLOW)


def test_restore_previous_sample_matches_independent_pixels() -> None:
    frames = compose_project(sample_restore_previous())
    assert pixel(frames[0], 20, 20) == RED
    # During frame 2 the blue tile covers the red.
    assert pixel(frames[1], 20, 20) == (30, 60, 200, 255)
    # After frame 2 disposal the previous red is restored, and frame 3's
    # semi-transparent white blends against red (not blue).
    assert pixel(frames[2], 17, 17) == RED
    assert pixel(frames[2], 30, 30) == RED
    assert pixel(frames[2], 20, 20) == expected_restore_overlap()
    assert pixel(frames[2], 20, 20) == (228, 143, 148, 255)


# -------------------------------------------------------- seek invariance
@pytest.mark.parametrize(
    "factory",
    [sample_alpha_overlap, sample_move_and_clear, sample_restore_previous],
)
def test_direct_seek_equals_forward_composition(factory) -> None:
    project = factory()
    forward = compose_project(project)
    for index in range(len(project.frames)):
        direct = composite_at(project, index)
        assert np.array_equal(direct, forward[index])
        # Recomputing with a modified browse history must not change anything.
        shuffled = project.copy()
        assert np.array_equal(compose_project(shuffled)[index], forward[index])


def test_jumping_backwards_and_forwards_is_stateless() -> None:
    project = sample_restore_previous()
    baseline = compose_project(project)
    order = [2, 0, 1, 2, 2, 0]
    for index in order:
        assert np.array_equal(composite_at(project, index), baseline[index])


# -------------------------------------------------------------- disposal
def test_dispose_clear_only_clears_own_rectangle() -> None:
    base = solid_tile(6, 6, (10, 20, 30, 255))
    top = solid_tile(2, 2, (200, 0, 0, 255))
    project = Project(canvas_width=8, canvas_height=8)
    project.add_frame(Frame(base, x=0, y=0, duration_ms=100, blend=BLEND_REPLACE, dispose=DISPOSE_KEEP))
    project.add_frame(Frame(top, x=3, y=3, duration_ms=100, blend=BLEND_REPLACE, dispose=DISPOSE_CLEAR))
    project.add_frame(Frame(top, x=6, y=6, duration_ms=100, blend=BLEND_REPLACE, dispose=DISPOSE_KEEP))
    frames = compose_project(project)
    assert pixel(frames[2], 3, 3) == (0, 0, 0, 0)
    assert pixel(frames[2], 5, 5) == (10, 20, 30, 255)


def test_dispose_previous_restores_only_own_rectangle() -> None:
    base = solid_tile(6, 6, (10, 20, 30, 255))
    top = solid_tile(2, 2, (200, 0, 0, 255))
    other = solid_tile(2, 2, (0, 200, 0, 255))
    project = Project(canvas_width=8, canvas_height=8)
    project.add_frame(Frame(base, x=0, y=0, duration_ms=100, blend=BLEND_REPLACE, dispose=DISPOSE_KEEP))
    project.add_frame(Frame(top, x=2, y=2, duration_ms=100, blend=BLEND_REPLACE, dispose=DISPOSE_PREVIOUS))
    project.add_frame(Frame(other, x=5, y=5, duration_ms=100, blend=BLEND_REPLACE, dispose=DISPOSE_KEEP))
    frames = compose_project(project)
    assert pixel(frames[2], 2, 2) == (10, 20, 30, 255)
    assert pixel(frames[2], 5, 5) == (0, 200, 0, 255)
    assert pixel(frames[2], 0, 0) == (10, 20, 30, 255)


def test_previous_uses_canvas_before_this_frame_not_the_original() -> None:
    # Frame 1 paints red, frame 2 paints blue on top with previous disposal.
    # Frame 3 must therefore continue from red, not from transparent.
    red = solid_tile(4, 4, (255, 0, 0, 255))
    blue = solid_tile(2, 2, (0, 0, 255, 255))
    project = Project(canvas_width=4, canvas_height=4)
    project.add_frame(Frame(red, 0, 0, 100, BLEND_REPLACE, DISPOSE_KEEP))
    project.add_frame(Frame(blue, 1, 1, 100, BLEND_REPLACE, DISPOSE_PREVIOUS))
    project.add_frame(Frame(blue, 0, 2, 100, BLEND_OVER, DISPOSE_KEEP))
    frames = compose_project(project)
    assert pixel(frames[2], 1, 1) == (255, 0, 0, 255)
    assert pixel(frames[2], 0, 2) == (0, 0, 255, 255)


# ----------------------------------------------------------------- blend
def test_alpha_over_handles_transparent_and_opaque_cases() -> None:
    empty = np.zeros((1, 1, 4), dtype=np.uint8)
    opaque = np.array([[[200, 100, 50, 255]]], dtype=np.uint8)
    half = np.array([[[200, 100, 50, 128]]], dtype=np.uint8)
    assert tuple(alpha_over(empty, opaque)[0, 0]) == (200, 100, 50, 255)
    assert tuple(alpha_over(empty, half)[0, 0]) == (200, 100, 50, 128)
    assert tuple(alpha_over(opaque, empty)[0, 0]) == (200, 100, 50, 255)
    assert tuple(alpha_over(empty, empty)[0, 0]) == (0, 0, 0, 0)


def test_alpha_over_matches_float_reference_on_random_tiles() -> None:
    rng = np.random.default_rng(2024)
    for _ in range(50):
        dst = rng.integers(0, 256, (5, 7, 4), dtype=np.uint8)
        src = rng.integers(0, 256, (5, 7, 4), dtype=np.uint8)
        got = alpha_over(dst, src).astype(np.int64)
        sa = src[..., 3:4].astype(np.float64) / 255.0
        da = dst[..., 3:4].astype(np.float64) / 255.0
        a_out = sa + da * (1.0 - sa)
        rgb = np.divide(
            src[..., :3] / 255.0 * sa + dst[..., :3] / 255.0 * da * (1.0 - sa),
            a_out,
            out=np.zeros((5, 7, 3)),
            where=a_out > 0,
        )
        expected = np.concatenate(
            [
                np.rint(rgb * 255).astype(np.int64),
                np.rint(a_out * 255).astype(np.int64),
            ],
            axis=2,
        )
        expected[a_out[..., 0] == 0] = 0
        assert np.abs(got - expected).max() <= 1


# ------------------------------------------------------------ validation
def test_out_of_bounds_position_is_rejected() -> None:
    tile = solid_tile(10, 10, RED)
    project = Project(canvas_width=32, canvas_height=32)
    with pytest.raises(ValidationError, match="越界"):
        project.add_frame(Frame(tile, x=25, y=0))
    with pytest.raises(ValidationError, match="越界"):
        project.add_frame(Frame(tile, x=-1, y=0))
    with pytest.raises(ValidationError, match="越界"):
        project.add_frame(Frame(tile, x=0, y=30))


def test_tile_larger_than_canvas_is_rejected() -> None:
    tile = solid_tile(40, 10, RED)
    project = Project(canvas_width=32, canvas_height=32)
    with pytest.raises(ValidationError, match="超过画布"):
        project.add_frame(Frame(tile, x=0, y=0))


@pytest.mark.parametrize("duration", [0, -5, 65536, 100000])
def test_invalid_duration_is_rejected(duration: int) -> None:
    tile = solid_tile(4, 4, RED)
    with pytest.raises(ValidationError, match="显示时长"):
        Frame(tile, duration_ms=duration)


def test_moving_position_out_of_bounds_is_rejected_and_keeps_state() -> None:
    project = Project(canvas_width=16, canvas_height=16)
    project.add_frame(Frame(solid_tile(8, 8, RED), x=0, y=0))
    with pytest.raises(ValidationError, match="越界"):
        project.update_frame(0, x=9)
    assert project.frames[0].x == 0


def test_frame_count_and_canvas_limits() -> None:
    project = Project(canvas_width=16, canvas_height=16)
    for _ in range(20):
        project.add_frame(Frame(solid_tile(2, 2, RED)))
    with pytest.raises(ValidationError, match="上限"):
        project.add_frame(Frame(solid_tile(2, 2, RED)))

    too_big = Project(canvas_width=512, canvas_height=512)
    with pytest.raises(ValidationError, match="画布尺寸无效"):
        Project(canvas_width=513, canvas_height=10)
    too_big.set_canvas_size(512, 512)
    assert too_big.canvas_size == (512, 512)


def test_canvas_shrink_rejected_when_tiles_no_longer_fit() -> None:
    project = Project(canvas_width=64, canvas_height=64)
    project.add_frame(Frame(solid_tile(40, 40, RED), x=20, y=20))
    with pytest.raises(ValidationError, match="超过画布"):
        project.set_canvas_size(32, 32)
    assert project.canvas_size == (64, 64)


def test_invalid_loop_count_is_rejected() -> None:
    project = Project()
    with pytest.raises(ValidationError, match="循环次数"):
        project.set_loop_count(-1)
    with pytest.raises(ValidationError, match="循环次数"):
        project.set_loop_count(70000)


def test_move_frame_reorders() -> None:
    project = Project()
    a = Frame(solid_tile(2, 2, RED), name="a")
    b = Frame(solid_tile(2, 2, GREEN), name="b")
    project.add_frame(a)
    project.add_frame(b)
    assert project.move_frame(1, -1) == 0
    assert [f.name for f in project.frames] == ["b", "a"]
    with pytest.raises(ValidationError, match="最后"):
        project.move_frame(1, 1)
    with pytest.raises(ValidationError, match="第一"):
        project.move_frame(0, -1)
