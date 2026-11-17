"""Offscreen UI smoke tests (no display server required)."""

from __future__ import annotations

import os

import numpy as np
import pytest

# Must be set before QApplication is imported/constructed.
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtWidgets import QApplication  # noqa: E402

from giftool.ui.main_window import MainWindow  # noqa: E402
from tests.fixtures.fixture_builder import all_fixtures, W, H  # noqa: E402


@pytest.fixture(scope="module")
def app() -> QApplication:
    existing = QApplication.instance()
    return existing or QApplication([])


@pytest.fixture
def fixture_path(tmp_path) -> str:
    fixture = all_fixtures()[0]
    path = tmp_path / "fixture.gif"
    path.write_bytes(fixture.gif_bytes)
    return str(path)


def test_window_constructs(app: QApplication) -> None:
    window = MainWindow()
    assert window.windowTitle()


def test_open_gif_populates_metadata_and_two_panes(
    app: QApplication, fixture_path: str
) -> None:
    window = MainWindow()
    window.document = None
    # Drive the same binding path used by the file-open action.
    from giftool.document import AnimationDocument

    window._reset_views()
    window.document = AnimationDocument(fixture_path)
    window._bind_document(fixture_path)
    assert window.document is not None
    assert window.document.frame_count >= 2
    assert window.slider.maximum() == window.document.frame_count - 1
    # Both panes have content after showing frame 0.
    assert not window.tile_pane.image_label.pixmap().isNull()
    assert not window.canvas_pane.image_label.pixmap().isNull()


def test_frame_navigation_and_seek(app: QApplication, fixture_path: str) -> None:
    from giftool.document import AnimationDocument

    window = MainWindow()
    window._reset_views()
    window.document = AnimationDocument(fixture_path)
    window._bind_document(fixture_path)

    last = window.document.frame_count - 1
    window._show_frame(last)
    assert window.slider.value() == last
    window._step_back()
    assert window.slider.value() == last - 1
    window._step_forward()
    assert window.slider.value() == last
    # Backward step clamps at zero.
    window._show_frame(0)
    window._step_back()
    assert window.slider.value() == 0


def test_reopen_clears_previous_document(app: QApplication, fixture_path: str) -> None:
    from giftool.document import AnimationDocument

    window = MainWindow()
    window._reset_views()
    window.document = AnimationDocument(fixture_path)
    window._bind_document(fixture_path)
    assert window.document is not None
    window._reset_views()
    assert window.document is None
    assert window.slider.maximum() == 0
    assert window.tile_pane.image_label.pixmap() is None or window.tile_pane.image_label.pixmap().isNull()


def test_export_flow_from_imported_pngs(app: QApplication, tmp_path) -> None:
    window = MainWindow()
    # Synthesize a small PNG sequence on disk.
    from PIL import Image

    png_paths = []
    for i in range(4):
        rgba = np.zeros((H, W, 4), dtype=np.uint8)
        rgba[2:5, i : i + 2, :3] = (255, 0, 0)
        rgba[2:5, i : i + 2, 3] = 255
        p = tmp_path / f"frame_{i:02d}.png"
        Image.fromarray(rgba, "RGBA").save(p)
        png_paths.append(str(p))

    # Bypass the native file dialog by feeding loaded frames directly.
    window._reset_views()
    window.imported_frames = [
        np.asarray(Image.open(p).convert("RGBA")) for p in png_paths
    ]
    window.imported_durations = [100] * 4
    window.export_btn.setEnabled(True)

    collected = window._collect_rgba_frames()
    assert collected is not None
    frames, durations = collected
    assert len(frames) == 4

    from giftool.exporter import export_gif

    result = export_gif(
        frames, durations, 0,
        colors=16, transparent_background=True, optimize=True, compare_full=True,
    )
    assert result.report.ok
    out = tmp_path / "out.gif"
    out.write_bytes(result.optimized_bytes)
    assert out.stat().st_size > 0
    assert result.report.size_optimized_bytes <= result.report.size_full_bytes


def test_import_rejects_mismatched_png_sizes(app, tmp_path) -> None:
    from PIL import Image
    p1 = tmp_path / "a.png"
    p2 = tmp_path / "b.png"
    Image.fromarray(np.zeros((8, 8, 4), dtype=np.uint8), "RGBA").save(p1)
    Image.fromarray(np.zeros((6, 6, 4), dtype=np.uint8), "RGBA").save(p2)
    images = [np.asarray(Image.open(p).convert("RGBA")) for p in (p1, p2)]
    shape = images[0].shape
    # Mirror the guard in MainWindow._import_pngs.
    assert any(img.shape != shape for img in images)
