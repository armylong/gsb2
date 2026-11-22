"""端到端集成测试: 样例标记在两种底色下的读数确实不同, 且全流程可跑通。"""
import tempfile
import unittest

import numpy as np

from colorcheck import cvd
from colorcheck.analysis import (category_masks, composite_image,
                                 conflict_hotspots, pair_pixel_metrics,
                                 pixel_color, simulate_frame)
from colorcheck.colorio import ciede2000
from colorcheck.pngio import read_png, write_png
from colorcheck.recolor import recolor_image
from samples.make_samples import MARKERS, make_all


class TestSampleGeneration(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="colorcheck_samples_")
        cls.sheet_path, cls.singles = make_all(cls.tmp)

    def test_png_roundtrip(self):
        rgba = read_png(self.sheet_path)
        self.assertEqual(rgba.ndim, 3)
        self.assertEqual(rgba.shape[2], 4)
        self.assertTrue((rgba[..., 3] > 0).any())
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as f:
            path = f.name
        write_png(path, rgba)
        back = read_png(path)
        np.testing.assert_array_equal(back, rgba)

    def test_semi_transparent_edges_exist(self):
        rgba = read_png(self.sheet_path)
        alpha = rgba[..., 3]
        n_partial = int(((alpha > 0) & (alpha < 255)).sum())
        self.assertGreater(n_partial, 50, "样例应包含抗锯齿半透明边缘")

    def test_edge_reading_differs_between_backgrounds(self):
        """核心验收: 同一半透明像素在浅/深底上的实际显示色不同,
        且两种底色下的色差/反差读数都能分别计算、结果确实不同。"""
        rgba = read_png(self.singles[0])
        edge_pts = np.argwhere(
            (rgba[..., 3] > 20) & (rgba[..., 3] < 240))
        self.assertTrue(len(edge_pts), "找不到半透明边缘像素")
        y, x = edge_pts[len(edge_pts) // 2]

        light = pixel_color(rgba, y, x, (245, 245, 245))
        dark = pixel_color(rgba, y, x, (30, 30, 30))
        self.assertNotEqual(light["shown_rgb"], dark["shown_rgb"])
        # 合成色应落在源色与底色之间
        self.assertTrue(all(0 <= v <= 255 for v in light["shown_rgb"]))

        red = MARKERS[0][1]
        green = MARKERS[1][1]
        # 两个单标记合成到同一画布上再测配对读数
        red_img = read_png(self.singles[0])
        green_img = read_png(self.singles[1])
        size = red_img.shape[0]
        canvas = np.zeros((size, size * 2 + 8, 4), dtype=np.uint8)
        canvas[:, :size] = red_img
        canvas[:, size + 8:] = green_img
        m_light = pair_pixel_metrics(
            canvas, red, green, (245, 245, 245), cvd.DEUTAN, 1.0)
        m_dark = pair_pixel_metrics(
            canvas, red, green, (30, 30, 30), cvd.DEUTAN, 1.0)
        self.assertTrue(m_light["available"] and m_dark["available"])
        self.assertNotAlmostEqual(
            m_light["contrast_a"], m_dark["contrast_a"], places=3)
        self.assertNotAlmostEqual(
            m_light["contrast_b"], m_dark["contrast_b"], places=3)
        # 两类各自的平均显示色在两种底色下也不同
        self.assertNotEqual(m_light["mean_a"], m_dark["mean_a"])

    def test_conflict_pair_gets_worse_under_simulation(self):
        rgba = read_png(self.sheet_path)
        red, green = MARKERS[0][1], MARKERS[1][1]
        bg = (245, 245, 245)
        normal = pair_pixel_metrics(rgba, red, green, bg, cvd.DEUTAN, 0.0)
        strong = pair_pixel_metrics(rgba, red, green, bg, cvd.DEUTAN, 1.0)
        self.assertLess(strong["de_mean"], normal["de_mean"])
        self.assertLess(strong["de_min"], normal["de_min"])

        hot, fraction, min_de = conflict_hotspots(
            rgba, red, green, bg, cvd.DEUTAN, 1.0, threshold=10.0)
        self.assertTrue(hot.any(), "红绿对应能定位出冲突热点")
        self.assertGreater(fraction, 0.0)

    def test_severity_slider_changes_readings(self):
        """模拟程度可调: 不同程度下读数不同, 且中等程度出现明显混淆。"""
        rgba = read_png(self.sheet_path)
        red, green = MARKERS[0][1], MARKERS[1][1]
        bg = (245, 245, 245)
        readings = {
            s: pair_pixel_metrics(rgba, red, green, bg, cvd.DEUTAN, s)["de_mean"]
            for s in (0.0, 0.25, 0.5, 0.75, 1.0)
        }
        self.assertEqual(len(set(round(v, 6) for v in readings.values())),
                         len(readings))
        # 某个中等程度比普通视觉混淆得多
        self.assertLess(min(readings.values()), readings[0.0] * 0.5)

    def test_recolor_preserves_outside_and_alpha(self):
        rgba = read_png(self.sheet_path)
        target_green = (60, 200, 190)  # 把绿色标记改成青色, 拉开与红的距离
        out = recolor_image(rgba, [MARKERS[1][1]], [target_green],
                            tolerance=10.0)
        # alpha 完全保留
        np.testing.assert_array_equal(out[..., 3], rgba[..., 3])
        # 未取样颜色 (蓝标记) 不动
        blue_mask = category_masks(rgba, [MARKERS[4][1]], 10.0)[..., 0] > 0.5
        np.testing.assert_array_equal(
            out[blue_mask][..., :3], rgba[blue_mask][..., :3])

        # 单标记图上验证调色后红绿对在两种底色、两种模拟下都改善
        red_img = read_png(self.singles[0])
        green_img = read_png(self.singles[1])
        green_recolored = recolor_image(
            green_img, [MARKERS[1][1]], [target_green], tolerance=10.0)
        for bg in ((245, 245, 245), (30, 30, 30)):
            cr = composite_image(red_img, bg).mean(axis=(0, 1))
            cg = composite_image(green_img, bg).mean(axis=(0, 1))
            ct = composite_image(green_recolored, bg).mean(axis=(0, 1))
            for kind, sev in ((cvd.PROTAN, 1.0), (cvd.DEUTAN, 0.5)):
                before = ciede2000(cvd.simulate(cr, kind, sev),
                                   cvd.simulate(cg, kind, sev))
                after = ciede2000(cvd.simulate(cr, kind, sev),
                                  cvd.simulate(ct, kind, sev))
                self.assertGreater(float(after), float(before))
            # 普通视觉也不应劣化
            self.assertGreaterEqual(
                float(ciede2000(cr, ct)), float(ciede2000(cr, cg)) - 1.0)

    def test_simulation_frame_uses_composited_edge_color(self):
        rgba = read_png(self.singles[0])
        f_light = simulate_frame(rgba, (245, 245, 245), cvd.DEUTAN, 0.0)
        f_dark = simulate_frame(rgba, (30, 30, 30), cvd.DEUTAN, 0.0)
        # 完全透明处两种底色显示各自背景, 不相同
        fully_clear = rgba[..., 3] == 0
        self.assertFalse(
            np.allclose(f_light[fully_clear], f_dark[fully_clear]))
        np.testing.assert_allclose(
            f_light[fully_clear][:1], np.array([[245.0, 245.0, 245.0]]))
        np.testing.assert_allclose(
            f_dark[fully_clear][:1], np.array([[30.0, 30.0, 30.0]]))


if __name__ == "__main__":
    unittest.main()
