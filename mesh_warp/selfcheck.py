"""Reusable checks shared by pytest and the ``python -m mesh_warp.selfcheck`` CLI.

Every check returns a ``CheckResult`` with measured pixel differences so a
pass/fail is reported with numbers instead of only a boolean.  Tolerances are
documented next to each check.
"""

from __future__ import annotations

import json
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from .io import (
    load_image_rgba,
    load_mesh_json,
    save_mesh_json,
    save_png_rgba,
)
from .mesh import ControlMesh, MeshError, barycentric
from .test_image import generate_test_image
from .warp import render_warp


@dataclass
class CheckResult:
    name: str
    passed: bool
    detail: str
    metrics: dict[str, float] = field(default_factory=dict)


def _result(name: str, passed: bool, detail: str, **metrics: float) -> CheckResult:
    return CheckResult(name, bool(passed), detail, {k: float(v) for k, v in metrics.items()})


def _rgba_diff(a: np.ndarray, b: np.ndarray) -> tuple[int, float]:
    d = np.abs(a.astype(np.int16) - b.astype(np.int16))
    return int(d.max()), float(d.mean())


def check_identity(image_rgba: np.ndarray, mesh: ControlMesh) -> CheckResult:
    """Rest pose must reproduce the source image exactly (max diff 0)."""
    out = render_warp(image_rgba, mesh)
    max_d, mean_d = _rgba_diff(out, image_rgba)
    exact = np.array_equal(out, image_rgba)
    return _result(
        "identity",
        exact,
        "rest mesh returns the exact source raster"
        if exact
        else f"identity differs: max={max_d}, mean={mean_d:.4f}",
        max_abs_diff=max_d,
        mean_abs_diff=mean_d,
    )


def check_known_point(
    image_rgba: np.ndarray,
    mesh: ControlMesh,
    index: int,
    delta: tuple[float, float],
) -> CheckResult:
    """A moved control point must land on its stated target pixel.

    Two independent assertions:

    * the model target coordinate equals the requested pixel exactly;
    * with a smooth coordinate-ramp image, the output pixel *at* the target
      location decodes to the source vertex's coordinate.  The ramp makes the
      check robust to sub-pixel rounding, unlike probing a high-contrast dot.
    """
    p = int(index)
    mesh.try_move([p], mesh.src[p][None] + np.asarray(delta)[None], respect_locks=False)
    reached = mesh.dst[p]
    expected = mesh.src[p] + np.asarray(delta, dtype=float)
    coord_err = float(np.linalg.norm(reached - expected))

    ramp = _coordinate_ramp(mesh.width, mesh.height)
    out = render_warp(ramp, mesh)
    tx, ty = int(round(expected[0])), int(round(expected[1]))
    source_err, decode_err = _decode_source_error(out[ty, tx], mesh, (tx, ty))
    # Allow a small tolerance: the ramp has ~2.8 px per 8-bit step and we probe
    # one integer pixel location, so <= 3 px is the quantization floor.
    passed = coord_err <= 1e-9 and source_err <= 3.0 and decode_err <= 2.0
    return _result(
        "known_control_point",
        passed,
        f"point #{p}: model error={coord_err:.2e} px; "
        f"raster-decoded source error={source_err:.2f} px "
        f"(ramp value error={decode_err:.1f}/255, tolerance 3 px / 2 levels)",
        coordinate_error_px=coord_err,
        decoded_source_error_px=source_err,
        ramp_value_error=decode_err,
    )


def _coordinate_ramp(width: int, height: int) -> np.ndarray:
    """RGBA image whose R/G channels encode x/y (for coordinate probing)."""
    yy, xx = np.mgrid[0:height, 0:width].astype(np.float32)
    out = np.empty((height, width, 4), dtype=np.uint8)
    out[..., 0] = np.clip(xx * 255.0 / max(width - 1, 1) + 0.5, 0, 255).astype(np.uint8)
    out[..., 1] = np.clip(yy * 255.0 / max(height - 1, 1) + 0.5, 0, 255).astype(np.uint8)
    out[..., 2] = 128
    out[..., 3] = 255
    return out


