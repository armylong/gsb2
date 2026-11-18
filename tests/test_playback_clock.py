"""Playback clock rules: per-frame durations, loop counts, pause."""

from __future__ import annotations

import pytest

from apng_editor.playback import PlaybackClock


def make_clock(durations=(100, 200, 300), loop_count=0) -> PlaybackClock:
    clock = PlaybackClock(durations_ms=list(durations), loop_count=loop_count)
    clock.start()
    return clock


def test_each_frame_uses_its_own_duration() -> None:
    clock = make_clock()
    assert clock.index == 0
    assert not clock.tick(99)
    assert clock.tick(1)  # 100 ms elapsed → frame 1
    assert clock.index == 1
    assert not clock.tick(199)
    assert clock.tick(1)  # 200 ms on frame 1 → frame 2
    assert clock.index == 2
    assert not clock.tick(299)
    assert clock.tick(1)
    assert clock.index == 0  # infinite loop wrapped
    assert clock.plays_completed == 1


def test_large_tick_skips_multiple_frames() -> None:
    clock = make_clock((100, 200, 300))
    clock.tick(100 + 200 + 10)
    assert clock.index == 2
    assert clock.elapsed_ms == 10


def test_paused_clock_never_advances() -> None:
    clock = make_clock()
    clock.pause()
    for _ in range(100):
        assert not clock.tick(50)
    assert clock.index == 0
    assert clock.elapsed_ms == 0


def test_finite_loop_stops_on_last_frame_after_n_passes() -> None:
    clock = make_clock((100, 100), loop_count=2)
    total = 100 * 2 * 2
    clock.tick(total)
    assert clock.finished
    assert clock.plays_completed == 2
    assert clock.index == 1  # stays on the last frame
    assert not clock.playing
    assert not clock.tick(1000)  # no further progress
    assert clock.index == 1


def test_finite_loop_does_not_stop_early() -> None:
    clock = make_clock((100, 100), loop_count=2)
    clock.tick(399)
    assert not clock.finished
    assert clock.plays_completed == 1
    clock.tick(1)
    assert clock.finished


def test_infinite_loop_never_finishes() -> None:
    clock = make_clock((50, 50), loop_count=0)
    clock.tick(50 * 2 * 100)  # 100 passes
    assert not clock.finished
    assert clock.playing
    assert clock.plays_completed >= 99


def test_start_restarts_from_frame_zero() -> None:
    clock = make_clock()
    clock.tick(250)
    assert clock.index == 1
    clock.start()
    assert clock.index == 0
    assert clock.elapsed_ms == 0
    assert clock.plays_completed == 0


def test_step_pauses_and_clamps() -> None:
    clock = make_clock()
    clock.step(5)
    assert not clock.playing
    assert clock.index == 2
    clock.step(-10)
    assert clock.index == 0


def test_duration_updates_keep_index_valid() -> None:
    clock = make_clock()
    clock.step(2)
    clock.set_durations([100, 100])
    assert clock.index == 1
    clock.set_durations([])
    assert clock.index == 0
    assert not clock.playing


def test_cycle_labels_explain_loop_mode() -> None:
    infinite = make_clock()
    assert "无限循环" in infinite.cycle_label()
    finite = make_clock(loop_count=3)
    assert "1/3" in finite.cycle_label()
    finite.tick(600 * 3)
    assert finite.finished
    assert "播放结束" in finite.cycle_label()


def test_negative_tick_rejected() -> None:
    clock = make_clock()
    with pytest.raises(ValueError):
        clock.tick(-1)
