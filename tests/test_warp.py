"""Pixel-level tests for the warper: identity, continuity, transparency, edges."""

from __future__ import annotations

import numpy as np
import pytest

from mesh_warp.mesh import ControlMesh
from mesh_warp.warp import premultiply, render_warp, unpremultiply


def _move(mesh: ControlMesh, i: int, j: int, dx: float, dy: float) -> None:
    p = mesh.index(i, j)
    ok, msg, _ = mesh.attempt_move([p], (mesh.src[p] + np.array([dx, dy]))[None])
    assert ok, msg


def test_identity_is_bit_exact(test_image):
    mesh = ControlMesh(6, 5, test_image.shape[1], test_image.shape[0])
    out = render_warp(test_image, mesh)
    assert np.array_equal(out, test_image)


def test_identity_reset_after_moves(test_image):
    mesh = ControlMesh(5, 4, test_image.shape[1], test_image.shape[0])
    _move(mesh, 2, 1, 20, -12)
    assert not np.array_equal(render_warp(test_image, mesh), test_image)
    mesh.reset_all()
    assert np.array_equal(render_warp(test_image, mesh), test_image)


def test_render_rejects_invalid_pose(test_image):
    mesh = ControlMesh(5, 4, test_image.shape[1], test_image.shape[0])
    bad = mesh.dst.copy()
    p = mesh.index(2, 1)
    bad[p] = bad[p] + np.array([mesh.width * 0.6, 0.0])
    with pytest.raises(Exception):
        render_warp(test_image, _mesh_with_pose(mesh, bad))


def _mesh_with_pose(mesh: ControlMesh, pose: np.ndarray) -> ControlMesh:
    clone = ControlMesh(mesh.cols, mesh.rows, mesh.width, mesh.height)
    clone.dst = pose.copy()
    return clone


def _ramp(w: int, h: int) -> np.ndarray:
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    out = np.empty((h, w, 4), np.uint8)
    out[..., 0] = np.clip(xx * 255.0 / (w - 1) + 0.5, 0, 255).astype(np.uint8)
    out[..., 1] = np.clip(yy * 255.0 / (h - 1) + 0.5, 0, 255).astype(np.uint8)
    out[..., 2] = 128
    out[..., 3] = 255
    return out


