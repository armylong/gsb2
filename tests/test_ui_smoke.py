"""离屏 UI 冒烟测试：窗口能构建、切样例、改 A4、圈选导出不崩。"""

import os
import sys
import tempfile
import unittest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from PySide6.QtWidgets import QApplication

from pitch_lab.exporter import export_segment_csv
from pitch_lab.main_window import MainWindow

_app = QApplication.instance() or QApplication([])


class TestUISmoke(unittest.TestCase):
    def setUp(self):
        self.win = MainWindow()

    def test_open_each_sample(self):
        for i in range(self.win.sample_combo.count()):
            self.win.sample_combo.setCurrentIndex(i)
            self.assertIsNotNone(self.win.result)
            self.win.pitch.repaint()
            self.win.cents.repaint()
            self.win.wave.repaint()

    def test_a4_change_keeps_hz_updates_labels(self):
        self.win.sample_combo.setCurrentIndex(1)  # 稳定音
        r = self.win.result
        f0_before = r.f0.copy()
        self.win.sp_a4.setValue(442.0)
        np = __import__("numpy")
        np.testing.assert_array_equal(f0_before, self.win.result.f0)
        self.assertEqual(self.win.a4, 442.0)

    def test_reanalyze_with_tight_range(self):
        self.win.sp_fmin.setValue(200.0)
        self.win.sp_fmax.setValue(600.0)
        self.assertIsNotNone(self.win.result)
        finite = self.win.result.f0[__import__("numpy").isfinite(self.win.result.f0)]
        self.assertTrue((finite >= 200.0).all() and (finite <= 600.0).all())

    def test_cursor_shows_candidates(self):
        self.win.sample_combo.setCurrentIndex(4)  # 弱基频
        r = self.win.result
        mid = r.times[len(r.times) // 2]
        self.win._show_frame(mid)
        self.assertGreaterEqual(self.win.table.rowCount(), 1)
        self.assertIn("Hz", self.win.detail.toPlainText())

    def test_selection_export_roundtrip(self):
        self.win.state.set_selection(0.2, 0.8)
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "ui.csv")
            n = export_segment_csv(path, self.win.result, 0.2, 0.8,
                                   self.win.a4)
            self.assertGreater(n, 0)


if __name__ == "__main__":
    unittest.main()
