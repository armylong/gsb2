"""关键数值验证（无需图形界面，CI 可跑）。

运行方式::

    python -m unittest discover -s tests -v

验证范围与容许误差
------------------
适用参数范围（与 distortion.SUPPORTED_RANGES 一致）：
    |k1| <= 1, |k2| <= 1, |p1| <= 0.2, |p2| <= 0.2，
    畸变中心在画幅内，归一化尺度 s = 画幅半对角线。

容许误差：
    * 坐标往返（Newton 反投）：单像素坐标误差 < 1e-6 px
    * 与 OpenCV projectPoints/undistort 交叉核对：坐标 < 1e-5 px，
      整图重映射 RMSE < 1.5 灰度级
    * 零参数：映射误差严格为 0，图像差 <= 1 灰度级（双线性取整）
    * 控制点拟合：径向两参数 |Δk| < 0.02，四参数 |Δ| < 0.01，
      拟合 RMSE < 0.5 px
    * 导出尺寸：与裁切矩形/原画幅严格相等（像素级，无容差）
"""

import json
import tempfile
import unittest
from pathlib import Path

import numpy as np
import cv2

from lens_corrector.distortion import (
    DistortionParams, norm_scale, project_pixels, unproject_pixels,
    project_normalized, unproject_normalized, build_undistort_map,
    build_distort_map, remap_image, valid_mask_from_map,
    check_stability, radial_monotonic_ok,
)
from lens_corrector.gridgen import make_sample, generate_grid
from lens_corrector.fitting import fit_distortion, check_points
from lens_corrector.cropping import (
    compute_valid_mask, valid_bounding_rect, largest_all_valid_rect,
)
from lens_corrector.export import export_corrected_image, build_record, export_record

SHAPE = (480, 640)
W, H = 640, 480


def sample_params() -> DistortionParams:
    return DistortionParams(k1=-0.28, k2=0.06, p1=0.010, p2=-0.015,
                            cx=W / 2, cy=H / 2)


def random_points(n: int, seed: int = 42) -> np.ndarray:
    rng = np.random.default_rng(seed)
    pts = np.empty((n, 2))
    pts[:, 0] = rng.uniform(20, W - 20, n)
    pts[:, 1] = rng.uniform(20, H - 20, n)
    return pts


class TestCoordinateRoundTrip(unittest.TestCase):
    """要求 3/其他要求：已知参数的坐标往返。"""

    def test_forward_backward_roundtrip(self):
        p = sample_params()
        pts = random_points(200)
        distorted = project_pixels(pts, SHAPE, p)
        restored, conv = unproject_pixels(distorted, SHAPE, p)
        self.assertTrue(np.all(conv), "支持范围内应全部收敛")
        err = np.linalg.norm(restored - pts, axis=1)
        self.assertLess(np.max(err), 1e-6,
                        f"反投误差过大：{np.max(err):.2e} px")

        # 反方向也核对一遍：畸变 -> 理想 -> 畸变
        back = project_pixels(restored, SHAPE, p)
        err2 = np.linalg.norm(back - distorted, axis=1)
        self.assertLess(np.max(err2), 1e-6)

    def test_normalized_roundtrip_extreme_corners(self):
        """画幅四角（r≈1）在支持范围内同样可往返。"""
        p = sample_params()
        corners = np.array([[0, 0], [W - 1, 0], [0, H - 1],
                            [W - 1, H - 1]], dtype=float)
        d = project_pixels(corners, SHAPE, p)
        r, conv = unproject_pixels(d, SHAPE, p)
        self.assertTrue(np.all(conv))
        self.assertLess(np.max(np.abs(r - corners)), 1e-6)

    def test_cross_check_opencv_projectpoints(self):
        """与成熟库 OpenCV 的 projectPoints 独立交叉核对正向模型。"""
        p = sample_params()
        s = norm_scale(SHAPE)
        pts = random_points(50)
        ours = project_pixels(pts, SHAPE, p)

        xn = (pts[:, 0] - p.cx) / s
        yn = (pts[:, 1] - p.cy) / s
        obj = np.zeros((len(pts), 3))
        obj[:, 0], obj[:, 1] = xn, yn
        K = np.array([[s, 0, p.cx], [0, s, p.cy], [0, 0, 1]])
        dist_vec = np.array([p.k1, p.k2, p.p1, p.p2])
        rvec = tvec = np.zeros((3, 1))
        cv_pts, _ = cv2.projectPoints(obj, rvec, tvec, K, dist_vec)
        cv_pts = cv_pts.reshape(-1, 2)
        self.assertLess(np.max(np.abs(ours - cv_pts)), 1e-5)

    def test_cross_check_opencv_undistort_image(self):
        """整图校正结果与 cv2.undistort 一致（同 K、同畸变向量）。"""
        sample = make_sample()
        p = sample.params
        s = norm_scale(sample.shape)
        K = np.array([[s, 0, p.cx], [0, s, p.cy], [0, 0, 1]])
        dist_vec = np.array([p.k1, p.k2, p.p1, p.p2])
        cv_corr = cv2.undistort(sample.dist_image, K, dist_vec, None, K)

        map_xy = build_undistort_map(sample.shape, p)
        ours = remap_image(sample.dist_image, map_xy)
        mask = valid_mask_from_map(map_xy, sample.shape)
        rmse = np.sqrt(np.mean(
            (ours[mask].astype(float) - cv_corr[mask].astype(float)) ** 2))
        self.assertLess(rmse, 1.5, f"与 OpenCV 校正 RMSE={rmse:.3f}")


