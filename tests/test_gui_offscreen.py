import os

import pytest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtWidgets import QApplication  # noqa: E402

from ambi_rotate.main_window import MainWindow  # noqa: E402


@pytest.fixture(scope="module")
def app():
    qapp = QApplication.instance() or QApplication([])
    yield qapp
    qapp.processEvents()


def test_window_loads_sample_and_switches_modes(app):
    win = MainWindow()
    win.load_builtin_sample()
    app.processEvents()
    assert win.b is not None and win.b.shape[1] == 4
    # 朝向转一圈回到同值
    win.spn_yaw.setValue(90)
    app.processEvents()
    win.spn_yaw.setValue(90 + 360 - 1)  # 控件范围 0..359, 验证 wrap 不崩
    win.dial.setValue(0)
    app.processEvents()
    # 各试听模式可切换
    for idx in range(win.cmb_mode.count()):
        win.cmb_mode.setCurrentIndex(idx)
        app.processEvents()
    # 扬声器夹角
    win.spn_angle.setValue(45)
    app.processEvents()
    assert win.engine._angle == 45
    win.engine.teardown()
    win.close()


def test_marker_workflow_and_export(app, tmp_path):
    win = MainWindow()
    win.load_builtin_sample()
    win.markers = [(0.0, 10.0), (1.0, 350.0)]
    win.cmb_dir.setCurrentIndex(2)  # 顺时针
    win._reload_marker_table()
    win.chk_auto.setChecked(True)
    win._refresh_automation()
    auto = win.engine._automation
    assert auto is not None and auto.direction == "cw"
    wav_path = str(tmp_path / "gui_out.wav")
    json_path = str(tmp_path / "gui_out.json")
    from ambi_rotate.exporter import export_stereo, verify_export
    export_stereo(wav_path, json_path, win.b, win.sr,
                  start_time=0.0, end_time=2.0,
                  speaker_angle_deg=win.spn_angle.value(),
                  mode=win._current_mode(), automation=auto,
                  lr_order="LR", subtype="float32")
    report = verify_export(json_path, win.b, win.sr, wav_path)
    assert report["ok"], report["reasons"]
    win.engine.teardown()
    win.close()


def test_validation_dialog_opens(app):
    win = MainWindow()
    win.load_builtin_sample()
    # 不弹模态, 直接跑底层校验函数链
    from ambi_rotate.validation import run_all_checks
    results = run_all_checks()
    assert all(r.passed for r in results)
    win.engine.teardown()
    win.close()
