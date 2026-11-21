import pytest

from app.timecode import (
    DroppedFrameError,
    RateMode,
    Timecode,
    TimecodeError,
    format_frame,
    format_tc,
    frame_to_tc,
    parse_tc,
    relative_time,
    tc_to_frame,
)

DF = RateMode.DF_2997
NDF30 = RateMode.NDF_2997
NDF25 = RateMode.NDF_25


def rt(mode, n, hh, mm, ss, ff, day=0):
    assert frame_to_tc(n, mode) == Timecode(hh, mm, ss, ff, day)
    assert tc_to_frame(Timecode(hh, mm, ss, ff, day), mode) == n


class TestNDF25:
    def test_zero(self):
        rt(NDF25, 0, 0, 0, 0, 0)

    def test_second_boundary(self):
        rt(NDF25, 25, 0, 0, 1, 0)

    def test_minute_boundary(self):
        rt(NDF25, 25 * 60, 0, 1, 0, 0)

    def test_ten_minute_boundary(self):
        rt(NDF25, 25 * 600, 0, 10, 0, 0)

    def test_midnight_crossing(self):
        # 23:59:59:24 的下一帧是次日 00:00:00:00
        last = 24 * 3600 * 25 - 1
        rt(NDF25, last, 23, 59, 59, 24, 0)
        rt(NDF25, last + 1, 0, 0, 0, 0, 1)
        assert format_frame(last + 1, NDF25) == "00:00:00:00+1天"

    def test_roundtrip_sweep(self):
        for n in range(0, 25 * 3600 * 26, 997):
            assert tc_to_frame(frame_to_tc(n, NDF25), NDF25) == n


class TestNDF2997:
    def test_minute_boundary_no_drop(self):
        # 不丢帧: 整分钟就是 00 号
        rt(NDF30, 1800, 0, 1, 0, 0)

    def test_midnight(self):
        last = 24 * 3600 * 30 - 1
        rt(NDF30, last, 23, 59, 59, 29, 0)
        rt(NDF30, last + 1, 0, 0, 0, 0, 1)

    def test_roundtrip_sweep(self):
        for n in range(0, 30 * 3600 * 25, 1237):
            assert tc_to_frame(frame_to_tc(n, NDF30), NDF30) == n


class TestDF2997:
    def test_zero(self):
        rt(DF, 0, 0, 0, 0, 0)

    def test_first_minute_end(self):
        # 第一分钟实际 1800 帧 (0..1799), 编号到 00:00:59;29
        rt(DF, 1799, 0, 0, 59, 29)

    def test_minute_boundary_drops_two(self):
        # 第 1800 帧的编号是 00:01:00;02 — 00 和 01 被跳过
        rt(DF, 1800, 0, 1, 0, 2)

    def test_dropped_numbers_rejected(self):
        for mm in (1, 2, 3, 7, 9, 11, 23):
            for ff in (0, 1):
                with pytest.raises(DroppedFrameError):
                    tc_to_frame(Timecode(0, mm, 0, ff), DF)

    def test_ten_minute_boundary_no_drop(self):
        # 整十分钟不跳号: 00:10:00;00 合法
        rt(DF, 17982, 0, 10, 0, 0)
        rt(DF, 17982 * 2, 0, 20, 0, 0)

    def test_hour_boundary(self):
        # 1 小时实际帧数 107892 = 30*3600 - 2*(60-6)
        rt(DF, 107892, 1, 0, 0, 0)

    def test_midnight_crossing(self):
        # 24 小时实际帧数 = 30*86400 - 2*(1440 - 144) = 2589408
        n = 2589408
        rt(DF, n - 1, 23, 59, 59, 29, 0)
        rt(DF, n, 0, 0, 0, 0, 1)
        assert format_frame(n, DF) == "00:00:00;00+1天"

    def test_midnight_drop_continuity(self):
        # 跨午夜后丢帧计数不重置: 00:01:00;00+1天 仍是被跳过的编号
        with pytest.raises(DroppedFrameError):
            tc_to_frame(Timecode(0, 1, 0, 0, day=1), DF)

    def test_roundtrip_sweep(self):
        for n in range(0, 30 * 3600 * 25, 991):
            assert tc_to_frame(frame_to_tc(n, DF), DF) == n

    def test_frame_out_of_range(self):
        with pytest.raises(TimecodeError):
            tc_to_frame(Timecode(0, 0, 0, 30), DF)
        with pytest.raises(TimecodeError):
            tc_to_frame(Timecode(0, 0, 0, 25), NDF25)


class TestParse:
    def test_basic(self):
        assert parse_tc("01:02:03:04", NDF25) == Timecode(1, 2, 3, 4)

    def test_semicolon(self):
        assert parse_tc("01:02:03;04", DF) == Timecode(1, 2, 3, 4)

    def test_hour_overflow_becomes_day(self):
        assert parse_tc("24:00:00:00", NDF25) == Timecode(0, 0, 0, 0, 1)
        assert parse_tc("25:00:00:00", NDF25) == Timecode(1, 0, 0, 0, 1)

    def test_day_suffix(self):
        assert parse_tc("00:00:00:00+2天", NDF25) == Timecode(0, 0, 0, 0, 2)
        assert parse_tc("00:00:00;00+1d", DF) == Timecode(0, 0, 0, 0, 1)

    def test_dropped_rejected(self):
        with pytest.raises(DroppedFrameError):
            parse_tc("00:07:00;01", DF)
        # 同一个编号在不丢帧制式下合法
        assert parse_tc("00:07:00:01", NDF30) == Timecode(0, 7, 0, 1)

    def test_garbage(self):
        with pytest.raises(TimecodeError):
            parse_tc("abc", NDF25)

    def test_format_parse_roundtrip(self):
        for mode in (NDF25, NDF30, DF):
            for n in (0, 1, 1799, 1800, 17982, 107892, 2589408, 2589408 + 1800):
                if mode is NDF25 and n >= 24 * 3600 * 25 * 2:
                    continue
                tc = frame_to_tc(n, mode)
                assert parse_tc(format_tc(tc, mode), mode) == tc


class TestRelativeTime:
    def test_25fps(self):
        assert relative_time(25, NDF25) == "00:00:01.000"
        assert relative_time(0, NDF25) == "00:00:00.000"

    def test_2997(self):
        # 30 帧在 29.97 下实际约 1.001 秒
        assert relative_time(30, DF) == "00:00:01.001"
