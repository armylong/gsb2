"""Editor / history / persistence tests, plus headless GUI smoke tests."""

from __future__ import annotations

import json
import os

import numpy as np
import pytest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from mesh_warp.editor import Editor, loaded_from_array
from mesh_warp.io import load_image_rgba


@pytest.fixture()
def editor(test_image) -> Editor:
    ed = Editor()
    ed.set_document(loaded_from_array(test_image, "test.png"), 5, 4)
    return ed


def test_one_drag_one_undo(editor: Editor):
    mesh = editor.mesh
    start = mesh.dst.copy()
    ok, _ = editor.begin_drag(mesh.index(2, 1))
    assert ok
    editor.drag_to(mesh.dst[mesh.index(2, 1)][0] + 10, mesh.dst[mesh.index(2, 1)][1] + 8)
    editor.drag_to(mesh.dst[mesh.index(2, 1)][0] + 20, mesh.dst[mesh.index(2, 1)][1] + 16)
    editor.end_drag()
    moved = mesh.dst.copy()
    assert not np.array_equal(moved, start)
    ok, msg = editor.undo()
    assert ok
    assert np.array_equal(mesh.dst, start)
    ok, msg = editor.redo()
    assert ok
    assert np.array_equal(mesh.dst, moved)
    # A second undo goes no further: the whole drag was one step.
    editor.undo()
    assert np.array_equal(mesh.dst, start)
    assert not editor.history.can_undo


def test_rejected_drag_does_not_create_history(editor: Editor):
    mesh = editor.mesh
    start = mesh.dst.copy()
    p = mesh.index(2, 1)
    ok, _ = editor.begin_drag(p)
    feedback = editor.drag_to(mesh.dst[p][0] + mesh.width * 0.6, mesh.dst[p][1])
    assert not feedback.accepted
    assert feedback.report is not None
    editor.end_drag()
    assert np.array_equal(mesh.dst, start)
    assert not editor.history.can_undo
    # Dragging back to a valid position still works in the same gesture.
    ok, _ = editor.begin_drag(p)
    assert ok
    editor.drag_to(mesh.src[p][0] + 12, mesh.src[p][1] - 9)
    editor.end_drag()
    assert not np.array_equal(mesh.dst, start)
    assert np.allclose(mesh.dst[p], mesh.src[p] + np.array([12.0, -9.0]))


def test_lock_state_survives_undo(editor: Editor):
    mesh = editor.mesh
    p = mesh.index(2, 1)
    editor.set_point_locked(p, True)
    assert mesh.locked[p]
    ok, _ = editor.begin_drag(p)
    assert not ok  # locked points refuse the gesture
    editor.set_point_locked(p, False)
    assert not mesh.locked[p]
    editor.undo()  # undo the unlock
    assert mesh.locked[p]
    editor.undo()  # undo the lock
    assert not mesh.locked[p]


def test_reset_point_and_all_undoable(editor: Editor):
    mesh = editor.mesh
    p = mesh.index(2, 1)
    editor.set_point_target(p, *mesh.src[p] + np.array([18.0, -12.0]))
    assert not mesh.is_identity
    editor.reset_point(p)
    assert mesh.is_identity
    editor.undo()
    assert not mesh.is_identity
    editor.reset_all()
    assert mesh.is_identity
    editor.undo()
    assert not mesh.is_identity


def test_border_lock_toggle(editor: Editor):
    mesh = editor.mesh
    editor.set_border_locked(True)
    assert editor.border_is_locked()
    border = mesh.border_indices()
    ok, _ = editor.begin_drag(int(border[0]))
    assert not ok
    editor.set_border_locked(False)
    assert not editor.border_is_locked()
    ok, _ = editor.begin_drag(int(border[0]))
    assert ok
    editor.cancel_drag()


def test_nudge_and_invalid_input(editor: Editor):
    mesh = editor.mesh
    p = mesh.index(2, 1)
    ok, msg = editor.nudge_point(p, 3, -2)
    assert ok, msg
    assert np.allclose(mesh.dst[p], mesh.src[p] + np.array([3.0, -2.0]))
    ok, msg = editor.nudge_point(p, mesh.width, 0)
    assert not ok
    assert np.allclose(mesh.dst[p], mesh.src[p] + np.array([3.0, -2.0]))


def test_noop_coordinate_edit_creates_no_history(editor: Editor):
    mesh = editor.mesh
    p = mesh.index(2, 1)
    x, y = mesh.dst[p]
    ok, msg = editor.set_point_target(p, float(x), float(y))
    assert ok and msg == ""
    assert not editor.history.can_undo
    ok, msg = editor.set_point_target(-1, 10.0, 10.0)
    assert not ok


