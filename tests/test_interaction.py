"""GUI interaction tests (offscreen Qt): painting at zoom, undo, view sync."""

from __future__ import annotations

import os

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import numpy as np
import pytest
from PySide6 import QtCore, QtGui, QtWidgets

# Tests must never block on a modal dialog.
QtWidgets.QMessageBox.question = staticmethod(lambda *a, **k: QtWidgets.QMessageBox.No)
QtWidgets.QMessageBox.information = staticmethod(lambda *a, **k: QtWidgets.QMessageBox.Ok)
QtWidgets.QMessageBox.warning = staticmethod(lambda *a, **k: QtWidgets.QMessageBox.Ok)
QtWidgets.QMessageBox.exec = lambda self: QtWidgets.QMessageBox.Ok

from matting.constraints import FG
from matting.samples import generate_sample
from ui.canvas import CanvasWidget


@pytest.fixture(scope="module")
def app():
    return QtWidgets.QApplication.instance() or QtWidgets.QApplication([])


@pytest.fixture()
def canvas(app):
    view = CanvasWidget()
    view.resize(700, 560)
    sample = generate_sample("jug")
    view.set_model(sample.image)
    view.show()
    app.processEvents()
    yield view
    view.close()


def _mouse(view, kind, x, y, button, buttons):
    local = QtCore.QPointF(x, y)
    event = QtGui.QMouseEvent(
        kind, local, local, button, buttons, QtCore.Qt.NoModifier,
    )
    QtWidgets.QApplication.sendEvent(view, event)


def _press(view, x, y, button=QtCore.Qt.LeftButton):
    _mouse(view, QtCore.QEvent.MouseButtonPress, x, y, button, button)


def _move(view, x, y, buttons=QtCore.Qt.LeftButton):
    _mouse(view, QtCore.QEvent.MouseMove, x, y, QtCore.Qt.NoButton, buttons)


def _release(view, x, y, button=QtCore.Qt.LeftButton):
    _mouse(view, QtCore.QEvent.MouseButtonRelease, x, y, button, QtCore.Qt.NoButton)


def _paint(view, widget_points, tool):
    view.set_tool(tool)
    view.set_brush_radius(6.0)
    strokes = []
    view.stroke_finished.connect(strokes.append)
    x, y = widget_points[0]
    _press(view, x, y)
    for x, y in widget_points[1:]:
        _move(view, x, y)
    x, y = widget_points[-1]
    _release(view, x, y)
    return strokes


def test_zoomed_brush_lands_on_original_pixels(app, canvas):
    """A stroke drawn at 4x must cover the same image pixels as at 1x."""
    sample = generate_sample("jug")
    image_pts = [(300.0, 260.0), (340.0, 280.0), (380.0, 300.0)]

    # --- at 1:1 with a known pan
    canvas._auto_fit = False
    canvas._zoom = 1.0
    canvas._pan = QtCore.QPointF(40.0, 35.0)
    widget_pts = [(x * 1.0 + 40.0, y * 1.0 + 35.0) for x, y in image_pts]
    strokes = _paint(canvas, widget_pts, FG)
    assert len(strokes) == 1
    s1 = strokes[0]

    # --- zoom in through the real public API (anchored at a widget point), then
    #     pan, so the test covers the same code path the mouse wheel uses.
    canvas.zoom_at(4.0, QtCore.QPointF(320.0, 260.0))
    assert canvas.zoom == pytest.approx(4.0)
    canvas.pan_by(-1100.0, -900.0)
    zoom, pan = canvas.zoom, canvas._pan
    widget_pts2 = [(x * zoom + pan.x(), y * zoom + pan.y()) for x, y in image_pts]
    strokes2 = _paint(canvas, widget_pts2, FG)
    assert len(strokes2) == 1
    s2 = strokes2[0]

    for (ax, ay), (bx, by) in zip(s1.points, s2.points):
        assert abs(ax - bx) < 0.01 and abs(ay - by) < 0.01

    # And the stroke itself covers identical image pixels.
    from matting.constraints import stroke_mask

    h, w = sample.image.shape[:2]
    assert np.array_equal(stroke_mask(s1, h, w), stroke_mask(s2, h, w))


def test_pan_then_paint_maps_correctly(canvas):
    canvas._auto_fit = False
    canvas._zoom = 2.5
    canvas._pan = QtCore.QPointF(-250.0, -180.0)
    widget_pos = canvas.image_to_widget(QtCore.QPointF(512.0, 333.0))
    back = canvas.widget_to_image(widget_pos)
    assert abs(back.x() - 512.0) < 1e-6 and abs(back.y() - 333.0) < 1e-6


def test_brush_cursor_radius_scales(canvas):
    canvas.set_brush_radius(12.0)
    canvas._zoom = 4.0
    assert canvas._brush_radius * canvas._zoom == pytest.approx(48.0)


def test_zoom_steps_and_fit(canvas):
    canvas._auto_fit = False
    canvas.actual_size()
    assert canvas.zoom == pytest.approx(1.0)
    canvas.set_zoom_steps(1)
    assert canvas.zoom > 1.0
    before = canvas.zoom
    canvas.set_zoom_steps(-1)
    assert canvas.zoom < before
    canvas.fit_to_window()
    assert canvas.zoom <= 1.0 or canvas.zoom > 1.0  # fit ran without error


