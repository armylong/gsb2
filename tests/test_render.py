"""渲染与导出测试：三种视图、同尺寸导出、边界与标签绘制。"""

import tempfile
import unittest
from pathlib import Path

import numpy as np
from PIL import Image

from colorbook.model import RegionModel
from colorbook.render import (
    VIEW_COLOR,
    VIEW_LINE,
    VIEW_ORIGINAL,
    boundary_mask,
    export_line_art,
    export_reference,
    load_font,
    plan_all_labels,
    render_view,
)
from colorbook.sample import build_sample_image


class TestRender(unittest.TestCase):
    def setUp(self):
        self.model = RegionModel(build_sample_image())
        self.font = load_font(16)

    def test_boundary_mask_sits_between_regions(self):
        mask = boundary_mask(self.model.labels)
        # 边界像素本身属于某个区域，但其四邻存在别的标签
        ys, xs = np.nonzero(mask)
        self.assertGreater(len(ys), 0)
        y, x = int(ys[0]), int(xs[0])
        neighbors = []
        for dy, dx in ((0, 1), (0, -1), (1, 0), (-1, 0)):
            ny, nx = y + dy, x + dx
            if 0 <= ny < self.model.height and 0 <= nx < self.model.width:
                neighbors.append(int(self.model.labels[ny, nx]))
        self.assertIn(int(self.model.labels[y, x]), neighbors)
        self.assertTrue(any(n != int(self.model.labels[y, x]) for n in neighbors))

    def test_all_views_same_size_as_source(self):
        for view in (VIEW_ORIGINAL, VIEW_COLOR, VIEW_LINE):
            img = render_view(self.model, view, self.font)
            self.assertEqual(img.size, (self.model.width, self.model.height))

    def test_line_art_is_mostly_white(self):
        img = render_view(self.model, VIEW_LINE, self.font)
        arr = np.asarray(img.convert("L"))
        # 黑白稿以白色为底，深色像素占比应很小
        dark_ratio = float((arr < 128).mean())
        self.assertLess(dark_ratio, 0.15)
        self.assertGreater(dark_ratio, 0.0)  # 但确实画了边界/数字

    def test_color_view_uses_region_colors(self):
        img = render_view(self.model, VIEW_COLOR, self.font)
        arr = np.asarray(img)
        # 取最大图形区域（排除背景）内部像素，颜色应等于区域颜色
        background = self.model.region_at(0, 0)
        ring = max(
            (lid for lid in self.model.region_ids() if lid != background),
            key=lambda lid: self.model.regions[lid].area,
        )
        # 环的质心在孔里，取区域 bbox 内第一个属于该区域的像素
        min_y, min_x, max_y, max_x = self.model.regions[ring].bbox
        cy, cx = min_y + 2, (min_x + max_x) // 2
        self.assertEqual(int(self.model.labels[cy, cx]), ring)
        self.assertEqual(tuple(arr[cy, cx]), self.model.regions[ring].color)

    def test_export_files_match_source_size(self):
        plans = plan_all_labels(self.model, self.font)
        with tempfile.TemporaryDirectory() as tmp:
            line_path = Path(tmp) / "line.png"
            ref_path = Path(tmp) / "ref.png"
            export_line_art(self.model, line_path, self.font, plans=plans)
            export_reference(self.model, ref_path, self.font, plans=plans)
            self.assertTrue(line_path.exists())
            self.assertTrue(ref_path.exists())
            with Image.open(line_path) as im:
                self.assertEqual(im.size, (self.model.width, self.model.height))
            with Image.open(ref_path) as im:
                self.assertEqual(im.size, (self.model.width, self.model.height))

    def test_selection_highlight_renders(self):
        some_id = self.model.region_ids()[1]
        plain = np.asarray(render_view(self.model, VIEW_COLOR, self.font))
        highlighted = np.asarray(
            render_view(
                self.model, VIEW_COLOR, self.font, selected={some_id}
            )
        )
        self.assertFalse(np.array_equal(plain, highlighted))

    def test_background_gets_no_label(self):
        plans = plan_all_labels(self.model, self.font)
        self.assertNotIn(self.model.background_id, plans)
        # 其余区域都有方案
        fillable = [
            lid for lid in self.model.region_ids()
            if lid != self.model.background_id
        ]
        self.assertEqual(set(plans.keys()), set(fillable))


if __name__ == "__main__":
    unittest.main()
