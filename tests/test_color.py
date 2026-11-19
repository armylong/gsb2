"""颜色转换与采样规则的单元测试 (不依赖 ffmpeg)。"""

import unittest

import numpy as np

from chromasubsample.color import (
    C_CENTER,
    plane_dims,
    reconstruct_rgb,
    rgb_to_yuv,
    subsample,
    upsample,
    yuv_to_rgb,
)
from chromasubsample.pattern import equiluminant_pair, expected_luma_diff_equiluminant


class TestColor(unittest.TestCase):
    def test_neutral_gray_chroma_is_center(self):
        for g in (0, 64, 128, 200, 255):
            rgb = np.full((4, 4, 3), g, dtype=np.uint8)
            y, cb, cr = rgb_to_yuv(rgb)
            self.assertTrue(np.all(cb == C_CENTER))
            self.assertTrue(np.all(cr == C_CENTER))

    def test_rgb_yuv_roundtrip_close(self):
        rng = np.random.default_rng(7)
        rgb = rng.integers(0, 256, size=(16, 24, 3), dtype=np.uint8)
        y, cb, cr = rgb_to_yuv(rgb)
        back = yuv_to_rgb(y, cb, cr)
        # 8-bit limited-range 两次量化, 全色格理论最大误差为 2 级 (与实现无关)
        self.assertLessEqual(np.abs(back.astype(int) - rgb.astype(int)).max(), 2)
        self.assertLess(np.abs(back.astype(int) - rgb.astype(int)).mean(), 0.6)

    def test_plane_dims_directions(self):
        w, h = 640, 480
        self.assertEqual(plane_dims("444", w, h), (640, 480))
        self.assertEqual(plane_dims("422", w, h), (320, 480))   # 只水平减半
        self.assertEqual(plane_dims("420", w, h), (320, 240))   # 两向减半

    def test_subsample_even_indices_and_nearest_upsample(self):
        plane = np.arange(100, dtype=np.uint8).reshape(10, 10)
        s422 = subsample(plane, "422")
        self.assertEqual(s422.shape, (10, 5))
        np.testing.assert_array_equal(s422, plane[:, 0::2])
        up422 = upsample(s422, "422", 10, 10)
        np.testing.assert_array_equal(up422[:, 0], up422[:, 1])
        np.testing.assert_array_equal(up422[:, 0], plane[:, 0])

        s420 = subsample(plane, "420")
        self.assertEqual(s420.shape, (5, 5))
        np.testing.assert_array_equal(s420, plane[0::2, 0::2])
        up420 = upsample(s420, "420", 10, 10)
        np.testing.assert_array_equal(up420[0], up420[1])
        np.testing.assert_array_equal(up420[:, 0], up420[:, 1])

    def test_reconstruct_shape(self):
        rng = np.random.default_rng(3)
        rgb = rng.integers(0, 256, size=(8, 8, 3), dtype=np.uint8)
        y, cb, cr = rgb_to_yuv(rgb)
        for mode in ("444", "422", "420"):
            rec = reconstruct_rgb(y, subsample(cb, mode), subsample(cr, mode), mode)
            self.assertEqual(rec.shape, rgb.shape)
            self.assertEqual(rec.dtype, np.uint8)


class TestEquiluminant(unittest.TestCase):
    def test_pair_luma_equal_after_quantization(self):
        a, b, _ = equiluminant_pair()
        self.assertNotEqual(a, b)
        # 量化后 Y 差值必须 <=1, 否则该边不能称为"等亮度"
        self.assertLessEqual(expected_luma_diff_equiluminant(), 1)
        ya = rgb_to_yuv(np.array(a, dtype=np.uint8).reshape(1, 1, 3))[0]
        yb = rgb_to_yuv(np.array(b, dtype=np.uint8).reshape(1, 1, 3))[0]
        # 但色度必须明显不同, 边才可见
        cba = rgb_to_yuv(np.array(a, dtype=np.uint8).reshape(1, 1, 3))[1]
        cbb = rgb_to_yuv(np.array(b, dtype=np.uint8).reshape(1, 1, 3))[1]
        self.assertGreater(abs(int(cba[0, 0]) - int(cbb[0, 0])), 20)
        self.assertEqual(int(ya[0, 0]), int(yb[0, 0]))


if __name__ == "__main__":
    unittest.main()
