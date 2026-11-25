"""核心管线无头测试: 不启动 Qt, 直接验证 numpy 合成语义与可复现性。"""

import json
import os
import sys
import tempfile
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from light_recombine.channels import ChannelSet, LoadedChannel, LoadStatus
from light_recombine.composite import (
    DisplayParams,
    ParamState,
    compute_composite,
    display_image,
    encode_srgb8,
    linear_to_srgb,
    probe_pixel,
    tonemap,
)
from light_recombine.example_scene import (
    PROBE_DIFFUSE_ONLY,
    PROBE_SPEC_HOT,
    PROBE_ZERO_BASE,
    build_example_scene,
)
from light_recombine.io_npy import (
    load_channels,
    load_params,
    save_channel_npy,
    save_params,
)
from light_recombine.io_png import write_png_rgb8


def example_channel_set() -> ChannelSet:
    scene = build_example_scene()
    return ChannelSet(channels={
        name: LoadedChannel(name, LoadStatus.OK, data=scene[name])
        for name in scene
    })


class TestExampleScene(unittest.TestCase):
    def setUp(self):
        self.scene = build_example_scene()
        self.cs = example_channel_set()

    def test_shapes_and_dtype(self):
        for name, arr in self.scene.items():
            self.assertEqual(arr.shape, (256, 256, 3))
            self.assertEqual(arr.dtype, np.float32)

    def test_probe_points_match_their_claims(self):
        zx, zy = PROBE_ZERO_BASE
        self.assertTrue(np.all(self.scene["base"][zy, zx] == 0.0))
        self.assertGreater(self.scene["emission"][zy, zx].max(), 1.0)

        hx, hy = PROBE_SPEC_HOT
        self.assertGreater(self.scene["specular"][hy, hx].max(), 4.0)

        dx, dy = PROBE_DIFFUSE_ONLY
        self.assertGreater(self.scene["diffuse"][dy, dx].max(), 0.5)
        self.assertEqual(self.scene["specular"][dy, dx].max(), 0.0)
        self.assertEqual(self.scene["emission"][dy, dx].max(), 0.0)


class TestCompositeSemantics(unittest.TestCase):
    def setUp(self):
        self.cs = example_channel_set()

    def test_default_composite_is_plain_sum(self):
        res = compute_composite(self.cs, ParamState(), DisplayParams())
        expected = sum(self.cs.channels[n].data
                       for n in ("base", "emission", "diffuse", "specular"))
        np.testing.assert_allclose(res.linear, expected, rtol=1e-6)
        # 无截断: 线性结果保留 >1 的值
        self.assertGreater(res.linear.max(), 1.0)

    def test_suppress_specular_keeps_diffuse_intact(self):
        """核心验收: 只压镜面 (倍率 0), 漫反射逐像素不变。"""
        p = ParamState()
        p.multipliers["specular"] = 0.0
        res = compute_composite(self.cs, p, DisplayParams())

        np.testing.assert_array_equal(
            res.contributions["specular"],
            np.zeros_like(res.contributions["specular"]))
        np.testing.assert_allclose(
            res.contributions["diffuse"],
            self.cs.channels["diffuse"].data, rtol=1e-6)
        # 合成结果 == base + emission + diffuse, 与镜面完全无关
        expected = (self.cs.channels["base"].data
                    + self.cs.channels["emission"].data
                    + self.cs.channels["diffuse"].data)
        np.testing.assert_allclose(res.linear, expected, rtol=1e-6)

    def test_scale_one_light_only(self):
        p = ParamState()
        p.multipliers["diffuse"] = 0.4
        res = compute_composite(self.cs, p, DisplayParams())
        np.testing.assert_allclose(
            res.contributions["diffuse"],
            self.cs.channels["diffuse"].data * 0.4, rtol=1e-6)
        np.testing.assert_allclose(
            res.contributions["specular"],
            self.cs.channels["specular"].data, rtol=1e-6)

    def test_solo_isolates_one_channel(self):
        p = ParamState()
        p.solo["specular"] = True
        res = compute_composite(self.cs, p, DisplayParams())
        np.testing.assert_allclose(
            res.linear, self.cs.channels["specular"].data, rtol=1e-6)
        self.assertTrue(res.included["specular"])
        self.assertFalse(res.included["diffuse"])

    def test_highlights_not_clipped_before_tonemap(self):
        """镜面热点在 linear/exposed 阶段必须保留原值, 只有显示阶段才压缩。"""
        res = compute_composite(self.cs, ParamState(), DisplayParams())
        hx, hy = PROBE_SPEC_HOT
        self.assertGreater(res.linear[hy, hx].max(), 4.0)
        self.assertGreater(res.exposed[hy, hx].max(), 4.0)
        self.assertLessEqual(res.tonemapped[hy, hx].max(), 1.0)
        self.assertEqual(res.srgb8.dtype, np.uint8)
        self.assertLessEqual(res.srgb8.max(), 255)

    def test_exposure_scales_linear_value(self):
        d0 = DisplayParams(exposure_ev=0.0)
        d1 = DisplayParams(exposure_ev=2.0)
        r0 = compute_composite(self.cs, ParamState(), d0)
        r1 = compute_composite(self.cs, ParamState(), d1)
        np.testing.assert_allclose(r1.exposed, r0.exposed * 4.0, rtol=1e-6)

    def test_tonemap_modes_in_range(self):
        x = np.array([[[-2.0, 0.0, 0.5, 4.0, 100.0]]], np.float32)
        for mode in ("clip", "aces"):
            y = tonemap(x, mode)
            self.assertTrue(np.all(y >= 0.0) and np.all(y <= 1.0), mode)
        # 对称 Reinhard: 非负值压到 [0,1), 负值保留为负供核对
        y = tonemap(x, "reinhard")
        self.assertTrue(np.all(y[x >= 0] >= 0.0)
                        and np.all(y[x >= 0] < 1.0))
        self.assertTrue(np.all(y[x < 0] < 0.0))
        # clip 直接截断, reinhard 保留层次
        self.assertEqual(tonemap(x, "clip")[0, 0, -1], 1.0)
        self.assertLess(tonemap(x, "reinhard")[0, 0, -1], 1.0)

    def test_srgb_encoding_known_points(self):
        np.testing.assert_allclose(
            linear_to_srgb(np.zeros(1, np.float32)), [0.0], atol=1e-6)
        np.testing.assert_allclose(
            linear_to_srgb(np.ones(1, np.float32)), [1.0], atol=1e-6)
        u8 = encode_srgb8(np.ones((1, 1, 3), np.float32))
        np.testing.assert_array_equal(u8, np.full((1, 1, 3), 255, np.uint8))


