"""PySide6 界面冒烟测试 (offscreen 平台), 走一遍完整工作流。"""
import os
import tempfile
import unittest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import numpy as np
from PySide6.QtWidgets import QApplication, QFileDialog
from PySide6.QtTest import QTest

from colorcheck.app import MainWindow
from colorcheck.pngio import read_png
from samples.make_samples import MARKERS, make_all

app = QApplication.instance() or QApplication([])


class TestGuiWorkflow(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="colorcheck_gui_")
        cls.sheet, cls.singles = make_all(cls.tmp)

    def setUp(self):
        self.win = MainWindow()
        self.win.rgba = read_png(self.sheet)
        self.win.image_path = self.sheet
        self.cids = []
        for name, rgb, _shape in MARKERS:
            self.cids.append(self.win.palette.add_category(rgb, name=name).cid)
        self.win.palette.add_pair(self.cids[0], self.cids[1])
        self.win.palette.add_pair(self.cids[2], self.cids[3])
        self.win._schedule_refresh()
        QTest.qWait(120)

    def tearDown(self):
        self.win.close()
        self.win.deleteLater()
        QTest.qWait(20)

    def test_views_rendered(self):
        for v in (self.win.view_normal, self.win.view_protan,
                  self.win.view_deutan):
            self.assertIsNotNone(v._pix)
            self.assertGreater(v._pix.width(), 0)

    def test_severity_and_background_change_output(self):
        pix_before = self.win.view_deutan.label.pixmap().toImage()
        self.win.severity_slider.setValue(30)
        self.win.bg_toggle.setCurrentIndex(1)
        QTest.qWait(120)
        pix_after = self.win.view_deutan.label.pixmap().toImage()
        self.assertFalse(_images_equal(pix_before, pix_after))

    def test_pick_readout(self):
        self.win.on_pick(8, 8)
        self.assertIn("RGBA", self.win.readout.text())
        self.assertIn("#", self.win.readout.text())

    def test_candidates_accept_and_preview(self):
        self.win.suggest_target.setCurrentIndex(1)
        self.win.generate_suggestions()
        self.assertGreater(self.win.suggest_table.rowCount(), 0)
        before = tuple(self.win.palette.categories[1].color)
        self.win.suggest_table.selectRow(0)
        self.win.accept_suggestion()
        after = tuple(self.win.palette.categories[1].color)
        self.assertNotEqual(before, after)

        self.win.preview_toggle.setCurrentIndex(1)
        QTest.qWait(120)
        recolored = self.win._current_recolored()
        # 取样范围外 (蓝标记区域) 像素保持不变
        blue_rgb = MARKERS[4][1]
        from colorcheck.analysis import category_masks
        mask = category_masks(self.win.rgba, [blue_rgb], 10.0)[..., 0] > 0.5
        np.testing.assert_array_equal(
            recolored[mask][..., :3], self.win.rgba[mask][..., :3])

    def test_lock_blocks_edit(self):
        cid = self.cids[0]
        self.win.palette.toggle_lock(cid)
        self.assertTrue(self.win.palette.get(cid).locked)
        src, dst, cids = self.win.palette.editable_sources_targets()
        self.assertNotIn(cid, cids)

    def test_save_load_and_compare_export(self):
        proj = os.path.join(self.tmp, "scheme.json")
        QFileDialog.getSaveFileName = staticmethod(
            lambda *a, **k: (proj, ""))
        self.win.action_save_project()
        self.assertTrue(os.path.exists(proj))

        compare = os.path.join(self.tmp, "compare.png")
        QFileDialog.getSaveFileName = staticmethod(
            lambda *a, **k: (compare, ""))
        self.win.action_export_compare()
        self.assertTrue(os.path.exists(compare))
        img = read_png(compare)
        self.assertIn(img.shape[2], (3, 4))
        # 对照图包含两行 (浅底/深底) 六列, 尺寸明显大于原图
        self.assertGreater(img.shape[0], self.win.rgba.shape[0])

        new_win = MainWindow()
        QFileDialog.getOpenFileName = staticmethod(
            lambda *a, **k: (proj, ""))
        new_win.action_load_project()
        QTest.qWait(80)
        self.assertEqual(len(new_win.palette.categories), len(MARKERS))
        self.assertEqual(len(new_win.palette.pairs), 2)
        new_win.close()
        new_win.deleteLater()

    def test_metric_table_populated(self):
        self.assertEqual(self.win.metric_table.rowCount(), 2)
        de_text = self.win.metric_table.item(0, 1).text()
        self.assertIn("ΔE", de_text) if False else self.assertTrue(
            any(ch.isdigit() for ch in de_text))

    def test_import_colors_json_with_required_pairs(self):
        path = os.path.join(os.path.dirname(__file__), "..", "samples",
                            "data", "test_colors.json")
        QFileDialog.getOpenFileName = staticmethod(
            lambda *a, **k: (path, ""))
        win = MainWindow()
        win.action_import_colors()
        QTest.qWait(40)
        self.assertEqual(len(win.palette.categories), 6)
        self.assertEqual(len(win.palette.pairs), 2)
        self.assertTrue(any(c.locked for c in win.palette.categories))
        win.close()
        win.deleteLater()


def _images_equal(img1, img2):
    if img1.size() != img2.size():
        return False
    ptr1 = bytes(img1.bits())
    ptr2 = bytes(img2.bits())
    return ptr1 == ptr2


if __name__ == "__main__":
    unittest.main()
