"""色彩空间与 CIEDE2000 数值正确性测试。"""
import unittest

import numpy as np

from colorcheck.colorio import (ciede2000, ciede2000_matrix, composite_over,
                                contrast_ratio, hex_to_rgb, rgb_to_hex,
                                rgb_to_lab, rgb_to_oklch, oklch_to_rgb,
                                srgb_to_linear, relative_luminance,
                                _de2000_elementwise)


def de2000_lab(lab1, lab2):
    return float(_de2000_elementwise(np.asarray(lab1, float),
                                     np.asarray(lab2, float)))


class TestDE2000(unittest.TestCase):
    # Sharma et al. (2005) 标准参考数据 (Lab 输入)
    SHARMA = [
        ((50.0000, 2.6772, -79.7751), (50.0000, 0.0000, -82.7485), 2.0425),
        ((50.0000, 3.1571, -77.2803), (50.0000, 0.0000, -82.7485), 2.8615),
        ((50.0000, 2.8361, -74.0200), (50.0000, 0.0000, -82.7485), 3.4412),
        ((50.0000, -1.3802, -84.2814), (50.0000, 0.0000, -82.7485), 1.0000),
        ((60.2574, -34.0099, 36.2677), (60.4626, -34.1751, 39.4387), 1.2644),
        ((63.0109, -31.0961, -5.8663), (62.8187, -29.7946, -4.0864), 1.2630),
        ((2.0776, 0.0795, -1.1350), (0.9033, -0.0636, -0.5514), 0.9082),
    ]

    def test_sharma_reference(self):
        for lab1, lab2, expected in self.SHARMA:
            got = de2000_lab(lab1, lab2)
            self.assertAlmostEqual(got, expected, delta=0.0002)

    def test_same_color_zero(self):
        rgb = np.array([[123, 45, 200]], dtype=float)
        self.assertAlmostEqual(float(ciede2000(rgb, rgb)[0]), 0.0, places=8)

    def test_matrix_matches_elementwise(self):
        rng = np.random.default_rng(0)
        a = rng.integers(0, 255, size=(5, 3))
        b = rng.integers(0, 255, size=(4, 3))
        m = ciede2000_matrix(a, b)
        for i in range(5):
            for j in range(4):
                self.assertAlmostEqual(
                    m[i, j], float(ciede2000(a[i], b[j])), places=6)


class TestLuminanceContrast(unittest.TestCase):
    def test_extremes(self):
        black = (0, 0, 0)
        white = (255, 255, 255)
        self.assertAlmostEqual(relative_luminance(black), 0.0, places=6)
        self.assertAlmostEqual(relative_luminance(white), 1.0, places=6)
        self.assertAlmostEqual(contrast_ratio(white, black), 21.0, places=4)
        self.assertAlmostEqual(contrast_ratio(black, white), 21.0, places=4)

    def test_linear_endpoints(self):
        self.assertAlmostEqual(float(srgb_to_linear(0.0)), 0.0, places=8)
        self.assertAlmostEqual(float(srgb_to_linear(1.0)), 1.0, places=8)
        # 255 输入不归一化时不具物理意义, 这里只验证 0-1 域


class TestComposite(unittest.TestCase):
    def test_alpha_endpoints(self):
        fg = np.array([100.0, 100.0, 100.0])
        bg = np.array([0.0, 0.0, 0.0])
        np.testing.assert_allclose(composite_over(fg, 1.0, bg), fg)
        np.testing.assert_allclose(composite_over(fg, 0.0, bg), bg)

    def test_half_alpha(self):
        out = composite_over(np.array([200.0, 0.0, 0.0]), 0.5,
                             np.array([0.0, 200.0, 0.0]))
        np.testing.assert_allclose(out, [100.0, 100.0, 0.0])


class TestRoundTrips(unittest.TestCase):
    def test_hex(self):
        for rgb in [(0, 0, 0), (255, 255, 255), (18, 172, 99)]:
            self.assertEqual(hex_to_rgb(rgb_to_hex(rgb)), rgb)

    def test_oklch_roundtrip(self):
        rng = np.random.default_rng(1)
        rgb = rng.integers(0, 256, size=(20, 3)).astype(float)
        L, C, h = rgb_to_oklch(rgb).T
        back = oklch_to_rgb(L, C, h)
        # OKLCH 往返本身无损, 误差只来自裁剪/量化
        np.testing.assert_allclose(back, rgb, atol=1.0)

    def test_lab_black_white(self):
        lab_black = rgb_to_lab(np.array([(0, 0, 0)], float))[0]
        lab_white = rgb_to_lab(np.array([(255, 255, 255)], float))[0]
        self.assertAlmostEqual(lab_black[0], 0.0, places=4)
        self.assertAlmostEqual(lab_white[0], 100.0, places=3)


if __name__ == "__main__":
    unittest.main()
