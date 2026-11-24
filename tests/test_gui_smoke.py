"""GUI 离屏冒烟测试（QT_QPA_PLATFORM=offscreen，无需窗口服务器）。

运行：QT_QPA_PLATFORM=offscreen .venv/bin/python -m unittest tests.test_gui_smoke -v
"""
from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import numpy as np  # noqa: E402
from PySide6.QtWidgets import QApplication  # noqa: E402

from rolling_shutter.export import export_clip, verify_export  # noqa: E402
from rolling_shutter.gui.main_window import MainWindow  # noqa: E402
from rolling_shutter.gui.widgets import numpy_to_qimage  # noqa: E402
from rolling_shutter.model import (  # noqa: E402
    MODE_GLOBAL, MODE_ROLLING, render_clip,
)
from rolling_shutter.presets import PRESET_FLASH, get_preset  # noqa: E402

_app = QApplication.instance() or QApplication([])


class GuiSmokeTests(unittest.TestCase):
    def setUp(self):
        self.win = MainWindow()

    def test_full_flow_preset_render_stale_export(self):
        params = get_preset(PRESET_FLASH)
        self.win.apply_params(params)
        # 控件 -> 参数对象往返一致
        self.assertEqual(self.win.read_params().signature(), params.signature())

        # 模拟渲染线程完成后的回调注入
        self.win._render_token += 1
        token = self.win._render_token
        for mode in (MODE_GLOBAL, MODE_ROLLING):
            clip = render_clip(params, mode)
            self.win._on_rendered(token, mode, clip)
        self.assertFalse(self.win._stale)  # 新结果不再陈旧
        self.assertEqual(len(self.win._clips), 2)
        self.assertTrue(all(c.signature == params.signature()
                            for c in self.win._clips.values()))

        # 切帧、选行、时序图/行曲线更新不报错
        self.win._step_frame(3)
        self.assertEqual(self.win._frame, 3)
        self.win._select_row(42)
        self.assertEqual(self.win._selected_row, 42)
        self.win._jump_to_frame(12)
        self.assertEqual(self.win._frame, 12)
        # 强制每个自定义控件真实走一遍 paintEvent（离屏平台不自动绘制）
        for w in (self.win.viewer_g, self.win.viewer_r, self.win.timing_g,
                  self.win.timing_r, self.win.plot_g, self.win.plot_r):
            pm = w.grab()
            self.assertGreater(pm.width(), 0)
        # 陈旧状态下也要能正常绘制遮罩
        self.win.sp_exposure.setValue(0.011)
        for w in (self.win.viewer_g, self.win.viewer_r):
            self.assertGreater(w.grab().width(), 0)
        # QImage 转换尺寸正确
        qimg = numpy_to_qimage(self.win._clips[MODE_ROLLING].frames[12])
        self.assertEqual((qimg.width(), qimg.height()),
                         (params.width, params.height))

        # 改动参数 -> 旧帧必须立即标记陈旧
        self.win.sp_exposure.setValue(0.011)
        self.assertTrue(self.win._stale)
        self.assertIn("参数", self.win._stale_reason)

        # 重新生成后陈旧解除
        self.win._render_token += 1
        token = self.win._render_token
        new_params = self.win.read_params()
        for mode in (MODE_GLOBAL, MODE_ROLLING):
            self.win._on_rendered(token, mode, render_clip(new_params, mode))
        self.assertFalse(self.win._stale)

        # 导出当前滚动短片并核对
        with tempfile.TemporaryDirectory() as d:
            out = Path(d) / "gui_export.zip"
            clip = self.win._clips[MODE_ROLLING]
            export_clip(clip, out)
            report = verify_export(out)
            self.assertTrue(report["ok"], msg=str(report))

    def test_play_timer_only_runs_when_fresh(self):
        params = get_preset(PRESET_FLASH)
        self.win._render_token += 1
        token = self.win._render_token
        for mode in (MODE_GLOBAL, MODE_ROLLING):
            self.win._on_rendered(token, mode, render_clip(params, mode))
        self.win._toggle_play()
        self.assertTrue(self.win._timer.isActive())
        # 参数改动作废：播放必须停止
        self.win.sp_fps.setValue(24.0)
        self.assertFalse(self.win._timer.isActive())
        self.assertTrue(self.win._stale)

    def test_lock_and_independent_frame_navigation(self):
        params = get_preset(PRESET_FLASH)
        self.win._render_token += 1
        token = self.win._render_token
        for mode in (MODE_GLOBAL, MODE_ROLLING):
            self.win._on_rendered(token, mode, render_clip(params, mode))
        # 默认锁定：步进同时作用于两边
        self.assertTrue(self.win.ck_sync.isChecked())
        self.win._step_frame(5)
        self.assertEqual(self.win._frames[MODE_GLOBAL],
                         self.win._frames[MODE_ROLLING])
        # 解锁：两边可停在不同帧
        self.win.ck_sync.setChecked(False)
        self.win._step_frame(2)  # 各自再 +2
        self.assertEqual(self.win._frames[MODE_GLOBAL], 7)
        self.assertEqual(self.win._frames[MODE_ROLLING], 7)
        self.win._jump_to_frame(11)  # 解锁下只改基准帧
        self.assertEqual(self.win._frames[MODE_ROLLING], 11)
        self.assertEqual(self.win._frames[MODE_GLOBAL], 7)
        # 重新锁定：对齐回滚动侧时刻
        self.win.ck_sync.setChecked(True)
        self.assertEqual(self.win._frames[MODE_GLOBAL], 11)
        self.assertEqual(self.win._frames[MODE_ROLLING], 11)
        # 整个过程绘制不报错
        self.assertGreater(self.win.timing_g.grab().width(), 0)
        self.assertGreater(self.win.timing_r.grab().width(), 0)


if __name__ == "__main__":
    unittest.main()
