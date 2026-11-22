import os
import sys
from pathlib import Path

import pytest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


@pytest.fixture(scope="session")
def qapp():
    from PySide6.QtWidgets import QApplication

    app = QApplication.instance() or QApplication([])
    yield app


@pytest.fixture
def odd_rgb_array():
    """Small odd-sized RGB array with unique-ish per-pixel colours."""
    import numpy as np

    height, width = 37, 53
    ys, xs = np.mgrid[0:height, 0:width]
    array = np.stack(
        [xs * 4 % 256, ys * 6 % 256, (xs * 7 + ys * 11) % 256], axis=2
    ).astype(np.uint8)
    return array


def write_png(path: Path, array) -> Path:
    from PIL import Image

    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(array).save(path)
    return path


@pytest.fixture
def source_png(tmp_path, odd_rgb_array):
    return write_png(tmp_path / "odd.png", odd_rgb_array)
