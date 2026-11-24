"""模拟核心的数值/物理正确性测试（不依赖 Qt）。

运行：.venv/bin/python -m unittest tests.test_model -v
"""
from __future__ import annotations

import unittest

import numpy as np

from rolling_shutter.model import (
    DIRECTION_BOTTOM_UP, DIRECTION_TOP_DOWN, MODE_GLOBAL, MODE_ROLLING,
    ObjectSpec, SimParams, render_clip, row_timing,
)


def _params(**overrides) -> SimParams:
    base = dict(
        width=40, height=20, fps=10.0, n_frames=4,
        readout_direction=DIRECTION_TOP_DOWN,
        total_readout=0.050, exposure=0.030, ambient=0.02,
        flash_enabled=False,
        objects=(ObjectSpec("条", x0=2.0, velocity=100.0, width=4.0,
                            y0=2, y1=18, color=(0.9, 0.9, 0.9)),),
    )
    base.update(overrides)
    return SimParams(**base)


class TimingTests(unittest.TestCase):
    def test_rolling_windows_follow_readout_top_down(self):
        p = _params()
        starts, ends, reads = row_timing(p, MODE_ROLLING, 0)
        # 自上而下：读出时刻从 t0 线性增长到 t0+R
        np.testing.assert_allclose(reads[0], 0.0)
        np.testing.assert_allclose(reads[-1], p.total_readout)
        np.testing.assert_allclose(ends, reads)  # 曝光窗终点即读出时刻
        np.testing.assert_allclose(starts, reads - p.exposure)
        self.assertTrue(np.all(np.diff(reads) > 0))

    def test_direction_bottom_up_reverses_order(self):
        down = row_timing(_params(), MODE_ROLLING, 1)[2]
        up = row_timing(_params(readout_direction=DIRECTION_BOTTOM_UP),
                        MODE_ROLLING, 1)[2]
        # 反向读出：行 0 最晚、最后一行最早；两序列为逆序
        np.testing.assert_allclose(up, down[::-1])
        self.assertGreater(up[0], up[-1])

    def test_global_shutter_single_shared_window(self):
        p = _params()
        starts, ends, reads = row_timing(p, MODE_GLOBAL, 2)
        np.testing.assert_allclose(starts, np.full(p.height, 0.2))
        np.testing.assert_allclose(ends, np.full(p.height, 0.2 + p.exposure))
        # 全局快门下读出仍逐行排队，但所有行曝光窗完全一致
        self.assertEqual(len(np.unique(np.round(starts, 9))), 1)
        self.assertEqual(len(np.unique(np.round(ends, 9))), 1)

    def test_frame_times_are_absolute(self):
        p = _params()
        clip = render_clip(p, MODE_ROLLING)
        np.testing.assert_allclose(clip.frame_times,
                                   [0.0, 0.1, 0.2, 0.3])
        self.assertEqual(clip.windows.shape, (4, p.height, 2))


class FlashTests(unittest.TestCase):
    def _flash_params(self) -> SimParams:
        # 闪光落在第 0 帧滚动读出窗口中部，时长只覆盖少数行
        return _params(flash_enabled=True, flash_start=0.020,
                       flash_duration=0.004, flash_intensity=0.9)

    def test_rolling_flash_lights_only_partial_rows(self):
        clip = render_clip(self._flash_params(), MODE_ROLLING)
        overlap = clip.flash_overlap[0]
        lit = np.where(overlap > 0)[0]
        self.assertGreater(len(lit), 0)
        self.assertLess(len(lit), clip.params.height)  # 只有部分行
        # 被照亮行严格比未照亮行亮（行均值）
        self.assertGreater(clip.row_means[0, lit].mean(),
                           clip.row_means[0, overlap == 0].mean())
        # overlap 与曝光窗几何一致：重叠时长 = overlap * E
        for r in lit:
            a, b = clip.windows[0, r]
            fs, fe = 0.020, 0.024
            expected = max(0.0, min(b, fe) - max(a, fs)) / (b - a)
            self.assertAlmostEqual(float(overlap[r]), expected, places=9)

    def test_global_flash_lights_all_rows_when_inside_window(self):
        p = self._flash_params()
        clip_g = render_clip(p, MODE_GLOBAL)
        # 闪光 20~24ms 完整落在全局曝光窗 0~30ms 内 -> 每行覆盖比例相同
        self.assertTrue(np.all(clip_g.flash_overlap[0] > 0))
        np.testing.assert_allclose(
            clip_g.flash_overlap[0],
            np.full(p.height, 0.004 / p.exposure))
        clip_r = render_clip(p, MODE_ROLLING)
        self.assertGreater(
            int((clip_g.flash_overlap[0] > 0).sum()),
            int((clip_r.flash_overlap[0] > 0).sum()))

    def test_row_readings_match_picture(self):
        # 行均值曲线必须直接来自画面像素，二者一致
        clip = render_clip(self._flash_params(), MODE_ROLLING)
        for fi in range(clip.n_frames):
            np.testing.assert_allclose(
                clip.row_means[fi], clip.frames[fi].mean(axis=(1, 2)))