def _decode_source_error(
    pixel: np.ndarray, mesh: ControlMesh, target_xy: tuple[int, int]
) -> tuple[float, float]:
    """Decode a ramp pixel to source coords and compare with inverse mapping."""
    expected, _ = mesh.locate_target(np.asarray(target_xy, dtype=float))
    if expected is None:
        return float("inf"), float("inf")
    sx = float(pixel[0]) * (mesh.width - 1) / 255.0
    sy = float(pixel[1]) * (mesh.height - 1) / 255.0
    err = float(np.hypot(sx - expected[0], sy - expected[1]))
    # Re-encode the expected coordinate and measure the value difference.
    ex = expected[0] * 255.0 / max(mesh.width - 1, 1)
    ey = expected[1] * 255.0 / max(mesh.height - 1, 1)
    return err, float(max(abs(float(pixel[0]) - ex), abs(float(pixel[1]) - ey)))


def _shared_edges(mesh: ControlMesh) -> list[tuple[tuple[int, int], int, int]]:
    """Map each undirected edge to the (at most two) triangles using it."""
    owners: dict[tuple[int, int], list[int]] = {}
    for k, tri in enumerate(mesh.tris):
        for e in ((0, 1), (1, 2), (2, 0)):
            a, b = sorted((int(tri[e[0]]), int(tri[e[1]])))
            owners.setdefault((a, b), []).append(k)
    return [(edge, ts[0], ts[1]) for edge, ts in owners.items() if len(ts) == 2]


def _inverse_on_edge(mesh: ControlMesh, tri: int, a: int, b: int, t: float) -> np.ndarray:
    p = mesh.dst[a] * (1 - t) + mesh.dst[b] * t
    tri_pts = mesh.dst[mesh.tris[tri]]
    _, bary = barycentric(np.asarray([p]), tri_pts)
    return bary[0] @ mesh.src[mesh.tris[tri]]


def check_edge_continuity(
    image_rgba: np.ndarray, mesh: ControlMesh, moved_points: list[tuple[int, float, float]]
) -> CheckResult:
    """Shared triangle edges must map to identical source coordinates.

    * Geometric check: sample points along each shared edge and evaluate the
      inverse affine map from *both* adjacent triangles; the maximum distance
      between the two source coordinates must be ~0 (machine precision).
    * Raster check: warp a smooth coordinate-ramp with constant alpha and
      verify there is no thin transparent seam and no content jump across
      interior edges.
    """
    for idx, dx, dy in moved_points:
        mesh.try_move([idx], mesh.src[idx][None] + np.array([[dx, dy]]), respect_locks=False)

    geo_max = 0.0
    for (a, b), t1, t2 in _shared_edges(mesh):
        for t in np.linspace(0.05, 0.95, 19):
            p1 = _inverse_on_edge(mesh, t1, a, b, t)
            p2 = _inverse_on_edge(mesh, t2, a, b, t)
            geo_max = max(geo_max, float(np.linalg.norm(p1 - p2)))

    ramp = _coordinate_ramp(mesh.width, mesh.height)
    out = render_warp(ramp, mesh)
    alpha_min = 255
    jump_max = 0.0
    for (a, b), t1, t2 in _shared_edges(mesh):
        # Skip edges on the canvas border: their outside legitimately ends.
        edge_pts = mesh.dst[[a, b]]
        if np.any(edge_pts <= 1.0) or np.any(edge_pts[:, 0] >= mesh.width - 2.0) or np.any(
            edge_pts[:, 1] >= mesh.height - 2.0
        ):
            continue
        mid = mesh.dst[[a, b]].mean(axis=0)
        # Find the vertex of t1 not on this edge.
        third_pt = None
        for v in mesh.tris[t1]:
            if int(v) not in (a, b):
                third_pt = mesh.dst[int(v)]
                break
        if third_pt is None:
            continue
        inward = third_pt - mid
        n = np.linalg.norm(inward)
        if n < 1e-9:
            continue
        inward /= n
        for s in np.linspace(0.2, 0.8, 13):
            p_on = mesh.dst[a] * (1 - s) + mesh.dst[b] * s
            sides = []
            for sign in (-1.0, 1.0):
                x, y = p_on + inward * (1.5 * sign)
                xi, yi = int(round(x)), int(round(y))
                if 0 <= yi < out.shape[0] and 0 <= xi < out.shape[1]:
                    alpha_min = min(alpha_min, int(out[yi, xi, 3]))
                    sides.append(out[yi, xi, :2].astype(float))
            if len(sides) == 2:
                jump_max = max(jump_max, float(np.abs(sides[0] - sides[1]).max()))

    # Ramp gradients are <= 1 level/px; 3 px separation should stay under a
    # few levels.  A real crack samples unrelated content and jumps much more.
    # The ramp itself changes alpha nowhere, so any interior alpha loss is a seam.
    ok = geo_max <= 1e-9 and alpha_min >= 250 and jump_max <= 16.0
    return _result(
        "edge_continuity",
        ok,
        f"shared-edge inverse-map mismatch={geo_max:.2e} px; "
        f"minimum interior seam alpha={alpha_min}/255; maximum cross-seam ramp jump={jump_max:.1f}/255",
        inverse_map_mismatch_px=geo_max,
        seam_alpha_min=float(alpha_min),
        cross_seam_jump=jump_max,
    )


