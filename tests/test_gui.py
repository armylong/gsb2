"""offscreen GUI 冒烟测试: 不发声、不弹窗, 验证主窗口整条交互链路。"""

import os
import tempfile
import unittest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import numpy as np
from PySide6.QtWidgets import QApplication

from cue_lab import examples, project as project_io
from cue_lab.main_window import MainWindow
from cue_lab.mixer import MODE_BG, MODE_CUE, MODE_MIX, render_mode, segment_sample_range

app = QApplication.instance() or QApplication([])


class TestMainWindowSmoke(unittest.TestCase):
    def setUp(self):
        self.win = MainWindow(examples.build_intermittent_example())

    def tearDown(self):
        self.win.player.stop()
        self.win.close()

    def test_initial_render(self):
        s = self.win.state
        self.assertEqual(len(s.cues), 3)
        self.assertTrue(self.win.spectrogram._heat is not None)
        self.assertEqual(self.win.energy.bg_db.shape[1], 8)
        self.assertEqual(len(self.win.energy.cue_db), 3)
        # 播放器缓冲覆盖整条时间轴, 区间在缓冲内
        self.assertGreaterEqual(self.win.player._seg[1], self.win.player._seg[0])
        self.assertLessEqual(self.win.player._seg[1], len(self.win.player._array))

    def test_mode_switch_keeps_segment_and_position(self):
        s = self.win.state
        seg_before = segment_sample_range(s)
        self.win.player.seek_seconds(s.seg_start + 0.3)
        pos_before = self.win.player.position_seconds()
        for mode in (MODE_CUE, MODE_BG, MODE_MIX):
            self.win.mode_buttons[mode].setChecked(True)
            self.assertEqual(self.win.state.mode, mode)
            self.assertEqual(segment_sample_range(self.win.state), seg_before)
            self.assertAlmostEqual(self.win.player.position_seconds(), pos_before, places=4)
        # 只听背景与背景 stem 一致
        self.win.mode_buttons[MODE_BG].setChecked(True)
        np.testing.assert_allclose(self.win.player._array.astype(float) / 32768.0,
                                   render_mode(self.win.state, MODE_BG), atol=4e-5)

    def test_gain_change_preserves_cue_start_sample(self):
        s = self.win.state
        first_before = int(np.flatnonzero(
            np.abs(render_mode(s, MODE_MIX)) > 1e-9)[0])
        self.win.cue_gain.set_value_db(-18.0)
        self.win._on_cue_gain()
        self.win._rebuild_timer.stop()
        self.win._rebuild()
        first_after = int(np.flatnonzero(
            np.abs(render_mode(s, MODE_MIX)) > 1e-9)[0])
        self.assertEqual(first_before, first_after)

    def test_chart_click_selects_band_and_moves_segment(self):
        s = self.win.state
        old_band = s.selected_band
        target_band = 0 if old_band != 0 else 2
        self.win._on_band_selected(target_band)
        self.assertEqual(s.selected_band, target_band)
        t = s.test_start + (s.test_end - s.test_start) * 0.4
        self.win._move_segment_start(t)
        self.assertAlmostEqual(s.seg_start, t, places=3)
        self.assertGreaterEqual(s.seg_start, s.test_start - 1e-9)
        self.assertLessEqual(s.seg_end(), s.test_end + 1e-9)

    def test_drag_creates_audition_range(self):
        s = self.win.state
        t0 = s.test_start + 0.2
        dur = 0.6
        self.win._on_spectro_drag(t0, dur)
        self.assertAlmostEqual(s.seg_start, t0, places=3)
        self.assertAlmostEqual(s.seg_dur, dur, places=3)

    def test_project_roundtrip_through_window(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "w.cuelab.json")
            project_io.save_project(p, self.win.state)
            state2 = project_io.load_project(p)
        win2 = MainWindow(state2)
        try:
            self.assertEqual(len(win2.state.cues), len(self.win.state.cues))
            np.testing.assert_allclose(
                render_mode(win2.state, MODE_MIX),
                render_mode(self.win.state, MODE_MIX),
                atol=4e-4,
            )
        finally:
            win2.player.stop()
            win2.close()

    def test_play_stop_lifecycle(self):
        self.win.player.set_loop(False)
        self.win.player.seek_seconds(self.win.state.seg_start)
        # 不真正 start 音频设备 (offscreen 无后端保证); 临时置播放态验证区间取数
        self.win.player._playing = True
        try:
            data = self.win.player.readData(2048)
            self.assertEqual(len(data), 2048)
            # 游标按读取字节数前移
            self.assertGreater(self.win.player.position_seconds(),
                               self.win.state.seg_start)
        finally:
            self.win.player.stop()
        self.assertFalse(self.win.player.is_playing())


if __name__ == "__main__":
    unittest.main()
