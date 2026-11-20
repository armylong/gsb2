"""核心算法的确定性单元测试（无需 GUI、无需 Qt）。

运行：.venv/bin/python -m unittest tests.test_core -v
"""
from __future__ import annotations

import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bandviewer.analysis import (  # noqa: E402
    boundary_mask,
    boundary_transitions,
    error_map,
    error_stats,
    level_histogram,
)
from bandviewer.levels import parse_custom_levels, spaced_levels, uniform_levels  # noqa: E402
from bandviewer.patterns import PATTERN_KINDS, generate_pattern  # noqa: E402
from bandviewer.pngio import read_png, write_png  # noqa: E402
from bandviewer.quantize import (  # noqa: E402
    add_noise,
    ordered_indices,
    quantize,
)


class TestLevels(unittest.TestCase):
    def test_uniform(self):
        lv = uniform_levels(4)
        np.testing.assert_allclose(lv, [0, 1 / 3, 2 / 3, 1.0])

    def test_gamma_spacing_ordering(self):
        dark = spaced_levels(8, "gamma-dark", 2.2)
        light = spaced_levels(8, "gamma-light", 2.2)
        self.assertTrue(np.all(np.diff(dark) > 0))
        # 暗部密集：第一级间距更小
        self.assertLess(dark[1] - dark[0], light[1] - light[0])

    def test_parse_8bit_and_float(self):
        np.testing.assert_allclose(parse_custom_levels("0 128 255"), [0, 128 / 255, 1.0])
        np.testing.assert_allclose(parse_custom_levels("0, 0.5, 1"), [0, 0.5, 1.0])

    def test_parse_sorts_and_dedups(self):
        lv = parse_custom_levels("0.9 0.1 0.1 0.5")
        np.testing.assert_allclose(lv, [0.1, 0.5, 0.9])

    def test_parse_rejects_single_and_negative(self):
        with self.assertRaises(ValueError):
            parse_custom_levels("128")
        with self.assertRaises(ValueError):
            parse_custom_levels("-1 0.5")


class TestQuantize(unittest.TestCase):
    def setUp(self):
        self.gray, self.alpha = generate_pattern("composite", 96)
        self.levels = uniform_levels(6)

    def test_all_methods_on_levels_and_keep_transparent(self):
        for method in ("nearest", "floor", "ordered", "fs", "random"):
            q = quantize(self.gray, self.alpha, self.levels, method=method, seed=3)
            used = np.unique(q[self.alpha > 0])
            for v in used:
                self.assertLessEqual(np.min(np.abs(self.levels - v)), 1e-9)
            # 透明像素原样保留
            np.testing.assert_array_equal(q[self.alpha == 0], self.gray[self.alpha == 0])

    def test_floor_is_monotonic_bands(self):
        g, a = generate_pattern("gradient", 120)
        q = quantize(g, a, uniform_levels(5), method="floor")
        # 任一条不透明扫描线，量化值沿 x 单调不减，且取值集合 = 全部 5 级
        row = q[a.shape[0] // 2][a[a.shape[0] // 2] > 0]
        self.assertTrue(np.all(np.diff(row) >= 0))
        self.assertEqual(np.unique(row).size, 5)

    def test_nearest_midpoint_decision(self):
        lv = np.array([0.0, 0.5, 1.0])
        # 中点 0.25 / 0.75 为判决门限
        g = np.array([[[0.24, 0.26, 0.74, 0.76]]], dtype=np.float64)
        a = np.ones_like(g)
        q = quantize(g, a, lv, method="nearest")
        np.testing.assert_allclose(q[0, 0], [0, 0.5, 0.5, 1.0])

    def test_ordered_indices_range(self):
        idx = ordered_indices(self.gray, self.levels, bayer_order=2)
        self.assertEqual(idx.min(), 0)
        self.assertLessEqual(idx.max(), self.levels.size - 1)

    def test_noise_seed_reproducible(self):
        n1 = add_noise(self.gray, self.alpha, 0.04, seed=99)
        n2 = add_noise(self.gray, self.alpha, 0.04, seed=99)
        n3 = add_noise(self.gray, self.alpha, 0.04, seed=100)
        np.testing.assert_array_equal(n1, n2)
        self.assertFalse(np.array_equal(n1, n3))
        # 透明区不加噪
        np.testing.assert_array_equal(n1[self.alpha == 0], self.gray[self.alpha == 0])


class TestAnalysis(unittest.TestCase):
    def test_histogram_and_boundary(self):
        g, a = generate_pattern("gradient", 120)
        lv = uniform_levels(5)
        q = quantize(g, a, lv, method="floor")
        hist = level_histogram(q, a, lv)
        self.assertEqual(int(hist.sum()), int((a > 0).sum()))
        bm = boundary_mask(q, a)
        # 渐变 + floor：每条不透明扫描线有 4 个边界位置，每处两侧各标记 -> 8 像素/行
        mid = bm[a.shape[0] // 2]
        self.assertEqual(int(mid.sum()), 8)
        transitions = boundary_transitions(q, a, lv)
        self.assertTrue(all(t["to_idx"] == t["from_idx"] + 1 for t in transitions))

    def test_error_map_stats(self):
        g, a = generate_pattern("vignette", 96)
        q = quantize(g, a, uniform_levels(4), method="nearest")
        err = error_map(g, q, a)
        stats = error_stats(err, a)
        self.assertEqual(stats["count"], int((a > 0).sum()))
        self.assertGreaterEqual(stats["rmse"], 0.0)
        # 最近邻误差不会超过半个最大级别间距
        self.assertLessEqual(stats["max"], np.max(np.diff(uniform_levels(4))) / 2 + 1e-9)
        # 透明处误差为 0
        np.testing.assert_array_equal(err[a == 0], 0.0)


class TestPngRoundtrip(unittest.TestCase):
    def test_gray_alpha_and_rgb_roundtrip(self, tmpdir=None):
        import tempfile
        g, a = generate_pattern("composite", 64)
        with tempfile.TemporaryDirectory() as d:
            p1 = os.path.join(d, "g.png")
            write_png(p1, g, a)
            rg, ra = read_png(p1)
            np.testing.assert_allclose(rg, np.round(g * 255) / 255, atol=1.5 / 255)
            np.testing.assert_allclose(ra, np.round(a * 255) / 255, atol=1.5 / 255)
            self.assertTrue(np.any(ra == 0.0))  # 透明区保留


class TestPatterns(unittest.TestCase):
    def test_all_patterns_shapes_and_range(self):
        for kind in PATTERN_KINDS:
            g, a = generate_pattern(kind, 64)
            self.assertEqual(g.shape, (64, 64))
            self.assertTrue(0.0 <= g.min() and g.max() <= 1.0)
            np.testing.assert_array_equal(np.unique(a), [0.0, 1.0]) if kind != "grayscale" else None


if __name__ == "__main__":
    unittest.main(verbosity=2)
