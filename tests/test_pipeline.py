"""Headless tests for the mirror-restoration engine and GUI smoke tests."""

from __future__ import annotations

import json
import os
import sys
import unittest
from pathlib import Path

import cv2
import numpy as np

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from mirror_restorer.geometry import (  # noqa: E402
    SymLine,
    build_maps,
    reflect_points,
    reflection_rt,
)
from mirror_restorer.inpaint import RestorationParams, restore  # noqa: E402
from mirror_restorer.suggest import suggest_line  # noqa: E402
from tests.make_fixtures import build_all  # noqa: E402

FIXTURE_DIR = ROOT / "tests" / "fixtures"


def ensure_fixtures() -> dict:
    meta_path = FIXTURE_DIR / "meta.json"
    if not meta_path.exists():
        return build_all(FIXTURE_DIR)
    return json.loads(meta_path.read_text(encoding="utf-8"))


def gt_line(meta: dict) -> SymLine:
    g = meta["line_gt"]
    return SymLine(g["x1"], g["y1"], g["x2"], g["y2"])


class GeometryTests(unittest.TestCase):
    def test_vertical_axis_reflects_x(self):
        line = SymLine(100, 0, 100, 200)
        pts = np.array([[110.0, 50.0], [100.25, 0.0]])
        out = reflect_points(pts, line)
        np.testing.assert_allclose(out[0], [90.0, 50.0], atol=1e-9)
        np.testing.assert_allclose(out[1], [99.75, 0.0], atol=1e-9)

    def test_reflection_is_involutary_and_keeps_subpixel(self):
        line = SymLine(12.3, 7.8, 130.7, 205.25)  # oblique, fractional
        rng = np.random.default_rng(0)
        pts = rng.uniform(0, 300, (50, 2))
        twice = reflect_points(reflect_points(pts, line), line)
        np.testing.assert_allclose(twice, pts, atol=1e-8)

    def test_maps_preserve_fractional_offsets(self):
        # a slightly tilted axis must NOT snap to an integer pixel shift
        line = SymLine(200, 0, 200.5, 400)
        map_x, map_y, inside = build_maps((400, 400), line)
        # along a horizontal row the reflected x coordinate varies smoothly
        row = map_x[200].astype(np.float64)
        self.assertTrue(np.any(np.abs(row - np.round(row)) > 1e-3))
        # reflection matrix used by export is float64
        r, t = reflection_rt(line)
        self.assertEqual(r.dtype, np.float64)
        self.assertTrue(inside.any())

    def test_inside_mask_flags_out_of_bounds(self):
        line = SymLine(10, 0, 10, 100)  # near the left edge
        _, _, inside = build_maps((100, 100), line)
        # pixels far to the right reflect to negative x -> outside
        self.assertFalse(inside[50, 95])
        self.assertTrue(inside[50, 12])


class InpaintTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.meta = ensure_fixtures()
        cls.line = gt_line(cls.meta)
        cls.pristine = cv2.imread(str(FIXTURE_DIR / "pristine.png"))
        cls.tilted = cv2.imread(str(FIXTURE_DIR / "tilted.png"))
        cls.dmg_one = cv2.imread(
            str(FIXTURE_DIR / "tilted_damage_mask.png"), cv2.IMREAD_GRAYSCALE
        )
        cls.both = cv2.imread(str(FIXTURE_DIR / "both_sides.png"))
        cls.dmg_both = cv2.imread(
            str(FIXTURE_DIR / "both_sides_damage_mask.png"), cv2.IMREAD_GRAYSCALE
        )
        cls.illum = cv2.imread(str(FIXTURE_DIR / "illumination.png"))

    def test_fill_uses_real_mirror_pixels_and_recovers_content(self):
        res = restore(self.tilted, self.dmg_one, self.line,
                      RestorationParams(feather_px=0, color_correct=False))
        damaged = self.dmg_one > 0
        # the great majority of marked damage is fillable from the other side
        fill_ratio = (res.fill_mask > 0).sum() / damaged.sum()
        self.assertGreater(fill_ratio, 0.95)
        self.assertEqual(int((res.gap_mask > 0).sum()), 0)
        # filled pixels resemble the pristine emblem much more than the black
        # damage color does
        before = np.abs(
            self.tilted[damaged].astype(np.float32)
            - self.pristine[damaged].astype(np.float32)
        ).mean()
        after = np.abs(
            res.result[damaged].astype(np.float32)
            - self.pristine[damaged].astype(np.float32)
        ).mean()
        self.assertLess(after, before * 0.35)

    def test_intact_pixels_are_never_modified(self):
        params = RestorationParams(feather_px=8, color_correct=True, cc_strength=1.0)
        res = restore(self.illum, self.dmg_one, self.line, params)
        intact = self.dmg_one == 0
        np.testing.assert_array_equal(
            res.result[intact], self.illum[intact],
            err_msg="过渡/校正泄漏到了缺损之外的原图像素",
        )

    def test_double_sided_damage_becomes_gap_not_fake_fill(self):
        res = restore(self.both, self.dmg_both, self.line,
                      RestorationParams(color_correct=False))
        gap = res.gap_mask > 0
        fill = res.fill_mask > 0
        # nothing can be both a gap and filled
        self.assertFalse(np.any(gap & fill))
        # the overlapping mirrored damage must show up as a real gap
        self.assertGreater(gap.sum(), 500)
        # gap pixels are left untouched (still the original damage color)
        np.testing.assert_array_equal(
            res.result[gap], self.both[gap]
        )

    def test_out_of_bounds_mirror_is_reported_as_gap(self):
        # damage a strip whose mirror lands beyond the image border
        h, w = self.tilted.shape[:2]
        mask = np.zeros((h, w), np.uint8)
        # reflect of far-right column across the tilted axis stays in-image on
        # this fixture, so build an explicit near-edge vertical axis instead
        edge_line = SymLine(4, 0, 4, h - 1)
        mask[:, w - 12:w] = 255
        res = restore(self.tilted, mask, edge_line,
                      RestorationParams(color_correct=False))
        self.assertGreater((res.gap_mask > 0).sum(), 0)
        self.assertTrue(np.all(res.alpha[res.gap_mask > 0] == 0))

    def test_feather_alpha_zero_outside_damage(self):
        res = restore(self.tilted, self.dmg_one, self.line,
                      RestorationParams(feather_px=12, color_correct=False))
        self.assertEqual(float(res.alpha[self.dmg_one == 0].max()), 0.0)
        # interior of a large damage region reaches full weight
        self.assertAlmostEqual(float(res.alpha[self.dmg_one > 0].max()), 1.0, places=2)

    def test_color_correction_reduces_illumination_mismatch(self):
        # A modest local correction removes the lighting ramp while the
        # remaining error is the bilinear interpolation floor of the texture.
        params = RestorationParams(
            feather_px=2, color_correct=True, cc_strength=0.4, cc_band_px=15
        )
        res = restore(self.illum, self.dmg_one, self.line, params)
        # fitted model stays small and bounded, but is not identity here
        self.assertFalse(np.allclose(res.color_model.offset, 0.0, atol=1e-6))
        self.assertTrue(np.all(np.abs(res.color_model.offset) <= 80.0))
        damaged = self.dmg_one > 0
        err = np.abs(
            res.result[damaged].astype(np.float32)
            - self.pristine[damaged].astype(np.float32)
        ).mean()
        res_no_cc = restore(self.illum, self.dmg_one, self.line,
                            RestorationParams(feather_px=2, color_correct=False))
        err_no_cc = np.abs(
            res_no_cc.result[damaged].astype(np.float32)
            - self.pristine[damaged].astype(np.float32)
        ).mean()
        self.assertLess(err, 0.75 * err_no_cc)

    def test_color_correction_on_pure_offset_lighting(self):
        # Two halves of the scan differ by a constant brightness offset:
        # the affine model's offset term should remove most of it.
        h = w = self.illum.shape[0]
        base = np.full((h, w), 200, np.uint8)
        lit = base.copy().astype(np.int16)
        nx, ny = self.line.normal
        gx, gy = np.meshgrid(np.arange(w, dtype=np.float64),
                             np.arange(h, dtype=np.float64))
        center = (w - 1) / 2.0
        side = ((gx - center) * nx + (gy - center) * ny) > 0
        lit[side] = np.clip(lit[side] + 25, 0, 255)
        lit3 = cv2.cvtColor(lit.astype(np.uint8), cv2.COLOR_GRAY2BGR)
        target = cv2.cvtColor(base, cv2.COLOR_GRAY2BGR)

        # damage entirely on one side, mirror source on the opposite side
        mask = np.zeros((h, w), np.uint8)
        mask[240:320, 440:510] = 255
        # confirm the mirror source really lands on the opposite side
        from mirror_restorer.geometry import build_maps
        map_x, map_y, inside = build_maps((h, w), self.line)
        target_side = side[mask > 0]
        src_y = np.clip(np.rint(map_y[mask > 0]).astype(int), 0, h - 1)
        src_x = np.clip(np.rint(map_x[mask > 0]).astype(int), 0, w - 1)
        src_side = side[src_y, src_x]
        self.assertTrue(inside[mask > 0].all())
        self.assertTrue(target_side.all() == np.logical_not(src_side).all())

        res = restore(lit3, mask, self.line, RestorationParams(
            feather_px=0, color_correct=True, cc_strength=1.0, cc_band_px=20))
        res0 = restore(lit3, mask, self.line,
                       RestorationParams(feather_px=0, color_correct=False))
        sel = mask > 0
        err_cc = np.abs(res.result[sel].astype(float) - target[sel].astype(float)).mean()
        err_no = np.abs(res0.result[sel].astype(float) - target[sel].astype(float)).mean()
        self.assertLess(err_cc, 0.4 * err_no)
        self.assertGreater(abs(float(res.color_model.offset.mean())), 5.0)

    def test_grayscale_pipeline_keeps_shape_and_channels(self):
        gray = cv2.cvtColor(self.tilted, cv2.COLOR_BGR2GRAY)
        line = gt_line(self.meta)
        res = restore(gray, self.dmg_one, line)
        self.assertEqual(res.result.ndim, 2)
        self.assertEqual(res.result.shape, gray.shape)
        self.assertEqual(res.mirrored.ndim, 2)
        self.assertGreater((res.fill_mask > 0).sum(), 0)

    def test_tiny_damage_feather_stays_inside(self):
        gray = cv2.cvtColor(self.tilted, cv2.COLOR_BGR2GRAY)
        line = gt_line(self.meta)
        small = np.zeros_like(gray)
        small[300:305, 320:324] = 255
        res = restore(cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR), small, line,
                      RestorationParams(feather_px=30))
        self.assertTrue(np.all(res.alpha[small == 0] == 0))
        self.assertLessEqual(float(res.alpha.max()), 1.0 + 1e-6)

    def test_original_size_and_masks_exported(self, tmp: Path | None = None):
        import tempfile
        out = Path(tempfile.mkdtemp())
        res = restore(self.tilted, self.dmg_one, self.line)
        cv2.imwrite(str(out / "result.png"), res.result)
        cv2.imwrite(str(out / "fill_mask.png"), res.fill_mask)
        cv2.imwrite(str(out / "gap_mask.png"), res.gap_mask)
        loaded = cv2.imread(str(out / "result.png"))
        mask = cv2.imread(str(out / "fill_mask.png"), cv2.IMREAD_GRAYSCALE)
        self.assertEqual(loaded.shape[:2], self.tilted.shape[:2])
        self.assertEqual(mask.shape, self.tilted.shape[:2])
        self.assertTrue((mask > 0).any())


class SuggestionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.meta = ensure_fixtures()
        cls.line = gt_line(cls.meta)
        # illumination image reuses the tilted single-side damage
        cls.illum = cv2.imread(str(FIXTURE_DIR / "illumination.png"))

    def test_suggestion_recovers_perturbed_angle_and_offset(self):
        # perturb the ground truth within the search window, then walk back
        from mirror_restorer.geometry import line_from_anchor

        anchor = (self.line.p1 + self.line.p2) / 2.0
        bad = line_from_anchor(
            anchor + self.line.normal * 2.0,
            self.line.angle + np.radians(0.8),
            self.line.length / 2.0,
        )
        roi = tuple(self.meta["suggest_roi"])
        sug = suggest_line(self.illum, roi, bad,
                           angle_range_deg=2.0, offset_range_px=4.0)
        # score must improve; the angle is recovered reliably, while under a
        # smooth lighting ramp the sub-pixel offset is genuinely ambiguous
        self.assertLess(sug.score, sug.baseline_score)
        err_before_a = abs(bad.angle - self.line.angle)
        anchor_sug = (sug.line.p1 + sug.line.p2) / 2.0
        err_after_a = abs(sug.line.angle - self.line.angle)
        err_after_o = abs(np.dot(anchor_sug - self.line.p1, self.line.normal))
        self.assertLess(err_after_a, err_before_a)
        self.assertLess(err_after_o, 3.0)

    def test_suggestion_is_exact_on_uniform_lighting(self):
        # without a lighting ramp, both angle and offset converge to truth
        from mirror_restorer.geometry import line_from_anchor

        img = cv2.imread(str(FIXTURE_DIR / "tilted.png"))
        anchor = (self.line.p1 + self.line.p2) / 2.0
        bad = line_from_anchor(
            anchor + self.line.normal * 2.0,
            self.line.angle + np.radians(0.8),
            self.line.length / 2.0,
        )
        sug = suggest_line(img, tuple(self.meta["suggest_roi"]), bad)
        anchor_sug = (sug.line.p1 + sug.line.p2) / 2.0
        self.assertLess(abs(sug.line.angle - self.line.angle), np.radians(0.15))
        self.assertLess(
            abs(np.dot(anchor_sug - self.line.p1, self.line.normal)), 0.75
        )

    def test_suggestion_respects_manual_override_contract(self):
        # the engine never mutates the input line
        roi = tuple(self.meta["suggest_roi"])
        before = (self.line.x1, self.line.y1, self.line.x2, self.line.y2)
        suggest_line(self.illum, roi, self.line)
        after = (self.line.x1, self.line.y1, self.line.x2, self.line.y2)
        self.assertEqual(before, after)


