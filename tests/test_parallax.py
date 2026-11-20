"""Unit tests for the core (run with `python -m unittest discover -s tests`).

`python -m parallax_lab.verify` is the human-readable coordinate check; these
tests pin the same behaviour plus a few API invariants.
"""

from __future__ import annotations

import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from parallax_lab.core import (CAT_FRONT_TO_BACK, CAT_TO_HOLE,
                               FILL_BACKGROUND, FILL_RAW, Camera, LayerEdit,
                               layout_diff, nearest_donor, render)
from parallax_lab.scene import Layer, PRESETS, Scene, make_ramp, make_slab
from parallax_lab import verify


class TestProjection(unittest.TestCase):
    def test_shift_formula(self):
        cam = Camera(baseline_px=40.0)
        dx, dy = cam.shift_at(2.0)
        self.assertAlmostEqual(dx, -20.0)
        self.assertAlmostEqual(dy, 0.0)

    def test_reference_view_has_no_holes(self):
        res = render(make_slab(), Camera(0.0), fill_mode=FILL_RAW)
        self.assertEqual(int(res.hole_mask.sum()), 0)
        self.assertEqual(int(res.crack_mask.sum()), 0)

    def test_holes_match_closed_form_for_every_preset(self):
        for name, factory in PRESETS.items():
            with self.subTest(preset=name):
                scene = factory()
                for b in (-40.0, -17.0, 17.0, 40.0):
                    cam = Camera(baseline_px=b)
                    res = render(scene, cam, fill_mode=FILL_RAW)
                    want = verify.predict_holes(scene, cam)
                    # Renderer holes must be a subset of the projection holes
                    # (crack closure may only remove holes, never add).
                    extra = int(np.count_nonzero(res.hole_mask & ~want))
                    self.assertEqual(extra, 0, f"{name} b={b}: holes not predicted")


