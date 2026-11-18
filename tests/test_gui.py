"""Headless GUI tests for the main window."""

from __future__ import annotations

import numpy as np
import pytest

pytest.importorskip("PySide6")

from PySide6.QtWidgets import QApplication  # noqa: E402

from apng_editor.model import DISPOSE_KEEP, compose_project  # noqa: E402
from apng_editor.ui.main_window import MainWindow  # noqa: E402


@pytest.fixture(scope="session")
def app():
    application = QApplication.instance() or QApplication([])
    yield application


@pytest.fixture()
def window(app):
    win = MainWindow()
    win.show()
    app.processEvents()
    yield win
    win.close()


def test_starts_on_default_sample(window) -> None:
    assert len(window.project.frames) == 2
    assert window.frame_list.count() == 2
    assert window.frame_list.currentRow() == 0


def test_direct_middle_selection_matches_forward_composition(window, app) -> None:
    window.combo_sample.setCurrentText("恢复旧画面")
    window.btn_load_sample.click()
    app.processEvents()

    forward = compose_project(window.project)
    # Look at the last frame first, then jump straight to the middle one.
    window.frame_list.setCurrentRow(2)
    app.processEvents()
    window.frame_list.setCurrentRow(1)
    app.processEvents()
    assert window.selected == 1

    shown = window.composite_preview._image
    assert shown is not None
    # Compare with the independently composed frame 1 (0-based).
    expected = forward[1]
    assert window.displayed[1].tobytes() == expected.tobytes()


def test_backwards_and_forwards_seek_are_identical(window, app) -> None:
    window.combo_sample.setCurrentText("恢复旧画面")
    window.btn_load_sample.click()
    app.processEvents()
    baseline = [frame.tobytes() for frame in compose_project(window.project)]

    seen = []
    for row in (2, 0, 2, 1, 0, 1, 2):
        window.frame_list.setCurrentRow(row)
        app.processEvents()
        seen.append((row, window.displayed[row].tobytes()))
    for row, data in seen:
        assert data == baseline[row]


def test_editing_an_early_frame_updates_later_composites(window, app) -> None:
    window.combo_sample.setCurrentText("恢复旧画面")
    window.btn_load_sample.click()
    app.processEvents()
    before = window.displayed[2].copy()

    window.frame_list.setCurrentRow(1)
    app.processEvents()
    # Change frame 2 from "restore previous" to "keep": the blue tile stays,
    # so frame 3 must be composited against blue instead of red.
    window.combo_dispose.setCurrentIndex(window.combo_dispose.findData(DISPOSE_KEEP))
    app.processEvents()
    after = window.displayed[2]
    assert window.project.frames[1].dispose == DISPOSE_KEEP
    assert not np.array_equal(before, after)

    # And the new composite equals a from-scratch composition of the project.
    assert np.array_equal(after, compose_project(window.project)[2])
    # Pixel at (20, 20) is now semi-transparent white over opaque blue.
    assert tuple(int(v) for v in after[20, 20]) == (143, 158, 228, 255)


def test_out_of_bounds_position_is_reported_and_reverted(window, app) -> None:
    old_x = window.project.frames[0].x
    window.spin_x.setValue(5000)
    app.processEvents()
    assert window.project.frames[0].x == old_x
    assert "越界" in window.warning_label.text()
    assert window.warning_label.isVisible()


def test_invalid_duration_is_reported(window, app) -> None:
    old = window.project.frames[0].duration_ms
    window.spin_duration.setValue(0)
    app.processEvents()
    assert window.project.frames[0].duration_ms == old
    assert "显示时长" in window.warning_label.text()


def test_add_remove_and_reorder_frames(window, app, monkeypatch) -> None:
    count = len(window.project.frames)
    window.btn_duplicate.click()
    app.processEvents()
    assert len(window.project.frames) == count + 1
    assert window.frame_list.count() == count + 1

    new_index = window.selected
    window.btn_up.click()
    app.processEvents()
    assert window.selected == new_index - 1

    window.btn_remove.click()
    app.processEvents()
    assert len(window.project.frames) == count