class TestProbe(unittest.TestCase):
    def setUp(self):
        self.cs = example_channel_set()

    def test_probe_zero_base_pixel(self):
        rep = probe_pixel(self.cs, ParamState(), DisplayParams(),
                          *PROBE_ZERO_BASE)
        self.assertTrue(rep.inside)
        np.testing.assert_array_equal(rep.rows["base"]["raw"],
                                      np.zeros(3, np.float32))
        self.assertGreater(rep.rows["emission"]["raw"].max(), 1.0)
        # 各路贡献之和等于总值
        total = sum(rep.rows[n]["scaled"] for n in rep.rows
                    if rep.rows[n]["included"])
        np.testing.assert_allclose(rep.total_linear, total, rtol=1e-6)

    def test_probe_specular_hotspot_keeps_linear_value(self):
        rep = probe_pixel(self.cs, ParamState(), DisplayParams(),
                          *PROBE_SPEC_HOT)
        self.assertGreater(rep.rows["specular"]["raw"].max(), 4.0)
        # 屏幕色被压到 255 以内, 但原始值仍可核对
        self.assertLessEqual(int(rep.total_screen8.max()), 255)

    def test_probe_outside_image(self):
        rep = probe_pixel(self.cs, ParamState(), DisplayParams(), 999, 999)
        self.assertFalse(rep.inside)

    def test_probe_reflects_suppressed_multiplier(self):
        p = ParamState()
        p.multipliers["specular"] = 0.0
        rep = probe_pixel(self.cs, p, DisplayParams(), *PROBE_SPEC_HOT)
        np.testing.assert_array_equal(
            rep.rows["specular"]["scaled"], np.zeros(3, np.float32))
        self.assertGreater(rep.rows["diffuse"]["scaled"].max() - 0.0, 0.0)
        # diffuse 与未压制时完全一致
        rep0 = probe_pixel(self.cs, ParamState(), DisplayParams(),
                           *PROBE_SPEC_HOT)
        np.testing.assert_allclose(
            rep.rows["diffuse"]["scaled"], rep0.rows["diffuse"]["scaled"],
            rtol=1e-6)