class TestZeroParams(unittest.TestCase):
    """要求 2：零参数必须保持原图。"""

    def test_zero_mapping_identity(self):
        zero = DistortionParams(cx=W / 2, cy=H / 2)
        self.assertTrue(zero.is_zero())
        pts = random_points(100)
        d = project_pixels(pts, SHAPE, zero)
        np.testing.assert_allclose(d, pts, atol=1e-12)
        r, conv = unproject_pixels(pts, SHAPE, zero)
        self.assertTrue(np.all(conv))
        np.testing.assert_allclose(r, pts, atol=1e-12)

        x, y = unproject_normalized(np.array([0.3, -0.7]),
                                    np.array([0.9, 0.2]), zero)[:2]
        np.testing.assert_allclose(x, [0.3, -0.7], atol=1e-12)
        np.testing.assert_allclose(y, [0.9, 0.2], atol=1e-12)

    def test_zero_remap_keeps_image(self):
        ref, _ = generate_grid()
        zero = DistortionParams(cx=W / 2, cy=H / 2)
        out = remap_image(ref, build_undistort_map(ref.shape, zero))
        self.assertLessEqual(int(np.max(np.abs(out.astype(int)
                                               - ref.astype(int)))), 1)
        # 生成畸变图用的反向映射在零参数下同样是恒等
        dmap, conv = build_distort_map(ref.shape, zero)
        self.assertTrue(np.all(conv))
        np.testing.assert_allclose(dmap[..., 0],
                                   np.mgrid[0:H, 0:W][1], atol=1e-6)


class TestSampleGeneration(unittest.TestCase):
    """要求 1：样例尺寸、真实参数与有效掩膜。"""

    def test_sample_keeps_size_and_truth(self):
        sample = make_sample()
        self.assertEqual(sample.ref_image.shape[:2], SHAPE)
        self.assertEqual(sample.dist_image.shape[:2], SHAPE)
        self.assertEqual(sample.params, sample_params())
        # 桶形畸变下畸变图边缘为黑（无对应源像素），内部仍有效
        self.assertGreater(np.mean(sample.valid_mask), 0.65)
        diff = np.mean(np.abs(sample.dist_image[sample.valid_mask].astype(int)
                              - sample.ref_image[sample.valid_mask].astype(int)))
        self.assertGreater(diff, 0.5)

    def test_undistort_recovers_grid(self):
        """用真实参数校正后，弯曲网格线应恢复为直线（几何级验证）。

        畸变图与校正图各做一次双线性重采样，灰度 RMSE 会被线边缘
        抗锯齿放大，因此这里测量每条竖直网格线的亚像素中心位置，
        校正后沿 v 方向其 u 坐标应恒定（直线），偏差 < 0.5px。
        """
        sample = make_sample()
        p = sample.params
        # 坐标级核对：参考交点 -> 畸变 -> 反投，应精确回到原交点
        inter = sample.meta.intersections()
        distorted = project_pixels(inter, sample.shape, p)
        restored, conv = unproject_pixels(distorted, sample.shape, p)
        self.assertTrue(np.all(conv))
        self.assertLess(np.max(np.abs(restored - inter)), 1e-6)

        map_xy = build_undistort_map(sample.shape, p)
        corrected = remap_image(sample.dist_image, map_xy)
        gray = cv2.cvtColor(corrected, cv2.COLOR_BGR2GRAY).astype(float)
        gray_ref = cv2.cvtColor(
            sample.ref_image, cv2.COLOR_BGR2GRAY).astype(float)
        h, w = gray.shape
        spacing = sample.meta.spacing

        def line_fit_residual(image_gray: np.ndarray) -> float:
            """对每条竖直线做亚像素追踪并拟合直线，返回最大拟合残差。

            残差包含横线交点处的测量噪声，因此理想原图本身也非零；
            校正图与原图取同量级即说明几何上已恢复直线。
            """
            vs = np.arange(25, h - 25)
            worst = 0.0
            for u0 in range(spacing, w, spacing):
                centers = np.full(len(vs), np.nan)
                for k, v in enumerate(vs):
                    lo, hi = max(u0 - 5, 0), min(u0 + 6, w)
                    xs = np.arange(lo, hi, dtype=float)
                    band = np.maximum(255.0 - image_gray[v, lo:hi], 0.0)
                    if band.sum() < 50:
                        continue
                    centers[k] = (xs * band).sum() / band.sum()
                m = ~np.isnan(centers)
                if m.sum() < 20:
                    continue
                slope, intercept = np.polyfit(vs[m], centers[m], 1)
                resid = np.abs(centers[m]
                               - (slope * vs[m] + intercept))
                worst = max(worst, float(resid.max()))
            return worst

        dev_corr = line_fit_residual(gray)
        dev_ref = line_fit_residual(gray_ref)
        # 校正图直线度与理想原图同量级（差 < 0.5px），证明弯曲已消除
        self.assertLess(abs(dev_corr - dev_ref), 0.5,
                        f"校正后直线残差 {dev_corr:.3f}px 与原图 "
                        f"{dev_ref:.3f}px 差异过大")
        self.assertEqual(corrected.shape, sample.ref_image.shape)


