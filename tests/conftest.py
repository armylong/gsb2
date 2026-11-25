"""Shared fixtures for the photometric test-suite."""
from __future__ import annotations

import os
import sys

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest

from photometric import synthesis


@pytest.fixture(scope="session")
def qapp():
    from PySide6.QtWidgets import QApplication

    app = QApplication.instance() or QApplication([])
    yield app


@pytest.fixture(scope="session")
def sphere_scene():
    return synthesis.build_builtin("sphere", size=160)


@pytest.fixture(scope="session")
def relief_scene():
    return synthesis.build_builtin("relief", size=160)


@pytest.fixture(scope="session")
def sphere_result(sphere_scene):
    from photometric import solver

    return solver.solve(sphere_scene.images, sphere_scene.direction_matrix(),
                        sphere_scene.object_mask)


@pytest.fixture(scope="session")
def relief_result(relief_scene):
    from photometric import solver

    return solver.solve(relief_scene.images, relief_scene.direction_matrix(),
                        relief_scene.object_mask)
