"""GUI 冒烟测试（使用 Qt 离屏平台，无需显示器）。

验证窗口能构建、样例能载入、参数调整/探针/拟合/导出的主路径不抛异常。
需要安装 PySide6；纯算法验证见 test_core.py。
"""

import os
import tempfile
import unittest
from pathlib import Path

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import numpy as np
from PySide6.QtWidgets import QApplication, QMessageBox

from lens_corrector.main_window import MainWindow
from lens_corrector.distortion import DistortionParams

_app = QApplication.instance() or QApplication([])

# headless 环境下模态对话框会阻塞事件循环，统一自动关闭；
# 真实桌面使用时仍正常弹窗
QMessageBox.warning = staticmethod(
    lambda *a, **k: QMessageBox.StandardButton.Ok)
QMessageBox.information = staticmethod(
    lambda *a, **k: QMessageBox.StandardButton.Ok)
QMessageBox.critical = staticmethod(
    lambda *a, **k: QMessageBox.StandardButton.Ok)


class TestMainWindowSmoke(unittest.TestCase):
    def setUp(self):
        self.win = MainWindow()

    def tearDown(self):
        self.win.close()
        self.win.deleteLater()

    def test_window_loads_sample_and_three_views(self):
        self.assertIsNotNone(self.win.ref_image)
        self.assertIsNotNone(self.win.dist_image)
        self.assertIsNotNone(self.win.corrected_image)
        self.assertEqual(self.win.ref_image.shape[:2],
                         self.win.corrected_image.shape[:2])
        # 默认 6 个控制点已建立在两幅图上
        self.assertEqual(len(self.win.control_points), 6)
        self.assertEqual(len(self.win.point_items_obs), 6)
        self.assertEqual(len(self.win.point_items_tgt), 6)

    def test_param_edit_updates_image(self):
        before = self.win.corrected_image.copy()
        self.win.spin_k1.setValue(-0.5)
        self.win.spin_p2.setValue(0.02)
        self.assertFalse(np.array_equal(before, self.win.corrected_image))
        self.assertAlmostEqual(self.win.params.k1, -0.5, places=4)

    def test_probe_roundtrip_display(self):
        # 在原图取探针
        self.win.on_canvas_probe_click("ref", 200.0, 150.0)
        d = self.win.probe_data
        self.assertIsNotNone(d)
        self.assertTrue(d["converged"])
        # 零参数之外的默认样例参数下，畸变坐标与原始坐标不同
        # 载入时参数为零，先设置一个非零参数再探
        self.win.spin_k1.setValue(-0.3)
        self.win.on_canvas_probe_click("ref", 200.0, 150.0)
        d = self.win.probe_data
        self.assertGreater(
            np.hypot(*(d["distorted"] - d["original"])), 0.1)
        self.assertLess(
            np.linalg.norm(d["restored"] - d["original"]), 1e-6)
        # 三个画布都出现了探针标记
        from lens_corrector.widgets import ProbeMarker
        for c in (self.win.canvas_ref, self.win.canvas_dist,
                  self.win.canvas_corr):
            self.assertTrue(
                any(isinstance(it, ProbeMarker) for it in c.scene.items()))

    def test_fit_apply_revert_workflow(self):
        # 样例控制点的观测点按真实参数生成，径向拟合应成功并可应用/撤回
        before = self.win.params.copy()
        self.win.rb_radial.setChecked(True)
        self.win.run_fit()
        self.assertIsNotNone(self.win.fit_preview)
        self.assertTrue(self.win.btn_apply.isEnabled())
        fitted = self.win.params.copy()
        # 残差表有 6 行
        self.assertEqual(self.win.tbl_resid.rowCount(), 6)
        self.win.apply_fit()
        self.assertFalse(self.win.btn_apply.isEnabled())
        self.win.revert_fit()
        self.assertEqual(self.win.params.k1, before.k1)
        self.assertEqual(self.win.params.k2, before.k2)
        # 撤回后拟合参数不再生效
        self.assertNotEqual(self.win.params.k1, fitted.k1)

    def test_export_full_and_crop_sizes(self):
        with tempfile.TemporaryDirectory() as tmp:
            # 通过直接调用导出逻辑验证尺寸（绕过目录选择对话框）
            from lens_corrector.export import export_corrected_image
            from lens_corrector.cropping import largest_all_valid_rect

            h, w = self.win.ref_image.shape[:2]
            wf, hf = export_corrected_image(
                Path(tmp) / "a.png", self.win.corrected_image,
                self.win.valid_mask, None, "full")
            self.assertEqual((wf, hf), (w, h))

            rect = largest_all_valid_rect(self.win.valid_mask)
            wc, hc = export_corrected_image(
                Path(tmp) / "b.png", self.win.corrected_image,
                self.win.valid_mask, rect, "crop")
            self.assertEqual((wc, hc), (rect.width, rect.height))

    def test_point_count_rebuild_and_drag_invalidation(self):
        for n in (10, 4, 12):
            self.win.spin_npoints.setValue(n)
            _app.processEvents()
            self.assertEqual(len(self.win.control_points), n)
            self.assertEqual(len(self.win.point_items_obs), n)
            self.assertEqual(len(self.win.point_items_tgt), n)
        # 拖动观测点会使未应用的拟合预览失效
        self.win.rb_full.setChecked(True)
        self.win.run_fit()
        self.assertIsNotNone(self.win.fit_preview)
        cp = self.win.control_points[0]
        self.win._on_observed_moved(
            0, cp.observed[0] + 2.0, cp.observed[1])
        self.assertIsNone(self.win.fit_preview)
        self.assertFalse(self.win.btn_apply.isEnabled())

    def test_failed_fit_keeps_existing_params(self):
        saved = self.win.params.copy()
        # 制造矛盾点位，拟合应失败且参数/图像保持不变
        self.win.chk_snap.setChecked(False)
        self.win._on_observed_moved(0, 3.0, 3.0)
        self.win._on_observed_moved(1, 5.0, 5.0)
        self.win.rb_full.setChecked(True)
        self.win.run_fit()
        self.assertEqual(self.win.params.k1, saved.k1)
        self.assertEqual(self.win.params.k2, saved.k2)
        self.assertIsNotNone(self.win.corrected_image)

    def test_open_image_and_zero_params_identity(self):
        # 合成一张外部图片并走打开流程的内部逻辑
        img = np.full((200, 260, 3), 200, dtype=np.uint8)
        self.win.ref_image = img
        self.win.dist_image = img.copy()
        self.win.dist_valid_mask = np.ones((200, 260), dtype=bool)
        self.win.set_params(DistortionParams(cx=130.0, cy=100.0))
        # 零参数校正图与原图一致（仅允许取整误差）
        self.assertLessEqual(
            int(np.max(np.abs(
                self.win.corrected_image.astype(int) - img.astype(int)))), 1)
        # 零参数为恒等映射：内部像素全部有效（最外半像素环因双线性
        # 边界约定可被保守排除），且没有大块越界
        self.assertGreater(float(np.mean(self.win.valid_mask)), 0.98)
        self.assertTrue(np.all(self.win.valid_mask[1:-1, 1:-1]))


if __name__ == "__main__":
    unittest.main(verbosity=2)
