"""UI-level tests that run headless (Qt 'offscreen' platform)."""

from __future__ import annotations

import os

import numpy as np
import pytest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

PySide6 = pytest.importorskip("PySide6")

from PySide6.QtCore import QPointF, Qt  # noqa: E402
from PySide6.QtGui import QMouseEvent  # noqa: E402
from PySide6.QtWidgets import QApplication  # noqa: E402

from mblend.ui.canvas import (  # noqa: E402
    TOOL_PAINT_A,
    TOOL_PICK,
    ImageCanvas,
    overlay_rgba,
)
from mblend.ui.scaling import detail_to_rgb8, resize_rgba  # noqa: E402


@pytest.fixture(scope="module")
def app():
    instance = QApplication.instance() or QApplication([])
    yield instance


def test_widget_to_image_round_trip(app):
    canvas = ImageCanvas()
    canvas.resize(600, 400)
    image = np.zeros((97, 131, 3), dtype=np.uint8)
    canvas.set_image(image)
    canvas.set_zoom(3.0)
    canvas.transform.offset_x = 20.0
    canvas.transform.offset_y = 10.0
    for x, y in ((0, 0), (37, 64), (130, 96)):
        wx, wy = canvas.transform.image_to_widget(x + 0.5, y + 0.5)
        ix, iy = canvas.transform.widget_to_image(wx, wy)
        assert ix == pytest.approx(x + 0.5)
        assert iy == pytest.approx(y + 0.5)


def test_painting_hits_the_image_position_under_the_cursor(app):
    canvas = ImageCanvas()
    canvas.resize(800, 600)
    canvas.set_image(np.zeros((100, 100, 3), dtype=np.uint8))
    canvas.set_zoom(4.0)
    canvas.transform.offset_x = 40.0
    canvas.transform.offset_y = 30.0
    canvas.tool = TOOL_PAINT_A

    received = []
    canvas.paint_requested.connect(
        lambda x0, y0, x1, y1, target: received.append((x0, y0, x1, y1, target))
    )
    widget_x = 40.0 + 25.5 * 4.0
    widget_y = 30.0 + 40.5 * 4.0
    press = QMouseEvent(
        QMouseEvent.Type.MouseButtonPress,
        QPointF(widget_x, widget_y),
        QPointF(widget_x, widget_y),
        Qt.MouseButton.LeftButton,
        Qt.MouseButton.LeftButton,
        Qt.KeyboardModifier.NoModifier,
    )
    canvas.mousePressEvent(press)
    assert received
    assert received[0][0] == pytest.approx(25.5)
    assert received[0][1] == pytest.approx(40.5)

    canvas.mouseMoveEvent(
        QMouseEvent(
            QMouseEvent.Type.MouseMove,
            QPointF(widget_x + 8.0, widget_y),
            QPointF(widget_x + 8.0, widget_y),
            Qt.MouseButton.NoButton,
            Qt.MouseButton.LeftButton,
            Qt.KeyboardModifier.NoModifier,
        )
    )
    assert received[-1][2] == pytest.approx(27.5)
    assert received[-1][3] == pytest.approx(40.5)


def test_pick_tool_reports_image_coordinates(app):
    canvas = ImageCanvas()
    canvas.resize(800, 600)
    canvas.set_image(np.zeros((100, 100, 3), dtype=np.uint8))
    canvas.set_zoom(2.0)
    canvas.transform.offset_x = 10.0
    canvas.transform.offset_y = 10.0
    canvas.tool = TOOL_PICK
    picks = []
    canvas.picked.connect(lambda x, y: picks.append((x, y)))
    canvas.mousePressEvent(
        QMouseEvent(
            QMouseEvent.Type.MouseButtonPress,
            QPointF(10.0 + 12.3 * 2.0, 10.0 + 7.8 * 2.0),
            QPointF(10.0 + 12.3 * 2.0, 10.0 + 7.8 * 2.0),
            Qt.MouseButton.LeftButton,
            Qt.MouseButton.LeftButton,
            Qt.KeyboardModifier.NoModifier,
        )
    )
    assert picks == [(12, 7)]


def test_overlay_rgba_marks_a_and_b_sides():
    mask = np.array([[1.0, 0.0, 0.5]], dtype=np.float32)
    rgba = overlay_rgba(mask)
    assert rgba.shape == (1, 3, 4)
    assert rgba[0, 0, 3] > 0  # A side visible
    assert rgba[0, 1, 3] > 0  # B side visible
    assert rgba[0, 2, 3] == 0  # neutral is invisible
    assert tuple(int(c) for c in rgba[0, 0, :3]) == (255, 140, 38)


def test_detail_display_bias_is_reversible():
    detail = np.zeros((4, 4, 3), dtype=np.float32)
    display = detail_to_rgb8(detail, 2.0)
    assert np.all(display == 128)
    detail[0, 0] = 0.25
    bright = detail_to_rgb8(detail, 2.0)
    assert bright[0, 0, 0] > 128


def test_resize_rgba_keeps_shape():
    rgba = np.zeros((20, 30, 4), dtype=np.uint8)
    rgba[..., 3] = 200
    out = resize_rgba(rgba, 60, 40)
    assert out.shape == (40, 60, 4)


