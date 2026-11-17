"""Playback scheduler tests: timing, looping, pause, seek, late events."""

from __future__ import annotations

from giftool.player import (
    MIN_PLAYABLE_MS,
    SHORT_FRAME_MS,
    PlaybackScheduler,
    Timeline,
    effective_duration_ms,
)


def test_short_frame_rule() -> None:
    assert effective_duration_ms(0) == SHORT_FRAME_MS
    assert effective_duration_ms(MIN_PLAYABLE_MS - 1) == SHORT_FRAME_MS
    assert effective_duration_ms(MIN_PLAYABLE_MS) == MIN_PLAYABLE_MS
    assert effective_duration_ms(250) == 250


def test_effective_timeline_keeps_stored_values() -> None:
    tl = Timeline([0, 19, 20, 100], 0)
    assert tl.effective_durations_ms == [
        SHORT_FRAME_MS,
        SHORT_FRAME_MS,
        20,
        100,
    ]
    # Stored durations remain available for display.
    assert tl.stored_durations_ms == [0, 19, 20, 100]


def test_frame_boundaries_within_one_pass() -> None:
    tl = Timeline([100, 100, 200, 300], 2)  # 700 ms/pass
    scheduler = PlaybackScheduler(tl)
    scheduler.play(0)
    expected = [
        (0, 0), (99, 0), (100, 1), (199, 1), (200, 2),
        (399, 2), (400, 3), (699, 3),
    ]
    for now, frame in expected:
        assert scheduler.update(now)[0] == frame


def test_loop_count_means_n_plus_one_plays() -> None:
    tl = Timeline([100, 100], 2)  # 3 total plays, 200 ms each = 600 ms
    assert tl.total_plays == 3
    scheduler = PlaybackScheduler(tl)
    scheduler.play(0)
    assert scheduler.update(200)[0] == 0  # wrapped into second pass
    assert scheduler.update(400)[0] == 0  # wrapped into third pass
    frame, finished = scheduler.update(600)
    assert finished is True
    assert frame == 1
    assert scheduler.is_playing is False


def test_infinite_loop_never_finishes() -> None:
    tl = Timeline([100], 0)
    scheduler = PlaybackScheduler(tl)
    scheduler.play(0)
    frame, finished = scheduler.update(10_000_000)
    assert finished is False
    assert frame == 0


def test_pause_drops_late_events() -> None:
    tl = Timeline([100, 100, 100], 0)
    scheduler = PlaybackScheduler(tl)
    scheduler.play(0)
    scheduler.update(50)
    scheduler.pause()
    generation = scheduler.generation
    # A timestamp arriving long after pausing must not move the frame.
    frame, _ = scheduler.update(9_999_999)
    assert frame == 0
    assert scheduler.generation == generation
    assert scheduler.is_playing is False


def test_backward_seek_is_deterministic() -> None:
    tl = Timeline([100, 100, 100, 100], 0)
    scheduler = PlaybackScheduler(tl)
    scheduler.play(0)
    scheduler.update(350)
    assert scheduler.frame_index == 3
    scheduler.seek_to_frame(1)
    assert scheduler.frame_index == 1
    assert scheduler.step_backward() == 0
    # Backward stepping clamps at frame 0 instead of wrapping a loop.
    assert scheduler.step_backward() == 0


def test_step_forward_clamps_at_end() -> None:
    tl = Timeline([100, 100], 0)
    scheduler = PlaybackScheduler(tl)
    scheduler.seek_to_frame(1)
    assert scheduler.step_forward() == 1


def test_stop_and_reset_for_reopen() -> None:
    tl = Timeline([100, 100], 0)
    scheduler = PlaybackScheduler(tl)
    scheduler.play(0)
    scheduler.update(150)
    scheduler.stop_and_reset()
    assert scheduler.frame_index == 0
    assert scheduler.is_playing is False
    assert scheduler.play_index == 0


def test_resume_after_pause_keeps_offset() -> None:
    tl = Timeline([100, 100, 100], 0)
    scheduler = PlaybackScheduler(tl)
    scheduler.play(1_000)
    scheduler.update(1_050)  # 50 ms in, frame 0
    scheduler.pause()
    scheduler.play(5_000)  # resume; internal start shifted to keep offset
    assert scheduler.update(5_050)[0] == 0
    assert scheduler.update(5_100)[0] == 1


def test_seek_bumps_generation_to_invalidate_callbacks() -> None:
    tl = Timeline([100, 100], 0)
    scheduler = PlaybackScheduler(tl)
    before = scheduler.generation
    scheduler.seek_to_frame(1)
    assert scheduler.generation != before