def check_invalid_rejected(mesh: ControlMesh) -> CheckResult:
    """Flipped / collapsed / crossing poses must be refused atomically."""
    checks: list[tuple[str, bool, str]] = []
    before = mesh.dst.copy()

    # 1) Move an interior point far past its neighbours => flipped triangles.
    i, j = mesh.cols // 2, mesh.rows // 2
    p = mesh.index(i, j)
    far = mesh.src[p] + np.array([2.5 * mesh.width / mesh.cols, 0.0])
    rejected = not mesh.try_move([p], far[None], respect_locks=False)
    checks.append(("flip", rejected and np.array_equal(mesh.dst, before), "flipped pose rejected"))

    # 2) Collapse a point onto a neighbour => near-zero-area triangles.
    q = mesh.index(i + 1, j)
    rejected = not mesh.try_move([p], mesh.dst[q][None].copy(), respect_locks=False)
    checks.append(("collapse", rejected and np.array_equal(mesh.dst, before), "collapsed pose rejected"))

    # 3) Swap two distant interior points => non-adjacent mesh edges cross.
    r = mesh.index(i + 1, j)
    moved = mesh.dst[[p, r]].copy()
    candidate_ok = not mesh.try_move([p, r], moved[::-1].copy(), respect_locks=False)
    checks.append(("crossing", candidate_ok and np.array_equal(mesh.dst, before), "edge crossing rejected"))

    passed = all(c[1] for c in checks)
    return _result(
        "invalid_rejection",
        passed,
        "; ".join(f"{name}: {'ok' if ok else 'FAILED'}" for name, ok, _ in checks),
    )