class TestMissingAndMismatch(unittest.TestCase):
    def test_missing_channel_is_zero_not_substituted(self):
        scene = build_example_scene()
        chs = {name: LoadedChannel(name, LoadStatus.OK, data=scene[name])
               for name in scene}
        chs["specular"] = LoadedChannel("specular", LoadStatus.MISSING,
                                        detail="未指定文件")
        cs = ChannelSet(channels=chs)
        self.assertEqual(cs.reference_shape, (256, 256))

        res = compute_composite(cs, ParamState(), DisplayParams())
        self.assertIn("specular", res.missing)
        np.testing.assert_array_equal(
            res.contributions["specular"], np.zeros((256, 256, 3), np.float32))
        # 其余三路不受影响
        np.testing.assert_allclose(
            res.contributions["diffuse"], scene["diffuse"], rtol=1e-6)
        self.assertFalse(res.available["specular"])

    def test_shape_mismatch_flagged_via_npy_load(self):
        scene = build_example_scene()
        with tempfile.TemporaryDirectory() as d:
            for name in ("base", "emission", "diffuse"):
                save_channel_npy(os.path.join(d, f"{name}.npy"), scene[name])
            save_channel_npy(os.path.join(d, "specular.npy"),
                             np.zeros((128, 128, 3), np.float32))
            cs = load_channels({n: os.path.join(d, f"{n}.npy")
                                for n in scene})
            self.assertEqual(cs.channels["specular"].status,
                             LoadStatus.SHAPE_MISMATCH)
            for name in ("base", "emission", "diffuse"):
                self.assertEqual(cs.channels[name].status, LoadStatus.OK)

            res = compute_composite(cs, ParamState(), DisplayParams())
            # 尺寸不符的通道不参与, 但其余部分照常预览
            self.assertIn("specular", res.missing)
            self.assertEqual(res.shape, (256, 256))

    def test_missing_file_on_disk(self):
        cs = load_channels({"base": "/nonexistent/base.npy"})
        self.assertEqual(cs.channels["base"].status, LoadStatus.MISSING)
        self.assertIsNone(cs.reference_shape)

    def test_bad_data_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "bad.npy")
            np.save(p, np.array([np.nan, 1.0], np.float32))
            cs = load_channels({"base": p})
            self.assertEqual(cs.channels["base"].status, LoadStatus.BAD_DATA)

    def test_grayscale_expanded_to_rgb(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "base.npy")
            np.save(p, np.full((16, 16), 0.5, np.float32))
            cs = load_channels({"base": p})
            self.assertEqual(cs.channels["base"].status, LoadStatus.OK)
            np.testing.assert_allclose(
                cs.channels["base"].data[0, 0], [0.5, 0.5, 0.5])


class TestRoundTripReproduce(unittest.TestCase):
    def test_params_roundtrip_gives_identical_result(self):
        cs = example_channel_set()
        p = ParamState()
        p.multipliers.update({"base": 1.0, "emission": 0.7,
                              "diffuse": 1.2, "specular": 0.15})
        d = DisplayParams(exposure_ev=0.8, tonemap="aces")
        r1 = compute_composite(cs, p, d)

        with tempfile.TemporaryDirectory() as tmp:
            pp = os.path.join(tmp, "params.json")
            save_params(pp, p, d, source_paths={n: f"/tmp/{n}.npy"
                                                for n in p.multipliers})
            p2, d2, _ = load_params(pp)
            r2 = compute_composite(cs, p2, d2)
            np.testing.assert_array_equal(r1.srgb8, r2.srgb8)
            np.testing.assert_allclose(r2.linear, r1.linear, rtol=1e-6)
            self.assertEqual(d2.tonemap, "aces")
            self.assertAlmostEqual(d2.exposure_ev, 0.8)

    def test_png_bytes_match_display_output(self):
        cs = example_channel_set()
        p = ParamState()
        p.multipliers["specular"] = 0.0
        res = compute_composite(cs, p, DisplayParams())
        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "composite.png")
            write_png_rgb8(out, res.srgb8)
            with open(out, "rb") as f:
                head = f.read(8)
            self.assertEqual(head, b"\x89PNG\r\n\x1a\n")
            self.assertGreater(os.path.getsize(out), 1000)

    def test_npy_roundtrip_preserves_above_one(self):
        scene = build_example_scene()
        with tempfile.TemporaryDirectory() as tmp:
            p = os.path.join(tmp, "specular.npy")
            save_channel_npy(p, scene["specular"])
            back = np.load(p)
            np.testing.assert_allclose(back, scene["specular"], rtol=1e-6)
            self.assertEqual(back.dtype, np.float32)
            self.assertGreater(back.max(), 4.0)

    def test_json_is_human_readable(self):
        with tempfile.TemporaryDirectory() as tmp:
            pp = os.path.join(tmp, "p.json")
            save_params(pp, ParamState(), DisplayParams(), {})
            with open(pp, encoding="utf-8") as fh:
                payload = json.load(fh)
            self.assertEqual(payload["version"], 1)
            self.assertIn("multipliers", payload)


class TestDisplayImageParity(unittest.TestCase):
    def test_display_image_matches_composite_chain(self):
        cs = example_channel_set()
        d = DisplayParams(exposure_ev=-0.5, tonemap="reinhard")
        res = compute_composite(cs, ParamState(), d)
        again = display_image(res.linear, d)
        np.testing.assert_array_equal(again, res.srgb8)


if __name__ == "__main__":
    unittest.main(verbosity=2)
