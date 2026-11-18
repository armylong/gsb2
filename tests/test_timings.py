"""纯时间数学测试: 偏移正负、floor 选帧、重叠区间、循环折回。"""
from __future__ import annotations

import pytest

from syncplayer.timings import (
    VideoInfo,
    choose_frame,
    format_time,
    overlap_interval,
    wrap_into,
)


def make_info(pts: tuple[float, ...], duration: float | None = None) -> VideoInfo:
    return VideoInfo(
        path="x", width=320, height=240,
        duration=duration if duration is not None else pts[-1] + 0.1,
        pts=pts, has_audio=False, frame_rate_nominal=None,
    )


def test_floor_selection_never_after_request():
    info = make_info(tuple(i / 10.0 for i in range(10)), duration=1.0)
    choice = choose_frame(info, 0.27)
    assert choice.within
    assert choice.index == 2
    assert choice.pts == pytest.approx(0.2)
    # 滞后恒在 [0, 一个帧间隔) 内
    assert 0.0 <= choice.lag < 0.1


def test_exact_pts_picks_that_frame():
    info = make_info(tuple(i / 24.0 for i in range(24)), duration=1.0)
    choice = choose_frame(info, 5 / 24.0)
    assert choice.index == 5
    assert choice.lag == pytest.approx(0.0, abs=1e-9)


def test_before_first_frame_is_blank_not_clamped():
    info = make_info((0.0, 0.1, 0.2), duration=0.3)
    choice = choose_frame(info, -0.05)
    assert not choice.within
    assert choice.reason == "before"
    assert choice.pts is None


def test_at_duration_is_after_blank_not_last_frame():
    # 半开区间 [0, duration): 到 duration 必须显示无画面, 不停在末帧
    info = make_info((0.0, 0.1, 0.2), duration=0.3)
    choice = choose_frame(info, 0.3)
    assert not choice.within
    assert choice.reason == "after"


def test_different_rates_same_master_clock():
    # A 30fps / B 24fps, 约定 B内容时间 = 主时间 + offset
    a = make_info(tuple(i / 30.0 for i in range(300)), duration=10.0)
    b = make_info(tuple(i / 24.0 for i in range(240)), duration=10.0)
    offset = -0.5
    for master in (0.6, 1.234, 3.777, 8.0):
        ca = choose_frame(a, master)
        cb = choose_frame(b, master + offset)
        assert ca.within and cb.within
        assert ca.lag < 1 / 30.0
        assert cb.lag < 1 / 24.0
        # 选中帧都不晚于各自请求时间
        assert ca.pts <= master + 1e-9
        assert cb.pts <= master + offset + 1e-9


def test_negative_offset_overlap_boundaries():
    # B 比 A 晚 0.5s 开始 => offset=-0.5;
    # B 在主时间有效区间 [0.5, 0.5+9.5)=[0.5, 10), 与 A[0,10) 相交
    ov = overlap_interval(duration_a=10.0, duration_b=9.5, offset=-0.5)
    assert ov == pytest.approx((0.5, 10.0))


def test_positive_offset_overlap_boundaries():
    # offset=+0.5: B 在主时间有效区间 [-0.5, 9.0); 与 A 相交得 [0, 9.0)
    ov = overlap_interval(duration_a=10.0, duration_b=9.5, offset=0.5)
    assert ov == pytest.approx((0.0, 9.0))


def test_no_overlap_returns_none_and_loop_refused():
    assert overlap_interval(10.0, 2.0, 5.0) is None
    assert overlap_interval(10.0, 2.0, -20.0) is None


def test_wrap_into_half_open_loop():
    assert wrap_into(9.0, 0.5, 9.0) == pytest.approx(0.5)
    assert wrap_into(9.3, 0.5, 9.0) == pytest.approx(0.8)
    assert wrap_into(4.0, 0.5, 9.0) == pytest.approx(4.0)


def test_format_time():
    assert format_time(0.0) == "00:00.000"
    assert format_time(83.25) == "01:23.250"
    assert format_time(None) == "--:--.---"