class GuiSmokeTests(unittest.TestCase):
    def test_window_lifecycle_and_pipeline(self):
        from PySide6.QtWidgets import QApplication

        from mirror_restorer.canvas import ViewMode
        from mirror_restorer.main_window import MainWindow

        app = QApplication.instance() or QApplication([])
        win = MainWindow()
        win.open_image(str(FIXTURE_DIR / "tilted.png"))
        self.assertIsNotNone(win.doc)

        # draw the ground-truth symmetry line programmatically
        win.canvas.set_line(gt_line(self.meta_holder()))
        # paint damage using the real mask
        win.doc.damage[:] = cv2.imread(
            str(FIXTURE_DIR / "tilted_damage_mask.png"), cv2.IMREAD_GRAYSCALE
        )
        win.canvas.refresh_overlays()
        win.run_preview()
        self.assertIsNotNone(win.result)
        self.assertGreater((win.result.fill_mask > 0).sum(), 0)

        # every view mode must render without raising
        for mode in ViewMode:
            win.mode_combo.setCurrentIndex(list(ViewMode).index(mode))
            app.processEvents()

        # magnifier pair updates at fractional coordinates
        win.magnifier.set_point(280.37, 240.19)
        app.processEvents()
        self.assertIsNotNone(win.magnifier.point)

        # changing the line keeps the previously painted damage region
        before = win.doc.damage.copy()
        win.canvas.set_line(
            win.doc.line.nudged(1.0, 0.5, 1.0, 0.5)
        )
        np.testing.assert_array_equal(before, win.doc.damage)
        win.close()

    @staticmethod
    def meta_holder() -> dict:
        return ensure_fixtures()


if __name__ == "__main__":
    unittest.main(verbosity=2)