def test_shared_edges_have_no_cracks_or_seams():
    """Warp a coordinate ramp; check adjacent triangles agree on their edge."""
    w, h = 480, 360
    ramp = _ramp(w, h)
    for cols, rows in [(4, 4), (6, 5), (8, 8)]:
        mesh = ControlMesh(cols, rows, w, h)
        _move(mesh, cols // 2, rows // 2, 28.0, -19.0)
        if cols > 4:
            _move(mesh, 1, 1, 17.0, 12.0)
        out = render_warp(ramp, mesh)
        # Alpha is 255 wherever the (full-canvas) mesh covers; no thin
        # transparent line may appear inside it.
        assert out[..., 3].min() == 255
        # Compare the decoded ramp values across every interior mesh edge:
        # sample 1.5 px to either side and require a smooth transition.
        jump = _max_cross_edge_jump(mesh, out)
        assert jump <= 14.0, f"{cols}x{rows}: jump {jump}"


def _max_cross_edge_jump(mesh: ControlMesh, out: np.ndarray) -> float:
    owners: dict[tuple[int, int], list[int]] = {}
    for k, tri in enumerate(mesh.tris):
        for e in ((0, 1), (1, 2), (2, 0)):
            key = tuple(sorted((int(tri[e[0]]), int(tri[e[1]]))))
            owners.setdefault(key, []).append(k)
    worst = 0.0
    h, w = out.shape[:2]
    for (a, b), tris in owners.items():
        if len(tris) != 2:
            continue
        if np.any(mesh.dst[[a, b]] <= 2.0):
            continue
        if np.any(mesh.dst[[a, b], 0] >= w - 3) or np.any(mesh.dst[[a, b], 1] >= h - 3):
            continue
        mid = mesh.dst[[a, b]].mean(axis=0)
        third = None
        for v in mesh.tris[tris[0]]:
            if int(v) not in (a, b):
                third = mesh.dst[int(v)]
                break
        if third is None:
            continue
        inward = third - mid
        n = np.linalg.norm(inward)
        if n < 1e-6:
            continue
        inward /= n
        for s in np.linspace(0.25, 0.75, 9):
            p = mesh.dst[a] * (1 - s) + mesh.dst[b] * s
            vals = []
            for sign in (-1.0, 1.0):
                x, y = p + inward * 1.5 * sign
                xi, yi = int(round(x)), int(round(y))
                if 0 <= yi < h and 0 <= xi < w:
                    vals.append(out[yi, xi, :2].astype(float))
            if len(vals) == 2:
                worst = max(worst, float(np.abs(vals[0] - vals[1]).max()))
    return worst


def test_warp_does_not_scale_whole_image():
    """Local deformation must leave far-away content where it was."""
    w, h = 400, 400
    ramp = _ramp(w, h)
    mesh = ControlMesh(5, 5, w, h)
    _move(mesh, 2, 2, 22.0, -16.0)
    out = render_warp(ramp, mesh)
    # A patch near the bottom-right corner is far from the moved point and its
    # containing triangles; its coordinate ramp must be unchanged there.
    patch = (slice(340, 380), slice(340, 380))
    assert np.array_equal(out[patch], ramp[patch])


def test_large_sheet_topology_seams():
    """8x8 mesh with several simultaneous moves stays seam-free."""
    w, h = 640, 480
    ramp = _ramp(w, h)
    mesh = ControlMesh(8, 8, w, h)
    moves = [(2, 2, 14.0, -9.0), (5, 3, -12.0, 15.0), (4, 5, 9.0, 8.0)]
    for i, j, dx, dy in moves:
        _move(mesh, i, j, dx, dy)
    out = render_warp(ramp, mesh)
    assert out[..., 3].min() == 255
    assert _max_cross_edge_jump(mesh, out) <= 14.0


def test_outside_canvas_is_transparent():
    # Small image, mesh boundary pulled inward: the canvas corner has no source.
    w, h = 200, 160
    img = np.full((h, w, 4), 200, np.uint8)
    img[..., 3] = 255
    mesh = ControlMesh(4, 4, w, h)
    corner = mesh.index(3, 3)
    ok, msg, _ = mesh.attempt_move([corner], (mesh.src[corner] + np.array([-50.0, -40.0]))[None], respect_locks=False)
    assert ok, msg
    out = render_warp(img, mesh)
    assert out[h - 1, w - 1, 3] == 0
    assert np.all(out[h - 10:, w - 10:, 3] == 0)


def test_soft_alpha_edge_has_no_black_fringe():
    """Interpolation must not blend colour with the black of transparent px."""
    w, h = 160, 160
    img = np.zeros((h, w, 4), np.uint8)
    # White disc with soft alpha on a transparent background; RGB stays white
    # even where alpha is zero (the case that produces dark fringes if handled
    # naively).
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    r = np.hypot(xx - w / 2, yy - h / 2)
    alpha = np.clip((60.0 - r) / 12.0, 0, 1)
    img[..., :3] = 255
    img[..., 3] = (alpha * 255 + 0.5).astype(np.uint8)

    mesh = ControlMesh(5, 4, w, h)
    _move(mesh, 2, 1, 16.0, -10.0)
    out = render_warp(img, mesh)
    partial = (out[..., 3] > 20) & (out[..., 3] < 240)
    assert partial.any()
    # Premultiplied interpolation of white keeps unpremultiplied RGB white.
    assert out[partial][:, :3].min() >= 250


def test_repeated_render_is_deterministic():
    w, h = 400, 320
    img = _ramp(w, h)
    mesh = ControlMesh(6, 5, w, h)
    _move(mesh, 2, 2, 13.0, -11.0)
    a = render_warp(img, mesh)
    b = render_warp(img, mesh)
    assert np.array_equal(a, b)


def test_premultiply_roundtrip():
    rng = np.random.default_rng(3)
    rgba = rng.integers(0, 256, (16, 16, 4), dtype=np.uint8)
    rgba[..., 3] = 0
    premul = premultiply(rgba)
    assert np.all(premul[..., :3] == 0)
    back = unpremultiply(premul)
    # RGB under zero alpha is normalized to 0; alpha itself round-trips.
    assert np.array_equal(back[..., 3], rgba[..., 3])


def test_control_point_destination_is_exact():
    """The moved vertex's source pixel maps exactly to the target pixel."""
    w, h = 500, 400
    img = _ramp(w, h)
    mesh = ControlMesh(6, 5, w, h)
    p = mesh.index(2, 2)
    delta = np.array([23.0, -17.0])
    mesh.attempt_move([p], (mesh.src[p] + delta)[None])
    out = render_warp(img, mesh)
    tx, ty = int(round(mesh.dst[p][0])), int(round(mesh.dst[p][1]))
    # Decode ramp values back to source coordinates; allow one quantization
    # step (~2 px) plus rounding of the probe location.
    sx = float(out[ty, tx, 0]) * (w - 1) / 255.0
    sy = float(out[ty, tx, 1]) * (h - 1) / 255.0
    assert abs(sx - mesh.src[p][0]) <= 3.0
    assert abs(sy - mesh.src[p][1]) <= 3.0


def test_alpha_boundary_stays_antialiased():
    """A deformed soft edge should not gain hard 0/255 alpha steps."""
    w, h = 240, 240
    img = np.zeros((h, w, 4), np.uint8)
    img[:, : w // 2] = (255, 255, 255, 255)
    # vertical soft gradient on the right half
    grad = np.linspace(255, 0, w - w // 2, dtype=np.float32)
    img[:, w // 2 :, :3] = 255
    img[:, w // 2 :, 3] = (grad + 0.5).astype(np.uint8)
    mesh = ControlMesh(5, 5, w, h)
    _move(mesh, 2, 2, 10.0, 10.0)
    out = render_warp(img, mesh)
    counts = np.bincount(out[..., 3].ravel(), minlength=256)
    intermediate = counts[16:240].sum()
    assert intermediate > 2000
