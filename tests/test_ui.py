"""界面冒烟测试: 用 offscreen 平台驱动主窗口, 验证载入/识别/历史/导出/点选.

这些用例不校验像素, 只校验界面的数据流: 场景切换后表格和状态栏更新、调整设定后
历史累积、旧结果对比能指出丢失的段落、导出按钮写出文件.
"""

from __future__ import annotations

import os

import pytest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

pytest.importorskip("PySide6")

from PySide6.QtWidgets import QApplication  # noqa: E402

from dtmf_lab.samples import SCENARIOS  # noqa: E402


@pytest.fixture(scope="module")
def app():
    instance = QApplication.instance() or QApplication([])
    yield instance


@pytest.fixture()
def window(app):
    from dtmf_lab.ui.main_window import MainWindow

    win = MainWindow()
    win.resize(1280, 860)
    win.show()
    app.processEvents()
    yield win
    win.close()
    app.processEvents()


def _select_scenario(window, name: str) -> None:
    for i, scenario in enumerate(SCENARIOS):
        if scenario.name == name:
            window.scenario_list.setCurrentRow(i)
            break
    window._use_scenario()


def test_window_starts_with_first_scenario(window):
    assert window.clip is not None
    assert window.result is not None
    assert window.result.keys == "123A"
    assert window.result_table.rowCount() == 4
    assert "123A" in window.status_label.text()


def test_switching_scenario_updates_tables(window, app):
    _select_scenario(window, "missing_high")
    app.processEvents()
    assert window.result.keys == ""
    assert window.result_table.rowCount() == 0
    assert window.rejected_table.rowCount() == 1
    assert "拒绝候选 1" in window.status_label.text()


def test_history_accumulates_and_diff_marks_lost(window, app):
    _select_scenario(window, "clean_digits")
    app.processEvents()
    before = window.history_list.count()
    window.settings_panel._editors["min_key_ms"].setValue(200)
    window._on_apply_settings(window.settings_panel.settings())
    app.processEvents()
    assert window.history_list.count() == before + 1
    diff_text = window.diff_box.toPlainText()
    assert "丢失" in diff_text


def test_table_selection_updates_readout(window, app):
    _select_scenario(window, "slight_offset")
    app.processEvents()
    window.result_table.selectRow(0)
    app.processEvents()
    assert "键 '8'" in window.readout_title.text()
    assert window.play_seg_btn.isEnabled()


def test_cursor_readout_reports_frequencies(window, app):
    _select_scenario(window, "clean_digits")
    app.processEvents()
    window._on_cursor(0.35)
    app.processEvents()
    detail = window.readout_detail.toPlainText()
    assert "低组" in detail and "高组" in detail
    assert "697" in detail  # 键 1 的低频组


def test_export_buttons_write_files(window, app, tmp_path, monkeypatch):
    from PySide6.QtWidgets import QFileDialog, QMessageBox

    _select_scenario(window, "missing_low_mid")
    app.processEvents()
    csv_path = tmp_path / "清单.csv"
    json_path = tmp_path / "结果.json"
    monkeypatch.setattr(QFileDialog, "getSaveFileName", staticmethod(lambda *a, **k: (str(csv_path), "")))
    monkeypatch.setattr(QMessageBox, "information", staticmethod(lambda *a, **k: None))
    window._export_csv()
    assert csv_path.exists() and csv_path.stat().st_size > 0
    monkeypatch.setattr(QFileDialog, "getSaveFileName", staticmethod(lambda *a, **k: (str(json_path), "")))
    window._export_json()
    assert json_path.exists() and json_path.stat().st_size > 0


def test_synthesis_panel_creates_audio(window, app):
    window.synth_panel.keys_edit.setText("5 6 7")
    window.synth_panel.key_ms.setValue(80)
    window.synth_panel.gap_ms.setValue(60)
    window.synth_panel._make()
    app.processEvents()
    assert window.result.keys == "567"
    assert "合成" in window.audio_label.text()


def test_bad_synthesis_input_warns(window, app, monkeypatch):
    from PySide6.QtWidgets import QMessageBox

    warnings = []
    monkeypatch.setattr(QMessageBox, "warning", staticmethod(lambda *a, **k: warnings.append(a[2])))
    window.synth_panel.keys_edit.setText("12X")
    window.synth_panel._make()
    app.processEvents()
    assert warnings and "不认识" in warnings[0]
