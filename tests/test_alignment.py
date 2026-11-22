"""End-to-end checks that level coordinates really map onto original pixels.

These tests answer the headline question ("do the reduced preview and the
original share one coordinate system?") on synthetic marker images where
the expected location can be computed independently.
"""

import math

import numpy as np
import pytest

from tests.conftest import write_png
from tileviewer.cache import CacheConfig, CacheManager
from tileviewer.geometry import (
    map_level_to_original,
    map_original_to_level,
)
from tileviewer.source import load_source


def _blob_image(width: int, height: int, centre=(2000, 1250), half=12):
    """Black image with a solid white square, easy to locate after scaling."""
    array = np.zeros((height, width, 3), np.uint8)
    cx, cy = centre
    array[max(0, cy - half) : cy + half, max(0, cx - half) : cx + half, :] = 255
    return array


def _blob_centroid(level: np.ndarray) -> tuple[float, float]:
    weight = level[:, :, 0].astype(np.float64)
    total = weight.sum()
    assert total > 0
    ys, xs = np.indices(weight.shape)
    return float((xs * weight).sum() / total), float((ys * weight).sum() / total)


@pytest.mark.parametrize("centre", [(2000, 1250), (40, 40), (3950, 2450)])
def test_scaled_blob_lands_where_the_mapping_says(tmp_path, centre):
    width, height = 4001, 2501
    source = load_source(
        write_png(tmp_path / "blob.png", _blob_image(width, height, centre))
    )
    manager = CacheManager(
        tmp_path / "cache",
        source,
        CacheConfig(tile_size=512, margin=8, resample="bilinear"),
    )
    manager.generate()
    for index, (level_w, level_h) in enumerate(manager.info.sizes):
        expected_x, expected_y = map_original_to_level(
            *centre, width, height, level_w, level_h
        )
        measured_x, measured_y = _blob_centroid(manager.stitch_level(index))
        tolerance = 2.0 + max(level_w / width, 1.0)
        assert measured_x == pytest.approx(expected_x, abs=tolerance), (
            f"level {index}: blob at {measured_x}, expected {expected_x}"
        )
        assert measured_y == pytest.approx(expected_y, abs=tolerance)
        # The inverse mapping returns the original coordinate.
        back = map_level_to_original(
            expected_x, expected_y, level_w, level_h, width, height
        )
        assert back[0] == pytest.approx(centre[0], abs=1e-6)
        assert back[1] == pytest.approx(centre[1], abs=1e-6)


def test_level_scales_are_exact_size_ratios(tmp_path):
    width, height = 4001, 2501
    array = np.zeros((height, width, 3), np.uint8)
    source = load_source(write_png(tmp_path / "blank.png", array))
    manager = CacheManager(tmp_path / "cache", source, CacheConfig(tile_size=512))
    for (level_w, level_h) in manager.info.sizes:
        lx0, ly0 = map_original_to_level(100, 200, width, height, level_w, level_h)
        lx1, ly1 = map_original_to_level(
            3500, 2200, width, height, level_w, level_h
        )
        assert lx1 / level_w == pytest.approx(3500 / width, abs=1e-9)
        assert ly1 / level_h == pytest.approx(2200 / height, abs=1e-9)
        assert (lx0, ly0) != (lx1, ly1)
        # Proportional mapping keeps rectangles on the same relative position.
        assert lx0 / level_w == pytest.approx(100 / width, abs=1e-9)
        assert ly0 / level_h == pytest.approx(200 / height, abs=1e-9)


def test_odd_tail_pixels_are_kept_in_every_level(tmp_path):
    """Ceiling division: no original pixel is dropped by the pyramid sizing."""
    width, height = 4001, 2501
    array = np.zeros((height, width, 3), np.uint8)
    source = load_source(write_png(tmp_path / "blank.png", array))
    manager = CacheManager(tmp_path / "cache", source, CacheConfig(tile_size=256))
    sizes = manager.info.sizes
    for index, (level_w, level_h) in enumerate(sizes):
        if index == 0:
            continue
        prev_w, prev_h = sizes[index - 1]
        assert level_w == (prev_w + 1) // 2
        assert level_h == (prev_h + 1) // 2
        assert level_w * 2 >= prev_w and level_h * 2 >= prev_h

        # Tile cores must still cover the last row/column of the level.
        geom = manager.geometry(index)
        last_col = geom.core_rect(geom.cols - 1, 0)
        last_row = geom.core_rect(0, geom.rows - 1)
        assert last_col.x2 == level_w
        assert last_row.y2 == level_h


def test_original_pointer_resolves_to_correct_tile_on_every_level(tmp_path):
    width, height = 4001, 2501
    array = np.zeros((height, width, 3), np.uint8)
    source = load_source(write_png(tmp_path / "blank.png", array))
    manager = CacheManager(
        tmp_path / "cache", source, CacheConfig(tile_size=256, margin=16)
    )
    probes = [(0, 0), (255, 255), (256, 256), (4000, 2500)]
    for index, (level_w, level_h) in enumerate(manager.info.sizes):
        geom = manager.geometry(index)
        for ox, oy in probes:
            lx, ly = map_original_to_level(ox, oy, width, height, level_w, level_h)
            px = min(int(math.floor(lx)), level_w - 1)
            py = min(int(math.floor(ly)), level_h - 1)
            col, row = geom.tile_index_at(px, py)
            tile = geom.tile(col, row)
            assert tile.core.contains_pixel(px, py)
            assert tile.full.x <= tile.core.x and tile.full.y <= tile.core.y
            assert tile.full.x2 >= tile.core.x2 and tile.full.y2 >= tile.core.y2
            # The same original point lands in the proportionally scaled core.
            assert (
                tile.core.x / level_w
                <= ox / width
                < tile.core.x2 / level_w
                or tile.core.x2 == level_w
            )


def test_level_0_is_the_original_pixel_grid(tmp_path):
    width, height = 4001, 2501
    array = np.random.default_rng(11).integers(
        0, 256, (height, width, 3), dtype=np.uint8
    )
    source = load_source(write_png(tmp_path / "noise.png", array))
    manager = CacheManager(
        tmp_path / "cache", source, CacheConfig(tile_size=256, margin=8)
    )
    manager.generate()
    assert np.array_equal(manager.stitch_level(0), source.array)
