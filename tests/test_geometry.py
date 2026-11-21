"""几何模型纯单测（不依赖 ffmpeg）。"""
import unittest
from fractions import Fraction

from vidgeo.geometry import (
    UnsupportedOrientationError,
    VideoGeometry,
    normalize_rotation,
)


def geo(w, h, par=(1, 1), rot=0):
    return VideoGeometry(w, h, par[0], par[1], rot)


class TestPAR(unittest.TestCase):
    def test_ntsc_dar(self):
        # 720x480 @ 40:33 是经典 NTSC 16:9 DV 素材
        g = geo(720, 480, (40, 33))
        self.assertFalse(g.is_square_pixel)
        self.assertEqual(g.coded_dar, Fraction(720 * 40, 480 * 33))
        self.assertAlmostEqual(float(g.coded_dar), 1.81818, places=4)
        self.assertEqual(g.display_size, (873, 480))

    def test_square_pixel(self):
        g = geo(1920, 1080)
        self.assertTrue(g.is_square_pixel)
        self.assertEqual(g.display_dar, Fraction(16, 9))

    def test_ideal_and_even_rounding(self):
        # 640x480 @ 40:33 -> 理想宽 775.76，取最近偶 776，向下取偶 774
        g = geo(640, 480, (40, 33))
        iw, ih = g.ideal_output_size()
        self.assertEqual(iw, Fraction(640 * 40, 33))
        self.assertEqual(g.output_size("nearest"), (776, 480))
        self.assertEqual(g.output_size("down"), (774, 480))
        d = g.edge_deltas("nearest")
        self.assertAlmostEqual(float(d["left"] + d["right"]), 776 - float(iw))
        self.assertEqual(float(d["top"]), 0.0)


class TestRotation(unittest.TestCase):
    def test_rot90_swaps_axes(self):
        # 横矩阵 1920x1080 带 90° 元数据 -> 竖屏显示 1080x1920
        g = geo(1920, 1080, rot=90)
        self.assertTrue(g.is_rotated)
        self.assertEqual(g.display_size, (1080, 1920))
        self.assertEqual(g.display_dar, Fraction(1080, 1920))
        self.assertEqual(g.output_size(), (1080, 1920))

    def test_par_plus_rot90(self):
        # 720x480 @40:33 + 90°：显示宽=480，显示高=720*40/33≈872.7
        g = geo(720, 480, (40, 33), rot=90)
        dw, dh = g.display_size
        self.assertEqual(dw, 480)
        self.assertIn(dh, (873, 872))
        ow, oh = g.output_size("nearest")
        # 872.727 的偶数邻居为 872(差0.73) 与 874(差1.27)，最近偶为 872
        self.assertEqual((ow, oh), (480, 872))
        self.assertEqual(g.output_size("down"), (480, 872))
        # 精确核对：720*40/33 = 872.727...
        self.assertAlmostEqual(float(Fraction(720 * 40, 33)), 872.73, places=2)

    def test_rot180_keeps_axes(self):
        g = geo(640, 480, rot=180)
        self.assertFalse(g.is_rotated)
        self.assertEqual(g.display_size, (640, 480))


class TestCoordinates(unittest.TestCase):
    def test_corners_invariant_rot90(self):
        # 显示四角的归一化坐标固定；检查它们映射到的存储像素位置
        g = geo(1920, 1080, rot=90)
        # 显示左上(0,0) 应来自存储矩阵的左下角 (0,1080)
        x, y = g.display_to_coded(0.0, 0.0)
        self.assertEqual((x, y), (0.0, 1080.0))
        # 显示右下(1,1) 应来自存储矩阵右上角 (1920,0)
        x, y = g.display_to_coded(1.0, 1.0)
        self.assertEqual((x, y), (1920.0, 0.0))

    def test_roundtrip_all_rotations(self):
        for rot in (0, 90, 180, 270):
            g = geo(720, 480, (40, 33), rot=rot)
            for u, v in ((0.3, 0.7), (0.0, 0.0), (1.0, 1.0), (0.5, 0.2)):
                x, y = g.display_to_coded(u, v)
                u2, v2 = g.coded_to_display(x, y)
                self.assertAlmostEqual(u, u2, places=9)
                self.assertAlmostEqual(v, v2, places=9)

    def test_output_mapping_proportion(self):
        g = geo(720, 480, (40, 33))
        ow, oh = g.output_size("nearest")
        x, y = g.display_to_output(0.5, 0.25)
        self.assertAlmostEqual(x, ow * 0.5)
        self.assertAlmostEqual(y, oh * 0.25)

    def test_marker_table_identity(self):
        g = geo(720, 480, rot=270)
        rows = g.corner_markers()
        self.assertEqual([r["marker"] for r in rows], [1, 2, 3, 4])
        # 270°：显示左上 -> 存储右上角
        self.assertEqual(rows[0]["coded_xy"], (720.0, 0.0))


class TestFilterChain(unittest.TestCase):
    def test_chain_contains_sar_and_transpose(self):
        g = geo(720, 480, (40, 33), rot=90)
        chain = g.bake_filter_chain(480, 874)
        self.assertIn("setsar=1", chain)
        self.assertIn("transpose=2", chain)
        self.assertIn("scale=480:874", chain)

    def test_chain_rot270(self):
        g = geo(1920, 1080, rot=270)
        chain = g.bake_filter_chain(1080, 1920)
        self.assertIn("transpose=1", chain)
        self.assertNotIn("transpose=2", chain)


class TestNormalize(unittest.TestCase):
    def test_supported(self):
        self.assertEqual(normalize_rotation(-90), 270)
        self.assertEqual(normalize_rotation(360), 0)
        self.assertEqual(normalize_rotation(0), 0)

    def test_unsupported_message(self):
        with self.assertRaises(UnsupportedOrientationError) as ctx:
            normalize_rotation(45)
        self.assertIn("45", ctx.exception.args[0])
        self.assertIn("0/90/180/270", ctx.exception.args[0])


if __name__ == "__main__":
    unittest.main()
