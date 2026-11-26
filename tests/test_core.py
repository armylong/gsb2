"""纯数值单元测试 (不依赖 Qt 显示): 模型、渲染、IO 往返。"""

import os
import tempfile
import unittest

import numpy as np

from bandview.io_utils import build_valid_mask, load_band, save_band_npy
from bandview.model import BandData, clip_counts
from bandview.rendering import (
    normalized_difference,
    render_composite,
    render_grayscale,
    scale_to_uint8,
)


class ModelTests(unittest.TestCase):
    def setUp(self):
        self.data = np.array([[0, 100, 200], [300, 400, 0]], dtype=np.uint16)
        self.valid = self.data != 0
        self.band = BandData("x", self.data, self.valid, nodata_value=0)

    def test_stats_skip_nodata(self):
        stats = self.band.stats_in(None)
        self.assertEqual(stats.count, 4)
        self.assertEqual(stats.minimum, 100)
        self.assertEqual(stats.maximum, 400)

    def test_roi_values_clipped(self):
        values = self.band.roi_values((1, 0, 99, 99))
        np.testing.assert_array_equal(np.sort(values), [100, 200, 400])
        empty = self.band.roi_values((0, 0, 0, 0))
        self.assertEqual(empty.size, 0)

    def test_clip_counts(self):
        low, high = clip_counts(self.band, 150, 350)
        self.assertEqual(low, 1)  # 100
        self.assertEqual(high, 1)  # 400

    def test_float_nan_mask(self):
        arr = np.array([[1.0, np.nan], [np.inf, 2.0]], dtype=np.float32)
        valid = build_valid_mask(arr, None)
        self.assertTrue(valid[0, 0])
        self.assertFalse(valid[0, 1])
        self.assertFalse(valid[1, 0])


class RenderingTests(unittest.TestCase):
    def setUp(self):
        rng = np.random.default_rng(0)
        self.a = BandData(
            "a", rng.integers(100, 1000, size=(8, 8), dtype=np.uint16),
            np.ones((8, 8), bool),
        )
        self.b = BandData(
            "b", rng.integers(100, 1000, size=(8, 8), dtype=np.uint16),
            np.ones((8, 8), bool),
        )

    def test_scale_endpoints_and_flat_range(self):
        data = np.array([[0, 5, 10]], dtype=np.uint16)
        valid = np.ones((1, 3), bool)
        gray, low, high = scale_to_uint8(data, valid, 0, 10)
        np.testing.assert_array_equal(gray[0], [0, 128, 255])
        self.assertFalse(low.any() and high.any())
        gray2, low2, high2 = scale_to_uint8(data, valid, 5, 5)
        # 平范围: 只有恰好等于 5 的点映射 128, 其余进裁剪掩码
        self.assertEqual(gray2[0, 1], 128)
        self.assertTrue(low2[0, 0] and high2[0, 2])
        self.assertFalse(low2[0, 1] or high2[0, 1])

    def test_grayscale_nodata_overlay(self):
        data = np.array([[0, 5]], dtype=np.uint16)
        valid = np.array([[False, True]])
        rgba = render_grayscale(BandData("z", data, valid, nodata_value=0), 0, 5)
        self.assertEqual(tuple(rgba[0, 0]), (255, 0, 255, 255))
        self.assertEqual(tuple(rgba[0, 1, :3]), (255, 255, 255))

    def test_composite_unassigned_channel_is_black(self):
        rgba = render_composite(
            (self.a, None, self.b),
            ((100, 1000), (0, 1), (100, 1000)),
        )
        # G 通道未分配 => 绿色通道全 0
        self.assertTrue((rgba[:, :, 1] == 0).all())
        self.assertEqual(rgba.shape, (8, 8, 4))

    def test_ndvi_basic_and_denom(self):
        a = BandData("a", np.array([[4.0, 1.0]], dtype=np.float64), np.ones((1, 2), bool))
        b = BandData("b", np.array([[1.0, 3.0]], dtype=np.float64), np.ones((1, 2), bool))
        ndvi, valid, low_denom = normalized_difference(a, b, 1e-6)
        self.assertAlmostEqual(ndvi[0, 0], 0.6, places=10)
        self.assertAlmostEqual(ndvi[0, 1], -0.5, places=10)
        self.assertFalse(low_denom.any())

        z1 = BandData("z1", np.array([[5.0]]), np.ones((1, 1), bool))
        z2 = BandData("z2", np.array([[-5.0]]), np.ones((1, 1), bool))
        _, _, low_denom2 = normalized_difference(z1, z2, 1e-6)
        self.assertTrue(low_denom2[0, 0])

    def test_ndvi_invalid_mask_intersection(self):
        a = BandData("a", np.array([[1.0, 2.0]]), np.array([[True, False]]))
        b = BandData("b", np.array([[3.0, 4.0]]), np.ones((1, 2), bool))
        _, valid, _ = normalized_difference(a, b, 1e-6)
        self.assertEqual(valid.tolist(), [[True, False]])

    def test_ndvi_nodata_takes_priority_over_low_denom(self):
        # 无值像素即便 a+b=0 也必须显示无值色, 不能被分母过小色覆盖
        from bandview.constants import NODATA_RGBA
        from bandview.rendering import render_ndvi

        a = BandData("a", np.array([[0.0, 5.0]]), np.array([[False, True]]))
        b = BandData("b", np.array([[0.0, -5.0]]), np.array([[False, True]]))
        rgba, _, valid, low_denom = render_ndvi(a, b, denom_eps=1e-6)
        self.assertFalse(valid[0, 0])
        self.assertFalse(low_denom[0, 0])  # 分母过小掩码不含无值像素
        self.assertEqual(tuple(rgba[0, 0]), NODATA_RGBA)
        # 第二个有效像素 a+b=0, 应进入分母过小
        self.assertTrue(low_denom[0, 1])

    def test_uint32_high_bit_depth_preserved(self):
        data = np.array([[0, 2**20, 2**31]], dtype=np.uint32)
        band = BandData("big", data, np.ones((1, 3), bool))
        rgba = render_grayscale(band, 0, 2**31)
        self.assertEqual(tuple(rgba[0, 0, :3]), (0, 0, 0))
        self.assertEqual(tuple(rgba[0, 2, :3]), (255, 255, 255))
        # 原始数组未被修改
        self.assertEqual(band.dtype, np.uint32)
        self.assertEqual(band.data[0, 1], 2**20)


class IoTests(unittest.TestCase):
    def test_npy_roundtrip_and_nodata(self):
        with tempfile.TemporaryDirectory() as tmp:
            arr = np.array([[0, 1, 2], [3, 0, 5]], dtype=np.uint16)
            path = os.path.join(tmp, "b.npy")
            save_band_npy(path, arr)
            band = load_band(path, nodata=0)
            np.testing.assert_array_equal(band.data, arr)
            self.assertEqual(band.valid.tolist(), (arr != 0).tolist())
            band_all_valid = load_band(path)
            self.assertTrue(band_all_valid.valid.all())

    def test_shape_guard(self):
        with self.assertRaises(ValueError):
            BandData("bad", np.zeros((2, 2, 2)), np.ones((2, 2, 2), bool))


if __name__ == "__main__":
    unittest.main()
