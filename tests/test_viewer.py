import numpy as np
import pytest
from PySide6.QtCore import QEvent, QPointF, Qt
from PySide6.QtGui import QMouseEvent
from PySide6.QtWidgets import QApplication

from tileviewer.cache import CacheConfig, CacheManager
from tileviewer.geometry import Rect
from tileviewer.source import load_source
from tileviewer.viewer import ViewerWidget


def _mouse(widget, event_type, point, button, buttons, modifiers=None):
    """Build a modern (non-deprecated) QMouseEvent for widget-local coords."""
    modifiers = modifiers or Qt.KeyboardModifier.NoModifier
    return QMouseEvent(
        event_type,
        point,
        widget.mapToGlobal(point.toPoint()).toPointF(),
        button,
        buttons,
        modifiers,
    )


@pytest.fixture
def viewer(qapp, tmp_path, source_png):
    source = load_source(source_png)
    manager = CacheManager(
        tmp_path / "cache", source, CacheConfig(tile_size=16, margin=2)
    )
    manager.generate()
    widget = ViewerWidget()
    widget.resize(640, 480)
    widget.set_source(manager)
    widget.refresh_statuses(manager.statuses())
    yield widget
    widget.shutdown()


def _point_on_widget_original(viewer, x: float, y: float) -> QPointF:
    return viewer.map_original_to_widget(x, y)


def _original_at(viewer, widget_point: QPointF):
    return viewer._widget_to_original(widget_point)


def test_level_switch_keeps_original_coordinate_under_cursor(viewer):
    probe_original = (17.0, 11.0)
    probe_widget = _point_on_widget_original(viewer, *probe_original)

    for level in range(viewer.manager.info.level_count):
        viewer.auto_level = False
        viewer.set_level(level)
        assert _original_at(viewer, probe_widget) == pytest.approx(
            probe_original, abs=1e-6
        )
        # Reading directly from the level also gives the same location.
        geom = viewer.manager.geometry(level)
        scale_x = geom.width / viewer.manager.source.width
        scale_y = geom.height / viewer.manager.source.height
        lx, ly = viewer._widget_to_original(probe_widget)
        assert (lx * scale_x, ly * scale_y) == pytest.approx(
            (
                probe_original[0] * scale_x,
                probe_original[1] * scale_y,
            ),
            abs=1e-6,
        )


def test_zoom_anchored_at_cursor_keeps_original_point(viewer):
    anchor = QPointF(200.0, 150.0)
    before = _original_at(viewer, anchor)
    for factor in (1.25, 4.0, 0.2):
        viewer.zoom_by(factor, anchor)
        after = _original_at(viewer, anchor)
        assert after == pytest.approx(before, abs=1e-6)


def test_auto_level_selects_finest_complete_level_for_zoom(viewer):
    viewer.set_auto_level(True)
    viewer.zoom_to(1.0)
    assert viewer.level == 0
    viewer.zoom_to(0.01)
    assert viewer.level == viewer.manager.info.level_count - 1


def test_selection_drag_maps_to_original_pixels(viewer):
    start = QPointF(100.0, 120.0)
    end = QPointF(260.0, 300.0)
    viewer.mousePressEvent(
        _mouse(
            viewer,
            QEvent.Type.MouseButtonPress,
            start,
            Qt.MouseButton.LeftButton,
            Qt.MouseButton.LeftButton,
        )
    )
    viewer.mouseMoveEvent(
        _mouse(
            viewer,
            QEvent.Type.MouseMove,
            end,
            Qt.MouseButton.NoButton,
            Qt.MouseButton.LeftButton,
        )
    )
    viewer.mouseReleaseEvent(
        _mouse(
            viewer,
            QEvent.Type.MouseButtonRelease,
            end,
            Qt.MouseButton.LeftButton,
            Qt.MouseButton.NoButton,
        )
    )
    rect = viewer.selection_pixel_rect()
    assert rect is not None
    expected_x0 = int(np.floor(_original_at(viewer, start)[0]))
    expected_y0 = int(np.floor(_original_at(viewer, start)[1]))
    assert rect.x == expected_x0
    assert rect.y == expected_y0
    assert rect.w > 0 and rect.h > 0


def test_click_without_drag_clears_selection(viewer):
    viewer.set_selection_pixels(Rect(1, 2, 5, 6))
    point = QPointF(50.0, 60.0)
    viewer.event(
        _mouse(
            viewer,
            QEvent.Type.MouseButtonPress,
            point,
            Qt.MouseButton.LeftButton,
            Qt.MouseButton.LeftButton,
        )
    )
    viewer.event(
        _mouse(
            viewer,
            QEvent.Type.MouseButtonRelease,
            point,
            Qt.MouseButton.LeftButton,
            Qt.MouseButton.NoButton,
        )
    )
    assert viewer.selection_pixel_rect() is None


def test_selection_beyond_image_bounds_is_kept(viewer):
    viewer.set_selection_pixels(Rect(-40, -20, 90, 70))
    rect = viewer.selection_pixel_rect()
    assert rect == Rect(-40, -20, 90, 70)
    inside = rect.clipped_to(viewer.manager.source.bounds)
    assert inside.w > 0 and inside.h > 0


def test_partial_level_still_draws_available_tiles(qapp, tmp_path, source_png):
    source = load_source(source_png)
    manager = CacheManager(
        tmp_path / "cache", source, CacheConfig(tile_size=16, margin=0)
    )
    manager.generate([0])
    # Remove one tile to simulate an interrupted level.
    victim = manager.tile_path(0, 1, 1)
    victim.unlink()
    manager.level_manifest_path(0).unlink()

    widget = ViewerWidget()
    widget.resize(640, 480)
    widget.set_source(manager)
    widget.refresh_statuses(manager.statuses())
    widget.auto_level = False
    widget.set_level(0)
    widget.zoom_to(1.0)
    widget.center = (source.width / 2, source.height / 2)
    QApplication.processEvents()
    image = widget.grab().toImage()
    assert not image.isNull()
    # The missing tile is reported, not silently painted from neighbours.
    assert manager.level_status(0).state.value == "partial"
    widget.shutdown()


def test_grab_after_level_switch_does_not_crash(viewer):
    for level in reversed(range(viewer.manager.info.level_count)):
        viewer.set_level(level)
        QApplication.processEvents()
        assert not viewer.grab().toImage().isNull()


def test_no_source_paints_placeholder(qapp):
    widget = ViewerWidget()
    widget.resize(320, 240)
    assert not widget.grab().toImage().isNull()
    widget.shutdown()


def test_probe_stays_on_the_same_screen_point_across_levels(viewer):
    """The crosshair is pinned in original coordinates, not screen pixels."""
    viewer.auto_level = False
    viewer.zoom_to(0.5)
    viewer.set_probe(17.0, 11.0)
    positions = []
    for level in range(viewer.manager.info.level_count):
        viewer.set_level(level)
        QApplication.processEvents()
        positions.append(viewer.map_original_to_widget(17.0, 11.0))
    for point in positions[1:]:
        assert point == positions[0]
    assert viewer.probe == (17.0, 11.0)


def test_probe_cleared_by_escape(viewer):
    from PySide6.QtGui import QKeyEvent

    viewer.set_probe(5.0, 5.0)
    viewer.keyPressEvent(
        QKeyEvent(
            QEvent.Type.KeyPress,
            Qt.Key.Key_Escape,
            Qt.KeyboardModifier.NoModifier,
        )
    )
    assert viewer.probe is None
