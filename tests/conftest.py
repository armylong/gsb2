"""Shared pytest fixtures."""

from __future__ import annotations

import os

import numpy as np
import pytest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from mesh_warp.test_image import generate_test_image  # noqa: E402


@pytest.fixture(scope="session")
def test_image() -> np.ndarray:
    return generate_test_image(720, 540)


@pytest.fixture(scope="session")
def small_image() -> np.ndarray:
    return generate_test_image(320, 240)


@pytest.fixture(scope="session")
def qt_app():
    from PySide6.QtWidgets import QApplication

    app = QApplication.instance() or QApplication([])
    yield app


@pytest.fixture()
def gui_window(qt_app):
    from mesh_warp.gui.main_window import MainWindow

    window = MainWindow()
    window.resize(1000, 720)
    window._load_test_scene(None)
    yield window
    window.close()
    window.deleteLater()
