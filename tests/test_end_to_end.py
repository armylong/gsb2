"""End-to-end checks of the behaviour the tool promises.

These mirror the GUI's 本地复查 but are expressed as pytest assertions so a
regression fails loudly.
"""

import os

import pytest
from PIL import Image

from cropkit.imaging import LoadedImage, export_crops, verify_export_edges
from cropkit.orientation import DISPLAY_CORNER_SOURCES, Orientation
from cropkit.project import (CropItem, Marker, Project, SourceInfo,
                             adapt_project, apply_reconciliation,
                             compare_sources, read_source_info)
from cropkit.rectmath import Rect
from cropkit.samples import (CORNER_COLORS, make_corner_probe, make_sheet,
                             save_with_orientation)


def corner_colour(img, corner, size=20):
    w, h = img.size
    x = 0 if corner.endswith("L") else w - size
    y = 0 if corner.startswith("T") else h - size
    patch = img.crop((x, y, x + size, y + size)).convert("RGB")
    data = patch.tobytes()
    return tuple(sum(data[i::3]) // (len(data) // 3) for i in range(3))


def nearest(colour):
    best, dist = None, None
    for name, ref in CORNER_COLORS.items():
        d = sum((a - b) ** 2 for a, b in zip(colour, ref))
        if dist is None or d < dist:
            best, dist = name, d
    return best


@pytest.mark.parametrize("value", range(1, 9))
def test_all_eight_orientations_restore_the_upright_sheet(tmp_path, value):
    reference = make_sheet(True, (320, 240))
    path = tmp_path / f"o{value}.jpg"
    save_with_orientation(reference, path, value)
    loaded = LoadedImage(str(path))
    assert loaded.orientation.value == value
    assert loaded.display_size == reference.size
    diff = sum(abs(a - b) for a, b in
               zip(loaded.display.tobytes(), reference.tobytes()))
    assert diff / (len(reference.tobytes())) < 4


@pytest.mark.parametrize("value", range(1, 9))
def test_corner_directions(tmp_path, value):
    probe = make_corner_probe((160, 120))
    path = tmp_path / f"p{value}.jpg"
    save_with_orientation(probe, path, value, quality=98)
    loaded = LoadedImage(str(path))
    # the upright image must show the original corner colours
    for corner in ("TL", "TR", "BL", "BR"):
        assert nearest(corner_colour(loaded.display, corner)) == corner
    # and the stored pixels must match the declared corner mapping
    for display_corner, stored_corner in \
            DISPLAY_CORNER_SOURCES[value].items():
        assert nearest(corner_colour(loaded.stored, stored_corner)) == \
            display_corner


def test_mirror_orientations_swap_the_right_axis(tmp_path):
    mapping2 = Orientation(2).corner_sources()
    assert mapping2 == {"TL": "TR", "TR": "TL", "BL": "BR", "BR": "BL"}
    mapping4 = Orientation(4).corner_sources()
    assert mapping4 == {"TL": "BL", "TR": "BR", "BL": "TL", "BR": "TR"}


def test_edge_crop_has_exact_size_and_pixels(tmp_path):
    reference = make_sheet(True, (320, 240))
    path = tmp_path / "edge.jpg"
    save_with_orientation(reference, path, 6, quality=96)
    loaded = LoadedImage(str(path))
    w, h = loaded.display_size
    rect = Rect.from_size(w - 17, h - 11, 17, 11)
    piece = loaded.upright_crop(rect)
    assert piece.size == (17, 11)
    assert piece.tobytes() == loaded.display.crop(
        (w - 17, h - 11, w, h)).tobytes()


def test_export_is_pixel_identical_and_mask_matches(tmp_path):
    reference = make_sheet(True, (320, 240))
    path = tmp_path / "e.jpg"
    save_with_orientation(reference, path, 5, quality=96)
    loaded = LoadedImage(str(path))
    rect = Rect.from_size(4, 7, 59, 43)
    result = export_crops(loaded, [CropItem("a", rect)],
                          [Marker("in", 10, 10), Marker("out", 1, 1)],
                          str(tmp_path / "out"))[0]
    with Image.open(result.crop_path) as png:
        assert png.size == rect.size
        assert png.convert("RGB").tobytes() == loaded.display.crop(
            (rect.x0, rect.y0, rect.x1, rect.y1)).tobytes()
    with Image.open(result.mask_path) as mask:
        assert mask.size == rect.size
    assert len(result.included) == 1 and len(result.outside) == 1
    assert verify_export_edges(loaded, [result])[0][1]


def test_replacement_is_flagged_and_adapted(tmp_path):
    reference = make_sheet(True, (320, 240))
    path = tmp_path / "r.jpg"
    save_with_orientation(reference, path, 6, quality=96)
    saved = read_source_info(str(path))
    project = Project(source=saved,
                      crops=[CropItem("a", Rect.from_size(20, 30, 100, 80))],
                      markers=[Marker("m", 40, 50)])
    project_path = tmp_path / "p.cropkit.json"
    project.save(str(project_path))

    save_with_orientation(make_sheet(True, (400, 300)), str(path), 8,
                          quality=96)
    reopened = Project.load(str(project_path))
    actual = read_source_info(str(path))
    diffs = {d.field for d in compare_sources(reopened.source, actual)}
    assert {"stored_size", "orientation", "hash"} <= diffs
    recon = adapt_project(reopened, actual)
    assert recon.needs_confirmation
    rect = recon.adapted_rects[0]
    assert 0 <= rect.x0 < rect.x1 <= actual.display_size[0]
    apply_reconciliation(reopened, actual, recon)
    assert reopened.source == actual
    assert reopened.crops[0].rect == rect


def test_relocated_but_identical_source_needs_no_confirmation(tmp_path):
    reference = make_sheet(True, (240, 200))
    a = tmp_path / "a.jpg"
    b = tmp_path / "b.jpg"
    save_with_orientation(reference, a, 3)
    os.replace(a, b)
    saved = SourceInfo(str(a), (240, 200), 3, "")
    actual = read_source_info(str(b))
    recon = adapt_project(Project(source=saved), actual)
    assert not recon.needs_confirmation


def test_nested_border_crop_from_every_orientation(tmp_path):
    reference = make_sheet(True, (240, 200))
    rect = Rect.from_size(0, 0, 240, 200)
    for value in range(1, 9):
        path = tmp_path / f"n{value}.jpg"
        save_with_orientation(reference, path, value, quality=96)
        loaded = LoadedImage(str(path))
        assert loaded.upright_crop(rect).size == (240, 200)