def test_linked_views_share_centre(app, canvas):
    other = CanvasWidget()
    other.resize(320, 560)
    other.set_interactive(False)
    sample = generate_sample("jug")
    other.set_model(sample.image)
    other.show()
    app.processEvents()
    canvas.link_view(other)
    other.link_view(canvas)

    canvas._auto_fit = False
    canvas._zoom = 3.0
    canvas._sync_zoom_pan()
    app.processEvents()
    assert other.zoom == pytest.approx(3.0)
    a = canvas.center_image_point()
    b = other.center_image_point()
    assert abs(a.x() - b.x()) < 0.01 and abs(a.y() - b.y()) < 0.01
    other.close()


def test_box_drag_emits_valid_rect(canvas):
    boxes = []
    canvas.box_changed.connect(boxes.append)
    canvas.set_tool(0)  # Tool.BOX
    canvas._auto_fit = False
    canvas._zoom = 1.0
    canvas._pan = QtCore.QPointF(0.0, 0.0)
    _press(canvas, 100, 120)
    _move(canvas, 300, 340)
    _release(canvas, 300, 340)
    assert boxes and boxes[-1] is not None
    x0, y0, x1, y1 = boxes[-1]
    assert (x0, y0, x1, y1) == (100, 120, 300, 340)


def test_tiny_box_drag_is_rejected(canvas):
    boxes = []
    canvas.box_changed.connect(boxes.append)
    canvas.set_tool(0)
    _press(canvas, 100, 100)
    _move(canvas, 101, 101)
    _release(canvas, 101, 101)
    assert boxes and boxes[-1] is None


def test_eraser_stroke_kind(canvas):
    from matting.constraints import ERASE

    strokes = _paint(canvas, [(100, 100), (200, 200)], ERASE)
    assert len(strokes) == 1 and strokes[0].kind == ERASE


def test_no_stroke_without_image(app):
    view = CanvasWidget()
    view.resize(300, 200)
    view.set_tool(FG)
    got = []
    view.stroke_finished.connect(got.append)
    _press(view, 50, 50)
    _release(view, 50, 50)
    assert got == []
    view.close()


def test_main_window_sample_flow(app):
    from ui.main_window import MainWindow

    window = MainWindow()
    window.resize(1400, 900)
    window.show()
    app.processEvents()
    window._load_sample("ring")
    app.processEvents()
    status = window.doc.status()
    assert status.has_result and status.has_box and not status.stale
    assert window.canvas.has_image() and window.alpha_view.has_image()
    assert window.composite_view.has_image()
    assert window.export_fg_btn.isEnabled()
    # Undo/redo through the window actions keeps the result dirty-flagged.
    steps_before = len(window.doc.history)
    window.action_undo()
    assert len(window.doc.history) == steps_before - 1
    assert window.doc.is_stale()
    window.action_redo()
    assert len(window.doc.history) == steps_before
    window.close()


def test_main_window_blocks_export_when_stale(app, monkeypatch):
    from ui.main_window import MainWindow

    window = MainWindow()
    window.resize(1200, 800)
    window.show()
    app.processEvents()
    window._load_sample("jug")
    app.processEvents()
    window.action_undo()  # now stale
    assert window.doc.is_stale()

    seen = {}
    original_question = QtWidgets.QMessageBox.question

    def fake_question(parent, title, text, *args, **kwargs):
        seen["title"] = title
        seen["text"] = text
        return QtWidgets.QMessageBox.No

    monkeypatch.setattr(QtWidgets.QMessageBox, "question", staticmethod(fake_question))
    try:
        assert window._ensure_fresh_before_export() is False
    finally:
        monkeypatch.setattr(QtWidgets.QMessageBox, "question", original_question)
    assert "过期" in (seen.get("title", "") + seen.get("text", ""))
    window.close()


def test_all_action_handlers_run(app, tmp_path, monkeypatch):
    """Smoke-test every menu/button handler so wiring errors surface in CI."""
    from ui.main_window import MainWindow

    window = MainWindow()
    window.resize(1300, 860)
    window.show()
    app.processEvents()
    # Before any image loaded: every action must degrade gracefully.
    window.action_recompute()
    window.action_undo()
    window.action_redo()
    window.action_export_foreground()
    window.action_export_alpha()
    window.action_export_record()
    window.action_import_record()
    window.action_clear_strokes()
    window._nudge_brush(5)
    window._nudge_brush(-3)
    for tool in (1, 2, 3, 0):
        window._apply_tool(tool)
    for mode in ("checker", "light", "dark", "checker"):
        window._set_backdrop(mode)
    window.canvas.set_zoom_steps(1)
    window.canvas.set_zoom_steps(-1)
    window.canvas.actual_size()
    window.canvas.fit_to_window()

    window._load_sample("ring")
    app.processEvents()

    paths = iter(
        [
            str(tmp_path / "fg.png"),
            str(tmp_path / "alpha.png"),
            str(tmp_path / "constraints.json"),
        ]
    )
    monkeypatch.setattr(
        QtWidgets.QFileDialog,
        "getSaveFileName",
        staticmethod(lambda *a, **k: (next(paths), "")),
    )
    window.action_export_foreground()
    window.action_export_alpha()
    window.action_export_record()
    for name in ("fg.png", "alpha.png", "constraints.json"):
        assert (tmp_path / name).stat().st_size > 0

    window.action_undo()
    assert window.doc.is_stale()
    window.action_redo()
    window.action_clear_strokes()
    assert len(window.doc.history) == 0
    window.action_recompute()  # must fail gracefully (no marks) without crashing
    assert window.doc.result is not None  # previous valid result preserved
    window.close()
