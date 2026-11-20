"""核心模块单元测试：纯 numpy，不依赖 GUI。

运行：.venv/bin/python -m unittest -v
"""
from __future__ import annotations

import os
import tempfile
import unittest

import numpy as np

from colormatch.core import (
    Rect,
    Sample,
    FitError,
    fit_transform,
    apply_transform,
    rgb_to_lab,
    delta_e00,
    gamut_mask,
    gamut_stats,
    patch_stat,
    Project,
    collect_means,
    load_image_rgb,
    save_image_rgb,
)
from colormatch.samples import generate_sample_project
from colormatch.pipeline import run_headless


def _samples_from_rows(rows, white_idx=None):
    out = []
    for i, _ in enumerate(rows):
        out.append(Sample(id=f"s{i:02d}", name=f"c{i}", is_white=(i == white_idx)))
    return out


class FittingTests(unittest.TestCase):
    def setUp(self):
        rng = np.random.default_rng(0)
        # 12 个分布在 RGB 空间的色块
        self.X = rng.uniform(0.05, 0.95, size=(12, 3))
        self.M_true = np.array(
            [[1.10, 0.04, -0.05], [-0.03, 0.95, 0.02], [0.02, 0.06, 0.90]]
        )
        self.t_true = np.array([0.02, -0.01, 0.05])
        self.Y = self.X @ self.M_true.T + self.t_true
        self.samples = _samples_from_rows(self.X)

    def test_affine_recovers_known_transform(self):
        params = fit_transform(self.X, self.Y, "affine", False, None, self.samples)
        np.testing.assert_allclose(np.asarray(params.M), self.M_true, atol=1e-9)
        np.testing.assert_allclose(np.asarray(params.t), self.t_true, atol=1e-9)
        self.assertLess(params.residual_rms, 1e-6)
        self.assertEqual(params.n_samples, 12)

    def test_diagonal_recovers_channelwise_transform(self):
        gains = np.array([1.08, 0.92, 1.03])
        bias = np.array([0.02, -0.01, 0.04])
        Yd = self.X * gains + bias
        params = fit_transform(self.X, Yd, "diagonal", False, None, self.samples)
        M = np.asarray(params.M)
        np.testing.assert_allclose(np.diag(M), gains, atol=1e-9)
        np.testing.assert_allclose(M - np.diag(np.diag(M)), 0.0, atol=1e-12)
        np.testing.assert_allclose(np.asarray(params.t), bias, atol=1e-9)

    def test_white_lock_is_hard_constraint(self):
        w = 3
        samples = _samples_from_rows(self.X, white_idx=w)
        params = fit_transform(self.X, self.Y, "affine", True, samples[w].id, samples)
        M, t = np.asarray(params.M), np.asarray(params.t)
        np.testing.assert_allclose(M @ self.X[w] + t, self.Y[w], atol=1e-12)
        self.assertTrue(params.white_locked)
        self.assertEqual(params.white_sample_id, samples[w].id)

    def test_white_lock_with_no_white_sample_raises(self):
        with self.assertRaises(FitError):
            fit_transform(self.X, self.Y, "affine", True, None, self.samples)

    def test_too_few_samples_raises(self):
        samples = self.samples[:3]
        with self.assertRaises(FitError) as cm:
            fit_transform(self.X[:3], self.Y[:3], "affine", False, None, samples)
        self.assertIn("至少需要 4", str(cm.exception))

        samples1 = self.samples[:1]
        with self.assertRaises(FitError):
            fit_transform(self.X[:1], self.Y[:1], "diagonal", False, None, samples1)

    def test_degenerate_coplanar_samples_raise(self):
        # 所有颜色只在一条直线上变化 -> 中心化矩阵秩 1
        base = np.array([0.2, 0.3, 0.4])
        direction = np.array([0.1, 0.1, 0.1])
        X = np.array([base + k * direction for k in np.linspace(0, 1, 8)])
        Y = X @ self.M_true.T + self.t_true
        w = 0
        samples = _samples_from_rows(X, white_idx=w)
        with self.assertRaises(FitError) as cm:
            fit_transform(X, Y, "affine", True, samples[w].id, samples)
        self.assertIn("退化", str(cm.exception))

    def test_degenerate_diagonal_channel_raises(self):
        X = np.tile(np.array([0.5, 0.3, 0.6]), (6, 1))  # 每个通道值都不变
        X[:, 0] = np.linspace(0.1, 0.9, 6)              # 只让 R 通道变化
        Y = X.copy()
        with self.assertRaises(FitError):
            fit_transform(X, Y, "diagonal", False, None, self.samples[:6])

    def test_apply_transform_roundtrip(self):
        params = fit_transform(self.X, self.Y, "affine", False, None, self.samples)
        img = self.X.reshape(3, 4, 3)
        out = apply_transform(img, params)
        np.testing.assert_allclose(out.reshape(-1, 3), self.Y, atol=1e-9)


