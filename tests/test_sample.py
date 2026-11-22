import numpy as np
import numpy.testing as npt
import pytest

from tileviewer.sample import (
    SAMPLE_HEIGHT,
    SAMPLE_WIDTH,
    build_sample,
    corner_points,
)


def test_sample_is_odd_sized_rgb():
    image = build_sample(203, 129)
    assert image.size == (203, 129)
    assert image.mode == "RGB"


def test_sample_corners_are_marked_with_colours():
    image = build_sample(203, 129)
    array = np.array(image)
    expected = {
        "TL": (255, 70, 70),
        "TR": (70, 220, 120),
        "BL": (80, 150, 255),
        "BR": (255, 210, 60),
    }
    for name, x, y in corner_points(203, 129):
        assert tuple(int(v) for v in array[y, x]) == expected[name]


def test_sample_contains_fine_grid():
    image = build_sample(203, 129)
    array = np.array(image)
    # The 1px grid must produce visible row/column structure.
    assert len(np.unique(array[60, :, :], axis=0)) > 10
    assert len(np.unique(array[:, 120, :], axis=0)) > 10


def test_sample_default_size_is_odd_and_matches_docs():
    assert SAMPLE_WIDTH % 2 == 1
    assert SAMPLE_HEIGHT % 2 == 1


def test_sample_is_deterministic():
    a = np.array(build_sample(101, 77))
    b = np.array(build_sample(101, 77))
    npt.assert_array_equal(a, b)


def test_sample_rejects_tiny_sizes():
    with pytest.raises(ValueError):
        build_sample(32, 32)


def test_sample_cli_writes_png(tmp_path):
    from tileviewer.sample import main

    target = tmp_path / "sample.png"
    assert main(["--out", str(target), "--width", "121", "--height", "97"]) == 0
    from PIL import Image

    with Image.open(target) as image:
        assert image.size == (121, 97)