def test_loop_count_controls_explain_semantics(window, app) -> None:
    window.spin_loops.setValue(0)
    app.processEvents()
    assert "无限循环" in window.loop_hint.text()
    window.spin_loops.setValue(4)
    app.processEvents()
    assert "4" in window.loop_hint.text()
    assert "有限" in window.loop_hint.text() or "遍" in window.loop_hint.text()


def test_play_pause_and_finite_loop(window, app) -> None:
    window.spin_loops.setValue(1)
    app.processEvents()
    window.btn_play.click()
    app.processEvents()
    assert window.clock.playing

    total = sum(frame.duration_ms for frame in window.project.frames)
    window.clock.tick(total)
    window._on_tick()
    app.processEvents()
    assert window.clock.finished
    assert window.selected == len(window.project.frames) - 1

    window.btn_play.click()  # starts again
    app.processEvents()
    assert window.clock.playing
    window.btn_play.click()  # pause
    app.processEvents()
    index = window.selected
    window.clock.tick(10000)
    window._on_tick()
    assert window.selected == index


def test_canvas_resize_validates(window, app) -> None:
    window.spin_canvas_w.setValue(20)
    window.spin_canvas_h.setValue(20)
    window.btn_apply_size.click()
    app.processEvents()
    # Tiles are larger than 20×20, so the resize must be refused.
    assert window.project.canvas_size == (80, 80)
    assert "超过画布" in window.warning_label.text() or "越界" in window.warning_label.text()


def test_previews_show_tile_placement_and_composite(window, app) -> None:
    window.combo_sample.setCurrentText("移动后清除")
    window.btn_load_sample.click()
    window.frame_list.setCurrentRow(1)
    app.processEvents()
    frame = window.project.frames[1]
    assert window.tile_preview._canvas_size == (frame.width, frame.height)
    assert window.placement_preview._outline == (
        frame.x,
        frame.y,
        frame.x + frame.width,
        frame.y + frame.height,
    )
    assert window.composite_preview._outline == window.placement_preview._outline
    assert window.composite_preview._image is not None


def test_reset_restores_default_sample(window, app) -> None:
    window.btn_duplicate.click()
    app.processEvents()
    window.btn_reset.click()
    app.processEvents()
    assert len(window.project.frames) == 2
    assert window.project.canvas_size == (80, 80)


def test_export_flow_writes_and_verifies(window, app, tmp_path, monkeypatch) -> None:
    from PySide6.QtWidgets import QFileDialog, QMessageBox

    from apng_editor.apng_codec import decode_apng
    from apng_editor.exporter import verify_export

    target = tmp_path / "gui_export.png"
    monkeypatch.setattr(
        QFileDialog,
        "getSaveFileName",
        staticmethod(lambda *args, **kwargs: (str(target), "")),
    )
    captured = {}

    def fake_exec(self):
        captured["text"] = self.text()
        captured["informative"] = self.informativeText()
        captured["detail"] = self.detailedText()
        return 0

    monkeypatch.setattr(QMessageBox, "exec", fake_exec)

    window.btn_export.click()
    app.processEvents()

    assert target.exists()
    assert "通过" in captured["text"]
    assert "未写入文件" in captured["informative"]
    assert "全部一致" in captured["detail"]
    assert "设定 250 ms" in captured["detail"]

    decoded = decode_apng(target)
    assert len(decoded.frames) == len(window.project.frames)
    assert verify_export(window.project, target).ok
    # The exporter must not leak the red outline or checkerboard.
    for frame in decoded.frames:
        colours = {tuple(int(v) for v in px) for px in frame.pixels.reshape(-1, 4)}
        assert (204, 204, 204, 255) not in colours
        assert (153, 153, 153, 255) not in colours


def test_export_refused_for_invalid_frame(window, app, monkeypatch) -> None:
    from PySide6.QtWidgets import QMessageBox

    # Corrupt the model behind the UI's back to force a validation failure.
    window.project.frames[0].duration_ms = 0
    shown = {}
    monkeypatch.setattr(
        QMessageBox,
        "warning",
        staticmethod(lambda *args, **kwargs: shown.setdefault("msg", args[2])),
    )
    window.btn_export.click()
    app.processEvents()
    assert "显示时长" in shown["msg"]
    assert window.warning_label.isVisible()
