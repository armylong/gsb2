"""Shared fixtures for the test suite."""

from __future__ import annotations

import numpy as np
import pytest

from mblend.samples import make_sample


@pytest.fixture(scope="session")
def odd_pair() -> tuple[np.ndarray, np.ndarray]:
    return make_sample("odd_size")


@pytest.fixture(scope="session")
def sample_pairs() -> dict[str, tuple[np.ndarray, np.ndarray]]:
    return {
        name: make_sample(name)
        for name in ("brightness", "stripes", "blocks", "odd_size")
    }


@pytest.fixture()
def random_pair() -> tuple[np.ndarray, np.ndarray]:
    rng = np.random.default_rng(1234)
    a = rng.integers(0, 256, size=(97, 131, 3), dtype=np.uint8)
    b = rng.integers(0, 256, size=(97, 131, 3), dtype=np.uint8)
    return a, b
