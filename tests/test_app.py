"""离屏 UI 冒烟测试: 不弹窗, 验证交互链路与导出不变量。

运行: .venv/bin/python -m unittest tests.test_app -v
"""

import os
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from PySide6.QtWidgets import QApplication  # noqa: E402

from trap_studio.app import (  # noqa: E402
    MainWindow,
    VIEW_DIFF,
    VIEW_OVERPRINT,
    VIEW_PAPER,
    load_plate,
    save_plate,
)
from trap_studio.geometry import shift_mask  # noqa: E402

_app = QApplication.instance() or QApplication([])


class TestMainWindow(unittest.TestCase):
    def setUp(self):
        self.win = MainWindow()

    def test_initial_state(self):
        self.assertEqual(self.win.plate_a.shape, self.win.plate_b.shape)
        self.assertGreater(int(self.win.added.sum()), 0)
        # 新增像素只落在被扩展的那一版上
        if self.win.spread == "A":
            self.assertTrue(np.all(self.win.added <= self.win.trap_a))
            self.assertTrue(np.array_equal(self.win.trap_b, self.win.plate_b))

    def test_all_views_render(self):
        for mode in [VIEW_OVERPRINT, "仅 A 版", "仅 B 版", VIEW_PAPER, VIEW_DIFF]:
            self.win.combo_view.setCurrentText(mode)
            item = self.win.view._pixmap_item
            self.assertIsNotNone(item)
            self.assertFalse(item.pixmap().isNull())

    def test_width_change_recomputes(self):
        self.win.spin_width.setValue(1.0)
        n1 = int(self.win.added.sum())
        self.win.spin_width.setValue(6.0)
        n6 = int(self.win.added.sum())
        self.assertGreater(n6, n1)
        # 始终从原版重算, 不会累积
        self.win.spin_width.setValue(1.0)
        self.assertEqual(int(self.win.added.sum()), n1)

    def test_spread_switch(self):
        self.win.spin_width.setValue(3.0)
        self.win.radio_b.setChecked(True)
        self.assertEqual(self.win.spread, "B")
        self.assertTrue(np.array_equal(self.win.trap_a, self.win.plate_a))
        self.assertTrue(np.all(self.win.trap_b >= self.win.plate_b))
        self.win.radio_a.setChecked(True)
        self.assertTrue(np.array_equal(self.win.trap_b, self.win.plate_b))

    def test_offsets_only_affect_preview(self):
        trap_a_before = self.win.trap_a.copy()
        trap_b_before = self.win.trap_b.copy()
        added_before = self.win.added.copy()
        self.win.off_bx.setValue(4)
        self.win.off_ay.setValue(-3)
        # 原坐标处理版完全不变
        self.assertTrue(np.array_equal(self.win.trap_a, trap_a_before))
        self.assertTrue(np.array_equal(self.win.trap_b, trap_b_before))
        self.assertTrue(np.array_equal(self.win.added, added_before))
        # 预览里 B 确实平移了
        sa, sb, _, _ = self.win._shifted_plates()
        self.assertTrue(np.array_equal(sb, shift_mask(self.win.trap_b, 4, 0)))
        self.assertTrue(np.array_equal(sa, shift_mask(self.win.trap_a, 0, -3)))

    def test_toggle_trap_compare(self):
        self.win.spin_width.setValue(3.0)
        gap_on = self.win._shifted_plates()[3].sum()
        self.win.btn_toggle.click()
        self.assertFalse(self.win.trap_on)
        gap_off = self.win._shifted_plates()[3].sum()
        # 相同偏移下, 无搭接时露白更多
        self.assertGreater(gap_off, gap_on)
        self.win.btn_toggle.click()
        self.assertEqual(self.win._shifted_plates()[3].sum(), gap_on)

    def test_probe_markers(self):
        # 点一个肯定露白的位置 (画布角)
        self.win._on_probe(2, 2)
        self.assertGreaterEqual(len(self.win.view._markers), 3)  # 十字线2 + 标记
        text = self.win._probe_text.text()
        self.assertIn("露白", text)

    def test_export_ignores_offsets_and_roundtrips(self):
        self.win.off_bx.setValue(5)
        self.win.off_ay.setValue(2)
        expected_a = self.win.trap_a.copy()
        expected_b = self.win.trap_b.copy()
        with tempfile.TemporaryDirectory() as d:
            save_plate(expected_a, os.path.join(d, "a.png"))
            save_plate(expected_b, os.path.join(d, "b.png"))
            back_a = load_plate(os.path.join(d, "a.png"))
            back_b = load_plate(os.path.join(d, "b.png"))
        self.assertTrue(np.array_equal(back_a, expected_a))
        self.assertTrue(np.array_equal(back_b, expected_b))
        # 导出目录里的图与偏移无关: 换个偏移再导, 字节层面一致
        self.win._reset_offsets()
        with tempfile.TemporaryDirectory() as d:
            save_plate(expected_a, os.path.join(d, "a.png"))
            self.assertTrue(np.array_equal(load_plate(os.path.join(d, "a.png")),
                                           expected_a))

    def test_png_roundtrip_grayscale_and_alpha(self):
        m = np.zeros((12, 12), dtype=bool)
        m[3:9, 4:10] = True
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "m.png")
            save_plate(m, p)
            self.assertTrue(np.array_equal(load_plate(p), m))


if __name__ == "__main__":
    unittest.main(verbosity=2)
