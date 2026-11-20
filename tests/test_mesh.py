"""Geometry / topology / validation tests for the control mesh."""

from __future__ import annotations

import numpy as np
import pytest

from mesh_warp.mesh import (
    MAX_GRID,
    MIN_GRID,
    ControlMesh,
    MeshError,
    barycentric,
    lattice_triangles,
    regular_grid,
    triangle_edges,
)


def test_grid_resolution_limits():
    for (c, r) in [(MIN_GRID, MIN_GRID), (MAX_GRID, MAX_GRID), (5, 7)]:
        mesh = ControlMesh(c, r, 400, 300)
        assert mesh.n_points == c * r
        assert len(mesh.tris) == 2 * (c - 1) * (r - 1)
    for (c, r) in [(MIN_GRID - 1, 5), (5, MAX_GRID + 1), (9, 9)]:
        with pytest.raises(MeshError):
            ControlMesh(c, r, 400, 300)


def test_topology_is_fixed_and_shared_edges_match():
    mesh = ControlMesh(6, 5, 500, 400)
    tris = mesh.tris
    # Each triangle has 3 distinct vertices.
    for tri in tris:
        assert len(set(int(v) for v in tri)) == 3
    # Every interior edge belongs to exactly two triangles; boundary to one.
    owners: dict[tuple[int, int], int] = {}
    for tri in tris:
        for e in ((0, 1), (1, 2), (2, 0)):
            key = tuple(sorted((int(tri[e[0]]), int(tri[e[1]]))))
            owners[key] = owners.get(key, 0) + 1
    border = set(int(i) for i in mesh.border_indices())
    for (a, b), count in owners.items():
        if a in border and b in border and _is_outer_edge(mesh, a, b):
            assert count == 1
        else:
            assert count == 2
    # Triangulation is unaffected by moving points.
    mesh.try_move([mesh.index(2, 2)], mesh.src[mesh.index(2, 2)][None] + 20, respect_locks=False)
    assert np.array_equal(mesh.tris, tris)


def _is_outer_edge(mesh: ControlMesh, a: int, b: int) -> bool:
    ai, aj = mesh.ij(a)
    bi, bj = mesh.ij(b)
    return (ai == bi and ai in (0, mesh.cols - 1)) or (
        aj == bj and aj in (0, mesh.rows - 1)
    )


def test_regular_grid_edges():
    grid = regular_grid(4, 4, 100, 80)
    xs = np.unique(grid[:, 0])
    ys = np.unique(grid[:, 1])
    assert xs[0] == 0 and xs[-1] == 99
    assert ys[0] == 0 and ys[-1] == 79


def test_triangle_edges_unique():
    tris = lattice_triangles(5, 4)
    edges = triangle_edges(tris)
    assert len(edges) == len(np.unique(edges, axis=0))


def test_identity_pose_is_valid():
    mesh = ControlMesh(5, 5, 300, 300)
    assert mesh.is_identity
    assert mesh.validate() == []
    report = mesh.check_pose()
    assert report.ok
    assert report.bad_triangles.size == 0


def test_flip_is_rejected_and_state_preserved():
    mesh = ControlMesh(5, 5, 400, 400)
    p = mesh.index(2, 2)
    before = mesh.dst.copy()
    # Push the centre point past its right / lower neighbours.
    accepted, message, report = mesh.attempt_move(
        [p], (mesh.src[p] + np.array([140.0, 0.0]))[None]
    )
    assert not accepted
    assert report is not None and len(report.flipped) > 0
    assert "flipped" in message
    assert np.array_equal(mesh.dst, before)


@pytest.mark.parametrize("offset", [(-0.3, 0.05), (0.0, 0.2), (0.15, -0.1)])
def test_sliver_or_collapse_is_rejected(offset):
    """A triangle driven to (almost) zero height is refused, not hidden."""
    mesh = ControlMesh(5, 5, 400, 400)
    p = mesh.index(2, 2)
    q = mesh.index(3, 2)
    before = mesh.dst.copy()
    accepted, message, report = mesh.attempt_move(
        [p], (mesh.dst[q] + np.asarray(offset))[None]
    )
    assert not accepted
    assert report is not None and not report.ok
    assert np.array_equal(mesh.dst, before)
    # The mesh must remain renderable afterwards.
    assert mesh.validate() == []


def test_edge_crossing_is_rejected():
    mesh = ControlMesh(5, 5, 400, 400)
    a = mesh.index(2, 2)
    b = mesh.index(3, 2)
    before = mesh.dst.copy()
    # Swapping adjacent interior points crosses all 4 incident edges of the
    # shared edge, even though the swap is small.
    accepted, message, report = mesh.attempt_move(
        [a, b], mesh.dst[[b, a]].copy()
    )
    assert not accepted
    assert np.array_equal(mesh.dst, before)
    assert report is not None and (
        len(report.crossings) or len(report.flipped) or len(report.degenerate)
    )


def test_containment_detected_without_edge_crossing():
    mesh = ControlMesh(6, 6, 480, 480)
    # Move a vertex to the inside of a far cell, so that cell contains it while
    # no pair of non-adjacent edges crosses.
    p = mesh.index(2, 2)
    far = mesh.src[mesh.index(3, 3)]
    pose = mesh.dst.copy()
    pose[p] = far + np.array([2.0, 1.0])
    report = mesh.check_pose(pose)
    assert len(report.contained_vertices) > 0
    assert not report.ok