def test_typed_invalid_coordinate_keeps_diagnostics(editor: Editor):
    mesh = editor.mesh
    before = mesh.dst.copy()
    p = mesh.index(2, 1)
    ok, msg = editor.set_point_target(p, float(mesh.dst[p][0] + mesh.width * 0.5), float(mesh.dst[p][1]))
    assert not ok and msg
    assert np.array_equal(mesh.dst, before)
    assert not editor.history.can_undo
    assert editor.last_rejection == msg
    assert editor.last_report is not None and not editor.last_report.ok


def test_sample_returns_source_and_triangle(editor: Editor):
    mesh = editor.mesh
    p = mesh.index(2, 1)
    editor.set_point_target(p, *mesh.src[p] + np.array([16.0, -10.0]))
    tri = 0
    target = mesh.dst[mesh.tris[tri]].mean(axis=0)
    sample = editor.sample((float(target[0]), float(target[1])))
    assert sample.covered
    assert sample.triangle is not None
    expected = mesh.src[mesh.tris[tri]].mean(axis=0)
    assert np.allclose(sample.source, expected, atol=1e-6)


def test_sample_uncovered_reports_none(test_image):
    ed = Editor()
    ed.set_document(loaded_from_array(test_image, "t.png"), 4, 4)
    mesh = ed.mesh
    corner = mesh.index(3, 3)
    ok, msg, _ = mesh.attempt_move([corner], (mesh.src[corner] + np.array([-80.0, -60.0]))[None], respect_locks=False)
    assert ok, msg
    sample = ed.sample((mesh.width - 1.0, mesh.height - 1.0))
    assert not sample.covered
    assert sample.source is None and sample.triangle is None


def test_rebuild_mesh_preserves_image(editor: Editor):
    editor.set_point_target(editor.mesh.index(2, 1), 200.0, 120.0)
    editor.rebuild_mesh(7, 6)
    assert editor.mesh.cols == 7 and editor.mesh.rows == 6
    assert editor.mesh.is_identity
    assert editor.image.height == editor.mesh.height


def test_export_png_and_json_roundtrip(editor: Editor, tmp_path):
    mesh = editor.mesh
    p = mesh.index(2, 1)
    editor.set_point_target(p, *mesh.src[p] + np.array([20.0, -14.0]))
    editor.set_point_locked(mesh.index(0, 0), True)
    rendered = editor.render_full()

    png_path = tmp_path / "out.png"
    json_path = tmp_path / "out.json"
    editor.export_png(png_path)
    editor.export_json(json_path)

    readback = load_image_rgba(png_path)
    assert (readback.width, readback.height) == (mesh.width, mesh.height)
    assert np.array_equal(readback.rgba, rendered)

    doc = json.loads(json_path.read_text(encoding="utf-8"))
    assert "triangles" in doc and "target_points" in doc and "locked" in doc
    # JSON export contains no overlay-only data.
    assert "guides" not in doc and "overlay" not in doc

    second = Editor()
    second.set_document(loaded_from_array(editor.image.rgba, "t.png"), mesh.cols, mesh.rows)
    second.load_mesh_json(json_path)
    assert np.array_equal(second.render_full(), rendered)
    assert np.array_equal(second.mesh.locked, mesh.locked)
    assert np.array_equal(second.mesh.dst, mesh.dst)


def test_load_mesh_rejects_wrong_image(editor: Editor, tmp_path):
    other = Editor()
    other.set_document(loaded_from_array(np.zeros((240, 320, 4), np.uint8), "o.png"))
    path = tmp_path / "m.json"
    editor.export_json(path)
    with pytest.raises(Exception):
        other.load_mesh_json(path)


def test_export_json_without_document_raises():
    ed = Editor()
    with pytest.raises(AssertionError):
        ed.export_json("nope.json")


# -- GUI smoke tests -----------------------------------------------------------
def test_main_window_loads_and_renders(qt_app, test_image):
    from mesh_warp.gui.main_window import MainWindow

    window = MainWindow()
    window.resize(1000, 700)
    window._load_test_scene("push")
    assert window.editor.has_document
    assert window.editor.mesh.cols == 5
    # Force a paint into an offscreen pixmap: must not raise.
    pix = window.grab()
    assert pix.width() > 0 and pix.height() > 0