class TestJacobian(unittest.TestCase):
    """拟合雅可比的有限差分回归测试（防止行顺序/符号错误复发）。"""

    def test_analytic_jacobian_matches_finite_difference(self):
        from lens_corrector.fitting import _analytic_jacobian
        p = sample_params()
        rng = np.random.default_rng(0)
        n = 7
        tn = np.column_stack([
            rng.uniform(-0.7, 0.7, n), rng.uniform(-0.5, 0.5, n)])
        obsx, obsy = project_normalized(tn[:, 0], tn[:, 1], p)
        obs = np.column_stack([obsx, obsy])

        def residual(theta, mode):
            pp = DistortionParams(
                k1=theta[0], k2=theta[1],
                p1=theta[2] if mode == "full" else 0.0,
                p2=theta[3] if mode == "full" else 0.0,
                cx=p.cx, cy=p.cy)
            xd, yd = project_normalized(tn[:, 0], tn[:, 1], pp)
            r = np.column_stack([xd, yd]) - obs
            return np.concatenate([r[:, 0], r[:, 1]])

        for mode, m in (("radial", 2), ("full", 4)):
            theta = np.array([p.k1, p.k2, p.p1, p.p2][:m])
            ja = _analytic_jacobian(tn, p, mode)
            jn = np.zeros_like(ja)
            eps = 1e-7
            for k in range(m):
                e = np.zeros(m)
                e[k] = eps
                jn[:, k] = ((residual(theta + e, mode)
                             - residual(theta - e, mode)) / (2 * eps))
            self.assertLess(np.max(np.abs(ja - jn)), 1e-7,
                            f"{mode} 雅可比与有限差分不符")


