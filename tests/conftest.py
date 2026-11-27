"""pytest 共享夹具."""
import numpy as np
import pytest

from photostereo.geometry import ring_rig, spherical_to_dir
from photostereo.synthetic import (
    make_bumpy_plate_scene,
    make_hemisphere_scene,
    render,
)


@pytest.fixture
def rng():
    return np.random.default_rng(42)


@pytest.fixture
def hemi():
    return make_hemisphere_scene(size=96)


@pytest.fixture
def plate():
    return make_bumpy_plate_scene(size=96)


@pytest.fixture
def rig():
    dirs = ring_rig(8, elevation_deg=45.0, start_azimuth_deg=22.5)
    strengths = np.full(8, 1.0)
    return dirs, strengths


@pytest.fixture
def rendered_hemi(hemi, rig, rng):
    dirs, strengths = rig
    return render(hemi, dirs, strengths, rng=rng)


@pytest.fixture
def rendered_plate(plate, rig, rng):
    dirs, strengths = rig
    return render(plate, dirs, strengths, rng=rng)
