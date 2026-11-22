import math

import pytest

from tileviewer.geometry import (
    LevelGeometry,
    Rect,
    choose_display_level,
    choose_level_for_zoom,
    fit_zoom,
    level_sizes,
    map_level_to_original,
    map_original_to_level,
)


def test_rect_half_open_and_clip():
    rect = Rect(2, 3, 4, 5)
    assert rect.x2 == 6 and rect.y2 == 8
    assert rect.contains_pixel(2, 3)
    assert not rect.contains_pixel(6, 3)
    assert rect.clipped_to(Rect(0, 0, 4, 4)) == Rect(2, 3, 2, 1)
    assert rect.clipped_to(Rect(10, 10, 5, 5)) == Rect(0, 0, 0, 0)


def test_level_sizes_keeps_odd_edges():
    sizes = level_sizes(4001, 2501)
    assert sizes[0] == (4001, 2501)
    for (w0, h0), (w1, h1) in zip(sizes, sizes[1:], strict=False):
        assert w1 == math.ceil(w0 / 2)
        assert h1 == math.ceil(h0 / 2)
        assert w1 * 2 >= w0 and h1 * 2 >= h0
    # The finest level still resolves the last original pixel.
    assert sizes[-1][0] >= 1 and sizes[-1][1] >= 1


def test_level_sizes_stops_at_min_and_respects_cap():
    sizes = level_sizes(1000, 800, min_size=256)
    # Stops at the first level whose long side is at most min_size.
    assert sizes[-1] == (250, 200)
    assert sizes[-2] == (500, 400)
    assert len(level_sizes(10**6, 10**6, max_levels=4)) == 4


def test_core_tiles_cover_level_exactly():
    for width, height, tile in [(4001, 2501, 512), (53, 37, 16), (513, 512, 512)]:
        geom = LevelGeometry(width, height, tile, margin=7)
        covered = [[0] * width for _ in range(height)]
        for spec in geom.iter_tiles():
            for y in range(spec.core.y, spec.core.y2):
                for x in range(spec.core.x, spec.core.x2):
                    covered[y][x] += 1
        assert all(value == 1 for row in covered for value in row)
        assert len(list(geom.iter_tiles())) == geom.tile_count


def test_last_tile_keeps_remaining_pixels():
    geom = LevelGeometry(1000, 700, 256, margin=0)
    assert (geom.cols, geom.rows) == (4, 3)
    last = geom.core_rect(3, 2)
    assert last == Rect(768, 512, 232, 188)
    assert last.x2 == 1000 and last.y2 == 700


def test_margins_are_clipped_but_include_neighbourhood():
    geom = LevelGeometry(1000, 700, 256, margin=16)
    middle = geom.tile(1, 1)
    assert middle.core == Rect(256, 256, 256, 256)
    assert middle.full == Rect(240, 240, 288, 288)
    corner = geom.tile(0, 0)
    assert corner.full == Rect(0, 0, 272, 272)
    assert corner.left_margin == 0 and corner.top_margin == 0
    last = geom.tile(3, 2)
    assert last.full.x2 == 1000 and last.full.y2 == 700


def test_margin_must_be_smaller_than_tile():
    with pytest.raises(ValueError):
        LevelGeometry(100, 100, 64, margin=64)


def test_tiles_intersecting_region():
    geom = LevelGeometry(1000, 700, 256, margin=8)
    tiles = list(geom.tiles_intersecting(Rect(250, 250, 20, 20)))
    assert [(t.col, t.row) for t in tiles] == [(0, 0), (1, 0), (0, 1), (1, 1)]
    assert list(geom.tiles_intersecting(Rect(-100, -100, 10, 10))) == []


def test_tile_index_at():
    geom = LevelGeometry(1000, 700, 256)
    assert geom.tile_index_at(0, 0) == (0, 0)
    assert geom.tile_index_at(255, 255) == (0, 0)
    assert geom.tile_index_at(256, 256) == (1, 1)
    assert geom.tile_index_at(1000, 0) is None


def test_original_level_roundtrip():
    x, y = 1234.5, 987.25
    lx, ly = map_original_to_level(x, y, 4001, 2501, 2001, 1251)
    assert map_level_to_original(lx, ly, 2001, 1251, 4001, 2501) == pytest.approx(
        (x, y)
    )


def test_choose_level_for_zoom_is_never_too_coarse_to_upscale():
    sizes = level_sizes(4001, 2501)
    # At 1:1 the original level is required.
    assert choose_level_for_zoom(sizes, 4001, 2501, 1.0) == 0
    # Zoomed far out, the coarsest level wins.
    assert choose_level_for_zoom(sizes, 4001, 2501, 0.001) == len(sizes) - 1


def test_choose_display_level_prefers_closest_available():
    sizes = level_sizes(4001, 2501)
    # If only coarse levels exist, pick the finest available.
    assert choose_display_level(sizes, [2, 3, 4], 4001, 1.0) == 2
    assert choose_display_level(sizes, [0, 4], 4001, 0.5) == 0
    assert choose_display_level(sizes, [], 4001, 1.0) is None


def test_fit_zoom_and_guards():
    assert fit_zoom(1000, 500, 4001, 2501) == pytest.approx(500 / 2501)
    with pytest.raises(ValueError):
        fit_zoom(0, 0, 0, 10)
