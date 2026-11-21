"""离屏 GUI 冒烟测试（QT_QPA_PLATFORM=offscreen，无需显示器）。

验证窗口可构建、四视图有图、滑块/选区/通道切换/评估按钮的完整回调链不报错，
并在 UI 层再次确认：切换算法与编辑区域的最终输出不依赖操作顺序。
"""
from __future__ import annotations

import os

import numpy as np
import pytest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtWidgets import QApplication  # noqa: E402

from denoise_lab.app import MainWindow  # noqa: E402
from denoise_lab.processing import RegionParams  # noqa: E402


@pytest.fixture(scope="module")
def qapp():
    app = QApplication.instance() or QApplication([])
    yield app


@pytest.fixture()
def win(qapp):
    w = MainWindow()
    w.recompute()
    yield w
    w.close()


def test_window_builds_with_four_views(win):
    for vw in win.views:
        assert not vw._pix_item.pixmap().isNull()
    # 初始即完成估计与两路降噪
    assert win.noise_model is not None
    assert win.out_smooth.shape == win.out_edge.shape


def test_selection_syncs_to_all_views(win):
    rect = (50, 150, 60, 220)
    win.on_selection(rect)
    for vw in win.views:
        assert vw._selection_item is not None
    assert win.selection == rect


def test_region_editor_uses_selection_and_recomputes(win):
    win.on_selection((80, 200, 90, 300))
    win.editors[0].set_from_selection(win.selection)
    p = win.editors[0].params()
    assert p.rect == (80, 200, 90, 300)
    before = win.out_edge.copy()
    win.editors[0].strength.setValue(95)
    win.recompute()
    assert not np.allclose(before, win.out_edge)


def test_channel_switch_and_erasure_overlay(win):
    for ch in ("RGB", "Luma", "Cr", "Cb"):
        win.channel_combo.setCurrentText(ch)
        win.refresh_views()
        assert not win.view_edge._pix_item.pixmap().isNull()
    win.chk_erasure.setChecked(False)
    win.refresh_views()
    for vw in win.views:
        assert vw._erasure_items == []
    win.chk_erasure.setChecked(True)
    win.refresh_views()


def test_noise_mode_regeneration(win):
    win.mode_combo.setCurrentIndex(1)  # fixed
    win.regenerate()
    assert win.sample.mode == "fixed"
    win.mode_combo.setCurrentIndex(0)  # luminance
    win.regenerate()
    assert win.sample.mode == "luminance"


def test_evaluation_button_populates_report(win):
    win.run_evaluation()
    text = win.eval_text.toPlainText()
    assert "噪声下降" in text and "边缘保留" in text
    assert "Cr" in text and "Cb" in text


def test_ui_order_independence(win):
    """UI 层复现需求 7：最终设置相同，输出与操作路径无关。"""
    # 路径 A：切算法 -> 改区域
    win.mode_combo.setCurrentIndex(0)
    win.editors[0].load_params(RegionParams((100, 260, 40, 320), 72, 10, True))
    win.editors[1].load_params(RegionParams((240, 420, 260, 560), 33, 18, True))
    win.priority_combo.setCurrentIndex(0)
    win.recompute()
    edge_a = win.out_edge.copy()
    smooth_a = win.out_smooth.copy()

    # 路径 B：先改回别的设置，再恢复同样的最终设置
    win.editors[0].strength.setValue(10)
    win.priority_combo.setCurrentIndex(1)
    win.recompute()
    win.editors[0].load_params(RegionParams((100, 260, 40, 320), 72, 10, True))
    win.editors[1].load_params(RegionParams((240, 420, 260, 560), 33, 18, True))
    win.priority_combo.setCurrentIndex(0)
    win.recompute()
    assert np.array_equal(edge_a, win.out_edge)
    assert np.array_equal(smooth_a, win.out_smooth)
    # 两算法结果确实不同
    assert not np.allclose(win.out_smooth, win.out_edge)


def test_estimation_panel_never_touches_clean(win):
    # 估计函数在 app 中的调用只传入 noisy（源码层 AST 已查，这里做运行时守护）
    import inspect
    from denoise_lab import noise_estimation
    src = inspect.getsource(win.run_estimation)
    assert "sample.clean" not in src
    assert "sample.noisy" in src
    assert inspect.signature(
        noise_estimation.fit_noise_model).parameters.get("clean") is None