class ColorDifferenceTests(unittest.TestCase):
    def test_identical_colors_zero_delta(self):
        rgb = np.array([[0.1, 0.2, 0.3], [0.9, 0.8, 0.7]])
        np.testing.assert_allclose(delta_e00(rgb_to_lab(rgb), rgb_to_lab(rgb)), 0.0, atol=1e-10)

    def test_known_ordering(self):
        # 红与绿的色差应明显大于红与稍暗的红
        red = np.array([[0.8, 0.1, 0.1]])
        green = np.array([[0.1, 0.7, 0.1]])
        dark_red = np.array([[0.65, 0.08, 0.08]])
        de_far = delta_e00(rgb_to_lab(red), rgb_to_lab(green))[0]
        de_near = delta_e00(rgb_to_lab(red), rgb_to_lab(dark_red))[0]
        self.assertGreater(de_far, de_near)
        self.assertGreater(de_far, 20.0)

    def test_lab_white_and_black_endpoints(self):
        lab_white = rgb_to_lab(np.array([[1.0, 1.0, 1.0]]))[0]
        lab_black = rgb_to_lab(np.array([[0.0, 0.0, 0.0]]))[0]
        self.assertAlmostEqual(lab_white[0], 100.0, places=5)
        self.assertAlmostEqual(lab_black[0], 0.0, places=5)


class GamutTests(unittest.TestCase):
    def test_mask_and_stats(self):
        img = np.array(
            [
                [[0.5, 0.5, 0.5], [1.2, 0.5, 0.5]],
                [[0.5, -0.1, 0.5], [0.0, 1.0, 0.5]],
            ]
        )
        mask = gamut_mask(img)
        self.assertEqual(mask.sum(), 2)
        stats = gamut_stats(img)
        self.assertAlmostEqual(stats["out_of_gamut_fraction"], 0.5)
        self.assertAlmostEqual(stats["per_channel"][0]["over"], 0.25)
        self.assertAlmostEqual(stats["per_channel"][1]["under"], 0.25)


class SamplingTests(unittest.TestCase):
    def test_patch_stat_and_clamp(self):
        img = np.full((10, 10, 3), 0.5)
        img[2:5, 3:7, :] = 1.0
        st = patch_stat(img, Rect(3, 2, 4, 3))
        np.testing.assert_allclose(st.mean, 1.0)
        np.testing.assert_allclose(st.std, 0.0)
        self.assertEqual(st.n_pixels, 12)
        # 越界矩形会被夹回图像
        clamped = Rect(-5, -5, 100, 100).clamped(10, 10)
        self.assertEqual((clamped.x, clamped.y), (0, 0))
        self.assertEqual((clamped.w, clamped.h), (10, 10))

    def test_collect_means_pairs(self):
        rng = np.random.default_rng(1)
        images = {"ref": rng.random((20, 20, 3)), "src": rng.random((20, 20, 3))}
        s = Sample(id="s", name="s")
        s.rects = {"ref": Rect(0, 0, 5, 5), "src": Rect(5, 5, 5, 5)}
        X, Y, used, *_ = collect_means(images, [s], "ref", "src")
        self.assertEqual(len(used), 1)
        self.assertEqual(X.shape, (1, 3))


class ProjectAndEndToEndTests(unittest.TestCase):
    def test_full_pipeline_and_project_roundtrip(self):
        with tempfile.TemporaryDirectory() as d:
            project_path = generate_sample_project(d)
            reports = run_headless(project_path, os.path.join(d, "exports"))
            self.assertEqual(len(reports), 2)
            for rep in reports:
                # 处理后平均色差必须显著下降
                self.assertLess(rep.mean_delta_e_after, 1.0)
                self.assertLess(rep.mean_delta_e_after, rep.mean_delta_e_before)
                # 白点必须精确对齐
                white = next(e for e in rep.errors if e.sample_id == "s00")
                self.assertLess(white.delta_e_after, 1e-8)
                self.assertTrue(os.path.exists(rep.export_path))

            # 重开工程：采样位置、哈希、拟合参数都在
            reopened = Project.load(project_path)
            self.assertEqual(len(reopened.samples), 12)
            self.assertEqual(reopened.samples[0].rects["img_ref"], Rect(40, 80, 110, 110))
            self.assertEqual(set(reopened.fits), {"img_a", "img_b"})
            self.assertTrue(all(fp.white_locked for fp in reopened.fits.values()))

            # 重开后再跑一次，结果应可复现（同样的参数与色差）
            reports2 = run_headless(project_path, None)
            for r1, r2 in zip(reports, reports2):
                np.testing.assert_allclose(
                    np.asarray(r1.fit.M), np.asarray(r2.fit.M), atol=1e-12
                )
                self.assertAlmostEqual(
                    r1.mean_delta_e_after, r2.mean_delta_e_after, places=9
                )

    def test_image_io_roundtrip(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "x.png")
            img = np.random.default_rng(2).random((4, 5, 3))
            save_image_rgb(p, img)
            back = load_image_rgb(p)
            # 8 位存储，误差应小于一个量化级
            np.testing.assert_allclose(back, img, atol=1.5 / 255.0)

    def test_tampered_image_is_reported(self):
        with tempfile.TemporaryDirectory() as d:
            project_path = generate_sample_project(d)
            ref = os.path.join(d, "reference.png")
            img = load_image_rgb(ref)
            save_image_rgb(ref, img * 0.5)  # 改写图像使哈希失效
            from colormatch.pipeline import check_integrity, Project

            project = Project.load(project_path)
            problems = check_integrity(project, d)
            self.assertTrue(any("哈希不一致" in p for p in problems))


if __name__ == "__main__":
    unittest.main()
