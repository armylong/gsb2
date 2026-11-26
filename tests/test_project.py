import json

import pytest

from cropkit.project import (CropItem, Marker, Project, SourceInfo,
                             adapt_project, apply_reconciliation,
                             compare_sources, read_source_info)
from cropkit.rectmath import Rect
from cropkit.samples import make_sheet, save_with_orientation


def make_source(path, stored=(100, 80), orientation=1, sha="hash-1"):
    return SourceInfo(path, stored, orientation, sha)


def test_round_trip(tmp_path):
    project = Project(
        source=make_source("/x/a.jpg"),
        crops=[CropItem("一", Rect.from_size(1, 2, 3, 4)),
               CropItem("二", Rect.from_size(5, 6, 7, 8), enabled=False)],
        markers=[Marker("m", 9, 10)],
        ratio="4:3",
    )
    path = tmp_path / "p.cropkit.json"
    project.save(str(path))
    loaded = Project.load(str(path))
    assert loaded.source.stored_size == (100, 80)
    assert [c.name for c in loaded.crops] == ["一", "二"]
    assert loaded.crops[1].enabled is False
    assert loaded.crops[0].rect.as_tuple() == (1, 2, 3, 4)
    assert loaded.markers[0].point == (9, 10)
    assert loaded.ratio == "4:3"


def test_save_is_atomic(tmp_path):
    path = tmp_path / "p.json"
    project = Project(source=make_source("/x/a.jpg"),
                      crops=[CropItem("a", Rect.from_size(0, 0, 5, 5))])
    project.save(str(path))
    first = path.read_text(encoding="utf-8")
    project.crops[0].rect = Rect.from_size(1, 1, 2, 2)
    project.save(str(path))
    second = path.read_text(encoding="utf-8")
    assert first != second
    assert json.loads(second)["crops"][0]["x"] == 1
    assert not any(p.name.startswith(".cropkit-") for p in tmp_path.iterdir())


def test_future_version_is_rejected():
    with pytest.raises(ValueError):
        Project.from_dict({"format": "cropkit-project", "version": 99})


def test_foreign_json_is_rejected():
    with pytest.raises(ValueError):
        Project.from_dict({"some": "other"})


def test_compare_detects_size_orientation_hash_and_path():
    saved = SourceInfo("/a/x.jpg", (100, 80), 6, "abc")
    actual = SourceInfo("/a/y.jpg", (200, 80), 8, "def")
    fields = {d.field for d in compare_sources(saved, actual)}
    assert fields == {"path", "stored_size", "orientation", "hash"}


def test_compare_ignores_missing_hash():
    saved = SourceInfo("/a/x.jpg", (100, 80), 6, "")
    actual = SourceInfo("/a/x.jpg", (100, 80), 6, "abc")
    assert compare_sources(saved, actual) == []


def test_same_bytes_new_orientation_keeps_the_same_pixels():
    # stored 120x80 -> upright 80x120 for both orientations 6 and 8
    saved = SourceInfo("/a/x.jpg", (120, 80), 6, "same")
    actual = SourceInfo("/a/x.jpg", (120, 80), 8, "same")
    project = Project(source=saved,
                      crops=[CropItem("a", Rect.from_size(10, 20, 30, 40))],
                      markers=[Marker("m", 15, 25)])
    recon = adapt_project(project, actual)
    assert recon.needs_confirmation
    rect = recon.adapted_rects[0]
    assert 0 <= rect.x0 and rect.x1 <= 80
    assert 0 <= rect.y0 and rect.y1 <= 120
    assert rect.size == (30, 40)
    # the same stored pixels, now seen through orientation 8
    from cropkit.orientation import Orientation
    old_stored = Orientation(6).display_rect_to_stored(
        project.crops[0].rect, (80, 120))
    new_stored = Orientation(8).display_rect_to_stored(rect, (80, 120))
    assert new_stored == old_stored
    # markers move through the same stored pixel too
    mx, my = recon.adapted_markers[0]
    old_m = Orientation(6).to_stored_mapping((15, 25), (80, 120))
    new_m = Orientation(8).to_stored_mapping((mx, my), (80, 120))
    assert new_m == old_m


def test_scaled_rect_keeps_border_contact():
    saved = SourceInfo("/a/x.jpg", (100, 100), 1, "a")
    actual = SourceInfo("/a/x.jpg", (200, 200), 1, "b")
    project = Project(source=saved,
                      crops=[CropItem("a", Rect.from_size(90, 90, 10, 10))])
    recon = adapt_project(project, actual)
    assert recon.adapted_rects[0].as_tuple() == (180, 180, 20, 20)


def test_keep_mode_only_clamps():
    saved = SourceInfo("/a/x.jpg", (100, 100), 1, "a")
    actual = SourceInfo("/a/x.jpg", (50, 50), 1, "b")
    project = Project(source=saved,
                      crops=[CropItem("a", Rect.from_size(40, 40, 40, 40))],
                      markers=[Marker("m", 90, 90)])
    recon = adapt_project(project, actual, mode="keep")
    assert recon.adapted_rects[0].as_tuple() == (10, 10, 40, 40)
    assert recon.adapted_markers[0] == (49, 49)


def test_apply_reconciliation_writes_back():
    saved = SourceInfo("/a/x.jpg", (100, 100), 1, "a")
    actual = SourceInfo("/a/x.jpg", (200, 200), 1, "b")
    project = Project(source=saved,
                      crops=[CropItem("a", Rect.from_size(10, 10, 10, 10))],
                      markers=[Marker("m", 10, 10)])
    recon = adapt_project(project, actual)
    apply_reconciliation(project, actual, recon)
    assert project.source == actual
    assert project.crops[0].rect == recon.adapted_rects[0]
    assert (project.markers[0].x, project.markers[0].y) == \
        recon.adapted_markers[0]
    assert project.dirty


def test_read_source_info(tmp_path):
    path = tmp_path / "a.jpg"
    save_with_orientation(make_sheet(True, (240, 200)), str(path), 6)
    info = read_source_info(str(path))
    assert info.orientation == 6
    assert info.stored_size == (200, 240)
    assert info.display_size == (240, 200)
    assert len(info.sha256) == 64


def test_missing_source_path_still_parses():
    info = SourceInfo.from_dict({"stored_width": 10, "stored_height": 20,
                                 "orientation": 6})
    assert info.path == ""
    assert info.display_size == (20, 10)
