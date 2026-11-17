"""关键点插值与边界限制的纯逻辑测试（不依赖 ffmpeg）。"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from framer.keyframes import (
    KeyframeError, build_x_expression, clamp_x, crop_size,
    default_keyframes, interpolate, normalize_keyframes,
)

DW, DH = 1280, 720
CROP_W, CROP_H = crop_size(DW, DH)  # 404 x 720（向下取偶数）
UPPER = DW - CROP_W                 # 876


class TestCropSize(unittest.TestCase):
    def test_is_nine_sixteen_full_height(self):
        self.assertEqual(CROP_H, 720)
        self.assertAlmostEqual(CROP_W / CROP_H, 9 / 16, delta=0.005)
        self.assertEqual(CROP_W % 2, 0)

    def test_too_narrow_rejected(self):
        with self.assertRaises(KeyframeError):
            crop_size(100, 720)


class TestClamp(unittest.TestCase):
    def test_clamp_bounds(self):
        self.assertEqual(clamp_x(-50, DW, CROP_W), 0)
        self.assertEqual(clamp_x(UPPER + 999, DW, CROP_W), UPPER)
        self.assertEqual(clamp_x(300, DW, CROP_W), 300)

    def test_default_centered(self):
        kf = default_keyframes(DW, CROP_W)[0]
        self.assertEqual(kf["t"], 0.0)
        self.assertAlmostEqual(kf["x"], (DW - CROP_W) / 2, delta=1)


class TestNormalize(unittest.TestCase):
    def test_sorts_and_clamps(self):
        raw = [{"t": 4, "x": 5000}, {"t": 1, "x": -90}]
        out = normalize_keyframes(raw, 6.0, DW, CROP_W)
        self.assertEqual([k["t"] for k in out], [1.0, 4.0])
        self.assertEqual(out[0]["x"], 0)
        self.assertEqual(out[1]["x"], UPPER)

    def test_reject_empty(self):
        with self.assertRaises(KeyframeError):
            normalize_keyframes([], 6.0, DW, CROP_W)

    def test_reject_duplicate_time(self):
        with self.assertRaises(KeyframeError):
            normalize_keyframes(
                [{"t": 1, "x": 0}, {"t": 1, "x": 10}], 6.0, DW, CROP_W)

    def test_reject_out_of_range(self):
        with self.assertRaises(KeyframeError):
            normalize_keyframes([{"t": 9, "x": 0}], 6.0, DW, CROP_W)
        with self.assertRaises(KeyframeError):
            normalize_keyframes([{"t": -0.1, "x": 0}], 6.0, DW, CROP_W)


class TestInterpolation(unittest.TestCase):
    KFS = [{"t": 0, "x": 0}, {"t": 2, "x": 200}, {"t": 4, "x": 0}]

    def test_endpoint_hold(self):
        # 关键点之外保持端点值，不外推
        self.assertEqual(interpolate(self.KFS, -1, DW, CROP_W), 0)
        self.assertEqual(interpolate(self.KFS, 5.5, DW, CROP_W), 0)

    def test_linear_midpoint(self):
        v = interpolate(self.KFS, 1.0, DW, CROP_W, "linear")
        self.assertEqual(v, 100)
        v = interpolate(self.KFS, 3.0, DW, CROP_W, "linear")
        self.assertEqual(v, 100)

    def test_linear_continuous_at_keypoints(self):
        # 关键点处左右极限相等，保证不跳变
        for t in (0.0, 2.0, 4.0):
            a = interpolate(self.KFS, t - 0.001, DW, CROP_W, "linear")
            b = interpolate(self.KFS, t + 0.001, DW, CROP_W, "linear")
            self.assertLessEqual(abs(a - b), 1, f"t={t} 附近不连续")

    def test_smoothstep_endpoint_velocity_zero(self):
        # smoothstep 在关键点处斜率≈0，段中单调推进
        v0 = interpolate(self.KFS, 0.0, DW, CROP_W, "smoothstep")
        v_near = interpolate(self.KFS, 0.05, DW, CROP_W, "smoothstep")
        self.assertLess(v_near - v0, 6)  # 起步缓慢
        mid = interpolate(self.KFS, 1.0, DW, CROP_W, "smoothstep")
        self.assertEqual(mid, 100)       # 中点与线性一致
        # 单调
        prev = -1
        for i in range(21):
            v = interpolate(self.KFS, i * 0.1, DW, CROP_W, "smoothstep")
            self.assertGreaterEqual(v, prev)
            prev = v

    def test_result_always_in_bounds(self):
        kfs = [{"t": 0, "x": -100}, {"t": 1, "x": 99999}]
        for i in range(50):
            x = interpolate(kfs, i * 0.02, DW, CROP_W, "linear")
            self.assertGreaterEqual(x, 0)
            self.assertLessEqual(x, UPPER)

    def test_single_keyframe_constant(self):
        kfs = [{"t": 1.5, "x": 333}]
        self.assertEqual(interpolate(kfs, 0, DW, CROP_W), 333)
        self.assertEqual(interpolate(kfs, 9, DW, CROP_W), 333)


class TestExpression(unittest.TestCase):
    def test_single_kf_expression_is_constant(self):
        expr = build_x_expression([{"t": 0, "x": 100}], DW, CROP_W)
        self.assertTrue(expr.startswith("clip(") and expr.endswith(f"\\,0\\,{UPPER})"))

    def test_expression_clipped(self):
        expr = build_x_expression(
            [{"t": 0, "x": 0}, {"t": 1, "x": UPPER}], DW, CROP_W, "linear")
        self.assertIn("if(lt(t\\,", expr)
        self.assertTrue(expr.startswith("clip(") and expr.endswith(f"\\,0\\,{UPPER})"))

    def test_expressions_match_for_both_easings(self):
        kfs = [{"t": 0, "x": 10}, {"t": 2, "x": 400}, {"t": 5, "x": 20}]
        e1 = build_x_expression(kfs, DW, CROP_W, "linear")
        e2 = build_x_expression(kfs, DW, CROP_W, "smoothstep")
        self.assertNotEqual(e1, e2)
        self.assertIn("clip((t-0.000)/2.000000\\,0\\,1)", e2)


if __name__ == "__main__":
    unittest.main()
