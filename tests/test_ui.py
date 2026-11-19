"""离屏 GUI 冒烟测试: 构建工程 -> 切平面/缩放/剖面/测量 -> 无异常。"""

import os
import shutil
import tempfile
import unittest
from pathlib import Path

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import numpy as np
from PySide6.QtCore import QPoint, Qt
from PySide6.QtWidgets import QApplication

from chromasubsample.color import MODES
from chromasubsample.pipeline import generate_synthetic
from chromasubsample.ui.main_window import MainWindow

FFMPEG_AVAILABLE = shutil.which("ffmpeg") is not None
app = QApplication.instance() or QApplication([])


@unittest.skipUnless(FFMPEG_AVAILABLE, "未安装 ffmpeg")
class TestUISmoke(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="chromaui_"))
        cls.win = MainWindow()
        cls.project = generate_synthetic(workdir=cls.tmp, width=320, height=240,
                                         frame_count=6, fps=30)
        cls.win._on_project_ready(cls.project)

    def test_three_views_render_each_plane_mode(self):
        for idx in range(4):
            self.win.cmb_plane.setCurrentIndex(idx)
            for mode in MODES:
                self.assertIsNotNone(self.win.views[mode].canvas._image)

    def test_zoom_is_integer_and_nearest(self):
        for z in ("1", "4", "8", "16"):
            self.win.cmb_zoom.setCurrentText(z)
            for mode in MODES:
                view = self.win.views[mode]
                self.assertEqual(view.zoom(), int(z))
                # 滚动视口会限制可见宽度, 检查的是内部画布的内容尺寸
                iw, ih = view.canvas.image_size()
                self.assertEqual(view.canvas.size().width(), iw * int(z))
                self.assertEqual(view.canvas.size().height(), ih * int(z))

    def test_step_and_time_seek(self):
        self.win._step(2)
        self.assertEqual(self.win._index, 2)
        self.win.time_spin.setValue(0.1)
        self.win._seek_time()
        self.assertEqual(self.win._index, self.project.frame_at_time(0.1))
        self.win._step(1000)
        self.assertEqual(self.win._index, self.project.frame_count - 1)

    def test_roi_metrics_all_modes(self):
        from PySide6.QtCore import QRect
        for v in self.win.views.values():
            v.set_roi(QRect(4, 4, 20, 12))
        self.win._update_metrics()
        text = self.win.metrics_text.toPlainText()
        for mode in ("4:4:4", "4:2:2", "4:2:0"):
            self.assertIn(mode, text)

    def test_profile_lines_and_channel_switch(self):
        self.win._hover["444"] = (10, 20)
        self.win._set_profile("h")
        self.win._set_profile("v")
        self.assertIsNotNone(self.win.plot.profile)
        for i in range(self.win.cmb_channel.count()):
            self.win.cmb_channel.setCurrentIndex(i)
        self.win._clear_profile()
        self.assertIsNone(self.win.plot.profile)

    def test_metadata_tables_show_actual_formats(self):
        for mode in MODES:
            table = self.win.meta_tables[mode]
            keys = {table.item(r, 0).text() for r in range(table.rowCount())}
            self.assertIn("pix_fmt", keys)
            self.assertIn("chroma_location", keys)


if __name__ == "__main__":
    unittest.main()
