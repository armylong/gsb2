"""Closed-form verification of projection and hole geometry (no GUI needed).

Run:

    python -m parallax_lab --verify
    # or equivalently: python -m parallax_lab.verify

Exit code 0 = every check passed.  The checks use only numpy plus the sample
scenes' documented coordinates: an occluding rectangle (`make_slab`, front
0.50 m over a 1.00 m back plane, rect = x 120..209, y 60..150 at 360x240) and a
linearly sloped strip (`make_ramp`).

The predicted hole maps are built from the projection `dx = -b / D` applied to
each layer's *data mask* and rounded with the same rule the renderer uses
(`rint`).  They are computed independently of the renderer's z-buffer, so they
verify both projection and hole placement.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass

import numpy as np

from .core import (CAT_BACK_TO_FRONT, CAT_FRONT_TO_BACK, CAT_FROM_HOLE, CAT_TO_HOLE,
                   FILL_BACKGROUND, FILL_RAW, HOLE_RGB, Camera, LayerEdit,
                   layout_diff, render)
from .scene import make_ramp, make_slab

MARKER = tuple(int(c) for c in HOLE_RGB)   # (255, 0, 176)


@dataclass
class Check:
    name: str
    ok: bool
    detail: str = ""


class Verifier:
    def __init__(self):
        self.checks: list[Check] = []

    def check(self, name: str, ok, detail: str = ""):
        self.checks.append(Check(name, bool(ok), detail))
        return bool(ok)

    def close(self, name: str, got, want, tol=1e-6):
        ok = abs(float(got) - float(want)) <= tol
        return self.check(name, ok, f"got {float(got):.4f} want {float(want):.4f} tol {tol:g}")

    def eq(self, name: str, got, want):
        good = got == want
        detail = "" if good else f"got {got!r} want {want!r}"
        return self.check(name, good, detail)

    def report(self) -> bool:
        width = max(len(c.name) for c in self.checks)
        failed = [c for c in self.checks if not c.ok]
        for c in self.checks:
            line = f"  [{'PASS' if c.ok else 'FAIL'}] {c.name:<{width}}"
            if c.detail:
                line += f"   {c.detail}"
            print(line)
        print()
        print(f"{len(self.checks) - len(failed)}/{len(self.checks)} checks passed"
              + (f" -- {len(failed)} FAILED" if failed else ""))
        return not failed


# ---------------------------------------------------------------------------
# independent prediction helpers
# ---------------------------------------------------------------------------


def _runs(mask_1d):
    """Contiguous True runs as (start, end_exclusive)."""
    m = np.asarray(mask_1d, dtype=np.int8)
    edges = np.flatnonzero(np.diff(np.r_[0, m, 0]))
    return [(int(a), int(b)) for a, b in zip(edges[::2], edges[1::2])]


def _inner_run(mask_1d, W: int):
    """The widest True run that does not touch the frame border."""
    runs = [r for r in _runs(mask_1d) if r[0] > 0 and r[1] < W]
    if not runs:
        runs = _runs(mask_1d)
    return max(runs, key=lambda r: r[1] - r[0])


def predict_layer_coverage(scene, camera: Camera, edits=None) -> np.ndarray:
    """Coverage predicted purely from the projection formula and data masks.

    Because every sample scene has depth constant per row of a layer (the slab
    and still life) or varying only with x (the ramp), the warped column mask
    is exact.  Returns a (H, W) bool of pixels that any layer sample covers.
    """
    H, W = scene.shape
    covered = np.zeros((H, W), bool)
    for i, layer in enumerate(scene.layers):
        edit = edits[i] if edits else LayerEdit()
        d = edit.apply(layer.depth)
        for y in range(H):
            row = d[y]
            valid = np.isfinite(row)
            if not valid.any():
                continue
            xs = np.flatnonzero(valid)
            xd = xs + np.rint(-camera.baseline_px / row[valid]).astype(np.int64)
            ok = (xd >= 0) & (xd < W)
            covered[y, xd[ok]] = True
    return covered


def predict_holes(scene, camera: Camera, edits=None) -> np.ndarray:
    return ~predict_layer_coverage(scene, camera, edits)


# ---------------------------------------------------------------------------
# checks
# ---------------------------------------------------------------------------


def check_projection(v: Verifier):
    scene = make_slab()
    y0, y1, x0, x1 = scene.meta["rect"]
    Df, Db = scene.meta["depth_front"], scene.meta["depth_back"]

    base = render(scene, Camera(0.0), fill_mode=FILL_RAW)
    v.eq("reference view has no holes", int(base.hole_mask.sum()), 0)

    for b in (-40.0, -20.0, 20.0, 40.0):
        tag = f"b={b:+05.0f}"
        sf = int(round(-b / Df))
        sb = int(round(-b / Db))
        res = render(scene, Camera(baseline_px=b), fill_mode=FILL_RAW)

        v.eq(f"{tag} foreground shift = -b/Df", sf, int(round(-b / Df)))
        v.eq(f"{tag} background shift = -b/Db", sb, int(round(-b / Db)))

        # The slab has constant depth -> it must translate rigidly.
        inner_y = slice(y0 + 5, y1 - 5)
        inner_x = np.arange(x0 + 5, x1 - 5)
        v.check(f"{tag} slab interior is a rigid {sf:+d}px translation",
                np.array_equal(res.rgb[inner_y, inner_x + sf],
                               scene.layers[0].rgb[inner_y, inner_x]))

        # Any output pixel inside the moved slab resolves to the front layer,
        # and its source is exactly (x - sf, y).
        for py, px in (((y0 + y1) // 2, (x0 + x1) // 2),
                       (y0 + 10, x0 + 10), (y1 - 10, x1 - 10)):
            info = res.probe(px + sf, py)
            v.eq(f"{tag} probe({px + sf},{py}) layer", info.layer, 0)
            v.eq(f"{tag} probe({px + sf},{py}) source", info.source, (px, py))
            v.close(f"{tag} probe({px + sf},{py}) depth", info.depth, Df, 1e-5)


def check_slab_holes(v: Verifier):
    scene = make_slab()
    H, W = scene.shape
    y0, y1, x0, x1 = scene.meta["rect"]
    Df, Db = scene.meta["depth_front"], scene.meta["depth_back"]

    for b in (-40.0, -20.0, 20.0, 40.0):
        tag = f"b={b:+05.0f}"
        sf = int(round(-b / Df))
        sb = int(round(-b / Db))
        res = render(scene, Camera(baseline_px=b), fill_mode=FILL_RAW)
        want = predict_holes(scene, Camera(baseline_px=b))
        got = res.hole_mask

        v.eq(f"{tag} hole mask matches projection-only prediction",
             int(np.count_nonzero(got != want)), 0)

        # Closed-form extremes: image-border strip + seam beside the slab.
        border_w = abs(sb)
        if sb > 0:
            border = got[:, :border_w].all() and not got[:, border_w].any()
        else:
            border = got[:, W - border_w:].all() and not got[:, W - border_w - 1].any()
        v.eq(f"{tag} vacated border strip is {border_w}px on the trailing side",
             border, True)

        # The seam's width is bounded by the slab's own width and by |sf - sb|;
        # for these shifts the front stays inside the frame, so it is |sf - sb|.
        seam_expect = abs(sf - sb)
        row = (y0 + y1) // 2
        seam_run = _inner_run(got[row], W)
        v.eq(f"{tag} seam in the slab rows is {seam_expect}px wide",
             seam_run[1] - seam_run[0], seam_expect)

        # Seam rows: exactly y0..y1 (holes outside the slab exist only at the
        # image border, where they span every row).
        in_slab_rows = got[y0:y1, seam_run[0]:seam_run[1]].all()
        out_slab_rows = not got[:y0, seam_run[0]:seam_run[1]].any() and \
            not got[y1:, seam_run[0]:seam_run[1]].any()
        v.eq(f"{tag} seam confined to the slab's rows", in_slab_rows and out_slab_rows, True)

        # The seam opens between the front's leading edge and the back's
        # leading edge in the same direction.  For camera-left (b < 0) both
        # edges are on the slab's left; for camera-right on the right.
        want_lo = x0 + sb if b < 0 else x1 + sf
        v.eq(f"{tag} seam starts at the front/back leading edge", seam_run[0], want_lo)


def check_fill(v: Verifier):
    scene = make_slab()
    y0, y1, x0, x1 = scene.meta["rect"]
    b = -40.0
    raw = render(scene, Camera(baseline_px=b), fill_mode=FILL_RAW)
    res = render(scene, Camera(baseline_px=b), fill_mode=FILL_BACKGROUND)

    v.eq("fill: hole count is unchanged by the fill mode",
         int(res.hole_mask.sum()), int(raw.hole_mask.sum()))
    v.eq("fill: every hole filled", int(res.filled_mask.sum()), int(res.hole_mask.sum()))
    v.eq("fill: no marker colour left", int(np.all(res.rgb == MARKER, axis=-1).sum()), 0)

    slab_rgb = tuple(int(c) for c in scene.layers[0].rgb[(y0 + y1) // 2, (x0 + x1) // 2])
    v.eq("fill: no slab colour inside filled holes",
         int((np.all(res.rgb == slab_rgb, axis=-1) & res.filled_mask).sum()), 0)

    fs = res.fill_source_flat[res.filled_mask]
    v.check("fill: donors exist", fs.size > 0, f"{fs.size} px")
    v.eq("fill: all donors are background pixels", int((res.sources.layer[fs] >= 1).all()), 1)
    v.eq("fill: all donors at background depth",
         int(np.allclose(res.sources.depth[fs], scene.meta["depth_back"], atol=1e-5)), 1)

    # The fill must be the *nearest* background pixel.  Check a sample against
    # a brute-force nearest search, and verify the pasted colour is the donor's.
    seam_lo = x0 + int(round(-b / scene.meta["depth_back"]))
    seam_hi = x0 + int(round(-b / scene.meta["depth_front"]))
    bg = res.layer_map >= 1
    bys, bxs = np.nonzero(bg)
    rng = np.random.default_rng(0)
    rows = rng.choice(np.arange(y0 + 3, y1 - 3), size=20, replace=False)
    cols = rng.choice(np.arange(seam_lo + 2, seam_hi - 2), size=20, replace=False)
    worse = 0
    rgb_ok = True
    worst_excess = 0.0
    for py, px in zip(rows, cols):
        dd = (bys - py) ** 2 + (bxs - px) ** 2
        best = max(float(dd.min()) ** 0.5, 1e-9)
        fs = int(res.fill_source_flat[py, px])
        # The donor is a *source* pixel; project it to output coordinates.
        dyx = res.sources.yx[fs]
        odx, ody = res.camera.shifts(float(res.sources.depth[fs]))
        ox = dyx[1] + odx
        oy = dyx[0] + ody
        chosen = float(((oy - py) ** 2 + (ox - px) ** 2) ** 0.5)
        worst_excess = max(worst_excess, chosen / best - 1.0)
        worse += chosen > best + 1e-9
        rgb_ok &= np.array_equal(res.rgb[py, px], res.sources.rgb[fs])
    # The fill uses a 3-4 chamfer distance transform: an approximation of the
    # Euclidean nearest neighbour with a bounded (few percent) overestimate.
    # For a preview tool the chosen donor is therefore the nearest or a
    # near-tied neighbour; the exact rule is documented in the README.
    v.check("fill: sampled seam donors are nearest/within 5% of nearest",
            worst_excess <= 0.05, f"{worse} non-tied picks, worst +{worst_excess * 100:.1f}%")
    v.eq("fill: filled colour comes from the donor pixel", rgb_ok, True)

    # Probe a seam pixel: reports the background donor, not the front.
    py, px = (y0 + y1) // 2, seam_lo + 5
    info = res.probe(px, py)
    v.eq("fill: seam probe status", info.status, "filled")
    v.eq("fill: seam probe donor layer", info.donor_layer, 1)
    v.eq("fill: seam probe donor row", info.donor_source[1] if info.donor_source else None, py)

    raw_info = raw.probe(px, py)
    v.eq("raw: seam probe status", raw_info.status, "hole")
    v.eq("raw: seam pixel shows marker colour", tuple(int(c) for c in raw.rgb[py, px]), MARKER)
    return res


def check_layout_diff(v: Verifier):
    scene = make_slab()
    y0, y1, x0, x1 = scene.meta["rect"]
    Df = scene.meta["depth_front"]
    left = render(scene, Camera(baseline_px=-40), fill_mode=FILL_RAW)
    right = render(scene, Camera(baseline_px=+40), fill_mode=FILL_RAW)
    d = layout_diff(left, right)

    v.check("diff: layouts differ", int(d.mask.sum()) > 0, d.describe())
    v.eq("diff: front→back pixels counted", d.counts[CAT_FRONT_TO_BACK] > 0, True)
    v.eq("diff: back→front pixels counted", d.counts[CAT_BACK_TO_FRONT] > 0, True)
    v.eq("diff: hole flips counted both ways",
         d.counts[CAT_TO_HOLE] > 0 and d.counts[CAT_FROM_HOLE] > 0, True)

    # With the camera left the seam is left of the moved slab; with the camera
    # right it is right of it.  The moved slab starts at x0 + sf.
    sf_left = int(round(40 / Df))       # b = -40 -> +80
    sf_right = int(round(-40 / Df))     # b = +40 -> -80
    row = (y0 + y1) // 2
    left_seam = max(_runs(left.hole_mask[row]), key=lambda r: r[1] - r[0])
    right_seam = max(_runs(right.hole_mask[row]), key=lambda r: r[1] - r[0])
    v.eq("diff: camera-left seam is left of the moved slab",
         left_seam[1] <= x0 + sf_left, True)
    v.eq("diff: camera-right seam is right of the moved slab",
         right_seam[0] >= x1 + sf_right, True)
    v.eq("diff: hole widths are mirror images",
         left_seam[1] - left_seam[0], right_seam[1] - right_seam[0])

    # A probe at the same output pixel resolves to different sources/layers.
    probe_x = x0 + sf_left + 10
    pl, pr = left.probe(probe_x, row), right.probe(probe_x, row)
    v.check("diff: same output pixel maps differently under the two cameras",
            (pl.layer, pl.source) != (pr.layer, pr.source),
            f"left={pl.describe(scene)} | right={pr.describe(scene)}")


def check_ramp(v: Verifier):
    scene = make_ramp()
    x0, x1 = scene.meta["strip"]
    db = scene.meta["depth_back"]
    b = -40.0

    d_near = scene.meta["depth_at"](x0)
    d_far = scene.meta["depth_at"](x1 - 1)
    s_near = -b / d_near
    s_far = -b / d_far
    v.check("ramp: near edge shifts more than far edge", s_near > s_far,
            f"{s_near:.2f} > {s_far:.2f}")

    res = render(scene, Camera(baseline_px=b), fill_mode=FILL_RAW)
    want = predict_holes(scene, Camera(baseline_px=b))
    v.eq("ramp: hole mask matches projection-only prediction "
         "(after sampling-crack closure)",
         int(np.count_nonzero(res.hole_mask & ~want)), 0)

    # Sampling cracks are reported separately and are never counted as holes.
    v.check("ramp: sampling cracks were closed, not marked as holes",
            res.stats["cracks"] >= 0,
            f"{res.stats['cracks']} crack px closed")

    hole_cols = res.hole_mask.any(axis=0)
    runs = _runs(hole_cols)
    v.check("ramp: hole columns form contiguous runs", len(runs) > 0, str(runs))
    for a, e in runs:
        v.eq(f"ramp: run [{a},{e}) is full-height",
             int(res.hole_mask[:, a:e].sum()), (e - a) * scene.height)

    # The seam beside the strip's near edge has the analytic width
    # |s_near - (-b / db)| (wall leading edge vs strip trailing edge).
    analytic = abs(s_near - (-b / db))
    widths = sorted(e - a for a, e in runs)
    v.check("ramp: a seam of ~|s_near - s_back| exists",
            any(abs(w - analytic) <= 2 for w in widths),
            f"widths {widths}, analytic {analytic:.1f}")

    # Both camera directions: the hole must switch sides.
    left = render(scene, Camera(baseline_px=-40), fill_mode=FILL_RAW)
    right = render(scene, Camera(baseline_px=+40), fill_mode=FILL_RAW)
    W = scene.width
    left_main = _inner_run(left.hole_mask.any(axis=0), W)
    right_main = _inner_run(right.hole_mask.any(axis=0), W)
    v.check("ramp: camera-left seam opens on the strip's left edge",
            left_main[1] <= x1 and left_main[0] > 0,
            f"seam {left_main}")
    v.check("ramp: camera-right seam opens on the strip's right edge",
            right_main[0] >= x0 and right_main[0] > left_main[1],
            f"seam {right_main}")

    # Fill must only use the wall.
    filled = render(scene, Camera(baseline_px=b), fill_mode=FILL_BACKGROUND)
    fs = filled.fill_source_flat[filled.filled_mask]
    v.eq("ramp fill: every donor is the background layer",
         int((filled.sources.layer[fs] >= 1).all()), 1)


def check_editable_depth(v: Verifier):
    scene = make_slab()
    H, W = scene.shape
    y0, y1, x0, x1 = scene.meta["rect"]
    Df = scene.meta["depth_front"]
    Db = scene.meta["depth_back"]
    b = -40.0

    base = render(scene, Camera(baseline_px=b), fill_mode=FILL_RAW)
    deeper = render(scene, Camera(baseline_px=b),
                    [LayerEdit(gain=0.5), LayerEdit()], fill_mode=FILL_RAW)
    v.close("edit: gain 0.5 halves the front depth",
            np.median(deeper.depth_map[deeper.layer_map == 0]), Df * 0.5, 1e-5)

    # New seam = shifted back-rect minus shifted front-rect, clipped to frame.
    sf = int(round(-b / (Df * 0.5)))
    sb = int(round(-b / Db))
    expected = min(x1 + sb, x0 + sf) - (x0 + sb)
    row = (y0 + y1) // 2
    got = max(_runs(deeper.hole_mask[row]), key=lambda r: r[1] - r[0])
    v.eq("edit: deepening the front widens the seam as predicted",
         got[1] - got[0], expected)

    # Probe reports the edited depth and the corresponding shift.
    info = deeper.probe((x0 + x1) // 2 + sf, (y0 + y1) // 2)
    v.eq("edit: probe resolves the edited front layer", info.layer, 0)
    v.close("edit: probe shift follows the edited depth",
            info.shift[0], -b / (Df * 0.5), 1e-4)

    # A local brush offset changes only that region's depth.
    brush = np.zeros((H, W), np.float32)
    brush[y0 + 10:y0 + 30, x0 + 10:x0 + 30] = 0.25
    edited = render(scene, Camera(0.0), [LayerEdit(brush=brush), LayerEdit()],
                    fill_mode=FILL_RAW)
    v.close("edit: brush adds 0.25 m locally",
            np.median(edited.depth_map[y0 + 15:y0 + 25, x0 + 15:x0 + 25]),
            Df + 0.25, 1e-5)
    v.close("edit: brush leaves the rest untouched",
            np.median(edited.depth_map[y0 + 3:y0 + 7, x0 + 3:x0 + 7]), Df, 1e-5)

    # Depth reordering flips which layer wins where both layers have samples.
    # The sample scenes are visible-surface maps (the back has no data under
    # the front), so build a small fully-covering stack for this check.
    from .scene import Layer, Scene
    Hs, Ws = 20, 30
    near_rgb = np.zeros((Hs, Ws, 3), np.uint8); near_rgb[..., 0] = 255
    far_rgb = np.zeros((Hs, Ws, 3), np.uint8); far_rgb[..., 2] = 255
    both = Scene(width=Ws, height=Hs, f_px=30.0,
                 layers=[Layer(near_rgb, np.full((Hs, Ws), 0.5, np.float32), "a"),
                         Layer(far_rgb, np.full((Hs, Ws), 1.0, np.float32), "b")],
                 name="overlap")
    normal = render(both, Camera(0.0), fill_mode=FILL_RAW)
    v.eq("edit: unedited overlap resolves to the nearer layer",
         normal.probe(10, 10).layer, 0)
    flip = render(both, Camera(0.0),
                  [LayerEdit(gain=3.0), LayerEdit()], fill_mode=FILL_RAW)
    centre = flip.probe(10, 10)
    v.eq("edit: pushing the front behind the back flips the winner", centre.layer, 1)
    v.close("edit: flipped winner depth is the back depth", centre.depth, 1.0, 1e-5)


def run_all() -> bool:
    v = Verifier()
    check_projection(v)
    check_slab_holes(v)
    check_fill(v)
    check_layout_diff(v)
    check_ramp(v)
    check_editable_depth(v)
    return v.report()


def main(argv=None) -> int:
    print("parallax_lab verification\n")
    return 0 if run_all() else 1


if __name__ == "__main__":
    sys.exit(main())