class TestControlPointFitting(unittest.TestCase):
    """要求 4/5：已知样例的控制点拟合与失败提示。"""

    def _make_points(self, n: int, p: DistortionParams, seed: int = 7):
        """多半径、多角度分散的合成控制点（半径 0.25~0.85 归一化）。"""
        sample = make_sample(params=p)
        s = norm_scale(sample.shape)
        rng = np.random.default_rng(seed)
        ang = rng.uniform(0, 2 * np.pi, n)
        rad = np.linspace(0.25, 0.85, n)
        targets = np.column_stack(
            [p.cx + s * rad * np.cos(ang),
             p.cy + s * rad * np.sin(ang)])
        observed = project_pixels(targets, sample.shape, p)
        return sample, targets, observed

    def test_fit_radial_recovers_k(self):
        # 纯径向真值：两参数模型可精确拟合
        p = DistortionParams(k1=-0.28, k2=0.06, cx=W / 2, cy=H / 2)
        sample, targets, observed = self._make_points(6, p)
        res = fit_distortion(targets, observed, sample.shape,
                             center=(p.cx, p.cy), mode="radial")
        self.assertTrue(res.ok, res.message)
        self.assertLess(abs(res.params.k1 - p.k1), 0.02)
        self.assertLess(abs(res.params.k2 - p.k2), 0.02)
        self.assertLess(res.rmse_px, 0.5)
        self.assertEqual(len(res.distances_px), 6)

    def test_fit_full_recovers_all_four(self):
        p = sample_params()
        sample, targets, observed = self._make_points(8, p)
        res = fit_distortion(targets, observed, sample.shape,
                             center=(p.cx, p.cy), mode="full")
        self.assertTrue(res.ok, res.message)
        for name, truth in (("k1", p.k1), ("k2", p.k2),
                            ("p1", p.p1), ("p2", p.p2)):
            self.assertLess(abs(getattr(res.params, name) - truth), 0.01,
                            f"{name} 恢复偏差过大")
        self.assertLess(res.rmse_px, 0.5)

    def test_radial_mode_on_decentered_data_reports_residual(self):
        """数据含偏心却只拟合径向：最佳径向拟合应留下可查的非零残差，
        且残差明显大于 full 模式（证明偏心项无法被径向项吸收）。"""
        p = sample_params()
        sample, targets, observed = self._make_points(8, p)
        r_rad = fit_distortion(targets, observed, sample.shape,
                               center=(p.cx, p.cy), mode="radial")
        r_full = fit_distortion(targets, observed, sample.shape,
                                center=(p.cx, p.cy), mode="full")
        self.assertTrue(r_full.ok)
        self.assertLess(r_full.rmse_px, 0.5)
        # 径向模型留下像素级系统残差，full 模型接近零
        self.assertGreater(r_rad.rmse_px, 1.0)
        self.assertGreater(r_rad.rmse_px, 10 * r_full.rmse_px + 1e-9)

    def test_refit_matches_current_points(self):
        """调整点位后重新拟合，结果对当前控制点的残差应极小。"""
        p = DistortionParams(k1=-0.28, k2=0.06, cx=W / 2, cy=H / 2)
        sample, targets, observed = self._make_points(6, p)
        rng = np.random.default_rng(11)
        observed = observed + rng.normal(0, 0.5, observed.shape)
        res = fit_distortion(targets, observed, sample.shape,
                             center=(p.cx, p.cy), mode="radial")
        self.assertTrue(res.ok, res.message)
        # 用拟合参数重新投影，核对残差表与当前点一致
        proj = project_pixels(targets, sample.shape, res.params)
        rmse = np.sqrt(np.mean(np.sum((proj - observed) ** 2, axis=1)))
        self.assertAlmostEqual(rmse, res.rmse_px, places=6)

    def test_insufficient_points_rejected(self):
        p = sample_params()
        pts = np.array([[100.0, 100.0], [500.0, 100.0], [300.0, 300.0]])
        obs = project_pixels(pts, SHAPE, p)
        res = fit_distortion(pts, obs, SHAPE, (p.cx, p.cy), "full")
        self.assertFalse(res.ok)
        self.assertIn("至少需要", res.message)
        ok, msg = check_points(pts[:2], "radial")
        self.assertFalse(ok)

    def test_collinear_and_clustered_rejected(self):
        p = sample_params()
        # 共线点
        pts = np.array([[100.0, 240.0], [200.0, 240.0], [300.0, 240.0],
                        [400.0, 240.0]])
        obs = project_pixels(pts, SHAPE, p)
        res = fit_distortion(pts, obs, SHAPE, (p.cx, p.cy), "radial")
        self.assertFalse(res.ok)
        self.assertTrue("共线" in res.message or "分布" in res.message)

        # 各方向都有展布但近似共线（斜线），应被共线/协方差判定拦下
        pts_line = np.array([[120.0 + 80 * i, 120.0 + 60 * i]
                             for i in range(4)])
        obs_line = project_pixels(pts_line, SHAPE, p)
        res_line = fit_distortion(pts_line, obs_line, SHAPE,
                                  (p.cx, p.cy), "radial")
        self.assertFalse(res_line.ok)
        self.assertTrue("共线" in res_line.message
                        or "分布" in res_line.message)

        # 过度集中的点
        pts2 = np.array([[318.0, 238.0], [320.0, 239.0], [322.0, 240.0],
                         [319.0, 241.0]])
        obs2 = project_pixels(pts2, SHAPE, p)
        res2 = fit_distortion(pts2, obs2, SHAPE, (p.cx, p.cy), "radial")
        self.assertFalse(res2.ok)
        self.assertIn("分布", res2.message)