def test_canvas_hit_testing_is_zoom_invariant(qt_app, test_image):
    from PySide6.QtCore import QPointF
    from mesh_warp.gui.main_window import MainWindow

    window = MainWindow()
    window.resize(900, 700)
    window._load_test_scene(None)
    window.canvas.resize(700, 600)
    window.canvas.fit_to_view()
    p = window.editor.mesh.index(2, 1)
    for zoom in (0.3, 1.0, 2.5):
        window.canvas.zoom = zoom
        window.canvas.pan = QPointF(10.0, 20.0)
        x, y = window.editor.mesh.dst[p]
        screen = window.canvas.image_to_screen(x, y)
        image_pos = window.canvas.screen_to_image(screen)
        assert abs(image_pos.x() - x) < 1e-6
        assert abs(image_pos.y() - y) < 1e-6
        assert window.canvas._hit_point(image_pos) == p
    # A few pixels away in screen space still hits at any zoom (10 px radius).
    window.canvas.zoom = 0.5
    screen = window.canvas.image_to_screen(x, y) + QPointF(4, 0)
    assert window.canvas._hit_point(window.canvas.screen_to_image(screen)) == p


def test_rejected_geometry_persists_until_next_valid_edit(editor: Editor):
    mesh = editor.mesh
    p = mesh.index(2, 1)
    start = mesh.dst.copy()
    ok, _ = editor.begin_drag(p)
    assert ok
    feedback = editor.drag_to(mesh.dst[p][0] + mesh.width * 0.5, mesh.dst[p][1])
    assert not feedback.accepted
    editor.end_drag()
    # The reason and the refused geometry stay available after release ...
    assert editor.last_rejection
    assert editor.last_report is not None and not editor.last_report.ok
    assert editor.last_rejected_index == p
    assert np.array_equal(mesh.dst, start)
    # ... and are cleared by the next successful edit.
    ok, msg = editor.nudge_point(p, 6, -4)
    assert ok, msg
    assert editor.last_rejection == ""
    assert editor.last_report is None
    assert editor.last_rejected_index is None


def test_canvas_drag_preview_updates_and_exports_without_guides(gui_window, tmp_path):
    from PySide6.QtCore import QEvent, QPointF, Qt
    from PySide6.QtGui import QMouseEvent

    window = gui_window
    canvas = window.canvas
    canvas.resize(820, 700)
    canvas.fit_to_view()
    editor = window.editor
    mesh = editor.mesh
    p = mesh.index(2, 1)
    screen = canvas.image_to_screen(*mesh.dst[p])

    def event(kind, pos, buttons=Qt.LeftButton):
        return QMouseEvent(kind, QPointF(pos), QPointF(screen), Qt.LeftButton, buttons, Qt.NoModifier)

    canvas.mousePressEvent(event(QEvent.MouseButtonPress, screen))
    hashes = []
    for step in range(1, 4):
        canvas.mouseMoveEvent(event(QEvent.MouseMove, screen + QPointF(6 * step, -4 * step)))
        hashes.append(hash(canvas.grab().toImage().bits().tobytes()))
    assert len(set(hashes)) == len(hashes)  # preview really redraws per move
    canvas.mouseReleaseEvent(
        event(QEvent.MouseButtonRelease, screen + QPointF(18, -12), Qt.NoButton)
    )
    assert editor.history.can_undo

    # Exported PNG equals the pure warp (no mesh lines / points / labels) and
    # matches the source exactly where the mesh is still at rest.
    out_path = tmp_path / "export.png"
    editor.export_png(out_path)
    readback = load_image_rgba(out_path)
    assert np.array_equal(readback.rgba, editor.render_full())
    assert not np.array_equal(readback.rgba, window.editor.image.rgba)

    editor.reset_all()
    editor.export_png(out_path)
    assert np.array_equal(load_image_rgba(out_path).rgba, editor.image.rgba)


def test_scene_buttons_work_without_an_open_document(qt_app):
    from mesh_warp.gui.main_window import MainWindow

    window = MainWindow()
    assert not window.editor.has_document
    for button, expect_identity in (
        (window.push_btn, False),
        (window.border_btn, False),
        (window.invalid_btn, True),
    ):
        assert button.isEnabled()
        button.click()
        assert window.editor.has_document
        assert window.editor.mesh.is_identity == expect_identity
        assert window.editor.border_is_locked()


def test_run_reuses_existing_application(qt_app):
    from PySide6.QtCore import QTimer
    from mesh_warp.gui.main_window import run

    QTimer.singleShot(150, qt_app.quit)
    assert run(["mesh-warp"]) == 0


def test_grid_combos_offer_4_to_8(qt_app):
    from mesh_warp.gui.main_window import MainWindow

    window = MainWindow()
    assert [window.cols_combo.itemData(i) for i in range(window.cols_combo.count())] == [
        4, 5, 6, 7, 8
    ]
    assert [window.rows_combo.itemData(i) for i in range(window.rows_combo.count())] == [
        4, 5, 6, 7, 8
    ]