class TestFill(unittest.TestCase):
    def test_no_foreground_colour_in_fill(self):
        scene = make_slab()
        y0, y1, x0, x1 = scene.meta["rect"]
        res = render(scene, Camera(baseline_px=-40), fill_mode=FILL_BACKGROUND)
        slab = scene.layers[0].rgb[(y0 + y1) // 2, (x0 + x1) // 2]
        leak = np.all(res.rgb == slab, axis=-1) & res.filled_mask
        self.assertEqual(int(leak.sum()), 0)
        self.assertEqual(int(res.filled_mask.sum()), int(res.hole_mask.sum()))

    def test_donors_are_background(self):
        scene = make_slab()
        res = render(scene, Camera(baseline_px=-40), fill_mode=FILL_BACKGROUND)
        fs = res.fill_source_flat[res.filled_mask]
        self.assertTrue((res.sources.layer[fs] >= 1).all())
        self.assertTrue((res.sources.layer[fs] < len(scene.layers)).all())


class TestNearestDonor(unittest.TestCase):
    def test_matches_brute_force_distance(self):
        rng = np.random.default_rng(7)
        for _ in range(8):
            H, W = rng.integers(4, 18, 2)
            mask = rng.random((H, W)) < rng.uniform(0.15, 0.85)
            idx = np.where(mask, np.arange(H * W).reshape(H, W), -1).astype(np.int32)
            got = nearest_donor(mask, idx)
            ys, xs = np.nonzero(mask)
            if ys.size == 0:
                self.assertTrue((got == -1).all())
                continue
            gy, gx = np.divmod(np.where(got >= 0, got, 0), W)
            gd = np.where(got >= 0,
                          (gy - np.arange(H)[:, None]) ** 2 +
                          (gx - np.arange(W)[None, :]) ** 2, np.inf)
            best = np.full((H, W), np.inf)
            for y in range(H):
                for x in range(W):
                    best[y, x] = ((ys - y) ** 2 + (xs - x) ** 2).min()
            # chamfer distances may differ by the sqrt(2) approximation but the
            # chosen donor should never be farther than best + 1 in squared
            # distance.
            self.assertTrue(np.all(gd <= best + 2.5),
                            f"picked donor farther than nearest: {np.max(gd - best)}")


class TestDepthEdits(unittest.TestCase):
    def test_gain_and_bias(self):
        depth = np.array([[1.0, 2.0]], np.float32)
        out = LayerEdit(gain=2.0, bias=0.5).apply(depth)
        np.testing.assert_allclose(out, [[2.5, 4.5]], rtol=1e-6)

    def test_nan_preserved(self):
        depth = np.array([[np.nan, 1.0]], np.float32)
        out = LayerEdit(gain=2.0).apply(depth)
        self.assertTrue(np.isnan(out[0, 0]))
        self.assertAlmostEqual(float(out[0, 1]), 2.0, places=5)

    def test_clip(self):
        depth = np.array([[100.0]], np.float32)
        out = LayerEdit(gain=10.0).apply(depth)
        self.assertLessEqual(float(out[0, 0]), 100.0)

    def test_zoom_changes_parallax(self):
        scene = make_slab()
        b = -40.0
        base = render(scene, Camera(baseline_px=b), fill_mode=FILL_RAW)
        deep = render(scene, Camera(baseline_px=b),
                      [LayerEdit(gain=0.5), LayerEdit()], fill_mode=FILL_RAW)
        self.assertGreater(int(deep.hole_mask.sum()), int(base.hole_mask.sum()))


class TestOverlap(unittest.TestCase):
    def test_nearer_layer_wins(self):
        Hs, Ws = 16, 24
        a = np.zeros((Hs, Ws, 3), np.uint8); a[..., 0] = 255
        b = np.zeros((Hs, Ws, 3), np.uint8); b[..., 2] = 255
        scene = Scene(Ws, Hs, 30.0,
                      [Layer(a, np.full((Hs, Ws), 0.5, np.float32), "a"),
                       Layer(b, np.full((Hs, Ws), 1.0, np.float32), "b")],
                      "overlap")
        res = render(scene, Camera(0.0), fill_mode=FILL_RAW)
        self.assertTrue((res.layer_map == 0).all())
        flipped = render(scene, Camera(0.0),
                         [LayerEdit(gain=3.0), LayerEdit()], fill_mode=FILL_RAW)
        self.assertTrue((flipped.layer_map == 1).all())


class TestLayoutDiff(unittest.TestCase):
    def test_diff_counts_are_consistent(self):
        scene = make_slab()
        left = render(scene, Camera(baseline_px=-40), fill_mode=FILL_RAW)
        right = render(scene, Camera(baseline_px=40), fill_mode=FILL_RAW)
        d = layout_diff(left, right)
        self.assertEqual(sum(d.counts.values()), scene.height * scene.width)
        self.assertGreater(d.counts[CAT_FRONT_TO_BACK], 0)
        self.assertGreater(d.counts[CAT_TO_HOLE], 0)

    def test_diff_of_identical_render_is_empty(self):
        scene = make_slab()
        r = render(scene, Camera(baseline_px=-10), fill_mode=FILL_RAW)
        d = layout_diff(r, r)
        self.assertEqual(int(d.mask.sum()), 0)
        self.assertEqual(d.counts[0], scene.height * scene.width)

    def test_geometry_mismatch_raises(self):
        a = render(make_slab(), Camera(0.0), fill_mode=FILL_RAW)
        b = render(make_ramp(size=(100, 100)), Camera(0.0), fill_mode=FILL_RAW)
        with self.assertRaises(ValueError):
            layout_diff(a, b)


class TestVerifySuite(unittest.TestCase):
    def test_all_checks_pass(self):
        import contextlib
        import io
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            ok = verify.run_all()
        self.assertTrue(ok, buf.getvalue()[-2000:])


class TestProbe(unittest.TestCase):
    def test_probe_out_of_range(self):
        res = render(make_slab(), Camera(0.0), fill_mode=FILL_RAW)
        with self.assertRaises(IndexError):
            res.probe(-1, 0)

    def test_probe_reports_source_and_hole(self):
        scene = make_slab()
        res = render(scene, Camera(baseline_px=-40), fill_mode=FILL_RAW)
        y0, y1, x0, x1 = scene.meta["rect"]
        info = res.probe((x0 + x1) // 2 + 80, (y0 + y1) // 2)
        self.assertEqual(info.status, "visible")
        self.assertEqual(info.source, ((x0 + x1) // 2, (y0 + y1) // 2))
        hole = res.probe(x0 + 45, (y0 + y1) // 2)   # inside the seam
        self.assertEqual(hole.status, "hole")


if __name__ == "__main__":
    unittest.main()
