import time

import pytest
from PySide6.QtWidgets import QApplication

from tileviewer.cache import LevelState
from tileviewer.geometry import Rect
from tileviewer.main_window import MainWindow
from tileviewer.source import load_source


@pytest.fixture
def window(qapp, tmp_path, source_png):
    from PySide6.QtCore import QSettings

    settings = QSettings(
        str(tmp_path / "settings.ini"), QSettings.Format.IniFormat
    )
    win = MainWindow(
        cache_root=tmp_path / "cache",
        settings=settings,
        auto_generate=False,
    )
    win.resize(1200, 800)
    win.show()
    win.open_image(source_png)
    yield win
    if win._thread is not None:
        win._worker.cancel()
        win._thread.quit()
        win._thread.wait(5000)
    win.viewer.shutdown()
    win.close()


def _wait_until(predicate, timeout_ms: int = 20000) -> bool:
    deadline = time.monotonic() + timeout_ms / 1000.0
    while time.monotonic() < deadline:
        QApplication.processEvents()
        if predicate():
            return True
        time.sleep(0.01)
    return False


def test_open_image_populates_level_table(window):
    assert window.source is not None
    assert window.level_table.rowCount() == window.manager.info.level_count
    assert window.manager.statuses()[0].state is LevelState.MISSING
    assert "x" not in window.source_path_label.text()  # single-line path box
    assert str(window.source.path) == window.source_path_label.text()


def test_generate_in_background_then_verify(window):
    window.generate_missing()
    assert _wait_until(lambda: window._thread is None)
    assert all(
        status.state is LevelState.COMPLETE for status in window.manager.statuses()
    )
    window.verify_all_levels()
    assert _wait_until(lambda: window._thread is None)
    log = window.log.toPlainText()
    assert "逐像素一致" in log


def test_cancel_then_resume_flow(window, tmp_path):
    import numpy as np

    from tests.conftest import write_png

    # A bigger image with small tiles guarantees cancellation lands mid-level.
    ys, xs = np.mgrid[0:900, 0:1100]
    bigger = np.stack(
        [xs % 256, ys % 256, (xs + ys) % 256], axis=2
    ).astype(np.uint8)
    big_path = write_png(tmp_path / "big.png", bigger)
    window.tile_size_combo.setCurrentIndex(window.tile_size_combo.findData(256))
    window.open_image(big_path)
    window.manager.clear_all()
    window.viewer.clear_tile_cache()
    window._refresh_statuses()

    window.generate_missing()
    assert _wait_until(
        lambda: window.progress.value() > 0 or window._thread is None, 5000
    )
    window.cancel_generation()
    assert _wait_until(lambda: window._thread is None)
    statuses = window.manager.statuses()
    incomplete = [s for s in statuses if s.state is not LevelState.COMPLETE]
    assert incomplete, "cancelling a 1100x900 image must leave work to resume"
    assert all(
        status.state in (LevelState.PARTIAL, LevelState.MISSING)
        for status in incomplete
    )
    assert "取消" in window.log.toPlainText()

    window.generate_missing()
    assert _wait_until(lambda: window._thread is None)
    assert all(
        status.state is LevelState.COMPLETE for status in window.manager.statuses()
    )
    assert np.array_equal(window.manager.stitch_level(0), bigger)


def test_config_change_switches_cache_directory(window):
    old_directory = window.manager.directory
    window.tile_size_combo.setCurrentIndex(
        window.tile_size_combo.findData(256)
    )
    window.apply_config()
    assert window.manager.directory != old_directory
    assert window.manager.config.tile_size == 256
    assert window.manager.statuses()[0].state is LevelState.MISSING


def test_export_selection_uses_original_pixels(window, tmp_path, monkeypatch):
    window.manager.generate()
    window._refresh_statuses()
    selection = Rect(3, 4, 20, 17)
    window.viewer.set_selection_pixels(selection)
    from tileviewer import main_window as module

    target = tmp_path / "crop.png"
    monkeypatch.setattr(
        module.QFileDialog,
        "getSaveFileName",
        staticmethod(lambda *args, **kwargs: (str(target), "PNG (*.png)")),
    )
    window.export_selection_dialog()
    assert target.exists()

    import numpy as np
    from PIL import Image

    with Image.open(target) as image:
        array = np.array(image.convert("RGB"))
    expected = window.source.array[4:21, 3:23, :]
    assert np.array_equal(array, expected)


def test_reload_detects_changed_file_content(window, tmp_path):
    from tileviewer.sample import build_sample

    path = window.source.path
    first_hash = window.source.short_hash
    # Rewrite the same file name with different content and reload.
    image = build_sample(101, 77)
    image.save(path, format="PNG")
    window.reload_current()
    assert window.source.short_hash != first_hash
    assert window.manager.statuses()[0].state is LevelState.MISSING
    window.manager.generate([0])
    expected = load_source(path).array
    import numpy as np

    assert np.array_equal(window.manager.stitch_level(0), expected)


def test_missing_tile_is_reported_as_partial(window):
    window.manager.generate()
    window._refresh_statuses()
    window.manager.tile_path(0, 0, 0).unlink()
    window.manager.level_manifest_path(0).unlink()
    window._refresh_statuses()
    status = window.manager.level_status(0)
    assert status.state is LevelState.PARTIAL
    table_text = [
        window.level_table.item(0, column).text() for column in range(5)
    ]
    assert table_text[0] == "L00"
    assert table_text[3] == "未完成"


def test_settings_roundtrip(window, tmp_path):
    window._save_settings()
    payload = (tmp_path / "settings.ini").read_text()
    assert "tile_size=512" in payload
    assert str(window.source.path) in payload


def test_about_dialog_mentions_shortcuts(window, monkeypatch):
    from tileviewer import main_window as module

    captured = {}
    monkeypatch.setattr(
        module.QMessageBox,
        "information",
        staticmethod(lambda parent, title, text, *a, **k: captured.update(text=text)),
    )
    window.show_about()
    assert "滚轮" in captured["text"]
