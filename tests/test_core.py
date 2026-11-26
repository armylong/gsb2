"""核心逻辑的本地测试: .venv/bin/python -m unittest discover -s tests -v"""
import math
import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from lenticular_tool import core  # noqa: E402
from lenticular_tool.params import LensParams, ProjectFile, ViewSource  # noqa: E402


class TestPhaseAndInterlace(unittest.TestCase):
    def test_integer_period_exact_cycle(self):
        p = LensParams(lpi=100, dpi=300)  # P=3
        s = core.slice_map(4, 1200, 3, core.effective_pitch(p, 1200), p)
        expected = np.tile([0, 1, 2], 400).reshape(1, -1).repeat(4, axis=0)
        np.testing.assert_array_equal(s, expected)

    def test_right_side_uses_global_phase_no_drift(self):
        # 非整除周期: 末列必须等于一次性全局公式, 而不是整数累加结果
        p = LensParams(lpi=80, dpi=280)  # P=3.5
        W, H = 1201, 3
        P = core.effective_pitch(p, W)
        s = core.slice_map(H, W, 2, P, p)
        u = core.phase_at(W - 0.5, 0.5, H, P, p)
        expect = min(int(math.floor((u - math.floor(u)) * 2)), 1)
        self.assertEqual(int(s[0, -1]), expect)
        # 每一行(无倾角)完全相同
        np.testing.assert_array_equal(s[0], s[1])

    def test_right_edge_lock(self):
        p = LensParams(lpi=75, dpi=300, fit_right_edge=True,
                       right_edge_phase=0.37)
        W, H = 1200, 800
        P = core.effective_pitch(p, W)
        ph = core.phase_at(float(W), core.pivot_y(H, p), H, P, p) % 1.0
        self.assertAlmostEqual(ph, 0.37, places=9)

    def test_whole_periods_lock_makes_head_tail_in_phase(self):
        p = LensParams(lpi=75.3, dpi=300, whole_periods=True)
        W, H = 1200, 800
        P = core.effective_pitch(p, W)
        ep = core.edge_phases(H, W, P, p)
        diff = abs(ep["left_edge"] - ep["right_edge"])
        diff = min(diff, 1 - diff)
        self.assertLess(diff, 1e-9)
        self.assertAlmostEqual(W / P, round(W / (300 / 75.3)))

    def test_offset_half_pixel(self):
        p = LensParams(lpi=100, dpi=300, offset_px=0.5)
        P = core.effective_pitch(p, 1200)
        u = core.phase_at(0.5, 0.5, 1, P, p)
        self.assertLess(abs(u - round(u)), 1e-9)

    def test_tilt_pivot_and_drift(self):
        p = LensParams(angle_deg=0.5, pivot_frac=0.0)
        H, P = 800, 4.0
        u_top = core.phase_at(500.5, core.pivot_y(H, p), H, P, p)
        u_ref = (500.5 - p.offset_px) / P
        self.assertAlmostEqual(u_top, u_ref, places=9)
        drift = ((H - 0.5 - core.pivot_y(H, p))
                 * math.tan(math.radians(0.5)) / P)
        u_bot = core.phase_at(500.5, H - 0.5, H, P, p)
        self.assertAlmostEqual(u_ref - u_bot, drift, places=9)

    def test_interlace_pixel_provenance(self):
        rng = np.random.default_rng(42)
        H, W = 64, 90
        views = [rng.integers(0, 256, (H, W, 4), np.uint8) for _ in range(4)]
        p = LensParams(lpi=90, dpi=300, order=(2, 0, 3, 1))
        P = core.effective_pitch(p, W)
        assign = core.assignment_map(H, W, 4, P, p)
        out = core.interlace(views, p, pitch=P)
        for vid in range(4):
            m = assign == vid
            np.testing.assert_array_equal(out[m], views[vid][m])

    def test_order_reversal(self):
        p1 = LensParams(order=(0, 1, 2, 3))
        p2 = LensParams(order=(3, 2, 1, 0))
        a = core.assignment_map(10, 90, 4, 3.0, p1)
        b = core.assignment_map(10, 90, 4, 3.0, p2)
        np.testing.assert_array_equal(b, 3 - a)

    def test_half_pixel_boundary_snap_deterministic(self):
        # offset=0.5 时多条分界线正好压像素中心, 不能出现浮点 floor 毛刺
        p = LensParams(lpi=100, dpi=300, offset_px=0.5)
        a = core.assignment_map(1, 300, 3, 3.0, p)[0]
        np.testing.assert_array_equal(a, np.tile([0, 1, 2], 100))

    def test_segment_counts_consistent(self):
        H, W = 200, 300
        p = LensParams(lpi=100, dpi=300)  # P=3
        P = 3.0
        assign = core.assignment_map(H, W, 3, P, p)
        stat = core.analyze_segment(assign, p, P, (30, 40, 90, 160))
        self.assertGreater(stat.total, 0)
        self.assertEqual(sum(stat.counts), stat.total)
        # P=3 三视图 -> 每根镜条每一行各视角恰好 1 像素
        self.assertEqual(stat.counts, [120, 120, 120])

    def test_observer_weights_normalized_and_pure(self):
        p = LensParams(eye_phase=1 / 6, eye_width_slices=0.1)
        w = core.observer_weights(np.array([0.5, 400.0]), 800, 3, 4.0, p)
        np.testing.assert_allclose(w.sum(axis=1), 1.0, atol=1e-12)
        self.assertGreater(w[0, 0], 0.99)

    def test_observer_weights_no_black_rows_under_large_drift(self):
        # 大倾角 / 远端漂移很多个周期时, 每一行仍必须有合法权重
        p = LensParams(angle_deg=3.0, pivot_frac=1.0, eye_phase=0.99,
                       eye_width_slices=1.2)
        y = np.arange(800, dtype=float) + 0.5
        w = core.observer_weights(y, 800, 4, 6.667, p)
        np.testing.assert_allclose(w.sum(axis=1), 1.0, atol=1e-10)
        self.assertTrue(np.all(w >= 0))

    def test_preview_quality_does_not_change_native_output(self):
        # 缩略图可以缩小, 但 interlace 永远是输入原尺寸
        rng = np.random.default_rng(1)
        views = [rng.integers(0, 256, (800, 1200, 4), np.uint8) for _ in range(3)]
        p = LensParams()
        out = core.interlace(views, p)
        self.assertEqual(out.shape, (800, 1200, 4))
        small_a = [v[::4, ::4] for v in views]
        prev_a = core.compose_preview(small_a, 800, p, 4.0)
        small_b = [v[::2, ::2] for v in views]
        prev_b = core.compose_preview(small_b, 800, p, 4.0)
        self.assertEqual(prev_a.shape[1] * 4, 1200)
        self.assertEqual(prev_b.shape[1] * 2, 1200)
        # 两种清晰度下输出交错图是同一个数组
        np.testing.assert_array_equal(out, core.interlace(views, p))


class TestProjectJson(unittest.TestCase):
    def test_roundtrip(self, tmp_path=None):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "proj.json"
            pf = ProjectFile(
                params=LensParams(lpi=88.5, angle_deg=0.4, order=(2, 0, 1)),
                views=[ViewSource(sample_index=0), ViewSource(kind="file",
                                                              path="a.png")],
                preview_max_side=900)
            pf.save_json(path)
            pf2 = ProjectFile.load_json(path)
            self.assertAlmostEqual(pf2.params.lpi, 88.5)
            self.assertAlmostEqual(pf2.params.angle_deg, 0.4)
            self.assertEqual(pf2.params.order, (2, 0, 1))
            self.assertEqual(pf2.preview_max_side, 900)
            self.assertEqual(len(pf2.views), 2)


if __name__ == "__main__":
    unittest.main()