class TestCroppingAndValidity(unittest.TestCase):
    """要求 6：越界区域、裁切矩形与稳定性提示。"""

    def test_strong_distortion_has_invalid_region(self):
        # 强枕形（k1>0）校正时边缘采样点跑到畸变图外，产生越界区
        strong = DistortionParams(k1=0.85, k2=0.1, cx=W / 2, cy=H / 2)
        mask = compute_valid_mask(SHAPE, strong)
        self.assertLess(np.mean(mask), 0.98, "强枕形畸变应产生越界区")
        bbox = valid_bounding_rect(mask)
        rect = largest_all_valid_rect(mask)
        self.assertIsNotNone(rect)
        # 裁切矩形内全部有效，且确实裁掉了边缘
        self.assertTrue(np.all(mask[rect.y:rect.bottom,
                                   rect.x:rect.right]))
        self.assertLess(rect.width * rect.height, W * H)
        self.assertGreaterEqual(bbox.x, 0)
        self.assertLessEqual(bbox.right, W)

    def test_barrel_distortion_distorted_image_has_black_border(self):
        # 强桶形（k1<0）时畸变图自身边缘没有对应源像素，应标记无效
        strong = DistortionParams(k1=-0.85, k2=0.1, cx=W / 2, cy=H / 2)
        dmap, converged = build_distort_map(SHAPE, strong)
        mask = valid_mask_from_map(dmap, SHAPE) & converged
        self.assertLess(np.mean(mask), 0.98)
        rect = largest_all_valid_rect(mask)
        self.assertIsNotNone(rect)
        self.assertTrue(np.all(mask[rect.y:rect.bottom,
                                   rect.x:rect.right]))

    def test_mild_params_fully_valid(self):
        mask = compute_valid_mask(SHAPE, sample_params())
        rect = largest_all_valid_rect(mask)
        self.assertEqual((rect.x, rect.y, rect.width, rect.height),
                         (0, 0, W, H))

    def test_unstable_params_warn(self):
        # 径向函数出现极值（强 k1），单调性检查应失败
        bad = DistortionParams(k1=-3.0, cx=W / 2, cy=H / 2)
        self.assertFalse(radial_monotonic_ok(bad))
        report = check_stability(SHAPE, bad)
        self.assertFalse(report.ok)
        self.assertTrue(len(report.warnings) >= 1)
        # 支持范围内的温和参数通过
        self.assertTrue(check_stability(SHAPE, sample_params()).ok)


class TestExport(unittest.TestCase):
    """要求 7：导出像素尺寸、记录内容与预览一致。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.out = Path(self.tmp.name)
        self.sample = make_sample()
        p = self.sample.params
        self.map_xy = build_undistort_map(self.sample.shape, p)
        self.corrected = remap_image(self.sample.dist_image, self.map_xy)
        self.mask = valid_mask_from_map(self.map_xy, self.sample.shape)

    def tearDown(self):
        self.tmp.cleanup()

    def test_full_export_size_and_black_pixels(self):
        path = self.out / "full.png"
        w, h = export_corrected_image(
            path, self.corrected, self.mask, None, "full")
        self.assertEqual((w, h), (W, H))  # 与原画幅严格一致
        written = cv2.imread(str(path))
        self.assertEqual(written.shape[:2], SHAPE)
        # 越界位置必须为黑，有效位置不是全黑
        self.assertTrue(np.all(written[~self.mask] == 0))
        self.assertGreater(written[self.mask].sum(), 0)

    def test_cropped_export_matches_rect(self):
        rect = largest_all_valid_rect(self.mask)
        path = self.out / "crop.png"
        w, h = export_corrected_image(
            path, self.corrected, self.mask, rect, "crop")
        self.assertEqual((w, h), (rect.width, rect.height))
        written = cv2.imread(str(path))
        self.assertEqual(written.shape[0], rect.height)
        self.assertEqual(written.shape[1], rect.width)

    def test_record_contents(self):
        rect = largest_all_valid_rect(self.mask)
        record = build_record(
            source_name="generated_sample", source_size=(W, H),
            params=self.sample.params, norm_s=norm_scale(SHAPE),
            control_points=[{"index": 0,
                             "target_uv_px": [160.0, 120.0],
                             "observed_uv_px": [158.1, 119.4]}],
            fit_mode="radial", fit_summary={"rmse_px": 0.21},
            crop_mode="crop", crop=rect,
            export_size=(rect.width, rect.height))
        jpath = self.out / "record.json"
        export_record(jpath, record)
        loaded = json.loads(jpath.read_text(encoding="utf-8"))
        self.assertEqual(loaded["distortion_model"]["k1"],
                         self.sample.params.k1)
        self.assertEqual(loaded["crop"]["export_size_wh"],
                         [rect.width, rect.height])
        self.assertEqual(loaded["control_points"][0]["index"], 0)
        self.assertIn("coordinate_system", loaded["source"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