class EdgeAndMotionTests(unittest.TestCase):
    def test_object_moving_out_of_frame_stays_in_range(self):
        # 高速物体在短片中途完全移出右边界（画面需高于标尺，取中间行核对）
        p = _params(height=40,
                    objects=(ObjectSpec("跑", x0=2.0, velocity=2000.0,
                                        width=4.0, y0=0, y1=40,
                                        color=(0.9, 0.9, 0.9)),))
        clip = render_clip(p, MODE_ROLLING)
        self.assertTrue(np.all(np.isfinite(clip.frames)))
        self.assertTrue(np.all(clip.frames >= 0.0))
        self.assertTrue(np.all(clip.frames <= 1.0))
        # 最后一帧物体已完全离开画面：中间行（避开上下标尺）无亮像素
        last = clip.frames[-1]
        middle = last[15:25].mean(axis=(0, 2))  # 行 15..24 平均到每列
        interior = middle[1:-1]                 # 排除标尺所在首列
        np.testing.assert_allclose(interior, p.ambient, atol=1e-6)

    def test_partial_entry_at_left_edge_is_clipped(self):
        # 物体左边缘在画面外（x0 为负），只有右半截在画面内，不越界
        p = _params(objects=(ObjectSpec("半入", x0=-2.0, velocity=0.0,
                                        width=4.0, y0=5, y1=15,
                                        color=(0.8, 0.8, 0.8)),))
        clip = render_clip(p, MODE_GLOBAL)
        row = clip.frames[0, 10]
        # 列 0、1 被覆盖，列 2 起回到背景
        self.assertGreater(row[0].mean(), p.ambient)
        self.assertGreater(row[1].mean(), p.ambient)
        self.assertAlmostEqual(float(row[2].mean()), p.ambient, places=5)

    def test_longer_exposure_causes_longer_smear(self):
        # 同一运动、同一读出方式下，曝光越长拖尾越宽
        short = render_clip(_params(exposure=0.005), MODE_GLOBAL)
        long = render_clip(_params(exposure=0.050), MODE_GLOBAL)

        def bright_width(clip, fi, row):
            return int((clip.frames[fi, row].mean(axis=1) > 0.2).sum())

        self.assertGreater(bright_width(long, 1, 10),
                           bright_width(short, 1, 10))

    def test_rolling_skews_fast_object_relative_to_global(self):
        # 高速水平运动：滚动快门各行采样时刻不同 -> 物体位置随行变化（剪切）
        p = _params(width=120, height=40,
                    objects=(ObjectSpec("快", x0=2.0, velocity=400.0,
                                        width=3.0, y0=0, y1=40,
                                        color=(0.9, 0.9, 0.9)),),
                    exposure=0.010)
        g = render_clip(p, MODE_GLOBAL)
        r = render_clip(p, MODE_ROLLING)

        def centroid(frame, row):
            weights = frame[row].mean(axis=1)
            cols = np.arange(len(weights))
            return float((cols * weights).sum() / max(weights.sum(), 1e-12))

        # 取第 0 帧的顶部行与底部行（标尺偏差在两行相同，质心作差时抵消）
        spread_g = centroid(g.frames[0], 2) - centroid(g.frames[0], 38)
        spread_r = centroid(r.frames[0], 2) - centroid(r.frames[0], 38)
        self.assertAlmostEqual(spread_g, 0.0, places=6)  # 全局：各行同心
        self.assertNotAlmostEqual(spread_r, 0.0, places=2)  # 滚动：行内错位


class DeterminismTests(unittest.TestCase):
    def test_same_params_identical_frames_and_signature(self):
        p = _params(flash_enabled=True, flash_start=0.01, flash_duration=0.002)
        a = render_clip(p, MODE_ROLLING)
        b = render_clip(p, MODE_ROLLING)
        np.testing.assert_array_equal(a.frames, b.frames)
        self.assertEqual(a.signature, b.signature)
        c = render_clip(_params(exposure=0.011), MODE_ROLLING)
        self.assertNotEqual(a.signature, c.signature)

    def test_modes_share_frame_times(self):
        p = _params()
        g = render_clip(p, MODE_GLOBAL)
        r = render_clip(p, MODE_ROLLING)
        np.testing.assert_array_equal(g.frame_times, r.frame_times)
        self.assertEqual(g.signature, r.signature)  # 同参数同指纹


if __name__ == "__main__":
    unittest.main()