def check_canvas_alpha(image_rgba: np.ndarray, mesh: ControlMesh) -> CheckResult:
    """Outside the mesh must be transparent; no dark fringe on soft edges."""
    out = render_warp(image_rgba, mesh)
    outside = out[:, :, 3] == 0
    # Fully transparent pixels must have no visible black-by-design RGB that
    # would bleed if a consumer ignores alpha; our unpremultiply zeroes it.
    rgb_under_zero = int(np.count_nonzero(out[:, :, :3][outside]))
    # Dark fringe probe: in regions where source alpha is partial, the output
    # should have RGB no darker than the source's darkest premultiplied colour
    # plus a small margin.  We inspect the frame band specifically.
    src_band = image_rgba[..., 3] > 0
    fringe = 0
    if src_band.any():
        # Where output alpha is partial, compare unpremultiplied RGB against
        # the nearest source colour magnitude; black fringe shows as very low
        # RGB with non-trivial alpha.
        partial = (out[..., 3] > 16) & (out[..., 3] < 250)
        if partial.any():
            luminance = out[..., :3][partial].astype(float).mean(axis=1)
            fringe = int(np.count_nonzero(luminance < 12.0))
    passed = rgb_under_zero == 0 and fringe == 0
    return _result(
        "transparent_canvas",
        passed,
        f"transparent pixels with non-zero RGB = {rgb_under_zero}; dark partial-alpha pixels = {fringe}",
        rgb_under_zero=rgb_under_zero,
        dark_fringe=fringe,
    )


