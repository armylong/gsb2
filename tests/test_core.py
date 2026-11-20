"""Pytest-style checks for the resampling core (no Qt needed except PNG bridge).

Run with either:

    python -m pytest tests -q
    python -m unittest discover -s tests -v
"""
from __future__ import annotations

import math
import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from resample_lab import core, samples  # noqa: E402


class TestFilters(unittest.TestCase):
    def test_area_1x1_is_crop_mean(self):
        rng = np.random.default_rng(7)
        image = rng.random((32, 48, 4)).astype(np.float32)
        crop = core.Crop(0.25, 0.75, 47.0, 31.0)
        # Straight-alpha averaging is the identity this test is about.
        got = core.resample(image, crop, (1, 1), "area", premultiply=False).rgba
        n = 512
        xs = crop.x0 + (np.arange(n) + 0.5) * crop.width / n
        ys = crop.y0 + (np.arange(n) + 0.5) * crop.height / n
        xx, yy = np.meshgrid(xs, ys)
        ref = image[np.floor(yy).astype(int), np.floor(xx).astype(int)].mean(axis=(0, 1))
        np.testing.assert_allclose(got[0, 0], ref, atol=2e-3)

    def test_premultiplied_1x1_preserves_energy(self):
        rng = np.random.default_rng(11)
        image = rng.random((24, 24, 4)).astype(np.float32)
        crop = core.Crop(0, 0, 24, 24)
        got = core.resample(image, crop, (1, 1), "area").rgba[0, 0]
        work = core.premultiply_rgba(image).mean(axis=(0, 1))
        np.testing.assert_allclose(got[:3] * got[3], work[:3], atol=1e-4)
        self.assertAlmostEqual(float(got[3]), float(work[3]), places=4)

    def test_extreme_shrink_clamps_to_one_pixel(self):
        for scale in (1e-6, 0.0, -1.0):
            self.assertEqual(core.output_size(core.Crop(0, 0, 192, 192), scale), (1, 1))

    def test_all_filters_finite_at_one_pixel(self):
        image = samples.transparent_icon(128)
        for key in core.FILTER_ORDER:
            result = core.resample(image, core.Crop(0, 0, 128, 128), (1, 1), key)
            self.assertTrue(np.isfinite(result.rgba).all(), key)

    def test_matched_box_tracks_area(self):
        image = samples.thin_lines(128, spacing=4, thickness=1)
        crop = core.Crop(0, 0, 128, 128)
        for scale in (0.5, 0.25, 0.125, 0.0625):
            size = core.output_size(crop, scale)
            area = core.resample(image, crop, size, "area").metrics.mean_alpha
            box = core.resample(image, crop, size, "mean").metrics.mean_alpha
            self.assertAlmostEqual(area, box, delta=0.01)

    def test_direct_can_miss_thin_lines(self):
        image = samples.thin_lines(128, spacing=4, thickness=1)
        crop = core.Crop(0, 0, 128, 128)
        values = [
            core.resample(image, crop, core.output_size(crop, s), "direct").metrics.mean_alpha
            for s in (0.5, 0.25, 0.125, 0.0625)
        ]
        self.assertGreater(max(values) - min(values), 0.2)

    def test_crop_may_extend_outside_image(self):
        image = samples.transparent_icon(64)
        result = core.resample(image, core.Crop(-20, -20, 120, 120), (8, 8), "area")
        self.assertTrue(np.isfinite(result.rgba).all())
        self.assertEqual(result.rgba.shape, (8, 8, 4))

    def test_tiny_footprint_upscale(self):
        image = samples.transparent_icon(64)
        result = core.resample(image, core.Crop(10, 10, 4, 4), (16, 16), "mean")
        self.assertEqual(result.rgba.shape, (16, 16, 4))


class TestAlpha(unittest.TestCase):
    def test_premultiplied_preserves_colour(self):
        icon = samples.transparent_icon(128)
        alpha = icon[..., 3].astype(np.float64)
        ref = (icon[..., :3] * alpha[..., None]).sum(axis=(0, 1)) / alpha.sum()
        got = core.resample(icon, core.Crop(0, 0, 128, 128), (1, 1), "area").rgba[0, 0, :3]
        np.testing.assert_allclose(got, ref, atol=2e-3)

    def test_straight_alpha_darkens_rim(self):
        icon = samples.transparent_icon(128)
        crop = core.Crop(0, 0, 128, 128)
        pre = core.resample(icon, crop, (24, 24), "area", premultiply=True).metrics
        straight = core.resample(icon, crop, (24, 24), "area", premultiply=False).metrics
        self.assertLess(straight.edge_delta, pre.edge_delta - 0.05)

    def test_unpremultiply_never_drops_energy(self):
        # alpha * rgb must survive the premultiply -> resample -> unpremultiply
        # round trip, otherwise compositing would change over a backdrop.
        rng = np.random.default_rng(3)
        image = rng.random((16, 16, 4)).astype(np.float32)
        image[..., 3] = rng.random((16, 16)).astype(np.float32)
        work = core.premultiply_rgba(image)
        back = core.unpremultiply_rgba(work)
        np.testing.assert_allclose(
            work[..., :3], back[..., :3] * back[..., 3:4], atol=1e-5
        )


class TestSamples(unittest.TestCase):
    def test_samples_are_straight_alpha(self):
        for key in samples.SAMPLE_ORDER:
            image = samples.make_sample(key, 64)
            self.assertEqual(image.shape, (64, 64, 4), key)
            self.assertTrue((image >= 0).all() and (image <= 1).all(), key)
            transparent = image[..., 3] == 0
            self.assertFalse(image[transparent][:, :3].any(), key)

    def test_odd_grid_mean(self):
        grid = samples.odd_ratio_grid(60, period=3)
        # 1-px bars on both axes with a 3-px period: union of a 3x3 block is 5/9.
        self.assertAlmostEqual(float(grid[..., 3].mean()), 5 / 9, places=3)

    def test_diagonal_alpha(self):
        line = samples.semi_transparent_diagonal(128, width=1.0, alpha=0.5)
        # 45-degree line of nominal width w has area w * size * sqrt(2) pixels,
        # i.e. mean coverage w*sqrt(2)/size; the AA ramp keeps a bit more.
        expected = 1.0 * math.sqrt(2) / 128 * 0.5
        self.assertAlmostEqual(float(line[..., 3].mean()), expected, delta=0.001)


class TestExports(unittest.TestCase):
    def test_png_roundtrip_pixel(self):
        image = samples.thin_lines(64)
        result = core.resample(image, core.Crop(0, 0, 64, 64), (8, 8), "area")
        import tempfile

        from PySide6.QtGui import QImage

        fd, path = tempfile.mkstemp(suffix=".png")
        os.close(fd)
        try:
            core.save_png(path, result.rgba)
            qimg = QImage(path).convertToFormat(QImage.Format.Format_RGBA8888)
            colour = qimg.pixelColor(3, 4)
            expected = result.u8[4, 3]
            self.assertEqual(
                [colour.red(), colour.green(), colour.blue(), colour.alpha()],
                [int(v) for v in expected],
            )
        finally:
            os.unlink(path)


if __name__ == "__main__":
    unittest.main()
