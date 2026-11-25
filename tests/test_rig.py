"""The rig verdict must flag rigs that cannot separate surface orientations."""
from __future__ import annotations

import numpy as np
import pytest

from photometric import rig, vecmath


def test_well_spread_rig_passes():
    q = rig.assess([rig.LightSpec(a, 45) for a in (0, 90, 180, 270)])
    assert q.well_posed
    assert q.covers_hemisphere
    assert q.rank == 3
    assert q.smallest_eigenvalue > 0.5
    assert "可以区分" in q.headline


def test_three_lights_same_side_warn():
    # all three azimuths inside a 30-degree arc: horizontally blind
    q = rig.assess([rig.LightSpec(0, 40), rig.LightSpec(12, 40), rig.LightSpec(24, 40)])
    assert not q.well_posed
    assert q.smallest_eigenvalue < 0.1
    assert "不足以区分" in q.headline


def test_coplanar_elevations_are_degenerate():
    # three lights all at zero elevation span only a plane through the origin?
    # they do span 3-D individually, but all e_z=0, so the z direction of g is
    # unconstrained: the normal matrix is singular.
    q = rig.assess([rig.LightSpec(0, 0), rig.LightSpec(120, 0), rig.LightSpec(240, 0)])
    assert not q.well_posed
    assert q.smallest_eigenvalue < 1e-6


def test_two_lights_cannot_work():
    q = rig.assess([rig.LightSpec(0, 45), rig.LightSpec(90, 45)])
    assert not q.well_posed
    assert q.rank < 3


def test_disabled_lights_are_ignored():
    specs = [rig.LightSpec(0, 45), rig.LightSpec(120, 45), rig.LightSpec(240, 45),
             rig.LightSpec(60, 45, enabled=False)]
    magic = rig.assess(specs[:3])
    assert rig.assess(specs).smallest_eigenvalue == pytest.approx(magic.smallest_eigenvalue)


def test_duplicate_direction_is_flagged_per_light():
    specs = [rig.LightSpec(0, 45), rig.LightSpec(90, 45), rig.LightSpec(180, 45),
             rig.LightSpec(2, 45)]
    q = rig.assess(specs)
    assert len(q.per_light_notes) == 4
    assert not q.per_light_ok[3]
    assert "几乎重复" in q.per_light_notes[3]


def test_coverage_gap_detected():
    # Lights only on the right half; the left side of the object never sees one.
    q = rig.assess([rig.LightSpec(0, 40), rig.LightSpec(90, 40), rig.LightSpec(180, 40)])
    assert q.well_posed
    assert q.max_gap_deg == pytest.approx(180.0)
    # exactly half the compass is empty -> still an uncovered side
    assert "覆盖不足" in q.headline


def test_per_pixel_eigenvalue_matches_bruteforce():
    dirs = np.stack([vecmath.light_from_az_el(a, e)
                     for a, e in [(0, 45), (120, 45), (240, 45), (270, 20)]])
    usable = np.array([[[True, True], [False, True]],
                       [[True, True], [True, True]],
                       [[False, True], [True, True]],
                       [[True, False], [True, True]]])
    lam = rig.per_pixel_min_eigenvalue(dirs, usable)
    for y in range(2):
        for x in range(2):
            d = dirs[usable[:, y, x]]
            if len(d) < 3:
                continue
            expected = np.linalg.eigvalsh(d.T @ d)[0]
            assert lam[y, x] == pytest.approx(expected, abs=1e-9)
