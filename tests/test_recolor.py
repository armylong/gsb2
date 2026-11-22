"""改色范围与透明边处理测试。"""
import unittest

import numpy as np

from colorcheck.recolor import affected_mask, recolor_image


def make_rgba():
    rgba = np.zeros((8, 8, 4), dtype=np.uint8)
    rgba[:4, :4, :3] = (200, 30, 30)
    rgba[:4, :4, 3] = 255
    rgba[4, :4, 3] = 128          # 半透明边缘, 保持红色
    rgba[4, :4, :3] = (200, 30, 30)
    rgba[6:, 6:, :3] = (20, 40, 200)  # 范围外蓝色
    rgba[6:, 6:, 3] = 255
    return rgba


class TestRecolor(unittest.TestCase):
    def test_outside_pixels_untouched(self):
        rgba = make_rgba()
        out = recolor_image(rgba, [(200, 30, 30)], [(30, 200, 30)],
                            tolerance=8.0)
        np.testing.assert_array_equal(out[6:, 6:], rgba[6:, 6:])
        # 完全透明像素永远不变
        np.testing.assert_array_equal(out[rgba[..., 3] == 0],
                                      rgba[rgba[..., 3] == 0])

    def test_opaque_interior_recolored(self):
        rgba = make_rgba()
        out = recolor_image(rgba, [(200, 30, 30)], [(30, 200, 30)],
                            tolerance=8.0)
        np.testing.assert_array_equal(out[0, 0, :3], [30, 200, 30])

    def test_semi_edge_partial_blend(self):
        rgba = make_rgba()
        out = recolor_image(rgba, [(200, 30, 30)], [(30, 200, 30)],
                            tolerance=8.0)
        edge = out[4, 0, :3].astype(float)
        # 边缘像素被纳入取样 (权重高), 颜色应明显向目标色移动
        self.assertGreater(edge[1], 100)
        self.assertLess(edge[0], 120)

    def test_alpha_channel_never_changes(self):
        rgba = make_rgba()
        out = recolor_image(rgba, [(200, 30, 30)], [(30, 200, 30)],
                            tolerance=8.0)
        np.testing.assert_array_equal(out[..., 3], rgba[..., 3])

    def test_strength_zero_is_identity(self):
        rgba = make_rgba()
        out = recolor_image(rgba, [(200, 30, 30)], [(30, 200, 30)],
                            tolerance=8.0, strength=0.0)
        np.testing.assert_array_equal(out, rgba)

    def test_affected_mask(self):
        rgba = make_rgba()
        mask = affected_mask(rgba, [(200, 30, 30)], tolerance=8.0)
        self.assertTrue(mask[:4, :4].all())
        self.assertFalse(mask[6:, 6:].any())
        self.assertFalse(mask[rgba[..., 3] == 0].any())

    def test_no_match_returns_copy(self):
        rgba = make_rgba()
        out = recolor_image(rgba, [(0, 255, 255)], [(1, 2, 3)],
                            tolerance=4.0)
        np.testing.assert_array_equal(out, rgba)
        self.assertIsNot(out, rgba)


if __name__ == "__main__":
    unittest.main()
