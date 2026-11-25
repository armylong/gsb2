"""The window must keep shared state across view switches, and stay in sync."""
from __future__ import annotations

import time

import numpy as np
import pytest



@pytest.fixture(scope="module")
def window(qapp):
    from photometric import theme
    from photometric.mainwindow import MainWindow

    theme.apply(qapp)
    win = MainWindow()
    win.show()
    # solve runs on a worker thread; wait for the first result
    deadline = time.time() + 40
    while time.time() < deadline:
        qapp.processEvents()
        if win.ctx.result is not None:
            break
        time.sleep(0.01)
    yield win
    win.service.shutdown()
    win.close()


def _wait(qapp, predicate, timeout: float = 40.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        qapp.processEvents()
        if predicate():
            return True
        time.sleep(0.01)
    return False


def test_first_scene_solves(window):
    assert window.ctx.result is not None
    assert window.ctx.result.valid.any()


def test_brightness_survives_tab_switching(window, qapp):
    window.ctx.set_brightness(2.35)
    for index in range(window.tabs.count()):
        window.tabs.setCurrentIndex(index)
        qapp.processEvents()
    assert window.ctx.brightness == pytest.approx(2.35)
    # the slider hands the same value back to the context
    window.relight_view._on_exposure(170)
    assert window.ctx.brightness == pytest.approx(1.70)
    window.ctx.set_brightness(1.0)


def test_brightness_survives_re_solving(window, qapp):
    window.ctx.set_brightness(1.8)
    window.solve()
    assert _wait(qapp, lambda: window.ctx.result is not None and not window.ctx.solving)
    assert window.ctx.brightness == pytest.approx(1.8)
    window.ctx.set_brightness(1.0)


def test_brightness_applied_to_rendered_preview(window):
    window.ctx.set_brightness(1.0)
    window.relight_view.refresh()
    dim = window.relight_view.view.array().astype(np.float64)
    window.ctx.set_brightness(2.0)
    window.relight_view.refresh()
    bright = window.relight_view.view.array().astype(np.float64)
    assert bright.mean() > dim.mean()
    window.ctx.set_brightness(1.0)


def test_pinned_probe_is_shared(window, qapp):
    result = window.ctx.result
    valid_xy = np.argwhere(result.valid)
    y, x = map(int, valid_xy[len(valid_xy) // 2])
    window.ctx.set_pinned((x, y))
    qapp.processEvents()
    assert window.normals_view.view._pinned == (x, y)
    for view in window.inputs_view.views:
        assert view._pinned == (x, y)
    info = window.ctx.probe_info()
    assert info is not None and info.valid
    assert info.normal is not None
    assert len(info.readings) == result.status.shape[0]


def test_probe_table_lists_every_light(window, qapp):
    result = window.ctx.result
    y, x = map(int, np.argwhere(result.valid)[0])
    window.ctx.set_pinned((x, y))
    qapp.processEvents()
    window.normals_view._update_probe()
    assert window.normals_view.table.rowCount() == result.status.shape[0]
    assert window.normals_view.table.item(0, 0).text().startswith("图")


def test_rig_edit_updates_verdict(window, qapp):
    original = window.light_list.specs()
    Spec = type(original[0])

    def rows(specs):
        window.light_list.set_rows(specs, loadable=False, removable=False)
        window._on_rig_edited()
        qapp.processEvents()

    try:
        # all three lights on the image plane -> the rig cannot see z
        rows([Spec(a, 0.0, True, f"图 {i + 1}") for i, a in enumerate((0, 120, 240))])
        assert "不足以区分" in window.verdict.text()
        # back to a well-spread rig
        rows([Spec(a, 45.0, True, f"图 {i + 1}") for i, a in enumerate((0, 90, 180, 270))])
        assert "可以区分" in window.verdict.text()
    finally:
        rows(original)


def test_scene_switch_updates_everything(window, qapp):
    window._load_scene("relief", autorun=True)
    assert _wait(qapp, lambda: window.ctx.scene.key == "relief"
                 and window.ctx.result is not None and not window.ctx.solving)
    assert window.ctx.scene.title == "浮雕 · 凸起与凹陷"
    assert window.light_list.count() == window.ctx.scene.n_lights
    window._load_scene("sphere", autorun=True)
    assert _wait(qapp, lambda: window.ctx.scene.key == "sphere"
                 and window.ctx.result is not None and not window.ctx.solving)


def test_export_view_round_trip(window, qapp, tmp_path):
    window.tabs.setCurrentWidget(window.export_view)
    window.export_view.path_edit.setText(str(tmp_path / "export"))
    window.export_view.export()
    assert window.export_view._last_paths is not None
    manifest = window.export_view._last_paths.manifest
    assert manifest.exists()
    window.export_view.read_back()
    text = window.export_view.report.toPlainText()
    assert "通过" in text
    assert "未通过" not in text


def test_loading_files_builds_a_scene(window, qapp, tmp_path):
    from photometric.views.source import load_grayscale
    from PySide6.QtGui import QImage

    loaded = []
    for i, az in enumerate((0, 120, 240)):
        # a grey ramp is not physically meaningful, but it is well-formed input
        arr = np.tile(np.linspace(0.1, 0.9, 64), (64, 1))
        img = np.repeat((arr * 255).astype(np.uint8)[:, :, None], 3, axis=-1)
        img = np.ascontiguousarray(img)
        path = tmp_path / f"img{i}.png"
        QImage(img.data, 64, 64, 3 * 64, QImage.Format.Format_RGB888).save(str(path))
        loaded.append((f"img{i}", load_grayscale(path)))
    window._load_files(loaded)
    assert _wait(qapp, lambda: window.ctx.scene is not None
                 and window.ctx.scene.source == "files")
    assert window.ctx.scene.n_lights == 3
    assert window.light_list.count() == 3
    assert window.ctx.scene.height == 64
    window._load_scene("sphere", autorun=True)
    assert _wait(qapp, lambda: window.ctx.scene.key == "sphere")


def test_disabled_light_keeps_photo_alignment(window, qapp, tmp_path):
    original = window.light_list.specs()
    try:
        specs = [type(s)(s.azimuth_deg, s.elevation_deg, s.enabled, s.name) for s in original]
        specs[1].enabled = False
        window.light_list.set_rows(specs, loadable=False, removable=False)
        window._on_rig_edited()
        window.solve()
        assert _wait(qapp, lambda: window.ctx.result is not None and not window.ctx.solving)
        result = window.ctx.result
        assert result.light_indices is not None
        assert 1 not in set(int(i) for i in result.light_indices)
        # probe readings must report the scene light numbers, not row numbers
        window.ctx.set_pinned((int(result.width // 2), int(result.height // 2)))
        info = window.ctx.probe_info()
        reported = {r.light for r in info.readings}
        assert reported == set(int(i) for i in result.light_indices)
        scene = window.ctx.scene
        for reading in info.readings:
            assert abs(reading.intensity - float(scene.images[reading.light, info.y, info.x])) < 1e-6
    finally:
        window.light_list.set_rows(original, loadable=False, removable=False)
        window._on_rig_edited()
        window.solve()
        _wait(qapp, lambda: window.ctx.result is not None and not window.ctx.solving)


def test_export_declares_every_light(window, qapp, tmp_path):
    import json

    window.tabs.setCurrentWidget(window.export_view)
    window.export_view.path_edit.setText(str(tmp_path / "m"))
    window.export_view.export()
    manifest = json.loads(window.export_view._last_paths.manifest.read_text(encoding="utf-8"))
    assert len(manifest["lights"]) == window.ctx.scene.n_lights
    assert manifest["normal_encoding"]["convention"] == "opengl"
