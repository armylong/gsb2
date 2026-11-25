"""GUI 冒烟测试：offscreen 模式下构建主窗口并走一遍主要交互。

需要 QT_QPA_PLATFORM=offscreen（CI/无头环境），本地有显示时也能跑。
"""

import os
import tempfile
import unittest
from pathlib import Path

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtWidgets import QApplication  # noqa: E402

from colorbook.app import MainWindow  # noqa: E402
from colorbook.render import VIEW_COLOR, VIEW_LINE, VIEW_ORIGINAL  # noqa: E402
from colorbook.sample import GREEN  # noqa: E402

_app = QApplication.instance() or QApplication([])


class TestGuiSmoke(unittest.TestCase):
    def setUp(self):
        self.win = MainWindow()
        self.win.action_load_sample()

    def test_window_loads_sample(self):
        self.assertIsNotNone(self.win.model)
        self.assertEqual(self.win.model.width, 640)
        self.assertEqual(self.win.model.height, 520)
        self.assertGreater(self.win.legend.count(), 0)

    def test_view_switching(self):
        for view in (VIEW_ORIGINAL, VIEW_COLOR, VIEW_LINE):
            self.win.switch_view(view)
            self.assertEqual(self.win._view, view)
            self.assertIsNotNone(self.win.canvas.pixmap_item)

    def test_select_and_legend_linkage(self):
        m = self.win.model
        lid = m.region_ids()[1]
        self.win.select_regions({lid})
        self.assertIn(lid, self.win._selected)
        # 图例点击应选中同色的全部区域
        self.win.legend.setCurrentRow(0)
        self.assertGreaterEqual(len(self.win._selected), 1)

    def test_protect_and_merge_workflow(self):
        m = self.win.model
        green_ids = m.regions_of_color(GREEN)
        small = min(green_ids, key=lambda lid: m.regions[lid].area)
        before = len(m.regions)

        # 先保护小绿块，合并不应动它
        self.win.select_regions({small})
        self.win.action_toggle_protection()
        self.assertTrue(m.regions[small].protected)
        self.win.area_spin.setValue(1500)
        merged = m.merge_small_regions(1500)
        self.assertNotIn(small, {s for s, _ in merged})
        self.assertIn(small, m.regions)

        # 取消保护后再合并，小绿块应消失
        self.win.action_toggle_protection()
        m.merge_small_regions(1500)
        self.assertNotIn(small, m.regions)
        self.assertLess(len(m.regions), before)

        # 撤销恢复
        self.assertTrue(m.undo())
        self.win.refresh()

    def test_problem_list_mentions_sliver(self):
        # 紫色狭长带应出现在问题清单（外部引线或无法放置）
        texts = [
            self.win.problem_list.item(i).text()
            for i in range(self.win.problem_list.count())
        ]
        self.assertTrue(any("引线" in t or "无法放置" in t for t in texts))

    def test_export_from_gui(self):
        with tempfile.TemporaryDirectory() as tmp:
            line = Path(tmp) / "line.png"
            ref = Path(tmp) / "ref.png"
            from colorbook.render import export_line_art, export_reference

            export_line_art(self.win.model, line, self.win.font, plans=self.win._plans)
            export_reference(self.win.model, ref, self.win.font, plans=self.win._plans)
            self.assertTrue(line.exists() and ref.exists())

    def test_undo_shortcut_handler(self):
        m = self.win.model
        n0 = len(m.regions)
        m.merge_small_regions(1500)
        self.assertNotEqual(len(m.regions), n0)
        # 直接调用窗口的撤销逻辑
        self.assertTrue(m.undo())
        self.win.refresh()
        self.assertEqual(len(m.regions), n0)


if __name__ == "__main__":
    unittest.main()
