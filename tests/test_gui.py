"""GUI 冒烟测试：offscreen 无头模式下驱动主窗口完整流程。"""
from __future__ import annotations

import os
import tempfile
import unittest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import numpy as np
from PySide6.QtWidgets import QApplication, QMessageBox
from PySide6.QtCore import QTimer

from colormatch.core import Project, Rect
from colormatch.samples import generate_sample_project
from colormatch.gui.app import MainWindow

app = QApplication.instance() or QApplication([])


def _auto_close_message_boxes():
    """offscreen 下模态消息框无人点击会阻塞，统一自动关闭。"""
    for w in QApplication.topLevelWidgets():
        if isinstance(w, QMessageBox):
            QTimer.singleShot(0, w.accept)


class GuiSmokeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.project_path = generate_sample_project(self.tmp.name)
        self.win = MainWindow()
        self.win.project_path = self.project_path
        self.win.project = Project.load(self.project_path)
        self.win._bind_project()

    def tearDown(self):
        self.win.close()
        self.tmp.cleanup()

    def test_canvases_created_for_each_image(self):
        self.assertEqual(len(self.win.canvases), 3)
        self.assertEqual(self.win.sample_table.rowCount(), 12)
        # 样例工程每个采样在三张图上都有矩形
        for s in self.win.project.samples:
            self.assertEqual(len(s.rects), 3)

    def test_rect_drawn_updates_sample(self):
        self.win.sample_table.selectRow(2)
        new_rect = Rect(50, 60, 70, 80)
        self.win.on_rect_drawn("img_ref", new_rect)
        self.assertEqual(self.win.project.samples[2].rects["img_ref"], new_rect)
        # 表格里的矩形文本同步更新
        self.assertIn("(50,60,70×80)", self.win.sample_table.item(2, 2).text())

    def test_fit_populates_tables_and_params(self):
        self.win.run_fit()
        self.assertEqual(set(self.win.fit_results), {"img_a", "img_b"})
        self.assertGreater(self.win.result_table.rowCount(), 0)
        self.assertIn("M =", self.win.param_label.text())
        # 白点行处理后 dE 应为 0
        first = float(self.win.result_table.item(0, 2).text())
        self.assertAlmostEqual(first, 0.0, places=6)
        # 变换结果已缓存
        self.assertEqual(set(self.win.transformed), {"img_a", "img_b"})

    def test_gamut_overlay_toggle(self):
        self.win.run_fit()
        sid = self.win._current_source_id()
        before = self.win.canvases[sid]._pixmap
        self.win.gamut_cb.setChecked(True)
        after_on = self.win.canvases[sid]._pixmap
        self.assertIsNotNone(after_on)
        self.win.gamut_cb.setChecked(False)
        after_off = self.win.canvases[sid]._pixmap
        self.assertIsNotNone(after_off)
        self.assertIsNot(before, after_on)
        self.assertIsNot(after_on, after_off)

    def test_fit_failure_message_on_degenerate_input(self):
        # 只保留 2 个采样，affine 需要 4 个 -> 应抛 FitError 且不崩溃
        self.win.project.samples = self.win.project.samples[:2]
        self.win._refresh_sample_table()
        self.win._refresh_canvas_rects()
        QTimer.singleShot(50, _auto_close_message_boxes)
        self.win.run_fit()  # 内部捕获 FitError，弹窗被自动关闭
        self.assertIn("拟合失败", self.win.log.toPlainText())

    def test_save_and_reopen_roundtrip(self):
        self.win.run_fit()
        self.win.save_project()
        reopened = Project.load(self.project_path)
        self.assertEqual(set(reopened.fits), {"img_a", "img_b"})
        self.assertTrue(all(fp.white_locked for fp in reopened.fits.values()))
        # 另开一个窗口加载同一工程，拟合参数仍在
        win2 = MainWindow()
        win2.project_path = self.project_path
        win2.project = Project.load(self.project_path)
        win2._bind_project()
        self.assertEqual(win2.sample_table.rowCount(), 12)
        win2.close()

    def test_add_and_delete_sample(self):
        n0 = self.win.sample_table.rowCount()
        self.win.add_sample()
        self.assertEqual(self.win.sample_table.rowCount(), n0 + 1)
        self.win.sample_table.selectRow(n0)
        self.win.delete_sample()
        self.assertEqual(self.win.sample_table.rowCount(), n0)

    def test_import_into_empty_project_does_not_crash(self):
        # 新建一个从未加载工程的空窗口，直接走导入图像后的内部绑定流程
        win = MainWindow()
        self.assertIsNone(win.project)
        win.project = Project(images=[], samples=[], fits={})
        ref_path = os.path.join(self.tmp.name, "reference.png")
        src_path = os.path.join(self.tmp.name, "source_a.png")
        # 模拟 import_image 中对每个选中文件执行的登记逻辑
        from colormatch.core import ImageEntry, load_image_rgb, file_sha256

        for path, role in ((ref_path, "reference"), (src_path, "source")):
            img = load_image_rgb(path)
            win.project.images.append(
                ImageEntry(
                    id=f"img_{len(win.project.images) + 1}",
                    path=os.path.abspath(path),
                    role=role,
                    sha256=file_sha256(path),
                    width=img.shape[1],
                    height=img.shape[0],
                )
            )
        win._bind_project()  # 之前会因 reference 为 None 之类的状态问题崩溃
        self.assertEqual(len(win.canvases), 2)
        win.add_sample()  # 空采样表上新增也不应崩溃
        self.assertEqual(win.sample_table.rowCount(), 1)
        win.close()


if __name__ == "__main__":
    unittest.main()
