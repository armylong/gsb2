import pytest

from cropkit.editing import Editor
from cropkit.lookup import locate_in_crops, point_in_crop
from cropkit.project import CropItem, SourceInfo
from cropkit.rectmath import Rect


@pytest.fixture
def editor():
    ed = Editor(SourceInfo("/tmp/x.jpg", (400, 300), 1, "h"))
    return ed


def test_add_and_remove_crop(editor):
    index = editor.add_crop(Rect.from_size(10, 10, 100, 80))
    assert index == 0
    assert editor.active_crop == 0
    editor.remove_crop()
    assert editor.crops == []
    assert editor.active_crop is None


def test_add_rejects_empty(editor):
    assert editor.add_crop(Rect.from_size(10, 10, 0, 0)) is None
    assert editor.crops == []


def test_crop_names_are_unique(editor):
    editor.add_crop(Rect.from_size(0, 0, 10, 10))
    editor.add_crop(Rect.from_size(20, 20, 10, 10))
    assert [c.name for c in editor.crops] == ["裁片 1", "裁片 2"]


def test_widen_only_active_or_all(editor):
    editor.add_crop(Rect.from_size(20, 20, 40, 40))
    editor.add_crop(Rect.from_size(100, 100, 40, 40))
    editor.select_crop(0)
    assert editor.widen(5, only_active=True) == 1
    assert editor.crops[0].rect.as_tuple() == (15, 15, 50, 50)
    assert editor.crops[1].rect.as_tuple() == (100, 100, 40, 40)
    assert editor.widen(5, only_active=False) == 2


def test_widen_clips_at_image_edge(editor):
    editor.add_crop(Rect.from_size(0, 0, 10, 10))
    editor.widen(50, True)
    assert editor.crops[0].rect.as_tuple() == (0, 0, 60, 60)


def test_widen_sides(editor):
    editor.add_crop(Rect.from_size(50, 50, 40, 40))
    editor.widen(5, True, "x")
    assert editor.crops[0].rect.as_tuple() == (45, 50, 50, 40)
    editor.widen(5, True, "y")
    assert editor.crops[0].rect.as_tuple() == (45, 45, 50, 50)


def test_translate_and_clip(editor):
    editor.add_crop(Rect.from_size(0, 0, 40, 30))
    editor.translate(400, 0, True)
    assert editor.crops[0].rect.as_tuple() == (360, 0, 40, 30)


def test_tighten_uses_ratio(editor):
    editor.add_crop(Rect.from_size(0, 0, 100, 100))
    editor.set_ratio("4:3")
    assert editor.tighten_to_ratio(None, True) == 1
    assert editor.crops[0].rect.size == (100, 75)


def test_tighten_rejects_bad_ratio(editor):
    editor.add_crop(Rect.from_size(0, 0, 100, 100))
    assert editor.tighten_to_ratio("banana", True) == 0


def test_tighten_no_change_does_not_stack_undo(editor):
    editor.add_crop(Rect.from_size(0, 0, 80, 60))
    editor.set_ratio("4:3")
    depth = len(editor._undo)
    assert editor.tighten_to_ratio(None, True) == 0
    assert len(editor._undo) == depth


def test_resize_crop_from_start(editor):
    editor.add_crop(Rect.from_size(20, 20, 100, 100))
    start = editor.crops[0].rect
    editor.resize_crop(0, 7, 10, 10, start)
    assert editor.crops[0].rect.as_tuple() == (20, 20, 110, 110)
    editor.resize_crop(0, 7, 20, 20, start)
    assert editor.crops[0].rect.as_tuple() == (20, 20, 120, 120)


def test_undo_redo(editor):
    editor.add_crop(Rect.from_size(10, 10, 20, 20))
    assert editor.can_undo
    editor.widen(5, True)
    assert editor.crops[0].rect.as_tuple() == (5, 5, 30, 30)
    editor.undo()
    assert editor.crops[0].rect.as_tuple() == (10, 10, 20, 20)
    editor.redo()
    assert editor.crops[0].rect.as_tuple() == (5, 5, 30, 30)


def test_undo_removes_added_crop(editor):
    editor.add_crop(Rect.from_size(10, 10, 20, 20))
    editor.undo()
    assert editor.crops == []


def test_interaction_is_one_undo_step(editor):
    editor.add_crop(Rect.from_size(10, 10, 50, 50))
    start = editor.crops[0].rect
    editor.begin_interaction()
    for i in range(1, 6):
        editor.move_crop_to(0, start, i, i)
    editor.end_interaction()
    assert editor.crops[0].rect.as_tuple() == (15, 15, 50, 50)
    editor.undo()
    assert editor.crops[0].rect.as_tuple() == (10, 10, 50, 50)


def test_markers(editor):
    idx = editor.add_marker(15, 20)
    assert editor.active_marker == idx
    editor.add_crop(Rect.from_size(10, 10, 20, 20))
    assert editor.crops_containing_marker(idx) == [0]
    editor.set_marker_position(idx, 500, 500)
    assert editor.markers[idx].point == (399, 299)
    editor.remove_marker()
    assert editor.markers == []


def test_selection_is_independent(editor):
    editor.add_crop(Rect.from_size(0, 0, 10, 10))
    editor.add_marker(5, 5)
    editor.select_crop(0)
    assert editor.active_crop == 0
    assert editor.active_marker == 0
    editor.select_marker(0)
    assert editor.active_crop == 0


def test_hit_testing(editor):
    editor.add_crop(Rect.from_size(10, 10, 40, 40))
    editor.add_crop(Rect.from_size(20, 20, 40, 40))
    # topmost (last) wins
    assert editor.crop_at(25, 25) == 1
    assert editor.crop_at(12, 12) == 0
    assert editor.crop_at(200, 200) is None
    editor.add_marker(35, 35)
    assert editor.marker_at(36, 36, 3) == 0
    assert editor.marker_at(80, 80, 3) is None


def test_project_round_trip_via_editor(editor):
    editor.add_crop(Rect.from_size(10, 10, 20, 20))
    editor.add_marker(15, 15)
    editor.set_ratio("1:1")
    project = editor.to_project()
    other = Editor(SourceInfo("/tmp/x.jpg", (400, 300), 1, "h"))
    other.load_project(project)
    assert other.crops[0].rect == editor.crops[0].rect
    assert other.markers[0].point == (15, 15)
    assert other.ratio == "1:1"


def test_lookup_outside_reports_distance():
    rect = Rect.from_size(10, 10, 40, 30)
    hit = point_in_crop(rect, 3, 20)
    assert not hit.inside
    assert hit.edge == "左"
    assert hit.outside_px == 7
    assert hit.local == (-7, 10)


def test_lookup_far_corner_outside():
    rect = Rect.from_size(0, 0, 10, 10)
    hit = point_in_crop(rect, 50, 60)
    assert not hit.inside
    assert hit.local == (50, 60)
    assert hit.outside_px > 0


def test_locate_in_crops():
    crops = [CropItem("a", Rect.from_size(0, 0, 10, 10)),
             CropItem("b", Rect.from_size(20, 20, 10, 10))]
    hits = locate_in_crops(crops, 25, 25)
    assert hits[0].inside is False
    assert hits[1].inside is True
    assert hits[1].local == (5, 5)