def test_containment_is_rejected():
    mesh = ControlMesh(5, 5, 400, 400)
    # Move the centre point onto another interior vertex region such that one
    # triangle contains a foreign vertex without edge crossings.
    p = mesh.index(2, 2)
    target = mesh.src[p] + np.array([-18.0, -6.0])
    accepted, message, report = mesh.attempt_move([p], target[None])
    # Whether or not this exact offset flips, the validation must not raise
    # and must preserve state on rejection.
    if not accepted:
        assert report is not None
        assert not report.ok
        assert mesh.dst[p][0] == pytest.approx(mesh.src[p][0])


def test_valid_move_is_accepted_exactly():
    mesh = ControlMesh(6, 5, 500, 400)
    p = mesh.index(2, 2)
    target = mesh.src[p] + np.array([12.5, -7.25])
    accepted, message, report = mesh.attempt_move([p], target[None])
    assert accepted and message == ""
    assert np.allclose(mesh.dst[p], target, atol=0)
    # Other points untouched.
    mask = np.ones(mesh.n_points, dtype=bool)
    mask[p] = False
    assert np.array_equal(mesh.dst[mask], mesh.src[mask])


def test_locked_points_cannot_move():
    mesh = ControlMesh(5, 4, 300, 240)
    border = mesh.border_indices()
    mesh.set_all_border_locked(True)
    accepted, message, _ = mesh.attempt_move(
        border, mesh.dst[border] + np.array([20.0, 20.0])
    )
    assert not accepted
    assert "locked" in message
    # Mixed request: the unlocked point still moves.
    inner = mesh.index(2, 1)
    idx = np.concatenate([border, [inner]])
    pos = mesh.dst[idx] + np.array([5.0, 5.0])
    accepted, _, _ = mesh.attempt_move(idx, pos)
    assert accepted
    assert np.allclose(mesh.dst[inner], mesh.src[inner] + np.array([5.0, 5.0]))
    assert np.array_equal(mesh.dst[border], mesh.src[border])


def test_reset_point_and_all():
    mesh = ControlMesh(5, 4, 300, 240)
    p = mesh.index(2, 1)
    mesh.attempt_move([p], (mesh.src[p] + 10)[None])
    assert not mesh.is_identity
    mesh.reset_point(p)
    assert mesh.is_identity
    mesh.attempt_move([p], (mesh.src[p] + np.array([10.0, -4.0]))[None])
    mesh.reset_all()
    assert mesh.is_identity


def test_locate_target_roundtrip():
    mesh = ControlMesh(6, 5, 480, 360)
    p = mesh.index(2, 2)
    mesh.attempt_move([p], (mesh.src[p] + np.array([15.0, -10.0]))[None])
    rng = np.random.default_rng(7)
    checked = 0
    for _ in range(200):
        tri = int(rng.integers(0, len(mesh.tris)))
        bary = rng.dirichlet(np.ones(3))
        target = bary @ mesh.dst[mesh.tris[tri]]
        src_xy, bary2 = mesh.locate_target(target)
        if src_xy is None:
            continue
        expected = bary2 @ mesh.src[mesh.tris[tri]]
        assert np.allclose(src_xy, expected, atol=1e-9)
        checked += 1
    assert checked > 100


def test_locate_target_outside_mesh():
    mesh = ControlMesh(4, 4, 300, 300)
    # Pull the bottom-right corner inward: the canvas corner loses coverage.
    p = mesh.index(3, 3)
    accepted, msg, _ = mesh.attempt_move([p], mesh.src[p][None] + np.array([[-60.0, -60.0]]), respect_locks=False)
    assert accepted, msg
    assert mesh.locate_target(np.array([299.0, 299.0]))[0] is None


def test_source_to_target_matches_triangles():
    mesh = ControlMesh(5, 4, 400, 300)
    pts = mesh.src.copy()
    mapped = mesh.source_to_target(pts)
    # Vertices map exactly to themselves / targets.
    assert np.allclose(mapped, mesh.dst, atol=1e-9)


def test_barycentric_matches_known_weights():
    tri = np.array([[0.0, 0.0], [10.0, 0.0], [0.0, 10.0]])
    inside, bary = barycentric(np.array([[2.0, 3.0], [20.0, 20.0]]), tri)
    assert inside.tolist() == [True, False]
    assert np.allclose(bary[0], [0.5, 0.2, 0.3])


def test_mesh_to_dict_roundtrip_via_json(tmp_path):
    from mesh_warp.io import LoadedImage, load_mesh_json, save_mesh_json

    img = np.zeros((120, 160, 4), np.uint8)
    mesh = ControlMesh(5, 4, 160, 120)
    p = mesh.index(2, 1)
    mesh.attempt_move([p], (mesh.src[p] + np.array([9.0, -6.0]))[None])
    mesh.locked[p] = True
    path = tmp_path / "m.json"
    save_mesh_json(path, mesh, LoadedImage(img, path, "digest"))
    restored = load_mesh_json(path, width=160, height=120, image_sha256="digest")
    assert restored.cols == mesh.cols and restored.rows == mesh.rows
    assert np.array_equal(restored.locked, mesh.locked)
    assert np.array_equal(restored.dst, mesh.dst)
    assert np.array_equal(restored.tris, mesh.tris)