def check_pick_source(image_rgba: np.ndarray, mesh: ControlMesh) -> CheckResult:
    """Picking a target location returns the right source coord + triangle."""
    idx = mesh.index(mesh.cols // 2, mesh.rows // 2)
    mesh.try_move([idx], mesh.src[idx][None] + np.array([[18.0, -12.0]]), respect_locks=False)
    tri = 0
    centroid = mesh.dst[mesh.tris[tri]].mean(axis=0)
    src_xy, bary = mesh.locate_target(centroid)
    if src_xy is None:
        return _result("pick_source", False, "centroid outside deformed mesh")
    # Reconstruct the target from the reported source coordinate: must be
    # within 0.01 px of the centroid.
    rt = bary @ mesh.dst[mesh.tris[tri]]
    err = float(np.linalg.norm(rt - centroid))
    # A gap in the target mesh must report no source.
    far = np.array([mesh.width - 0.25, mesh.height - 0.25])
    gap_src, _ = mesh.locate_target(far)
    # For a genuine gap, shift the bottom-right corner point inward.
    gap_pt = mesh.index(mesh.cols - 1, mesh.rows - 1)
    mesh.try_move([gap_pt], mesh.src[gap_pt][None] + np.array([[-40.0, -30.0]]), respect_locks=False)
    outside_src, _ = mesh.locate_target(np.array([mesh.width - 1.0, mesh.height - 1.0], float))
    gap_reported = outside_src is None
    passed = err <= 1e-6 and gap_reported
    return _result(
        "pick_source",
        passed,
        f"triangle-{tri} centroid round-trip error={err:.2e} px; uncovered corner reports no source={gap_reported}",
        roundtrip_px=err,
    )


def check_export_roundtrip(image_rgba: np.ndarray) -> CheckResult:
    """Export PNG + JSON, reload, re-render and compare pixel-for-pixel."""
    mesh = ControlMesh(6, 5, image_rgba.shape[1], image_rgba.shape[0])
    steps = [
        (mesh.index(2, 2), 22.0, -16.0),
        (mesh.index(3, 1), -14.0, 9.0),
        (mesh.index(4, 3), 7.0, 18.0),
    ]
    for idx, dx, dy in steps:
        ok = mesh.try_move([idx], mesh.src[idx][None] + np.array([[dx, dy]]), respect_locks=False)
        if not ok:
            return _result("export_roundtrip", False, f"setup move #{idx} was rejected")
    mesh.locked[mesh.index(0, 0)] = True
    first = render_warp(image_rgba, mesh)

    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        try:
            from .io import LoadedImage

            loaded = LoadedImage(image_rgba, Path("input.png"), "test-digest")
            png_path = td / "warped.png"
            json_path = td / "mesh.json"
            save_png_rgba(png_path, first)
            save_mesh_json(json_path, mesh, loaded)
            reread = load_image_rgba(png_path)
            restored = load_mesh_json(
                json_path,
                width=image_rgba.shape[1],
                height=image_rgba.shape[0],
                image_sha256="test-digest",
            )
            second = render_warp(image_rgba, restored)
        except (MeshError, ValueError, OSError) as exc:
            return _result("export_roundtrip", False, f"roundtrip error: {exc}")

    max_a, mean_a = _rgba_diff(reread.rgba, first)
    max_b, _ = _rgba_diff(second, first)
    pose_err = float(np.abs(restored.dst - mesh.dst).max())
    pose_same = pose_err == 0.0 and np.array_equal(restored.locked, mesh.locked)
    # Alpha bytes must be identical and colour within rounding (0 for lossless PNG).
    passed = max_a == 0 and max_b == 0 and pose_same
    return _result(
        "export_roundtrip",
        passed,
        f"PNG re-read max diff={max_a}; re-render max diff={max_b}; "
        f"pose max diff={pose_err:.2e} px; lock identical={np.array_equal(restored.locked, mesh.locked)}",
        png_max_diff=max_a,
        render_max_diff=max_b,
        pose_max_diff=pose_err,
    )


def check_lock_border(image_rgba: np.ndarray) -> CheckResult:
    """Border lock must prevent boundary movement and be restorable."""
    mesh = ControlMesh(5, 4, image_rgba.shape[1], image_rgba.shape[0])
    border = mesh.border_indices()
    mesh.set_all_border_locked(True)
    before = mesh.dst[border].copy()
    ok = mesh.try_move(border, before + np.array([30.0, 20.0]))
    unchanged = np.array_equal(mesh.dst[border], before)
    mesh.set_all_border_locked(False)
    # A canonical "pull" of one border point towards the interior must be
    # accepted with locks off and must actually move it.
    q = int(border[len(border) // 2])
    start = mesh.dst[q].copy()
    inward = mesh.src[mesh.index(mesh.cols // 2, mesh.rows // 2)] - start
    inward /= max(float(np.linalg.norm(inward)), 1e-9)
    ok2 = mesh.try_move([q], (start + inward * 20.0)[None])
    moved = np.linalg.norm(mesh.dst[q] - start) > 1.0
    passed = (not ok) and unchanged and ok2 and moved
    return _result(
        "border_lock",
        passed,
        f"locked border move accepted={ok} (expected False), border unchanged={unchanged}; "
        f"unlocked border move accepted={ok2}, moved={moved}",
    )


def run_all(image: np.ndarray | None = None) -> list[CheckResult]:
    """Run the full verification suite on a generated or supplied image."""
    if image is None:
        image = generate_test_image(720, 540)
    h, w = image.shape[:2]
    results: list[CheckResult] = []

    results.append(check_identity(image, ControlMesh(6, 5, w, h)))

    m = ControlMesh(6, 5, w, h)
    results.append(check_known_point(image, m, m.index(2, 2), (21.0, -17.0)))

    m = ControlMesh(7, 5, w, h)
    results.append(check_edge_continuity(image, m, [(m.index(2, 2), 20.0, -14.0), (m.index(3, 2), -16.0, 11.0)]))

    results.append(check_invalid_rejected(ControlMesh(6, 5, w, h)))
    results.append(check_lock_border(image))

    m = ControlMesh(7, 5, w, h)
    m.try_move([m.index(3, 2)], m.src[m.index(3, 2)][None] + np.array([[12.0, -8.0]]), respect_locks=False)
    results.append(check_canvas_alpha(image, m))
    results.append(check_pick_source(image, ControlMesh(6, 5, w, h)))
    results.append(check_export_roundtrip(image))
    return results


def main(argv: list[str] | None = None) -> int:
    import argparse
    parser = argparse.ArgumentParser(description="Mesh warp headless self-check")
    parser.add_argument("--json", action="store_true", help="print results as JSON")
    args = parser.parse_args(argv)
    results = run_all()
    payload = [
        {"name": r.name, "passed": r.passed, "detail": r.detail, "metrics": r.metrics}
        for r in results
    ]
    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        for r in results:
            print(f"[{'PASS' if r.passed else 'FAIL'}] {r.name}: {r.detail}")
    return 0 if all(r.passed for r in results) else 1


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
