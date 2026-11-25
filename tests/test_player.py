"""播放引擎的取数/循环/边界测试 (不依赖真实音频后端)。"""

import os
import unittest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import numpy as np
from PySide6.QtWidgets import QApplication

from cue_lab import examples
from cue_lab.mixer import MODE_BG, MODE_CUE, MODE_MIX, render_mode, segment_sample_range
from cue_lab.player import SegmentPlayer

app = QApplication.instance() or QApplication([])


class TestSegmentPlayer(unittest.TestCase):
    def setUp(self):
        self.sr = examples.SR
        self.state = examples.build_intermittent_example()
        self.player = SegmentPlayer(self.sr)

    def tearDown(self):
        self.player.stop()

    def test_loop_reads_stay_inside_segment(self):
        s = self.state
        seg = segment_sample_range(s)
        mix = render_mode(s, MODE_MIX)
        self.player.set_mix(mix, seg, playing=False)
        self.player._playing = True
        self.player.set_loop(True)
        self.player._pos = seg[0]
        total_bytes = (seg[1] - seg[0]) * 2 * 3 + 1234
        got = self.player.readData(total_bytes)
        # 循环播放可以持续供给, 游标始终落在区间内
        self.assertTrue(seg[0] <= self.player._pos < seg[1])
        self.assertEqual(len(got), total_bytes)

    def test_non_loop_stops_at_segment_end(self):
        s = self.state
        seg = segment_sample_range(s)
        mix = render_mode(s, MODE_MIX)
        self.player.set_mix(mix, seg, playing=False)
        self.player._playing = True
        self.player.set_loop(False)
        self.player._pos = seg[1] - 5
        data = self.player.readData(10_000)
        # 只给出剩余 5 帧 (10 字节), 之后不再越界供给
        self.assertEqual(len(data), 10)
        self.assertEqual(self.player._pos, seg[1])

    def test_set_mix_preserves_cursor_sample(self):
        s = self.state
        seg = segment_sample_range(s)
        self.player.set_mix(render_mode(s, MODE_MIX), seg)
        target = seg[0] + 1234
        self.player._pos = target
        # 切模式只换缓冲, 游标采样位置不变
        self.player.set_mix(render_mode(s, MODE_BG), seg)
        self.assertEqual(self.player._pos, target)
        self.player.set_mix(render_mode(s, MODE_CUE), seg)
        self.assertEqual(self.player._pos, target)

    def test_data_matches_rendered_stem(self):
        s = self.state
        seg = segment_sample_range(s)
        mix = render_mode(s, MODE_MIX)
        self.player.set_mix(mix, seg)
        # 缓冲必须与播放器自身的完整处理链 (软限幅 + Int16 量化) 完全一致
        expected = SegmentPlayer._to_int16(mix)
        np.testing.assert_array_equal(self.player._array, expected)
        # 真实静音 (浮点精确零) 量化后仍为零, 不产生时间空洞
        np.testing.assert_array_equal(self.player._array[mix == 0.0], 0)
        # 限幅后不允许超过满刻度
        self.assertLessEqual(int(np.max(np.abs(self.player._array))), 32767)

    def test_soft_clip_on_overflow(self):
        # 人为构造大幅值, 确认不会产生 NaN/Inf, 且被压回合法 Int16 范围
        y = np.ones(1000) * 5.0
        pcm = SegmentPlayer._to_int16(y)
        self.assertTrue(np.isfinite(pcm).all())
        self.assertLessEqual(int(np.max(pcm)), 32767)

    def test_rebuild_during_playback_keeps_cursor(self):
        """播放中换缓冲 (切模式/改推子) 不中断且游标采样位置保持。"""
        s = self.state
        seg = segment_sample_range(s)
        self.player.set_mix(render_mode(s, MODE_MIX), seg)
        self.player._playing = True
        self.player._pos = seg[0] + 4321
        for mode in (MODE_BG, MODE_CUE, MODE_MIX):
            self.player.set_mix(render_mode(s, mode), seg)
            self.assertEqual(self.player._pos, seg[0] + 4321)
            self.assertTrue(self.player._playing)

    def test_segment_change_clamps_cursor(self):
        """试听段变化时游标被夹进新段, 不会落到播放区间外。"""
        s = self.state
        seg = segment_sample_range(s)
        self.player.set_mix(render_mode(s, MODE_MIX), seg)
        self.player._pos = seg[1] - 2
        new_seg = (seg[0] + 100, seg[0] + 200)
        self.player.set_mix(render_mode(s, MODE_MIX), new_seg)
        self.assertTrue(new_seg[0] <= self.player._pos < new_seg[1])


if __name__ == "__main__":
    unittest.main()