def test_main_window_loads_and_paints(app, tmp_path):
    from mblend.ui.main_window import MainWindow

    window = MainWindow()
    session = window.session
    assert session is not None
    assert window.tabs.count() == 6
    assert window.level_inspector.level_combo.count() == session.config.levels

    # Sample switching.
    for name in ("brightness", "stripes", "blocks", "odd_size"):
        window.sample_combo.setCurrentIndex(window.sample_combo.findData(name))
        window._on_load_sample()
        assert window.session.engine.a_rgb8.shape == window.session.engine.b_rgb8.shape
        assert window.session.engine.a_rgb8.shape[0] <= 1200
        assert window.session.engine.a_rgb8.shape[1] <= 1200

    # Painting through the canvas signal path.
    window.tool_a.setChecked(True)
    before_paint = window.session.mask.copy()
    window._on_stroke_started()
    window._on_paint(10.0, 10.0, 60.0, 40.0, 1.0)
    window._on_stroke_finished()
    painted = window.session.mask.copy()
    assert window.undo_button.isEnabled()
    assert not np.array_equal(painted, before_paint)

    # Undo/redo through the buttons.
    window._on_undo()
    assert np.array_equal(window.session.mask, before_paint)
    window._on_redo()
    assert np.array_equal(window.session.mask, painted)

    # Mask operations.
    window._mask_op("fill_a")
    assert np.all(window.session.mask == 1.0)
    window._mask_op("invert")
    assert np.all(window.session.mask == 0.0)

    # Level switching updates the inspector.
    window.session.set_levels(6)
    window.level_inspector.refresh()
    assert window.level_inspector.level_combo.count() == 6
    assert window.level_inspector.info_label.text().startswith("层 0")
    window.level_inspector.level_combo.setCurrentIndex(3)
    assert window.session.inspected_level == 3


def test_main_window_exports(app, tmp_path):
    from mblend.ui.main_window import MainWindow

    window = MainWindow()
    info = window.session.export(str(tmp_path), "from_window")
    assert os.path.isfile(info.output_png)
    assert os.path.isfile(info.mask_png)
    assert os.path.isfile(info.record_json)


def test_comparison_tab_uses_the_other_mode(app):
    from mblend.ui.main_window import MainWindow

    window = MainWindow()
    assert window.session.config.mode == "pyramid"
    window.session.set_mode("naive")
    window._refresh_all()
    assert window.session.config.mode == "naive"
    window.session.set_mode("pyramid")
    window._refresh_all()
    assert window.session.config.mode == "pyramid"


def test_load_rejects_mismatched_pair_and_keeps_session(app, tmp_path):
    """A size mismatch must be refused without replacing the current pair."""
    import cv2
    from PySide6.QtWidgets import QMessageBox

    from mblend.ui.main_window import MainWindow

    window = MainWindow()
    original = window.session
    window._custom = {}
    window._custom_paths = {}

    def write(path, shape):
        rgb = np.full((*shape, 3), 120, dtype=np.uint8)
        ok, buf = cv2.imencode(".png", cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR))
        assert ok
        buf.tofile(str(path))

    a_path = tmp_path / "a.png"
    b_path = tmp_path / "b.png"
    write(a_path, (30, 40))
    write(b_path, (31, 40))

    shown = []
    original_warning = QMessageBox.warning
    QMessageBox.warning = staticmethod(
        lambda parent, title, text, *args, **kwargs: shown.append(text)
    )
    try:
        window._load_pair_file("A", str(a_path))
        assert window.session is original  # only one image is not a pair yet
        window._load_pair_file("B", str(b_path))
        assert window.session is original  # rejected, pair preserved
        assert shown
    finally:
        QMessageBox.warning = original_warning


def test_load_accepts_matching_pair(app, tmp_path):
    import cv2

    from mblend.ui.main_window import MainWindow

    window = MainWindow()
    window._custom = {}
    window._custom_paths = {}

    def write(path, value):
        rgb = np.full((21, 33, 3), value, dtype=np.uint8)
        ok, buf = cv2.imencode(".png", cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR))
        buf.tofile(str(path))

    a_path = tmp_path / "a.png"
    b_path = tmp_path / "b.png"
    write(a_path, 40)
    write(b_path, 200)
    window._load_pair_file("A", str(a_path))
    window._load_pair_file("B", str(b_path))
    assert window.session.engine.a_rgb8.shape == (21, 33, 3)
    assert int(window.session.engine.a_rgb8[0, 0, 0]) == 40
    assert int(window.session.engine.b_rgb8[0, 0, 0]) == 200
    assert window.level_spin.maximum() == 6
    window.session.set_levels(6)
    assert window.session.config.levels == 6


def test_tiny_pair_disables_pyramid(app, tmp_path):
    import cv2

    from mblend.ui.main_window import MainWindow

    window = MainWindow()
    window._custom = {}
    window._custom_paths = {}
    rgb = np.zeros((1, 1, 3), dtype=np.uint8)
    ok, buf = cv2.imencode(".png", cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR))
    path = tmp_path / "tiny.png"
    buf.tofile(str(path))
    window._load_pair_file("A", str(path))
    window._load_pair_file("B", str(path))
    assert not window.session.pyramid_available
    assert window.session.config.mode == "naive"
    assert not window.mode_combo.isEnabled()


def test_painting_in_comparison_tab_updates_the_same_mask(app):
    from mblend.ui.main_window import MainWindow

    window = MainWindow()
    before = window.session.mask.copy()
    window._on_paint(5.0, 5.0, 30.0, 30.0, 0.0)
    window._on_stroke_finished()
    assert not np.array_equal(window.session.mask, before)
    assert window.comparison_canvas.overlay_mask_pixels().any()


def test_detail_views_are_independent_of_inspected_level(app):
    from mblend.ui.main_window import MainWindow

    window = MainWindow()
    window.session.set_levels(4)
    window._refresh_all()
    first = window.level_inspector.info_label.text()
    window.level_inspector.level_combo.setCurrentIndex(2)
    second = window.level_inspector.info_label.text()
    assert first != second
    assert "实际尺寸" in second
