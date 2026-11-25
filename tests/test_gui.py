"""GUI 冒烟测试: offscreen 平台下构建窗口、改参数、探针与导出, 不进事件循环。

运行: QT_QPA_PLATFORM=offscreen .venv/bin/python -I tests/test_gui.py
"""

import os
import sys
import tempfile
import unittest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import numpy as np
from PySide6.QtWidgets import QApplication

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from light_recombine.channels import ChannelSet, LoadedChannel, LoadStatus
from light_recombine.example_scene import PROBE_SPEC_HOT, build_example_scene
from light_recombine.gui.main_window import MainWindow
from light_recombine.io_npy import load_params, save_channel_npy, save_params
from light_recombine.io_png import write_png_rgb8

_app = QApplication.instance() or QApplication([])


class TestGuiSmoke(unittest.TestCase):
    def setUp(self):
        self.win = MainWindow(start_with_example=True)

    def test_window_starts_with_example_and_composite(self):
        self.assertIsNotNone(self.win.result)
        self.assertEqual(self.win.result.srgb8.dtype, np.uint8)
        self.assertTrue(self.win.banner.isHidden())  # 示例四路齐全
        # 下拉框默认色调映射必须与 DisplayParams 默认一致 (reinhard)
        self.assertEqual(self.win.tonemap.currentData(),
                         self.win._collect_display().tonemap)
        self.assertEqual(self.win.tonemap.currentData(), "reinhard")

    def test_suppress_specular_in_ui_keeps_diffuse(self):
        diffuse_before = self.win.result.contributions["diffuse"].copy()
        self.win.rows["specular"].mult.setValue(0.0)
        res = self.win.result
        np.testing.assert_array_equal(
            res.contributions["specular"],
            np.zeros_like(res.contributions["specular"]))
        np.testing.assert_allclose(
            res.contributions["diffuse"], diffuse_before, rtol=1e-6)

    def test_solo_checkbox_isolates_channel(self):
        self.win.rows["emission"].solo.setChecked(True)
        scene = build_example_scene()
        np.testing.assert_allclose(
            self.win.result.linear, scene["emission"], rtol=1e-6)

    def test_probe_hotspot_and_jump_buttons(self):
        self.win._jump_probe(PROBE_SPEC_HOT)
        self.assertEqual(self.win._cursor, PROBE_SPEC_HOT)
        self.assertGreater(
            self.win.result.raw["specular"][PROBE_SPEC_HOT[1],
                                           PROBE_SPEC_HOT[0]].max(), 4.0)
        # 探针表里四路都在, 且镜面行原始值含 >1
        table = self.win.probe_table
        self.assertEqual(table.rowCount(), 4)
        spec_text = table.item(3, 2).text()
        self.assertNotEqual(spec_text, "—")

    def test_missing_channel_banner_and_no_substitution(self):
        scene = build_example_scene()
        chs = {n: LoadedChannel(n, LoadStatus.OK, data=scene[n])
               for n in scene}
        chs["specular"] = LoadedChannel("specular", LoadStatus.MISSING,
                                        detail="未指定文件")
        self.win.channel_set = ChannelSet(channels=chs)
        self.win._recompute()
        self.assertFalse(self.win.banner.isHidden())
        self.assertIn("specular", self.win.result.missing)
        # 切到缺失通道的预览: 棋盘格, 无 rgb8 可导出
        idx = self.win.preview_target.findData("specular")
        self.win.preview_target.setCurrentIndex(idx)
        self.assertIsNone(self.win._view_rgb8)

    def test_export_png_and_params_roundtrip(self):
        with tempfile.TemporaryDirectory() as d:
            png = os.path.join(d, "out.png")
            write_png_rgb8(png, self.win.result.srgb8)
            self.assertGreater(os.path.getsize(png), 1000)

            jpath = os.path.join(d, "p.json")
            self.win.rows["specular"].mult.setValue(0.25)
            self.win.exposure.setValue(0.5)
            save_params(jpath, self.win._collect_params(),
                        self.win._collect_display(), self.win.paths)
            p2, d2, _ = load_params(jpath)
            self.assertAlmostEqual(p2.multipliers["specular"], 0.25)
            self.assertAlmostEqual(d2.exposure_ev, 0.5)

    def test_npy_directory_reload_and_reproduce(self):
        scene = build_example_scene()
        with tempfile.TemporaryDirectory() as d:
            for name, arr in scene.items():
                save_channel_npy(os.path.join(d, f"{name}.npy"), arr)
            self.win.paths = {n: os.path.join(d, f"{n}.npy")
                              for n in scene}
            self.win._reload_all()
            first = self.win.result.srgb8.copy()

            jpath = os.path.join(d, "p.json")
            save_params(jpath, self.win.params, self.win.display,
                        self.win.paths)
            # 模拟重开: 新建窗口, 只给参数文件
            win2 = MainWindow()
            p2, d2, sources = load_params(jpath)
            win2.paths.update({k: v for k, v in sources.items()
                               if v and os.path.isfile(v)})
            win2._reload_all()
            for name in win2.rows:
                win2.rows[name].mult.setValue(p2.multipliers[name])
            np.testing.assert_array_equal(win2.result.srgb8, first)


if __name__ == "__main__":
    unittest.main(verbosity=2)
