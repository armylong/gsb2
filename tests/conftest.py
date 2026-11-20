"""pytest 公共夹具。"""

import sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from content_aware import demos  # noqa: E402
from content_aware.engine import carve_width  # noqa: E402


@pytest.fixture(scope="session")
def scene():
    image, markers = demos.make_demo_scene(width=400, height=240)
    return {"image": image, "markers": markers}


@pytest.fixture(scope="session")
def carve_normal(scene):
    image = scene["image"]
    h, w = image.shape[:2]
    target = int(round(w * 0.75))
    outcome = carve_width(image, np.zeros((h, w), dtype=bool), target)
    return outcome
